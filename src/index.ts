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
import { compileRules, type CompiledRule } from "./engine/rules.ts";
import { resolveTurnDecision } from "./hooks/agent.ts";
import { resolveProviderDecision } from "./hooks/provider.ts";
import { onProviderResponse, onToolResult } from "./hooks/failure.ts";
import { formatRules, formatStatus } from "./commands/router.ts";
import { buildRouterTool } from "./tool/router.ts";

export default function (pi: ExtensionAPI) {
  let watcher: ConfigWatcher | null = null;
  let compiledRules: CompiledRule[] = [];
  let cooldowns = new CooldownSet();
  let cacheManager = new CacheManager();
  let history: DecisionRecord[] = [];
  let turnIndex = 0;
  let lastPromptText = "";

  const DECISION_ENTRY = "pi-smart-router-decision";
  const CACHE_ENTRY = "pi-smart-router-cache";
  const MAX_HISTORY = 50;

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

  // ——— session_start: 加载配置、恢复历史与缓存 ———
  pi.on("session_start", async (_event, ctx) => {
    turnIndex = 0;
    try {
      watcher = createConfigWatcher(ctx.cwd);
      const cfg = watcher.get();
      compiledRules = compileRules(cfg.rules).compiled;
      history = [];
      cacheManager = new CacheManager();
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
      ctx.ui.setStatus("router", `⚡ ${status} ${cacheStatus}${cur ? ` · ${cur}` : ""}`);
      if (cfg.verbose) console.log(`[pi-smart-router] loaded: ${status}, ${cacheStatus}, rules=${cfg.rules.length}, cooldowns=${cooldowns.all().length}`);
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
    const sid = sessionIdOf(ctx);
    const promptText = (event as unknown as { prompt?: string }).prompt ?? "";
    lastPromptText = promptText;

    const rec = resolveTurnDecision({
      prompt: promptText,
      images: (event as unknown as { images?: unknown[] }).images as unknown[] | undefined,
      systemPromptOptions: (event as unknown as { systemPromptOptions?: { selectedTools?: string[] } }).systemPromptOptions as { selectedTools?: string[] } | undefined,
      currentModelSelector: cur,
      thinkingLevel: (ctx as unknown as { thinkingLevel?: string }).thinkingLevel,
      messageCount: messageCount(ctx),
      turnIndex,
      contextTokens: contextTokens(ctx),
      availableModels: available,
      deps: {
        config: cfg,
        compiledRules,
        cooldowns,
        cacheManager,
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
      availableModels: available,
      deps: { config: cfg, compiledRules, cooldowns, cacheManager, sessionId: sid },
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

  // ——— after_provider_response: 失败冷却 + 缓存统计 ———
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
  });

  // ——— message_end: 回填缓存 usage（核心特色） ———
  pi.on("message_end", async (event, ctx) => {
    try {
      const msg = (event as unknown as { message?: { role?: string; usage?: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number } } }).message;
      if (!msg || msg.role !== "assistant" || !msg.usage) return;
      const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
      if (!cfg.cache.enabled) return;
      const sel = currentSelector(ctx);
      if (!sel) return;
      const sid = sessionIdOf(ctx);
      const usage = msg.usage;
      cacheManager.recordUsage(sel, sid, lastPromptText, { cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 });
      // 持久化一条轻量 cache 记录（便于 /router status 展示与恢复）
      try {
        const rec = cacheManager.getRecord(sel);
        if (rec) pi.appendEntry(CACHE_ENTRY, rec as unknown as Record<string, unknown>);
      } catch { /* ignore */ }
      if (cfg.verbose && (usage.cacheRead ?? 0) > 0) {
        console.log(`[pi-smart-router] cache hit: ${sel} read=${usage.cacheRead} write=${usage.cacheWrite}`);
      }
    } catch { /* ignore */ }
  });

  // ——— tool_result: 工具错误冷却 ———
  pi.on("tool_result", async (event, ctx) => {
    const cfg = watcher?.get() ?? loadConfig(ctx.cwd);
    onToolResult(
      { isError: (event as unknown as { isError?: boolean }).isError, content: (event as unknown as { content?: unknown }).content },
      {
        config: cfg,
        cooldowns,
        currentModelSelector: () => currentSelector(ctx),
        notify: (msg, level) => ctx.ui.notify(msg, level ?? "warning"),
        log: (msg) => { if (cfg.verbose) console.log(msg); },
      },
    );
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
    description: "pi-smart-router: status / rules / reload / clear-cooldown / toggle / test / cache",
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
        ctx.ui.notify(`router reloaded: ${cfg.enabled ? "enabled" : "disabled"} · rules=${cfg.rules.length} · level=${cfg.routingLevel} · cache=${cfg.cache.enabled ? "on" : "off"}`, "info");
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
          "  status (default) — current model / rules / cooldowns / cache / recent decisions",
          "  rules            — list compiled rules",
          "  cache            — show per-model cache hit stats",
          "  reload           — reload config from pi-router.json",
          "  clear [model]    — clear cooldown(s)",
          "  clear-cache      — clear cache records",
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
}
