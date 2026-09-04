/**
 * 决策引擎（PolicyEngine 语义）
 *
 * 优先级：显式指定 > 规则 > selfLearn > learn > 粘滞 > defaultModel > fallback 链
 *        > 池内兜底扫描 > 全灭赦免 > 保持当前
 * 提炼自 CCR 的多策略优先级 + fallback 链。
 *
 * 闭环不变量：**任何路径都不得返回一个不可用的模型**。
 * 可用性由统一的 `usable()` 门禁判定（候选集合内 + 未冷却 + 未被 probe 排除）。
 * 早期实现有三处漏洞会让 router 撞墙停摆（详见 .debug/fallback-loop-debug.md 的 L3）：
 * ① 规则目标冷却且 fallback 链为空时，直接把冷却中的死模型返回；
 * ② pool 只当"过滤器"，从不当"候选来源"，池内其余健康模型永不被兜底；
 * ③ 候选耗尽后返回 undefined（= 保持当前），而当前往往正是那个死模型 → 每轮撞墙。
 * 现在 ② 由池内兜底扫描解决，③ 由赦免（解除最先恢复者的排除）解决。
 */
import type { NormalizedRouterConfig, RouteDecision, TaskFeatures, RouterRule } from "../types.ts";
import { CooldownSet } from "./registry.ts";
import { pickAvailableModel, createExecutionPlan } from "./planner.ts";
import { type CompiledRule } from "./rules.ts";
import { evaluateCondition } from "./conditions.ts";
import type { CacheManager } from "./cache.ts";
import type { LearningManager } from "./learn.ts";
import type { SelfLearnManager } from "./selflearn.ts";
import { analyzeTask } from "./difficulty.ts";
import type { AvailabilityProbe } from "../probe/availability.ts";

export interface DecisionInput {
  features: TaskFeatures;
  config: NormalizedRouterConfig;
  compiledRules: CompiledRule[];
  cooldowns: CooldownSet;
  availableModels: Set<string>;
  cacheManager?: CacheManager;
  learning?: LearningManager;
  selfLearn?: SelfLearnManager;
  probe?: AvailabilityProbe;
  sessionId?: string;
  promptText?: string;
}

function isAvailable(selector: string | undefined, available: Set<string>): boolean {
  if (!selector) return false;
  const lower = selector.toLowerCase();
  for (const a of available) {
    if (a.toLowerCase() === lower) return true;
  }
  return false;
}

function fallbackAvailable(
  config: NormalizedRouterConfig,
  cooldowns: CooldownSet,
  available: Set<string>,
  cacheManager?: CacheManager,
  sessionId?: string,
  promptText?: string,
  probe?: AvailabilityProbe,
): string | undefined {
  const fallback = config.fallback;
  if (!fallback || fallback.mode === "off") return undefined;
  // probe 标记 unavailable（额度耗尽/套餐失效）的模型不进 fallback 链，防止冷却过期后被重新选中
  const probeOk = (s: string): boolean => !probe || probe.getAvailability(s) !== "unavailable";
  let chain = (fallback.models ?? []).filter((m) => isAvailable(m, available) && !cooldowns.isCooldown(m) && probeOk(m));
  if (chain.length === 0) return undefined;
  // 缓存感知排序：偏好命中高的模型（仅在 cache.enabled 时）
  if (cacheManager && sessionId && promptText && config.cache?.enabled && config.cache?.preferCache) {
    chain = cacheManager.rankCandidates(chain, sessionId, promptText, config);
  }
  return chain[0];
}

/** 估算切到目标模型将丢失的缓存 token（相对当前模型） */
function estimateChurn(
  current: string | undefined,
  target: string | undefined,
  cacheManager: CacheManager | undefined,
  sessionId: string,
  promptText: string,
): number {
  if (!current || !target || !cacheManager || !sessionId || !promptText) return 0;
  const currentLower = current.toLowerCase();
  const targetLower = target.toLowerCase();
  if (currentLower === targetLower) return 0;
  const est = cacheManager.estimate(current, sessionId, promptText);
  return Math.round(est.commonPrefixChars / 4);
}

export function decide(input: DecisionInput): RouteDecision {
  const { features, config, compiledRules, cooldowns, cacheManager, learning, selfLearn, probe, sessionId, promptText } = input;
  const now = Date.now();
  const prompt = promptText ?? features.promptText ?? "";
  const sid = sessionId ?? "";
  const current = features.currentModel;
  // 模型池硬边界（config.pool）：池非空时，全部决策（规则/learn/sticky/default/fallback）只在池内选
  const poolSet = config.pool && config.pool.length > 0 ? new Set(config.pool.map((s) => s.toLowerCase())) : undefined;
  const availableModels = poolSet
    ? new Set([...input.availableModels].filter((s) => poolSet.has(s.toLowerCase())))
    : input.availableModels;

  /** 决策时如果目标 ≠ 当前且 churn 超阈值，在 reason 标注；规则仍优先，非规则层则倾向保持 */
  const churnNote = (target: string): string => {
    if (!config.churn.enabled || !current) return "";
    const loss = estimateChurn(current, target, cacheManager, sid, prompt);
    return loss > 0 ? ` churn≈${loss}tok` : "";
  };
  const shouldKeepForChurn = (target: string): boolean => {
    if (!config.churn.enabled || !current) return false;
    const loss = estimateChurn(current, target, cacheManager, sid, prompt);
    return loss > config.churn.maxChurnTokens;
  };

  // probe 排除（额度耗尽/套餐失效）：任何路径都不可再选，直到 TTL 到期或真实调用成功自愈
  const probeOk = (s: string | undefined): boolean => Boolean(s) && (!probe || probe.getAvailability(s as string) !== "unavailable");

  /** 统一可用性门禁 —— 所有选型路径共用，杜绝"把死模型返回给调用方" */
  const usable = (s: string | undefined): boolean =>
    Boolean(s) && isAvailable(s, availableModels) && !cooldowns.isCooldown(s as string) && probeOk(s);

  /**
   * 当前模型已死（不在候选集合 / 冷却中 / 被 probe 排除）→ 必须换，否则每轮都撞在它身上。
   * 池内兜底扫描与赦免都以此为闸门：当前健康时不打扰（含用户手动选的池外模型）。
   */
  const currentDead = Boolean(current) && !usable(current);

  /** 有序候选宇宙：defaultModel → fallback.models → 池内其余。pool 既是边界也是兜底来源。 */
  const orderedUniverse = (): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (s: string | undefined): void => {
      const trimmed = s?.trim();
      if (!trimmed) return;
      const k = trimmed.toLowerCase();
      if (seen.has(k) || !isAvailable(trimmed, availableModels)) return;
      seen.add(k);
      out.push(trimmed);
    };
    push(config.defaultModel);
    for (const m of config.fallback.models ?? []) push(m);
    for (const m of availableModels) push(m);
    return out;
  };

  /** 缓存感知排序（cm 传 undefined 表示该路径不做缓存优化，如 rule.cacheAware === false） */
  const rankByCache = (candidates: string[], cm: CacheManager | undefined = cacheManager): string[] => {
    if (candidates.length < 2) return candidates;
    if (cm && sid && prompt && config.cache?.enabled && config.cache?.preferCache) {
      return cm.rankCandidates(candidates, sid, prompt, config);
    }
    return candidates;
  };

  /** 池内兜底扫描：fallback 链耗尽后，从池内其余健康模型里挑一个（缓存感知排序） */
  const poolSweep = (cm: CacheManager | undefined = cacheManager): string | undefined => {
    if (!currentDead) return undefined;
    const candidates = orderedUniverse().filter(usable);
    if (candidates.length === 0) return undefined;
    return rankByCache(candidates, cm)[0];
  };

  /**
   * 全灭赦免（最后一搏）：池内没有任何可用模型时，解除"最先恢复"那个模型的冷却/排除并推进。
   * 不赦免就只能停摆等用户手动把模型从 pool 里删掉（旧行为，见 .debug L2/L3）。
   * 重试次数由调用方的链路预算兜住，不会无限循环。
   */
  const amnesty = (): { selector: string; waitMs: number } | undefined => {
    if (!currentDead) return undefined;
    const universe = orderedUniverse();
    if (universe.length === 0) return undefined;
    const probeRemaining = new Map(
      (probe?.excluded() ?? []).map((e) => [e.selector.trim().toLowerCase(), e.remainingMs] as const),
    );
    let best: string | undefined;
    let bestWait = Infinity;
    const currentKey = current?.trim().toLowerCase();
    for (const sel of universe) {
      if (usable(sel)) continue;
      // 不赦免 current 本身：它就是刚失败/正在冷却的那个，原地重试等于 flip-flop
      if (currentKey && sel.trim().toLowerCase() === currentKey) continue;
      // 冷却与 probe 排除可能叠加，取两者中较晚恢复的时间作为"代价"
      const wait = Math.max(cooldowns.remainingMs(sel), probeRemaining.get(sel.toLowerCase()) ?? 0);
      if (wait < bestWait) { bestWait = wait; best = sel; }
    }
    if (!best) return undefined;
    cooldowns.clear(best);
    probe?.clear(best);
    return { selector: best, waitMs: bestWait };
  };

  /** 说明某个模型为什么不可用（写进 reason，便于用户判断） */
  const unusableWhy = (sel: string): string => {
    if (!isAvailable(sel, availableModels)) return poolSet ? "unavailable (outside pool)" : "unavailable";
    if (cooldowns.isCooldown(sel)) return `cooling ${Math.round(cooldowns.remainingMs(sel) / 1000)}s`;
    return "unavailable (quota/auth)";
  };

  // 1. 显式指定：强制，不做冷却规避、不受模型池限制（用户手动意志高于自动路由边界）
  if (features.explicitModel) {
    const sel = features.explicitModel.trim();
    if (isAvailable(sel, input.availableModels)) {
      return { selector: sel, reason: `explicit @${config.explicitModelPrefix}${sel}`, ruleId: undefined, source: "explicit", timestamp: now };
    }
    return { selector: undefined, reason: `explicit model "${sel}" not available`, ruleId: undefined, source: "explicit", timestamp: now };
  }

  // 2. 规则命中（池感知：目标模型在池外的规则被跳过，继续找下一条可用的）
  const poolAllows = (sel: string): boolean => !poolSet || poolSet.has(sel.toLowerCase());
  let matched: RouterRule | undefined;
  for (const entry of compiledRules) {
    if (!entry.active) continue;
    try {
      if (evaluateCondition(entry.rule.when, features) && poolAllows(entry.rule.model.trim())) { matched = entry.rule; break; }
    } catch { /* 条件异常视为不命中 */ }
  }
  if (matched) {
    const desired = matched.model.trim();
    // rule.cacheAware === false 表示该规则不参与缓存优化排序（如强制特定能力模型）
    const cm = matched.cacheAware !== false ? cacheManager : undefined;
    if (usable(desired)) {
      // 规则命中：尊重规则（即便 churn 大，规则优先）；reason 标注 churn；带 thinkingLevel
      return { selector: desired, reason: `rule "${matched.id}" → ${desired}${churnNote(desired)}`, ruleId: matched.id, source: "rule", timestamp: now, thinkingLevel: matched.thinkingLevel };
    }
    const why = unusableWhy(desired);
    // 逐级兜底：fallback 链 → 池内扫描 → 赦免。任何一级命中都返回可用模型，绝不返回死模型。
    const alt = fallbackAvailable(config, cooldowns, availableModels, cm, sid, prompt, probe);
    if (alt) {
      return { selector: alt, reason: `rule "${matched.id}" → ${desired} ${why} → fallback "${alt}"`, ruleId: matched.id, source: "cooldown-avoid", timestamp: now, thinkingLevel: matched.thinkingLevel };
    }
    const swept = poolSweep(cm);
    if (swept) {
      return { selector: swept, reason: `rule "${matched.id}" → ${desired} ${why} → pool sweep "${swept}"`, ruleId: matched.id, source: "pool-sweep", timestamp: now, thinkingLevel: matched.thinkingLevel };
    }
    const pardon = amnesty();
    if (pardon) {
      return { selector: pardon.selector, reason: `rule "${matched.id}" → ${desired} ${why}; pool exhausted → pardoned "${pardon.selector}" (recovering in ${Math.round(pardon.waitMs / 1000)}s)`, ruleId: matched.id, source: "amnesty", timestamp: now, thinkingLevel: matched.thinkingLevel };
    }
    return { selector: undefined, reason: `rule "${matched.id}" → ${desired} ${why}, no usable candidate`, ruleId: matched.id, source: "rule", timestamp: now };
  }

  // 2.5 self-learn 自适应（场景×难度）—— 无规则命中时，用学到的"最适合模型"
  if (selfLearn && config.selfLearn.enabled && config.difficulty.enabled) {
    const { difficulty, scenario } = analyzeTask(features, config.difficulty.lowThreshold, config.difficulty.highThreshold);
    const learned = selfLearn.best(scenario, difficulty);
    if (learned && usable(learned)) {
      // churn：若切走丢缓存超阈值且当前模型健康，倾向保持
      if (shouldKeepForChurn(learned) && !currentDead) {
        const loss = estimateChurn(current, learned, cacheManager, sid, prompt);
        return { selector: current, reason: `selfLearn→${learned} but churn≈${loss}tok; keep ${current}`, ruleId: undefined, source: "keep", timestamp: now };
      }
      return { selector: learned, reason: `selfLearn[${scenario}/${difficulty}] → ${learned}${churnNote(learned)}`, ruleId: undefined, source: "default", timestamp: now };
    }
    // 无 self-learn 命中时，低/中难度默认回落到便宜模型（兜底在步骤 6/6.5）
  }

  // 3. 学习偏好（learn）—— 在粘滞之前，minSamples 门槛
  if (learning && config.learn.enabled) {
    const learned = learning.preferred(features.taskType, config.learn);
    if (learned && usable(learned)) {
      // churn：若切走会丢缓存且超过阈值，倾向保持当前（保缓存）；当前已死则必须切
      if (shouldKeepForChurn(learned) && !currentDead) {
        const loss = estimateChurn(current, learned, cacheManager, sid, prompt);
        return { selector: current, reason: `learn→${learned} but churn≈${loss}tok > ${config.churn.maxChurnTokens}; keep ${current} (cache)`, ruleId: undefined, source: "keep", timestamp: now };
      }
      return { selector: learned, reason: `learn[${features.taskType}] → ${learned}${churnNote(learned)}`, ruleId: undefined, source: "default", timestamp: now };
    }
  }

  // 4. 粘滞优先（同 taskType 连续轮次）—— 在 default 之前检查
  if (cacheManager && sid && config.cache?.enabled && config.cache?.sticky) {
    const stickySel = cacheManager.stickyPreferred(features.taskType, config);
    if (usable(stickySel)) {
      return { selector: stickySel, reason: `sticky ${features.taskType} → ${stickySel} (cache)`, ruleId: undefined, source: "default", timestamp: now };
    }
  }

  // 5. 默认模型（同样受 usable() 门禁约束，不可用则走 fallback 链）
  if (config.defaultModel) {
    const def = config.defaultModel.trim();
    if (usable(def)) {
      return { selector: def, reason: `default → ${def}`, ruleId: undefined, source: "default", timestamp: now };
    }
    const alt = fallbackAvailable(config, cooldowns, availableModels, cacheManager, sid, prompt, probe);
    if (alt) {
      return { selector: alt, reason: `default "${def}" ${unusableWhy(def)} → fallback "${alt}"`, ruleId: undefined, source: "cooldown-avoid", timestamp: now };
    }
  }

  // 6. fallback 链兜底（缓存感知排序）
  {
    let plan = createExecutionPlan({ primary: config.defaultModel, fallback: config.fallback });
    // 对 fallback 链做缓存排序
    if (cacheManager && sid && prompt && config.cache?.enabled && config.cache?.preferCache && plan.attempts.length > 1) {
      const selectors = plan.attempts.map((a) => a.selector).filter((s): s is string => Boolean(s));
      const ranked = cacheManager.rankCandidates(selectors, sid, prompt, config);
      // 重排 attempts 按 ranked 顺序
      const rankIndex = new Map(ranked.map((s, i) => [s.toLowerCase(), i]));
      plan = {
        ...plan,
        attempts: [...plan.attempts].sort((a, b) => {
          const ai = a.selector ? (rankIndex.get(a.selector.toLowerCase()) ?? 999) : 999;
          const bi = b.selector ? (rankIndex.get(b.selector.toLowerCase()) ?? 999) : 999;
          return ai - bi;
        }),
      };
    }
    // 逐个尝试判定可用性：旧实现只取"第一个未冷却"的再单独判 probe，
    // 首个被 probe 排除时整条链就被放弃（链中后续健康模型漏选）
    const avail = pickAvailableModel(plan, cooldowns, (s) => isAvailable(s, availableModels) && probeOk(s));
    if (avail) {
      return { selector: avail, reason: `fallback chain → ${avail}${churnNote(avail)}`, ruleId: undefined, source: "default", timestamp: now };
    }
  }

  // 6.5 池内兜底扫描：default + fallback 链全灭，但池内还有健康模型（用户配置的链往往远小于池）
  {
    const swept = poolSweep();
    if (swept) {
      return { selector: swept, reason: `default/fallback exhausted → pool sweep "${swept}"${churnNote(swept)}`, ruleId: undefined, source: "pool-sweep", timestamp: now };
    }
  }

  // 6.6 全灭赦免：池内一个可用的都没有 → 解除最先恢复者的排除，强行推进而不是停摆
  {
    const pardon = amnesty();
    if (pardon) {
      return { selector: pardon.selector, reason: `pool exhausted → pardoned "${pardon.selector}" (was recovering in ${Math.round(pardon.waitMs / 1000)}s)`, ruleId: undefined, source: "amnesty", timestamp: now };
    }
  }

  // 7. 保持当前（仅在当前健康、或确实无任何候选时到达）
  if (currentDead) {
    return { selector: undefined, reason: `current "${current}" unusable and no candidate in pool`, ruleId: undefined, source: "keep", timestamp: now };
  }
  return { selector: undefined, reason: "keep current (no routing decision)", ruleId: undefined, source: "keep", timestamp: now };
}
