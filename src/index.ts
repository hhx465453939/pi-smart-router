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
import { loadConfig, createConfigWatcher, type ConfigWatcher } from "./config.ts";
import { CooldownSet } from "./engine/registry.ts";
import { CacheManager } from "./engine/cache.ts";
import { LearningManager } from "./engine/learn.ts";
import { compileRules, type CompiledRule } from "./engine/rules.ts";
import { resolveTurnDecision } from "./hooks/agent.ts";
import { resolveProviderDecision } from "./hooks/provider.ts";
import { onProviderResponse, onToolResult } from "./hooks/failure.ts";
import { formatRules, formatStatus } from "./commands/router.ts";
import { buildRouterTool } from "./tool/router.ts";
import { classifyTaskType } from "./context/task.ts";
import { ModelCatalog } from "./catalog/catalog.ts";
import { SelfLearnManager } from "./engine/selflearn.ts";
import { AvailabilityProbe } from "./probe/availability.ts";
import { analyzeTask } from "./engine/difficulty.ts";

export default function (pi: ExtensionAPI) {
  let watcher: ConfigWatcher | null = null;
  let compiledRules: CompiledRule[] = [];
  let cooldowns = new CooldownSet();
  let cacheManager = new CacheManager();
  let learning = new LearningManager();
  let catalog: ModelCatalog | null = null;
  let selfLearn: SelfLearnManager | null = null;
  let probe: AvailabilityProbe | null = null;
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

  /** 从 modelRegistry 提取目录信息（seed catalog + 探测目标） */
  function registryInfos(ctx: ExtensionContext): Array<{ selector: string; provider: string; baseUrl?: string; contextWindow?: number; cost?: { input: number; output: number; cacheRead: number }; input?: string[] }> {
    const out: Array<{ selector: string; provider: string; baseUrl?: string; contextWindow?: number; cost?: { input: number; output: number; cacheRead: number }; input?: string[] }> = [];
    try {
      const reg: unknown = (ctx as unknown as Record<string, unknown>).modelRegistry;
      const r = reg as { getAvailableSnapshot?: () => Array<Record<string, unknown>> };
      const list = r.getAvailableSnapshot?.() ?? [];
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
      // 初始化可用性探测 + 启动后台异步探测（不阻塞）
      probe = new AvailabilityProbe({
        config: cfg.probe,
        getBaseUrl: (provider) => providerBaseUrl(ctx, provider),
        log: (m) => { if (cfg.verbose) console.log(m); },
      });
      probe.start(regInfos.map((r) => ({ selector: r.selector, provider: r.provider, baseUrl: r.baseUrl })), (snap) => {
        const bad = Object.entries(snap).filter(([, v]) => v === "unavailable").map(([k]) => k);
        if (bad.length && cfg.verbose) console.log(`[probe] done: ${bad.length} unavailable: ${bad.join(", ")}`);
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
    const available = availableSelectors(ctx);
    const availableFiltered = probe ? new Set(probe.filterAvailable([...available])) : available;
    const sid = sessionIdOf(ctx);
    const promptText = (event as unknown as { prompt?: string }).prompt ?? "";
    lastPromptText = promptText;
    lastTaskType = (event as unknown as { systemPromptOptions?: { taskType?: string } }).systemPromptOptions?.taskType ?? classifyGuess(promptText);

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
    const available = availableSelectors(ctx);
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
    // 可用性：401/402/403 → 套餐失效/欠费，标记本 session 不可用
    if (cfg.probe.enabled && (event.status === 401 || event.status === 402 || event.status === 403)) {
      const sel = currentSelector(ctx);
      if (sel && probe) {
        probe.markAuthFailure(sel);
        ctx.ui.notify(`⚡ router: ${sel} auth failed (HTTP ${event.status}) — excluded this session`, "warning");
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

  // ——— message_end: 回填缓存 usage（核心特色）+ 学习成功记录 ———
  pi.on("message_end", async (event, ctx) => {
    try {
      const msg = (event as unknown as { message?: { role?: string; usage?: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number; cost?: { total?: number } } } }).message;
      if (!msg || msg.role !== "assistant" || !msg.usage) return;
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

  // ——— tool_result: 工具错误冷却 + 学习失败记录 ———
  pi.on("tool_result", async (event, ctx) => {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    const sel = currentSelector(ctx);
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
    description: "pi-smart-router: status / rules / reload / clear-cooldown / toggle / test / cache / learn",
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
        const rawCfg = watcher?.get();
        if (rawCfg) (rawCfg as unknown as Record<string, unknown>).enabled = next;
        ctx.ui.notify(`router ${next ? "enabled" : "disabled"} (memory only — edit pi-router.json to persist)`, "info");
        ctx.ui.setStatus("router", next ? `⚡ ${deps.getCurrentModel() ?? ""}` : "⏸ router off");
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
          "/router [subcommand]",
          "  status (default) — current model / rules / cooldowns / cache / learn / recent decisions",
          "  rules            — list compiled rules",
          "  cache            — show per-model cache hit stats",
          "  learn            — show per-taskType learned model scores",
          "  catalog          — show model catalog + self-learn scores",
          "  probe            — show availability snapshot",
          "  handoff          — show recent handoff events",
          "  reload           — reload config from pi-router.json",
          "  clear [model]    — clear cooldown(s)",
          "  clear-cache      — clear cache records",
          "  clear-learn      — clear learned state",
          "  clear-history    — clear decision history",
          "  toggle           — enable/disable router (memory only)",
          "  test <prompt>    — dry-run routing for a prompt",
          "  help             — this help",
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

      const avail = availableSelectors(ctx as unknown as ExtensionContext);
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
