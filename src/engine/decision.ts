/**
 * 决策引擎（PolicyEngine 语义）
 *
 * 优先级：显式指定 > 冷却规避 > 规则 > defaultModel > 保持当前
 * 提炼自 CCR 的多策略优先级 + fallback 链。
 */
import type { NormalizedRouterConfig, RouteDecision, TaskFeatures } from "../types.ts";
import { CooldownSet } from "./registry.ts";
import { pickAvailableModel, createExecutionPlan } from "./planner.ts";
import { type CompiledRule, matchFirstRule } from "./rules.ts";
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
): string | undefined {
  const fallback = config.fallback;
  if (!fallback || fallback.mode === "off") return undefined;
  let chain = (fallback.models ?? []).filter((m) => isAvailable(m, available) && !cooldowns.isCooldown(m));
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
  const { features, config, compiledRules, cooldowns, availableModels, cacheManager, learning, selfLearn, probe, sessionId, promptText } = input;
  const now = Date.now();
  const prompt = promptText ?? features.promptText ?? "";
  const sid = sessionId ?? "";
  const current = features.currentModel;

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

  // 1. 显式指定：强制，不做冷却规避与规则
  if (features.explicitModel) {
    const sel = features.explicitModel.trim();
    if (isAvailable(sel, availableModels)) {
      return { selector: sel, reason: `explicit @${config.explicitModelPrefix}${sel}`, ruleId: undefined, source: "explicit", timestamp: now };
    }
    return { selector: undefined, reason: `explicit model "${sel}" not available`, ruleId: undefined, source: "explicit", timestamp: now };
  }

  // 1.5 粘滞优化：同 taskType 连续轮次保持同一模型以保缓存（仅当无高优规则且非显式时）
  if (cacheManager && sid && config.cache?.enabled && config.cache?.sticky) {
    const stickySel = cacheManager.stickyPreferred(features.taskType, config);
    if (stickySel && isAvailable(stickySel, availableModels) && !cooldowns.isCooldown(stickySel)) {
      // 粘滞仅在“无规则命中或规则优先级低”时生效；这里先记录，规则命中后仍优先规则
      // 若后续无规则命中，粘滞将作为 default 候选
    }
  }

  // 2. 规则命中
  const matched = matchFirstRule(compiledRules, features);
  if (matched) {
    const desired = matched.model.trim();
    const isCacheAware = matched.cacheAware !== false;
    // 若命中模型在冷却，尝试 fallback 链（缓存感知排序）
    if (cooldowns.isCooldown(desired)) {
      const alt = fallbackAvailable(config, cooldowns, availableModels, isCacheAware ? cacheManager : undefined, sid, prompt);
      if (alt) {
        return { selector: alt, reason: `rule "${matched.id}" hit but "${desired}" cooling → fallback "${alt}"`, ruleId: matched.id, source: "cooldown-avoid", timestamp: now };
      }
      // 冷却但无 fallback 可用，仍返回原命中并由调用方决定是否保持当前
      if (isAvailable(desired, availableModels)) {
        return { selector: desired, reason: `rule "${matched.id}" hit → "${desired}" (cooling, no fallback)`, ruleId: matched.id, source: "rule", timestamp: now, thinkingLevel: matched.thinkingLevel };
      }
      return { selector: undefined, reason: `rule "${matched.id}" hit but model "${desired}" unavailable/cooling`, ruleId: matched.id, source: "rule", timestamp: now };
    }

    if (isAvailable(desired, availableModels)) {
      // 规则命中：尊重规则（即便 churn 大，规则优先）；reason 标注 churn；带 thinkingLevel
      return { selector: desired, reason: `rule "${matched.id}" → ${desired}${churnNote(desired)}`, ruleId: matched.id, source: "rule", timestamp: now, thinkingLevel: matched.thinkingLevel };
    }
    // 规则命中但模型不可用 → 尝试 fallback（缓存感知）
    const alt = fallbackAvailable(config, cooldowns, availableModels, isCacheAware ? cacheManager : undefined, sid, prompt);
    if (alt) {
      return { selector: alt, reason: `rule "${matched.id}" model "${desired}" unavailable → fallback "${alt}"`, ruleId: matched.id, source: "cooldown-avoid", timestamp: now };
    }
    return { selector: undefined, reason: `rule "${matched.id}" model "${desired}" unavailable`, ruleId: matched.id, source: "rule", timestamp: now };
  }

  // 2.5 self-learn 自适应（场景×难度）—— 无规则命中时，用学到的"最适合模型"
  if (selfLearn && config.selfLearn.enabled && config.difficulty.enabled) {
    const { difficulty, scenario } = analyzeTask(features, config.difficulty.lowThreshold, config.difficulty.highThreshold);
    const learned = selfLearn.best(scenario, difficulty);
    if (learned && isAvailable(learned, availableModels) && !cooldowns.isCooldown(learned)) {
      const probeOk = probe ? probe.getAvailability(learned) !== "unavailable" : true;
      if (probeOk) {
        // churn：若切走丢缓存超阈值，倾向保持
        if (shouldKeepForChurn(learned) && current) {
          const loss = estimateChurn(current, learned, cacheManager, sid, prompt);
          return { selector: current, reason: `selfLearn→${learned} but churn≈${loss}tok; keep ${current}`, ruleId: undefined, source: "keep", timestamp: now };
        }
        return { selector: learned, reason: `selfLearn[${scenario}/${difficulty}] → ${learned}${churnNote(learned)}`, ruleId: undefined, source: "default", timestamp: now };
      }
    }
    // 无 self-learn 命中时，低/中难度默认回落到便宜模型（fallback 链兜底在步骤 6）
  }

  // 3. 学习偏好（learn）—— 在粘滞之前，minSamples 门槛
  if (learning && config.learn.enabled) {
    const learned = learning.preferred(features.taskType, config.learn);
    if (learned && isAvailable(learned, availableModels) && !cooldowns.isCooldown(learned)) {
      // churn：若切走会丢缓存且超过阈值，倾向保持当前（保缓存）
      if (shouldKeepForChurn(learned) && current) {
        const loss = estimateChurn(current, learned, cacheManager, sid, prompt);
        return { selector: current, reason: `learn→${learned} but churn≈${loss}tok > ${config.churn.maxChurnTokens}; keep ${current} (cache)`, ruleId: undefined, source: "keep", timestamp: now };
      }
      return { selector: learned, reason: `learn[${features.taskType}] → ${learned}${churnNote(learned)}`, ruleId: undefined, source: "default", timestamp: now };
    }
  }

  // 4. 粘滞优先（同 taskType 连续轮次）—— 在 default 之前检查
  if (cacheManager && sid && config.cache?.enabled && config.cache?.sticky) {
    const stickySel = cacheManager.stickyPreferred(features.taskType, config);
    if (stickySel && isAvailable(stickySel, availableModels) && !cooldowns.isCooldown(stickySel)) {
      return { selector: stickySel, reason: `sticky ${features.taskType} → ${stickySel} (cache)`, ruleId: undefined, source: "default", timestamp: now };
    }
  }

  // 5. 默认模型（也受冷却 + 可用性约束，fallback 缓存感知）
  if (config.defaultModel) {
    const def = config.defaultModel.trim();
    if (isAvailable(def, availableModels) && !cooldowns.isCooldown(def)) {
      return { selector: def, reason: `default → ${def}`, ruleId: undefined, source: "default", timestamp: now };
    }
    if (cooldowns.isCooldown(def)) {
      const alt = fallbackAvailable(config, cooldowns, availableModels, cacheManager, sid, prompt);
      if (alt) return { selector: alt, reason: `default "${def}" cooling → fallback "${alt}"`, ruleId: undefined, source: "cooldown-avoid", timestamp: now };
    }
    if (!isAvailable(def, availableModels)) {
      const alt = fallbackAvailable(config, cooldowns, availableModels, cacheManager, sid, prompt);
      if (alt) return { selector: alt, reason: `default "${def}" unavailable → fallback "${alt}"`, ruleId: undefined, source: "cooldown-avoid", timestamp: now };
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
    const avail = pickAvailableModel(plan, cooldowns);
    if (avail && isAvailable(avail, availableModels)) {
      return { selector: avail, reason: `fallback chain → ${avail}`, ruleId: undefined, source: "default", timestamp: now };
    }
  }

  // 7. 保持当前
  return { selector: undefined, reason: "keep current (no routing decision)", ruleId: undefined, source: "keep", timestamp: now };
}
