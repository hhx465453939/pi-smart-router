/**
 * pi-smart-router — extension entry
 *
 * 智能模型路由：根据任务特征自动选择模型，支持规则、fallback 链、失败冷却、缓存感知。
 * 逻辑提炼自 claude-code-router 的路由决策引擎，原生运行于 pi 的事件生命周期。
 * 核心特色：缓存感知的路由（Cache-Aware Routing）—— 多跳转运中保留 session 前缀缓存。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DecisionRecord, NormalizedRouterConfig } from "./types.ts";
import { loadConfig, createConfigWatcher, persistEnabled, persistPool, persistPoolPreset, removePoolPreset, renamePoolPreset, applyPoolPreset, filterByPool, type ConfigWatcher } from "./config.ts";
import { CooldownSet } from "./engine/registry.ts";
import { CacheManager } from "./engine/cache.ts";
import { LearningManager } from "./engine/learn.ts";
import { compileRules, type CompiledRule } from "./engine/rules.ts";
import { resolveTurnDecision } from "./hooks/agent.ts";
import { resolveProviderDecision } from "./hooks/provider.ts";
import { onProviderResponse, onToolResult, isQuotaExceeded } from "./hooks/failure.ts";
import { formatRules, formatStatus } from "./commands/router.ts";
import { PoolPickerComponent, NamePromptComponent, PresetPickerComponent, type PoolItem, type PickerTheme } from "./tui/multipick.ts";
import { buildRouterTool } from "./tool/router.ts";
import { classifyTaskType } from "./context/task.ts";
import { ModelCatalog } from "./catalog/catalog.ts";
import { SelfLearnManager } from "./engine/selflearn.ts";
import { AvailabilityProbe } from "./probe/availability.ts";
import { analyzeTask } from "./engine/difficulty.ts";
import { profileModel, rankModels, valueScore, type ModelProfile, type RegistryModel } from "./engine/profile.ts";
import type { Difficulty } from "./types.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  let watcher: ConfigWatcher | null = null;
  let compiledRules: CompiledRule[] = [];
  let cooldowns = new CooldownSet();
  let cacheManager = new CacheManager();
  let learning = new LearningManager();
  let catalog: ModelCatalog | null = null;
  let selfLearn: SelfLearnManager | null = null;
  let probe: AvailabilityProbe | null = null;
  let profiles: ModelProfile[] = [];
  let history: DecisionRecord[] = [];
  let turnIndex = 0;
  let lastPromptText = "";
  let lastTaskType = "general";
  let lastHandoffs: Array<{ from: string; to: string; reason: string; ts: number }> = [];

  const DECISION_ENTRY = "pi-smart-router-decision";
  const CACHE_ENTRY = "pi-smart-router-cache";
  const LEARN_ENTRY = "pi-smart-router-learn";
  const MAX_HISTORY = 50;

  function classifyGuess(prompt: string): string {
    try {
      return classifyTaskType(prompt, watcher?.get()?.taskTypeRules ?? {});
    } catch { return "general"; }
  }

  function currentSelector(ctx: ExtensionContext): string | undefined {
    const m: unknown = (ctx as unknown as Record<string, unknown>).model;
    if (m && typeof m === "object") {
      const mm = m as { provider?: string; id?: string };
      if (mm.provider && mm.id) return `${mm.provider}/${mm.id}`;
    }
    return undefined;
  }

  function sessionIdOf(ctx: ExtensionContext): string {
    try {
      const sm = (ctx as unknown as { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string } }).sessionManager;
      return sm?.getSessionId?.() ?? sm?.getSessionFile?.() ?? "default";
    } catch { return "default"; }
  }

  function availableSelectors(ctx: ExtensionContext): Set<string> {
    const s = new Set<string>();
    try {
      const reg: unknown = (ctx as unknown as Record<string, unknown>).modelRegistry;
      const r = reg as { getAvailable?: () => Array<{ provider: string; id: string }>; getAvailableSnapshot?: () => Array<{ provider: string; id: string }> };
      const list = r.getAvailableSnapshot?.() ?? r.getAvailable?.() ?? [];
      for (const m of list as Array<{ provider: string; id: string }>) {
        if (m?.provider && m?.id) s.add(`${m.provider}/${m.id}`);
      }
    } catch { /* ignore */ }
    return s;
  }

  /** 当前生效的模型池（热加载后） */
  function cfgPool(ctx: ExtensionContext): string[] {
    return (watcher?.get() ?? loadConfig(ctx.cwd)).pool ?? [];
  }

  /** 从 modelRegistry 提取目录信息（seed catalog + 探测目标） */
  function registryInfos(ctx: ExtensionContext): Array<{ selector: string; provider: string; baseUrl?: string; contextWindow?: number; cost?: { input: number; output: number; cacheRead: number }; input?: string[] }> {
    const out: Array<{ selector: string; provider: string; baseUrl?: string; contextWindow?: number; cost?: { input: number; output: number; cacheRead: number }; input?: string[] }> = [];
    try {
      const reg: unknown = (ctx as unknown as Record<string, unknown>).modelRegistry;
      const r = reg as { getAvailableSnapshot?: () => Array<Record<string, unknown>>; getAvailable?: () => Array<Record<string, unknown>> };
      const list = r.getAvailableSnapshot?.() ?? r.getAvailable?.() ?? [];
      for (const m of list as Array<Record<string, unknown>>) {
        const provider = String(m.provider ?? "");
        const id = String(m.id ?? "");
        if (!provider || !id) continue;
        const baseUrl = typeof m.baseUrl === "string" ? m.baseUrl : undefined;
        const contextWindow = typeof m.contextWindow === "number" ? m.contextWindow : undefined;
        const costRaw = m.cost as { input?: number; output?: number; cacheRead?: number } | undefined;
        const cost = costRaw && typeof costRaw === "object"
          ? { input: costRaw.input ?? 0, output: costRaw.output ?? 0, cacheRead: costRaw.cacheRead ?? 0 }
          : undefined;
        const input = Array.isArray(m.input) ? (m.input as string[]) : undefined;
        out.push({ selector: `${provider}/${id}`, provider, baseUrl, contextWindow, cost, input });
      }
    } catch { /* ignore */ }
    return out;
  }

  /** 找 provider baseUrl（探测用，不含 key） */
  function providerBaseUrl(ctx: ExtensionContext, provider: string): string | undefined {
    try {
      const reg: unknown = (ctx as unknown as Record<string, unknown>).modelRegistry;
      const r = reg as { getProvider?: (p: string) => { baseUrl?: string } | undefined };
      return r.getProvider?.(provider)?.baseUrl;
    } catch { return undefined; }
  }

  // 无痛切换：按当前场景/难度 rank 逐个试下一个可用模型，直至成功
  const recentFallbackTries = new Map<string, number>();
  const rateLimit429Count = new Map<string, number>();
  /** 归一化 model id 到家族基准：去 provider 前缀、小写、去 [1m]/-0731 等变体后缀，使跨供应商同款可匹配 */
  function normalizeModelBase(id: string): string {
    return id
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, "")          // [1m] [256k] 等
      .replace(/-\d{3,4}(?=$|-)/g, "")      // -0731 / -0813 日期后缀
      .replace(/[-_]+$/g, "")
      .trim();
  }
  async function tryImmediateFallback(failedSelector: string, ctx: ExtensionContext, reason: string): Promise<boolean> {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    // 模型池硬边界：秒切候选只在池内
    const available = new Set(filterByPool(availableSelectors(ctx), cfg.pool));
    const filtered = probe ? new Set(probe.filterAvailable([...available])) : available;
    // 已排除失败者，候选为 filtered 中未冷却的
    const candidates = [...filtered].filter((s) => !cooldowns.isCooldown(s));
    if (candidates.length === 0) {
      ctx.ui.notify(`router: 无可用模型可 fallback（${failedSelector} 失败: ${reason}）`, "error");
      return false;
    }
    // 按当前场景/难度 rank 排序候选
    let ranked = candidates;
    if (cfg.difficulty.enabled && profiles.length) {
      const { difficulty } = analyzeTask(
        { taskType: lastTaskType as never, toolNames: [], contextTokens: contextTokens(ctx), messageCount: messageCount(ctx), turnIndex, promptLength: lastPromptText.length, hasImage: false, explicitModel: undefined, currentModel: failedSelector, thinkingLevel: undefined, promptText: lastPromptText },
        cfg.difficulty.lowThreshold,
        cfg.difficulty.highThreshold,
      );
      const scenario = (() => { try { return analyzeTask({ taskType: lastTaskType as never, toolNames: [], contextTokens: undefined, messageCount: 0, turnIndex, promptLength: 0, hasImage: false, explicitModel: undefined, currentModel: failedSelector, thinkingLevel: undefined, promptText: lastPromptText }, cfg.difficulty.lowThreshold, cfg.difficulty.highThreshold).scenario; } catch { return "general" as const; } })();
      ranked = rankModels(
        profiles.filter((p) => candidates.includes(p.selector)),
        difficulty,
        (sel) => catalog?.get(sel)?.learnScore[`${scenario}×${difficulty}`] ?? 0,
      ).map((p) => p.selector);
      // 若 rank 为空，回退到原 candidates 顺序
      if (ranked.length === 0) ranked = candidates;
    }
    // 防循环：同 prompt 短时间内最多 3 次
    const promptHash = `${lastPromptText.slice(0, 200)}::${failedSelector}`;
    const tries = recentFallbackTries.get(promptHash) ?? 0;
    if (tries >= 3) {
      ctx.ui.notify(`router: 已尝试 3 次仍失败，暂停自动切换`, "warning");
      return false;
    }
    recentFallbackTries.set(promptHash, tries + 1);
    setTimeout(() => recentFallbackTries.delete(promptHash), 60_000);
    const next = (() => {
      // 同类模型优先（用户核心需求："秒切其他供应商的同类模型"）——
      // volces/dsv4-flash[1m] 耗尽 → 优先 opencode/deepseek-v4-flash / shudie 同款，而非仅凭性价比选 minimax
      const failedBase = normalizeModelBase(failedSelector.split("/").slice(1).join("/"));
      const sameFamily = ranked.filter((s) => {
        if (s.toLowerCase() === failedSelector.toLowerCase()) return false;
        return normalizeModelBase(s.split("/").slice(1).join("/")) === failedBase;
      });
      if (sameFamily.length > 0) return sameFamily[0];
      return ranked.find((s) => s.toLowerCase() !== failedSelector.toLowerCase());
    })();
    if (!next) {
      ctx.ui.notify(`router: 无其他可用模型可切（${failedSelector} 已排除）`, "warning");
      return false;
    }
    // 切换模型并静默重试本轮 prompt
    // pi.setModel 期望 model 对象（内部 checkAuth(model.provider)），字符串会失败；
    // 先用 modelRegistry.find 解析为对象，失败再试字符串兼容。
    try {
      let ok = false;
      try {
        const reg = (ctx as unknown as { modelRegistry?: { find?: (p: string, id: string) => unknown } }).modelRegistry;
        const [p, ...rest] = next.split("/");
        const modelObj = reg?.find?.(p, rest.join("/"));
        if (modelObj) ok = (await pi.setModel(modelObj as never)) !== false;
      } catch { /* 尝试字符串兼容 */ }
      if (!ok) ok = (await pi.setModel(next as never)) !== false;
      if (!ok) {
        ctx.ui.notify(`router: 切换到 ${next} 失败（无权限或找不到）`, "warning");
        return false;
      }
      ctx.ui.notify(`⚡ router: ${failedSelector} 不可用 → 已秒切 ${next} 并重试`, "info");
      // 静默重试：用 followUp 触发新 turn，重试原始 prompt
      try { pi.sendUserMessage(lastPromptText, { deliverAs: "followUp" } as never); } catch { /* ignore */ }
      return true;
    } catch (e) {
      ctx.ui.notify(`router: 切换失败 ${String(e).slice(0, 100)}`, "error");
      return false;
    }
  }

  /** auto-profiling：遍历全部已注册模型，生成画像（含未在 available 的） */
  /** 读取 pi models-store.json 作为真实 cost 补充源（运行时快照可能缺 cost） */
  function storeCosts(): Map<string, { input: number; output: number; cacheRead: number }> {
    const out = new Map<string, { input: number; output: number; cacheRead: number }>();
    try {
      const f = join(homedir(), ".pi/agent/models-store.json");
      if (!existsSync(f)) return out;
      const d = JSON.parse(readFileSync(f, "utf8")) as Record<string, { models?: Array<Record<string, unknown>> }>;
      for (const [prov, v] of Object.entries(d)) {
        if (!v?.models) continue;
        for (const m of v.models) {
          const id = String(m.id ?? "");
          const c = m.cost as { input?: number; output?: number; cacheRead?: number } | undefined;
          if (!id || !c || typeof c.input !== "number") continue;
          out.set(`${prov}/${id}`, { input: c.input, output: c.output ?? 0, cacheRead: c.cacheRead ?? 0 });
        }
      }
    } catch { /* ignore */ }
    return out;
  }

  function registryProfiles(ctx: ExtensionContext): { profiles: ModelProfile[]; targets: Array<{ selector: string; provider: string; baseUrl?: string }> } {
    const profiles: ModelProfile[] = [];
    const targets: Array<{ selector: string; provider: string; baseUrl?: string }> = [];
    const costs = storeCosts();
    try {
      // 只对"实际可用"的模型做画像（getAvailableSnapshot = 有 auth 的），
      // 避免 pi 内置全球目录（amazon/azure/cloudflare 等未接入 provider）混入 rank
      const reg: unknown = (ctx as unknown as Record<string, unknown>).modelRegistry;
      const r = reg as { getAvailableSnapshot?: () => RegistryModel[]; getAll?: () => RegistryModel[]; getAvailable?: () => RegistryModel[] };
      const all = r.getAvailableSnapshot?.() ?? r.getAvailable?.() ?? r.getAll?.() ?? [];
      for (const m of all) {
        if (!m?.provider || !m?.id) continue;
        // 运行时快照缺 cost 时，用 models-store 真实定价补充
        const selector = `${m.provider}/${m.id}`;
        const storeCost = costs.get(selector);
        const model: RegistryModel = storeCost
          ? { ...m, cost: { input: storeCost.input, output: storeCost.output, cacheRead: storeCost.cacheRead } }
          : m;
        profiles.push(profileModel(model));
        targets.push({ selector, provider: m.provider, baseUrl: (m as unknown as Record<string, unknown>).baseUrl as string | undefined });
      }
    } catch { /* ignore */ }
    return { profiles, targets };
  }

  function contextTokens(ctx: ExtensionContext): number | undefined {
    try {
      const u = (ctx as unknown as { getContextUsage?: () => { tokens?: number } }).getContextUsage?.();
      return typeof u?.tokens === "number" ? u.tokens : undefined;
    } catch { return undefined; }
  }

  function messageCount(ctx: ExtensionContext): number {
    try {
      const sm = (ctx as unknown as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
      const entries = sm?.getEntries?.() ?? [];
      return entries.length;
    } catch { return 0; }
  }

  function pushDecision(rec: DecisionRecord, ctx?: ExtensionContext) {
    history.push(rec);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    try { pi.appendEntry(DECISION_ENTRY, rec as unknown as Record<string, unknown>); } catch { /* ignore */ }
    // 缓存粘滞记录
    try { cacheManager.recordDecision(rec.taskType, rec.selector ?? ""); } catch { /* ignore */ }
    try {
      if (ctx) {
        const label = `⚡ ${rec.selector ?? "?"} ← ${rec.reason}`;
        (ctx as unknown as { ui?: { setStatus?: (k: string, v: string) => void } }).ui?.setStatus?.("router", label);
      }
    } catch { /* ignore */ }
  }

  // ——— session_start: 加载配置、恢复历史、初始化 catalog/selfLearn/probe、启动后台探测 ———
  pi.on("session_start", async (_event, ctx) => {
    turnIndex = 0;
    try {
      watcher = createConfigWatcher(ctx.cwd);
      const cfg = watcher.get();
      compiledRules = compileRules(cfg.rules).compiled;
      history = [];
      cacheManager = new CacheManager();
      learning = new LearningManager();
      lastHandoffs = [];
      // 初始化模型目录 + self-learn
      catalog = new ModelCatalog(cfg.catalogPath);
      const regInfos = registryInfos(ctx);
      catalog.ensureSeed(regInfos);
      selfLearn = new SelfLearnManager(catalog, cfg.selfLearn);
      // auto-profiling：遍历全部已注册模型生成画像（含未 available 的），顺手采集连通性探测目标
      const { profiles: allProfiles, targets: allTargets } = registryProfiles(ctx);
      profiles = allProfiles;
      // 初始化可用性探测 + 启动后台异步探测（不阻塞，按 provider 去重，覆盖全量模型）
      probe = new AvailabilityProbe({
        config: cfg.probe,
        getBaseUrl: (provider) => providerBaseUrl(ctx, provider),
        log: (m) => { if (cfg.verbose) console.log(m); },
      });
      probe.startByProvider(allTargets, (snap) => {
        const bad = Object.entries(snap).filter(([, v]) => v === "unavailable").map(([k]) => k);
        if (bad.length && cfg.verbose) console.log(`[probe] done: ${bad.length} unreachable models excluded: ${bad.slice(0, 8).join(", ")}...`);
      });
      try {
        const entries = (ctx.sessionManager as unknown as { getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }> }).getEntries?.() ?? [];
        for (const e of entries) {
          if (e.type === "custom" && e.customType === DECISION_ENTRY && e.data) {
            history.push(e.data as DecisionRecord);
          }
          if (e.type === "custom" && e.customType === CACHE_ENTRY && e.data) {
            // 恢复缓存记录（若有）
            const d = e.data as { selector?: string; sessionId?: string; promptHash?: string; commonPrefixChars?: number; cacheRead?: number; cacheWrite?: number; hitRate?: number };
            if (d?.selector && d?.sessionId) {
              cacheManager.recordUsage(d.selector, d.sessionId, "", { cacheRead: d.cacheRead ?? 0, cacheWrite: d.cacheWrite ?? 0 });
            }
          }
        }
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      } catch { /* ignore */ }

      const cur = currentSelector(ctx);
      const status = cfg.enabled ? `enabled (${cfg.routingLevel})` : "disabled";
      const cacheStatus = cfg.cache.enabled ? `cache:on` : `cache:off`;
      const learnStatus = cfg.learn.enabled ? `learn:on` : `learn:off`;
      ctx.ui.setStatus("router", `⚡ ${status} ${cacheStatus} ${learnStatus}${cur ? ` · ${cur}` : ""}`);
      if (cfg.verbose) console.log(`[pi-smart-router] loaded: ${status}, ${cacheStatus}, ${learnStatus}, rules=${cfg.rules.length}, cooldowns=${cooldowns.all().length}`);
    } catch (err) {
      console.error(`[pi-smart-router] session_start error: ${err}`);
    }
  });

  pi.on("session_shutdown", async () => {
    try { cooldowns.clearAll(); } catch { /* ignore */ }
  });

  // ——— before_agent_start: turn 级路由（缓存感知） ———
  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    if (!cfg.enabled || (cfg.routingLevel !== "turn" && cfg.routingLevel !== "both")) return;

    turnIndex += 1;
    const cur = currentSelector(ctx);
    const available = new Set(filterByPool(availableSelectors(ctx), cfg.pool));
    const availableFiltered = probe ? new Set(probe.filterAvailable([...available])) : available;
    const sid = sessionIdOf(ctx);
    const promptText = (event as unknown as { prompt?: string }).prompt ?? "";
    lastPromptText = promptText;
    lastTaskType = (event as unknown as { systemPromptOptions?: { taskType?: string } }).systemPromptOptions?.taskType ?? classifyGuess(promptText);
    // auto-rank：按当前难度把画像好的模型并入候选（让 fallback 层能自动选到，无需手写规则）
    if (cfg.difficulty.enabled && profiles.length) {
      const { difficulty } = analyzeTask(
        { taskType: lastTaskType as never, toolNames: [], contextTokens: contextTokens(ctx), messageCount: messageCount(ctx), turnIndex, promptLength: promptText.length, hasImage: false, explicitModel: undefined, currentModel: cur, thinkingLevel: undefined, promptText },
        cfg.difficulty.lowThreshold,
        cfg.difficulty.highThreshold,
      );
      const ranked = rankModels(profiles, difficulty, (sel) => {
        const rec = catalog?.get(sel);
        if (!rec) return 0;
        const k = `${lastTaskType}×${difficulty}`;
        return rec.learnScore[k] ?? 0;
      });
      // 并入前 8 名画像候选（与 available 求并集），不通的模型已在后台探测排除；模型池外不入候选
      const poolOk = (sel: string): boolean => !cfg.pool?.length || cfg.pool.some((p) => p.toLowerCase() === sel.toLowerCase());
      for (const p of ranked.slice(0, 8)) {
        if (probe && probe.getAvailability(p.selector) === "unavailable") continue;
        if (!poolOk(p.selector)) continue;
        availableFiltered.add(p.selector);
      }
    }

    const rec = resolveTurnDecision({
      prompt: promptText,
      images: (event as unknown as { images?: unknown[] }).images as unknown[] | undefined,
      systemPromptOptions: (event as unknown as { systemPromptOptions?: { selectedTools?: string[] } }).systemPromptOptions as { selectedTools?: string[] } | undefined,
      currentModelSelector: cur,
      thinkingLevel: (ctx as unknown as { thinkingLevel?: string }).thinkingLevel,
      messageCount: messageCount(ctx),
      turnIndex,
      contextTokens: contextTokens(ctx),
      availableModels: availableFiltered,
      deps: {
        config: cfg,
        compiledRules,
        cooldowns,
        cacheManager,
        learning,
        selfLearn: selfLearn ?? undefined,
        probe: probe ?? undefined,
        sessionId: sid,
        pushDecision: (r) => pushDecision(r, ctx),
        setStatus: (t) => ctx.ui.setStatus("router", t),
        verboseLog: (m) => { if (cfg.verbose) console.log(m); },
      },
    });

    if (!rec || !rec.selector) return;

    if (cur && rec.selector.toLowerCase() === cur.toLowerCase()) {
      if (cfg.verbose) console.log(`[pi-smart-router] keep ${cur} (${rec.reason}) [cache:hit]`);
      pushDecision(rec, ctx);
      return;
    }

    try {
      const reg = (ctx as unknown as { modelRegistry?: { find?: (p: string, id: string) => unknown } }).modelRegistry;
      const parsed = rec.selector.includes("/") ? rec.selector.split("/") : [undefined, rec.selector];
      const provider = parsed[0];
      const modelId = parsed.slice(1).join("/");
      const modelObj = provider ? reg?.find?.(provider, modelId) : undefined;
      let target: unknown = modelObj;
      if (!target) {
        const avail = [...available];
        for (const sel of avail) {
          const [p, ...rest] = sel.split("/");
          const id = rest.join("/");
          if (id.toLowerCase() === rec.selector.toLowerCase() || sel.toLowerCase() === rec.selector.toLowerCase()) {
            target = reg?.find?.(p, id);
            if (target) break;
          }
        }
      }
      if (!target) {
        console.warn(`[pi-smart-router] model not found: ${rec.selector} — keep ${cur ?? "(none)"}`);
        return;
      }
      const ok = await pi.setModel(target as never);
      if (!ok) {
        console.warn(`[pi-smart-router] setModel failed (no auth): ${rec.selector}`);
        return;
      }
      // 应用规则建议的思考级别（若带）
      if (rec.thinkingLevel) {
        try { pi.setThinkingLevel(rec.thinkingLevel); } catch (err) { console.warn(`[pi-smart-router] setThinkingLevel failed: ${err}`); }
      }
      pushDecision(rec, ctx);
      if (cfg.verbose) ctx.ui.notify(`⚡ router: ${cur ?? "?"} → ${rec.selector} — ${rec.reason}`, "info");
    } catch (err) {
      console.error(`[pi-smart-router] setModel error: ${err}`);
    }
  });

  // ——— before_provider_request: request 级路由（保留缓存字段） ———
  pi.on("before_provider_request", (event, ctx) => {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    if (!cfg.enabled || (cfg.routingLevel !== "request" && cfg.routingLevel !== "both")) return;

    const cur = currentSelector(ctx);
    const available = new Set(filterByPool(availableSelectors(ctx), cfg.pool));
    const sid = sessionIdOf(ctx);
    const res = resolveProviderDecision({
      payload: event.payload as Record<string, unknown>,
      currentModelSelector: cur,
      thinkingLevel: (ctx as unknown as { thinkingLevel?: string }).thinkingLevel,
      messageCount: messageCount(ctx),
      turnIndex,
      contextTokens: contextTokens(ctx),
      availableModels: probe ? new Set(probe.filterAvailable([...available])) : available,
      deps: { config: cfg, compiledRules, cooldowns, cacheManager, learning, selfLearn: selfLearn ?? undefined, probe: probe ?? undefined, sessionId: sid },
    });

    if (!res) return;

    const currentPayloadModel = typeof (event.payload as Record<string, unknown>).model === "string"
      ? String((event.payload as Record<string, unknown>).model)
      : undefined;
    if (currentPayloadModel && res.selector.toLowerCase() === currentPayloadModel.toLowerCase()) return;

    pushDecision(res.record, ctx);
    if (cfg.verbose) console.log(`[pi-smart-router] payload model: ${currentPayloadModel ?? "?"} → ${res.selector} (${res.record.reason}) [cache:preserved]`);
    // 关键：仅覆盖 model，保留所有缓存相关字段（sessionId, cacheRetention, prompt_cache_key, cache_control 等）
    const next = { ...(event.payload as Record<string, unknown>), model: res.selector } as unknown as typeof event.payload;
    return next;
  });

  // ——— after_provider_response: 失败冷却 + 学习失败记录 ———
  pi.on("after_provider_response", (event, ctx) => {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    onProviderResponse(
      { status: event.status, headers: event.headers as Record<string, string> | undefined },
      {
        config: cfg,
        cooldowns,
        currentModelSelector: () => currentSelector(ctx),
        notify: (msg, level) => ctx.ui.notify(msg, level ?? "warning"),
        log: (msg) => { if (cfg.verbose) console.log(msg); },
      },
    );
    // 学习：失败状态码 → 该 taskType 该模型降权
    if (cfg.learn.enabled && (event.status === 429 || event.status >= 500)) {
      const sel = currentSelector(ctx);
      if (sel) {
        const taskType = lastTaskType ?? "general";
        learning.recordFailure(taskType, sel, cfg.learn);
        try { pi.appendEntry(LEARN_ENTRY, { taskType, selector: sel, success: false, timestamp: Date.now() } as never); } catch { /* ignore */ }
      }
    }
    // 可用性：401/402/403 → 套餐失效/欠费，标记本 session 不可用 + 无痛秒切
    if (cfg.probe.enabled && (event.status === 401 || event.status === 402 || event.status === 403)) {
      const sel = currentSelector(ctx);
      if (sel && probe) {
        probe.markAuthFailure(sel);
        ctx.ui.notify(`⚡ router: ${sel} auth failed (HTTP ${event.status}) — excluded this session`, "warning");
        void tryImmediateFallback(sel, ctx, `HTTP ${event.status}`);
      }
    }
    // 可用性：连续 429 → 判定额度耗尽/严重限流，标 unavailable + 长冷却 + 无痛秒切（换供应商同类模型）
    if (cfg.probe.enabled && event.status === 429) {
      const sel = currentSelector(ctx);
      if (sel && probe) {
        const n = (rateLimit429Count.get(sel) ?? 0) + 1;
        rateLimit429Count.set(sel, n);
        // 同一模型连续 2 次 429（pi 内部 retry 也会触发多次）→ 视为额度耗尽而非瞬时限流
        if (n >= 2) {
          probe.markAuthFailure(sel);
          cooldowns.add(sel, 60 * 60 * 1000, `429×${n} quota/rate exhausted`);
          ctx.ui.notify(`⚡ router: ${sel} 连续 ${n} 次 429 — 本 session 排除，秒切其他供应商`, "warning");
          rateLimit429Count.delete(sel);
          void tryImmediateFallback(sel, ctx, "429 rate/quota exhausted");
        } else {
          // 首次 429：短暂标记 uncertain 防立即重选，60s 后自动清除
          setTimeout(() => rateLimit429Count.delete(sel), 60_000);
        }
      }
    }
    // self-learn 失败记录
    if (selfLearn && cfg.selfLearn.enabled && (event.status === 429 || event.status >= 500)) {
      const sel = currentSelector(ctx);
      if (sel) {
        const { scenario, difficulty } = analyzeTask(
          { taskType: lastTaskType as never, toolNames: [], contextTokens: undefined, messageCount: 0, turnIndex, promptLength: 0, hasImage: false, explicitModel: undefined, currentModel: sel, thinkingLevel: undefined, promptText: lastPromptText },
          cfg.difficulty.lowThreshold,
          cfg.difficulty.highThreshold,
        );
        selfLearn.record({ selector: sel, scenario, difficulty, success: false, cost: 0, cacheRead: 0, timestamp: Date.now() });
      }
    }
  });

  // ——— message_end: 回填缓存 usage（核心特色）+ 学习成功记录 + API 错误检测（真正可靠的 429/401 捕获点）———
  // 根因：openai-completions 等 API 的 429 重试在 SDK 客户端层(retryProviderRequest)内部完成，
  // 3 次都失败后 throw，onResponse/after_provider_response 根本不触发；
  // 错误最终以 assistant message(stopReason=error, errorMessage) 的形式到达 message_end。
  pi.on("message_end", async (event, ctx) => {
    try {
      const msg = (event as unknown as { message?: { role?: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string; usage?: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number; cost?: { total?: number } } } }).message;
      if (!msg || msg.role !== "assistant") return;
      // — API 错误检测：429 quota / 401/402/403 套餐失效 → 无痛秒切 —
      if (msg.stopReason === "error" && msg.errorMessage) {
        const errText = msg.errorMessage;
        const cfg0 = watcher?.get() ?? loadConfig(ctx.cwd);
        // 出错模型的 selector：优先从错误 message 的 provider/model 字段取（pi 重试后 ctx.model 可能已非请求模型）
        const errSel = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : currentSelector(ctx);
        const isAuth = /\b(401|402|403)\b|unauthorized|forbidden|payment/i.test(errText);
        const isQuota = /AccountQuotaExceeded|quota.*exceeded|exceeded.*quota/i.test(errText);
        const is429 = /\b429\b|TooManyRequests|rate.?limit/i.test(errText);
        if (errSel && cfg0.enabled && (isAuth || isQuota || is429)) {
          if (probe) probe.markAuthFailure(errSel);
          cooldowns.add(errSel, isQuota || isAuth ? 60 * 60 * 1000 : 10 * 60 * 1000, `api_error: ${errText.slice(0, 80)}`);
          ctx.ui.notify(`⚡ router: ${errSel} API 失败（${isQuota ? "额度耗尽" : isAuth ? "套餐失效" : "429 限流"}）— 本 session 排除，秒切其他供应商`, "error");
          void tryImmediateFallback(errSel, ctx, isQuota ? "quota exceeded" : isAuth ? "auth failed" : "429");
          return; // 失败轮不记录缓存/学习
        }
      }
      if (!msg.usage) return;
      const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
      const sel = currentSelector(ctx);
      if (!sel) return;
      const sid = sessionIdOf(ctx);
      const usage = msg.usage;
      if (cfg.cache.enabled) {
        cacheManager.recordUsage(sel, sid, lastPromptText, { cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
        // 持久化一条轻量 cache 记录（便于 /router status 展示与恢复）
        try {
          const rec = cacheManager.getRecord(sel);
          if (rec) pi.appendEntry(CACHE_ENTRY, rec as unknown as Record<string, unknown>);
        } catch { /* ignore */ }
        if (cfg.verbose && (usage.cacheRead ?? 0) > 0) {
          console.log(`[pi-smart-router] cache hit: ${sel} read=${usage.cacheRead} write=${usage.cacheWrite}`);
        }
      }
      // 学习：成功结果 → 该 taskType 该模型加分（含缓存命中与成本）
      if (cfg.learn.enabled) {
        const taskType = lastTaskType ?? "general";
        const cost = typeof usage.cost?.total === "number" ? usage.cost.total : 0;
        learning.recordOutcome({
          taskType,
          selector: sel,
          cost,
          cacheRead: usage.cacheRead ?? 0,
          success: true,
          timestamp: Date.now(),
        }, cfg.learn);
        try { pi.appendEntry(LEARN_ENTRY, { taskType, selector: sel, cost, cacheRead: usage.cacheRead ?? 0, success: true, timestamp: Date.now() } as never); } catch { /* ignore */ }
      }
      // self-learn：成功结果 → 场景×难度 该模型加分
      if (selfLearn && cfg.selfLearn.enabled && cfg.difficulty.enabled) {
        const cost = typeof usage.cost?.total === "number" ? usage.cost.total : 0;
        const { scenario, difficulty } = analyzeTask(
          { taskType: lastTaskType as never, toolNames: [], contextTokens: contextTokens(ctx), messageCount: messageCount(ctx), turnIndex, promptLength: lastPromptText.length, hasImage: false, explicitModel: undefined, currentModel: sel, thinkingLevel: undefined, promptText: lastPromptText },
          cfg.difficulty.lowThreshold,
          cfg.difficulty.highThreshold,
        );
        selfLearn.record({ selector: sel, scenario, difficulty, success: true, cost, cacheRead: usage.cacheRead ?? 0, timestamp: Date.now() });
      }
    } catch { /* ignore */ }
  });

  // ——— session_before_compact: compaction 后重置缓存前缀（避免旧前缀误导） ———
  pi.on("session_before_compact", async (_event, _ctx) => {
    try { cacheManager.invalidatePrefix(); } catch { /* ignore */ }
  });

  // ——— tool_result: 工具错误冷却 + 学习失败记录 + 额度耗尽排除 ———
  pi.on("tool_result", async (event, ctx) => {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    const sel = currentSelector(ctx);
    // 额度耗尽（AccountQuotaExceeded）需要立即从 rank 排除，避免 60s 后重试死循环
    const contentText = (() => {
      const c = (event as unknown as { content?: unknown }).content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return (c as Array<Record<string, unknown>>).map((p) => typeof p.text === "string" ? p.text : "").join("\n");
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
        if (typeof o.message === "string") return o.message;
      }
      return "";
    })();
    if (isQuotaExceeded(contentText) && sel && probe) {
      probe.markAuthFailure(sel);
      ctx.ui.notify(`⚡ router: "${sel}" quota exceeded — excluded from rank until next session`, "error");
      void tryImmediateFallback(sel, ctx, "quota exceeded");
    }
    onToolResult(
      { isError: (event as unknown as { isError?: boolean }).isError, content: (event as unknown as { content?: unknown }).content },
      {
        config: cfg,
        cooldowns,
        currentModelSelector: () => sel,
        notify: (msg, level) => ctx.ui.notify(msg, level ?? "warning"),
        log: (msg) => { if (cfg.verbose) console.log(msg); },
      },
    );
    // 学习：工具错误且命中冷却 → 该模型降权
    if (cfg.learn.enabled && (event as unknown as { isError?: boolean }).isError && sel) {
      const taskType = lastTaskType ?? "general";
      learning.recordFailure(taskType, sel, cfg.learn);
      try { pi.appendEntry(LEARN_ENTRY, { taskType, selector: sel, success: false, timestamp: Date.now() } as never); } catch { /* ignore */ }
    }
  });

  // ——— model_select: 更新状态条 ———
  pi.on("model_select", async (event, ctx) => {
    const cur = `${event.model.provider}/${event.model.id}`;
    const cfg = watcher?.get();
    const label = cfg?.enabled ? `⚡ ${cur}` : cur;
    ctx.ui.setStatus("router", label);
  });

  // ——— /router 命令 ———
  pi.registerCommand("router", {
    description: "pi-smart-router: status / rules / reload / clear-cooldown / toggle / test / cache / learn / pool [use|save|rename|list|rm]",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const [sub, ...rest] = raw.split(/\s+/).filter(Boolean);
      const cmd = (sub ?? "status").toLowerCase();
      const deps = {
        getConfig: () => watcher?.get() ?? loadConfig(ctx.cwd),
        reloadConfig: () => {
          const c = watcher ? watcher.reload() : loadConfig(ctx.cwd);
          if (!watcher) watcher = createConfigWatcher(ctx.cwd);
          compiledRules = compileRules(c.rules).compiled;
          return c;
        },
        recompileRules: () => compileRules((watcher?.get() ?? loadConfig(ctx.cwd)).rules).compiled,
        cooldowns,
        cacheManager,
        learning,
        getHistory: () => history,
        clearHistory: () => { history = []; },
        getCurrentModel: () => currentSelector(ctx as unknown as ExtensionContext),
        getAvailableModels: () => [...availableSelectors(ctx as unknown as ExtensionContext)],
      };

      if (cmd === "status" || cmd === "st" || cmd === "") {
        ctx.ui.notify(formatStatus(deps), "info");
        return;
      }
      if (cmd === "pool") {
        // 子命令：save <名> / use [名] / list / rm <名> / rename <旧名> <新名>
        const subArg = rest.join(" ").trim();
        const presetList = (): Array<{ name: string; models: string[] }> => {
          const c = watcher?.get() ?? loadConfig(ctx.cwd);
          return Object.entries(c.poolPresets ?? {}).map(([name, models]) => ({ name, models }));
        };
        if (subArg.startsWith("save")) {
          const name = subArg.slice(4).trim();
          const c = watcher?.get() ?? loadConfig(ctx.cwd);
          if (!name) { ctx.ui.notify("用法: /router pool save <预设名>", "warning"); return; }
          if (!c.pool?.length) { ctx.ui.notify("router: 当前池为空，先用 /router pool 挑选再保存", "warning"); return; }
          try {
            persistPoolPreset(name, c.pool);
            if (watcher) watcher.reload();
            ctx.ui.notify(`router: 预设 "${name}" 已保存（${c.pool.length} 模型）`, "info");
          } catch (e) { ctx.ui.notify(`router: 保存预设失败 ${String(e).slice(0, 100)}`, "error"); }
          return;
        }
        if (subArg === "list" || subArg === "ls") {
          const ps = presetList();
          if (!ps.length) { ctx.ui.notify("router: 无预设 — /router pool 挑选后回车即可命名保存", "info"); return; }
          const c = watcher?.get() ?? loadConfig(ctx.cwd);
          const lines = ps.map((p) => {
            const active = c.pool?.length && p.models.length === c.pool.length && p.models.every((m, i) => m === c.pool![i]) ? " ← 当前" : "";
            return `  ${p.name} (${p.models.length} 模型)${active}\n    ${p.models.join(", ")}`;
          });
          ctx.ui.notify(`pool 预设 (${ps.length}):\n${lines.join("\n")}\n切换: /router pool use [预设名]`, "info");
          return;
        }
        if (subArg.startsWith("rm") && !subArg.startsWith("rules")) {
          const name = subArg.slice(2).trim();
          if (!name) { ctx.ui.notify("用法: /router pool rm <预设名>", "warning"); return; }
          const ok = removePoolPreset(name);
          if (watcher) watcher.reload();
          ctx.ui.notify(ok ? `router: 预设 "${name}" 已删除` : `router: 预设 "${name}" 不存在`, ok ? "info" : "warning");
          return;
        }
        if (subArg.startsWith("rename")) {
          const rest2 = subArg.slice(6).trim();
          const spaceIdx = rest2.indexOf(" ");
          if (spaceIdx === -1) { ctx.ui.notify("用法: /router pool rename <旧名> <新名>", "warning"); return; }
          const oldName = rest2.slice(0, spaceIdx).trim();
          const newName = rest2.slice(spaceIdx + 1).trim();
          if (!oldName || !newName) { ctx.ui.notify("用法: /router pool rename <旧名> <新名>", "warning"); return; }
          const ok = renamePoolPreset(oldName, newName);
          if (watcher) watcher.reload();
          ctx.ui.notify(ok ? `router: 预设 "${oldName}" 已重命名为 "${newName}"` : `router: 预设 "${oldName}" 不存在`, ok ? "info" : "warning");
          return;
        }
        if (subArg.startsWith("use")) {
          const name = subArg.slice(3).trim();
          // 直接激活指定预设
          if (name) {
            const models = applyPoolPreset(name);
            if (watcher) watcher.reload();
            if (!models) { ctx.ui.notify(`router: 预设 "${name}" 不存在或为空 — /router pool list 查看`, "warning"); return; }
            ctx.ui.notify(`⚡ router: 已切换到预设 "${name}"（${models.length} 模型）`, "info");
            return;
          }
          // 无名称：打开预设单选器
          const ps = presetList();
          if (!ps.length) { ctx.ui.notify("router: 无预设 — /router pool 挑选后回车即可命名保存", "info"); return; }
          const picked = await (ctx.ui as unknown as { custom: <T>(fn: (tui: { requestRender: () => void }, theme: PickerTheme, kb: unknown, done: (v: T | null) => void) => { render: (w: number) => string[]; invalidate: () => void; handleInput: (d: string) => void }) => Promise<T | null> }).custom<{ name: string; models: string[] } | null>((tui, theme, _kb, done) => {
            const pp = new PresetPickerComponent(ps);
            pp.onConfirm = (item) => done(item);
            pp.onCancel = () => done(null);
            return {
              render: (w) => pp.render(w, theme),
              invalidate: () => {},
              handleInput: (d) => pp.handleInput(d, () => tui.requestRender()),
            };
          });
          if (!picked) { ctx.ui.notify("router: 未切换（取消）", "info"); return; }
          persistPool(picked.models);
          if (watcher) watcher.reload();
          ctx.ui.notify(`⚡ router: 已切换到预设 "${picked.name}"（${picked.models.length} 模型）`, "info");
          return;
        }
        // 主流程：模型池多选器（搜索 + 空格勾选 + 回车保存到全局配置）
        const infos = registryInfos(ctx as unknown as ExtensionContext);
        // 兑底：registry 元信息拿不到时，用 availableSelectors 字符串构造基础条目（无窗口/价格但可挑选）
        if (!infos.length) {
          const sels = [...availableSelectors(ctx as unknown as ExtensionContext)];
          if (!sels.length) { ctx.ui.notify("router: 无可用模型（modelRegistry 为空）", "warning"); return; }
          for (const s of sels) infos.push({ selector: s, provider: s.split("/")[0] ?? "" });
        }
        const items: PoolItem[] = infos.map((i) => ({ selector: i.selector, contextWindow: i.contextWindow, costInput: i.cost?.input }));
        const cfgNow = watcher?.get() ?? loadConfig(ctx.cwd);
        const initial = new Set((cfgNow.pool ?? []).map((s) => s.toLowerCase()));
        const presetItems = presetList();
        const result = await (ctx.ui as unknown as { custom: <T>(fn: (tui: { requestRender: () => void }, theme: PickerTheme, kb: unknown, done: (v: T | null) => void) => { render: (w: number) => string[]; invalidate: () => void; handleInput: (d: string) => void }) => Promise<T | null> }).custom<string[] | null>((tui, theme, _kb, done) => {
          const picker = new PoolPickerComponent(items, initial);
          picker.onConfirm = (sel) => done(sel);
          picker.onCancel = () => done(null);
          return {
            render: (w) => picker.render(w, theme, presetItems),
            invalidate: () => { /* 每次现算，无需缓存 */ },
            handleInput: (d) => picker.handleInput(d, () => tui.requestRender()),
          };
        });
        if (result === null) { ctx.ui.notify("router: pool 未修改（取消）", "info"); return; }
        try {
          persistPool(result);
          if (watcher) watcher.reload();
          const n = result.length;
          ctx.ui.notify(n === 0 ? "router: pool 已清空（全部可用模型参与路由）" : `router: pool 已保存 ${n} 个模型到全局配置 ~/.pi/agent/pi-router.json`, "info");
        } catch (e) {
          ctx.ui.notify(`router: pool 保存失败 ${String(e).slice(0, 120)}`, "error");
        }
        // 非空池 → 弹命名框（可存为预设，esc 跳过）
        if (result.length > 0) {
          try {
            const name = await (ctx.ui as unknown as { custom: <T>(fn: (tui: { requestRender: () => void }, theme: PickerTheme, kb: unknown, done: (v: T | null) => void) => { render: (w: number) => string[]; invalidate: () => void; handleInput: (d: string) => void }) => Promise<T | null> }).custom<string | null>((tui, theme, _kb, done) => {
              const np = new NamePromptComponent("保存为预设？输入名称");
              np.onConfirm = (v) => done(v);
              np.onCancel = () => done(null);
              return {
                render: (w) => np.render(w, theme),
                invalidate: () => {},
                handleInput: (d) => np.handleInput(d, () => tui.requestRender()),
              };
            });
            if (name) {
              persistPoolPreset(name, result);
              if (watcher) watcher.reload();
              ctx.ui.notify(`router: 预设 "${name}" 已保存（${result.length} 模型）— /router pool use ${name} 快速切换`, "info");
            }
          } catch { /* 命名弹窗失败不影响池激活 */ }
        }
        return;
      }
      if (cmd === "rules" || cmd === "r") {
        ctx.ui.notify(formatRules(deps), "info");
        return;
      }
      if (cmd === "cache") {
        const recs = cacheManager.getRecords();
        if (!recs.length) { ctx.ui.notify("cache: no records yet", "info"); return; }
        const lines = ["cache records:"];
        for (const r of recs) {
          lines.push(`  ${r.selector}: hit=${(r.hitRate*100).toFixed(1)}% prefix=${r.commonPrefixChars} read=${r.cacheRead} write=${r.cacheWrite} session=${r.sessionId.slice(0,8)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "reload") {
        const cfg = deps.reloadConfig();
        ctx.ui.notify(`router reloaded: ${cfg.enabled ? "enabled" : "disabled"} · rules=${cfg.rules.length} · level=${cfg.routingLevel} · cache=${cfg.cache.enabled ? "on" : "off"} · learn=${cfg.learn.enabled ? "on" : "off"}`, "info");
        return;
      }
      if (cmd === "learn") {
        const all = learning.all();
        if (!all.length) { ctx.ui.notify("learn: no samples yet", "info"); return; }
        const lines = ["learn scores:"];
        for (const { taskType, scores } of all) {
          const top = scores[0];
          lines.push(`  ${taskType}: → ${top.selector} (score=${top.score.toFixed(2)}, n=${top.samples})`);
          for (const s of scores.slice(1, 4)) {
            lines.push(`    - ${s.selector} score=${s.score.toFixed(2)} n=${s.samples}`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "clear-learn") {
        learning.clear();
        ctx.ui.notify("learn state cleared", "info");
        return;
      }
      if (cmd === "catalog") {
        if (!catalog) { ctx.ui.notify("catalog not initialized", "warning"); return; }
        const entries = catalog.all();
        if (!entries.length) { ctx.ui.notify("catalog: empty — run a few turns to populate", "info"); return; }
        const lines = [`catalog (${entries.length}):`];
        for (const e of entries.slice(0, 15)) {
          const best = Object.entries(e.learnScore).sort((a, b) => b[1] - a[1])[0];
          const bestStr = best ? ` best=${best[0]}:${best[1].toFixed(1)}` : "";
          const scen = e.scenarios.length ? ` scen=[${e.scenarios.join(",")}]` : "";
          lines.push(`  ${e.selector} ctx=${e.contextWindow ?? "?"}${scen}${bestStr}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "value") {
        if (!profiles.length) { ctx.ui.notify("profiles not loaded yet (run a turn first)", "info"); return; }
        const lines = [`model value rank (${profiles.length} auto-profiled):`];
        const diffArg = (rest[0] ?? "low").toLowerCase() as Difficulty;
        const diff = (["low", "medium", "high"] as const).includes(diffArg as never) ? diffArg : "low";
        const ranked = rankModels(profiles, diff, (sel) => catalog?.get(sel)?.learnScore[`${lastTaskType}×${diff}`] ?? 0);
        for (const p of ranked.slice(0, 15)) {
          const v = valueScore(p, diff, catalog?.get(p.selector)?.learnScore[`${lastTaskType}×${diff}`] ?? 0);
          lines.push(`  ${v.toFixed(1)}  ${p.selector}  [${p.priceTier}/${p.capabilityTier}/${p.speed}] ctx=${p.contextWindow} $${p.costInput}/${p.costOutput}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "probe") {
        if (!probe) { ctx.ui.notify("probe not initialized", "warning"); return; }
        const snap = probe.getSnapshot();
        const entries = Object.entries(snap);
        if (!entries.length) { ctx.ui.notify(probe.isRunning() ? "probe: running in background..." : "probe: no targets yet", "info"); return; }
        const unavail = entries.filter(([, v]) => v === "unavailable");
        const lines = [`probe: ${entries.length} targets (${probe.isRunning() ? "running" : "done"}), ${unavail.length} unavailable`];
        for (const [k, v] of entries) if (v === "unavailable") lines.push(`  ✗ ${k}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "handoff") {
        if (!lastHandoffs.length) { ctx.ui.notify("no handoffs recorded", "info"); return; }
        const lines = ["recent handoffs:"];
        for (const h of lastHandoffs.slice(-8)) {
          lines.push(`  [${new Date(h.ts).toLocaleTimeString()}] ${h.from} → ${h.to} — ${h.reason}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "clear-cooldown" || cmd === "clear") {
        const target = rest.join(" ").trim();
        if (target) {
          const ok = cooldowns.clear(target);
          ctx.ui.notify(ok ? `cleared cooldown: ${target}` : `no cooldown for: ${target}`, ok ? "info" : "warning");
        } else {
          cooldowns.clearAll();
          ctx.ui.notify("all cooldowns cleared", "info");
        }
        return;
      }
      if (cmd === "clear-cache") {
        cacheManager.clear();
        ctx.ui.notify("cache cleared", "info");
        return;
      }
      if (cmd === "clear-history") {
        deps.clearHistory();
        ctx.ui.notify("history cleared", "info");
        return;
      }
      if (cmd === "toggle") {
        const cfg = deps.getConfig();
        const next = !cfg.enabled;
        try { persistEnabled(ctx.cwd, next); } catch { /* ignore */ }
        // 同步内存状态
        const rawCfg = watcher?.get();
        if (rawCfg) (rawCfg as unknown as Record<string, unknown>).enabled = next;
        // 立即重载以同步 watcher
        try { watcher?.reload(); } catch { /* ignore */ }
        ctx.ui.notify(`router ${next ? "✅ enabled" : "⏸️ disabled"} (已持久化到 pi-router.json)`, next ? "info" : "warning");
        ctx.ui.setStatus("router", next ? `⚡ ${deps.getCurrentModel() ?? ""} (router on)` : "⏸ router off — 手动模式");
        return;
      }
      if (cmd === "on" || cmd === "enable") {
        try { persistEnabled(ctx.cwd, true); } catch { /* ignore */ }
        const rawCfg = watcher?.get();
        if (rawCfg) (rawCfg as unknown as Record<string, unknown>).enabled = true;
        try { watcher?.reload(); } catch { /* ignore */ }
        ctx.ui.notify("router ✅ enabled (已持久化)", "info");
        ctx.ui.setStatus("router", `⚡ ${deps.getCurrentModel() ?? ""} (router on)`);
        return;
      }
      if (cmd === "off" || cmd === "disable") {
        try { persistEnabled(ctx.cwd, false); } catch { /* ignore */ }
        const rawCfg = watcher?.get();
        if (rawCfg) (rawCfg as unknown as Record<string, unknown>).enabled = false;
        try { watcher?.reload(); } catch { /* ignore */ }
        ctx.ui.notify("router ⏸️ disabled — 手动模式 (已持久化)", "warning");
        ctx.ui.setStatus("router", "⏸ router off — 手动模式");
        return;
      }
      if (cmd === "test") {
        const prompt = rest.join(" ").trim() || "implement a fix for the failing test";
        const avail = deps.getAvailableModels();
        const cfg = deps.getConfig();
        const fakeCtx: ExtensionContext = ctx as unknown as ExtensionContext;
        const cur = currentSelector(fakeCtx);
        const sid = sessionIdOf(fakeCtx);
        const rec = resolveTurnDecision({
          prompt,
          systemPromptOptions: { selectedTools: ["bash", "edit"] },
          currentModelSelector: cur,
          thinkingLevel: (fakeCtx as unknown as { thinkingLevel?: string }).thinkingLevel,
          messageCount: messageCount(fakeCtx),
          turnIndex: turnIndex + 1,
          contextTokens: contextTokens(fakeCtx),
          availableModels: new Set(avail),
          deps: {
            config: cfg,
            compiledRules,
            cooldowns,
            cacheManager,
            learning,
            selfLearn: selfLearn ?? undefined,
            probe: probe ?? undefined,
            sessionId: sid,
            pushDecision: () => {},
            setStatus: () => {},
            verboseLog: () => {},
          },
        });
        if (rec) ctx.ui.notify(`test "${prompt}" → ${rec.selector ?? "(no decision)"} — ${rec.reason}`, "info");
        else ctx.ui.notify(`test "${prompt}" → no routing decision`, "info");
        return;
      }
      if (cmd === "help" || cmd === "h") {
        ctx.ui.notify([
          "pi-smart-router — 智能路由使用指南",
          "",
          "开关控制（持久化，重启后仍生效）：",
          "  /router toggle          — 切换开/关（自动写入 pi-router.json）",
          "  /router on / enable     — 开启路由",
          "  /router off / disable   — 关闭路由（手动选模型，不自动切）",
          "",
          "查看状态：",
          "  /router / status        — 总览：开关/当前模型/可用模型/规则/fallback/冷却/缓存/学习/最近决策",
          "  /router rules           — 已编译规则（优先级/条件→模型）",
          "  /router cache           — 每模型缓存命中（hit%/prefix/read/write）",
          "  /router learn           — 每任务类型学习得分（taskType→model 分数）",
          "  /router catalog         — 模型能力快照 + 自适应得分",
          "  /router value [low|medium|high] — 全量模型性价比排名（自动画像）",
          "  /router probe           — 本 session 可用性（连通性/套餐失效排除）",
          "  /router handoff         — 最近模型交接事件",
          "",
          "维护操作：",
          "  /router reload          — 热重载 pi-router.json（改配置后用）",
          "  /router clear [model]   — 清除某模型或全部冷却",
          "  /router clear-cache     — 清空缓存记录",
          "  /router clear-learn     — 清空学习状态",
          "  /router clear-history   — 清空决策历史",
          "  /router test <prompt>   — 干跑：输入 prompt 看会路由到谁（不真切模型）",
          "",
          "配置：全局 ~/.pi/agent/pi-router.json  项目级 .pi/pi-router.json（覆盖全局）",
          "  模板：examples/pi-router.cn.json（中文生态，开箱即用）",
          "  额度耗尽（AccountQuotaExceeded 429）会自动从 rank 排除至下次会话",
          "",
          "示例：@model:openai/gpt-5.1 强制指定本次模型（绕过路由）",
        ].join("\n"), "info");
        return;
      }
      ctx.ui.notify(`unknown subcommand: ${cmd} — try /router help`, "warning");
    },
  });

  // ——— LLM 工具 ———
  pi.registerTool({
    ...buildRouterTool({
      getConfig: () => watcher?.get() ?? { enabled: false } as unknown as NormalizedRouterConfig,
      getCurrentModel: () => {
        try {
          const last = history[history.length - 1];
          return last?.selector;
        } catch { return undefined; }
      },
      getAvailableModels: () => [],
      cooldowns,
      getHistory: () => history,
    }),
    parameters: Type.Object({}),
  } as never);

  // ——— router_handoff 工具（模型自判交接） ———
  pi.registerTool({
    name: "router_handoff",
    label: "Router Handoff",
    description: "Hand off the current task to a different model when you think it is better suited. Use when the task is outside your strengths, too complex, or better handled by a specialized model. The context and cache are preserved.",
    parameters: Type.Object({
      target: Type.String({ description: "Target model selector, e.g. 'opencode-go/kimi-k3' or 'zai-coding-cn/glm-5.3'" }),
      reason: Type.String({ description: "Why you are handing off to this model" }),
      summary: Type.String({ description: "Handoff summary for the next model: current state, what was done, what to do next." }),
      scenario: Type.Optional(Type.String({ description: "Task scenario: frontend/backend/test/ops/research/document/general" })),
      difficulty: Type.Optional(Type.String({ description: "Task difficulty: low/medium/high" })),
    }),
    async execute(_toolCallId, params: { target: string; reason: string; summary: string; scenario?: string; difficulty?: string }, _signal, _onUpdate, ctx) {
      const target = params.target.trim();
      if (!target) return { content: [{ type: "text" as const, text: "Error: target model is required." }], details: { ok: false, error: "missing target" } };

      const avail = new Set(filterByPool(availableSelectors(ctx as unknown as ExtensionContext), cfgPool(ctx)));
      const targetInAvail = [...avail].some((s) => s.toLowerCase() === target.toLowerCase());
      if (!targetInAvail) {
        const msg = `Cannot hand off to "${target}": not in available models or marked unavailable.`;
        ctx.ui.notify(msg, "warning");
        return { content: [{ type: "text" as const, text: msg }], details: { ok: false, error: "unavailable" } };
      }
      if (cooldowns.isCooldown(target)) {
        const msg = `Cannot hand off to "${target}": model is in cooldown.`;
        ctx.ui.notify(msg, "warning");
        return { content: [{ type: "text" as const, text: msg }], details: { ok: false, error: "cooldown" } };
      }

      const from = currentSelector(ctx as unknown as ExtensionContext);
      if (from && from.toLowerCase() === target.toLowerCase()) {
        return { content: [{ type: "text" as const, text: `Already on ${target}.` }], details: { ok: true, unchanged: true } };
      }

      const scenario = (["frontend", "backend", "test", "ops", "research", "document", "general"] as const).includes(params.scenario as never)
        ? (params.scenario as "frontend" | "backend" | "test" | "ops" | "research" | "document" | "general")
        : "general";
      const difficulty = (["low", "medium", "high"] as const).includes(params.difficulty as never)
        ? (params.difficulty as "low" | "medium" | "high")
        : "medium";

      // 记录 handoff（喂 self-learn）
      if (from) {
        lastHandoffs.push({ from, to: target, reason: params.reason, ts: Date.now() });
        if (selfLearn) selfLearn.recordHandoff(from, target, scenario, difficulty);
      }

      // 切换模型：用 tool 的 ctx
      try {
        const reg = (ctx as unknown as { modelRegistry?: { find?: (p: string, id: string) => unknown } }).modelRegistry;
        const parsed = target.includes("/") ? target.split("/") : [undefined, target];
        const provider = parsed[0];
        const modelId = parsed.slice(1).join("/");
        let modelObj = provider ? reg?.find?.(provider, modelId) : undefined;
        if (!modelObj) {
          for (const s of avail) {
            const [p, ...rest] = s.split("/");
            if (s.toLowerCase() === target.toLowerCase() || rest.join("/").toLowerCase() === target.toLowerCase()) {
              modelObj = reg?.find?.(p, rest.join("/"));
              if (modelObj) break;
            }
          }
        }
        if (!modelObj) {
          const msg = `Model not found: ${target}`;
          ctx.ui.notify(msg, "warning");
          return { content: [{ type: "text" as const, text: msg }], details: { ok: false, error: "not_found" } };
        }
        const ok = await pi.setModel(modelObj as never);
        if (!ok) {
          const msg = `Failed to switch to "${target}" (no auth?).`;
          ctx.ui.notify(msg, "error");
          return { content: [{ type: "text" as const, text: msg }], details: { ok: false, error: "setModel_failed" } };
        }
        // 交接说明交给新模型
        try { pi.sendMessage({ customType: "pi-smart-router-handoff", content: `[handoff from ${from ?? "previous model"}]\n${params.summary}`, display: true }); } catch { /* ignore */ }
        const msg = `⚡ handed off to ${target} — ${params.reason}`;
        ctx.ui.notify(msg, "info");
        console.log(`[handoff] ${from ?? "?"} → ${target} (${scenario}/${difficulty}): ${params.reason}`);
        return { content: [{ type: "text" as const, text: msg }], details: { ok: true, from, to: target } };
      } catch (err) {
        const msg = `handoff error: ${err instanceof Error ? err.message : String(err)}`;
        ctx.ui.notify(msg, "error");
        return { content: [{ type: "text" as const, text: msg }], details: { ok: false, error: String(err) } };
      }
    },
  });
}
