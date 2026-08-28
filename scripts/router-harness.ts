/* eslint-disable */
// Router Harness: 直接驱动 pi-smart-router 扩展，模拟 pi 事件链，复现 fallback 场景
// 用法：bun scripts/router-harness.ts <scenario>
//   scenarios:
//     quota-rule-loop   — volces 额度耗尽 + huge-context 规则反复切回（用户真实 bug）
//     basic-flow        — 健康路径全跑一遍冒烟

import type { ExtensionAPI } from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

class FakeCtx {
  cwd = process.cwd();
  ui: { notify: (msg: string, level?: string) => void; setStatus: (k: string, v: string) => void };
  sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
    getEntries: () => any[];
  };
  model: { provider: string; id: string };
  thinkingLevel: string = "medium";
  modelRegistry: {
    getAvailableSnapshot: () => any[];
    getAll: () => any[];
    find: (provider: string, id: string) => any;
    getProvider: (provider: string) => any;
  };
  signal: AbortSignal = new AbortController().signal;
  isProjectTrusted: () => true;
  isIdle: () => true;
  abort: () => void;
  shutdown: () => void;
  constructor(opts: { cwd?: string; provider?: string; id?: string; sessionId?: string } = {}) {
    this.cwd = opts.cwd ?? "/tmp/router-harness";
    this.model = { provider: opts.provider ?? "volces", id: opts.id ?? "deepseek-v4-flash[1m]" };
    const notifications: string[] = [];
    this.ui = {
      notify: (m, l) => { notifications.push(`[${l ?? "info"}] ${m}`); },
      setStatus: () => {},
    };
    this.sessionManager = {
      getSessionId: () => opts.sessionId ?? "test-session",
      getSessionFile: () => undefined,
      getEntries: () => [],
    };
    this.modelRegistry = { getAvailableSnapshot: () => [], getAll: () => [], find: () => undefined, getProvider: () => undefined };
  }
  getNotifications(): string[] { return (this.ui as any).__notes ?? []; }
}

const FAKE_BASE_URL: Record<string, string | undefined> = {
  volces: undefined,    // 无 baseUrl → probeReachability 视为可达（available），避免误杀
  opencode: undefined,
  shudie: undefined,
  zai: undefined,
};

const FAKE_MODELS = [
  { provider: "volces", id: "deepseek-v4-flash[1m]", contextWindow: 1048576, cost: { input: 0, output: 0, cacheRead: 0 }, input: ["text"], reasoning: false },
  { provider: "opencode", id: "deepseek-v4-flash", contextWindow: 1048576, cost: { input: 0.22, output: 0.66, cacheRead: 0.007 }, input: ["text"], reasoning: false },
  { provider: "shudie", id: "deepseek-v4-flash-0731", contextWindow: 262144, cost: { input: 0.14, output: 0.28, cacheRead: 0 }, input: ["text"], reasoning: false },
  { provider: "zai", id: "glm-5.3", contextWindow: 1000000, cost: { input: 1.4, output: 0, cacheRead: 0 }, input: ["text"], reasoning: false },
  { provider: "opencode", id: "minimax-m3", contextWindow: 1048576, cost: { input: 0.3, output: 0, cacheRead: 0 }, input: ["text"], reasoning: true },
];

const FAKE_CONFIG = {
  enabled: true,
  defaultModel: "volces/deepseek-v4-flash[1m]",
  routingLevel: "turn",
  cooldownMs: 60000,
  cooldownOnStatus: [429, 500, 502, 503, 504],
  cooldownOnToolErrorPatterns: ["rate.?limit", "quota.*exceeded", "AccountQuotaExceeded"],
  taskTypeRules: {},
  rules: [
    { id: "huge-context", priority: 92, when: { contextTokens: { gt: 150000 } }, model: "volces/deepseek-v4-flash[1m]" },
  ],
  fallback: { mode: "model-chain" as const, models: ["opencode/deepseek-v4-flash", "shudie/deepseek-v4-flash-0731", "zai/glm-5.3"] },
  explicitModelPrefix: "@model:",
  verbose: true,
  cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: false, stickyTtlMs: 300000 },
  learn: { enabled: true, windowSize: 50, minSamples: 2, successWeight: 1, failureWeight: -2, cacheWeight: 0, costWeight: 0 },
  churn: { enabled: false, maxChurnTokens: 8000 },
  catalogPath: "/tmp/router-harness-catalog.json",
  difficulty: { enabled: false, lowThreshold: 40, highThreshold: 120 },
  selfLearn: { enabled: false, minSamples: 3, decay: 0.9, successWeight: 1, failureWeight: -2, costWeight: 0 },
  probe: { enabled: true, timeoutMs: 300000, probeOnStart: false, excludeUnavailable: true },
};

class Harness {
  private handlers = new Map<string, Handler[]>();
  private ctx: FakeCtx;
  private initialModel = { provider: "volces", id: "deepseek-v4-flash[1m]" };
  private setModel: (sel: string) => Promise<boolean> = async () => false;
  private currentSelector = `${this.initialModel.provider}/${this.initialModel.id}`;
  private sendMessageCalls: string[] = [];
  notifications: string[] = [];

  constructor(opts: { initialModel?: { provider: string; id: string } } = {}) {
    if (opts.initialModel) this.initialModel = opts.initialModel;
    this.currentSelector = `${this.initialModel.provider}/${this.initialModel.id}`;
    this.ctx = new FakeCtx({ provider: this.initialModel.provider, id: this.initialModel.id });
    this.ctx.ui.notify = (m: string, l?: string) => {
      this.notifications.push(`[${l ?? "info"}] ${m}`);
    };
    // modelRegistry mock
    this.ctx.modelRegistry = {
      getAvailableSnapshot: () => FAKE_MODELS.map((m) => ({ ...m, id: m.id })),
      getAll: () => FAKE_MODELS.map((m) => ({ ...m, id: m.id })),
      find: (provider: string, id: string) => {
        const found = FAKE_MODELS.find((m) => m.provider === provider && m.id === id);
        return found ? { ...found, id: found.id } : undefined;
      },
      getProvider: (provider: string) => ({ baseUrl: FAKE_BASE_URL[provider] }),
    };
    // setModel mock — 更新 currentSelector 并返回值
    this.setModel = async (sel: any) => {
      // 兼容 string "provider/id" 或 { provider, id } 对象（扩展传 modelObj 时是对象）
      let p: string, id: string;
      if (typeof sel === "string") {
        const parts = sel.split("/");
        p = parts[0]; id = parts.slice(1).join("/");
      } else if (sel && typeof sel === "object") {
        p = sel.provider; id = sel.id;
      } else { this.notifications.push(`[setModel-FAIL] bad arg type`); return false; }
      const hit = FAKE_MODELS.find((m) => m.provider === p && m.id === id);
      if (hit) {
        this.initialModel = { provider: p, id };
        this.ctx.model = { provider: p, id };
        this.currentSelector = `${p}/${id}`;
        this.notifications.push(`[setModel] ${this.currentSelector}`);
        return true;
      }
      this.notifications.push(`[setModel-FAIL] ${p}/${id}`);
      return false;
    };
  }

  // 暴露给扩展注入的 ExtensionAPI 形状
  buildApi(): ExtensionAPI {
    const api = {
      on: (event: string, handler: Handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      registerTool: (tool: any) => { /* harness 不调用工具 */ },
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      setModel: this.setModel,
      sendUserMessage: (text: string, opts?: any) => { this.sendMessageCalls.push(text + (opts?.deliverAs ? ` [${opts.deliverAs}]` : "")); this.notifications.push(`[sendUserMessage] ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`); },
      sendMessage: (msg: any) => { this.sendMessageCalls.push(typeof msg === "string" ? msg : (msg?.content ?? "")); this.notifications.push(`[sendMessage] ${typeof msg === "string" ? msg.slice(0,60) : JSON.stringify(msg).slice(0,60)}`); },
      appendEntry: (type: string, data: any) => { /* no-op */ },
      getAgentDir: () => "/tmp/router-harness-agent",
      ui: this.ctx.ui,
      getModel: () => this.ctx.model,
      getThinkingLevel: () => this.ctx.thinkingLevel,
      getSystemPromptOptions: () => ({ selectedTools: ["bash", "edit"] }),
      getContextUsage: () => ({ tokens: 160000 }),
      setActiveTools: () => {},
      setActiveTool: () => {},
      getActiveTools: () => ["bash", "edit"],
      getActiveTool: () => undefined,
      getAllTools: () => [],
      setStatus: (k: string, v: string) => { /* status */ },
      setThinkingLevel: (l: string) => { this.ctx.thinkingLevel = l; },
      shutdown: () => {},
      abort: () => {},
      events: { on: () => {}, emit: () => {} },
      isIdle: () => true,
    } as unknown as ExtensionAPI;
    return api;
  }

  async fire(event: string, payload: any): Promise<any[]> {
    const list = this.handlers.get(event) ?? [];
    const results: any[] = [];
    for (const h of list) {
      try {
        const r = await h(payload, this.ctx);
        if (r !== undefined) results.push(r);
      } catch (e: any) {
        this.notifications.push(`[${event}-ERR] ${e.message}`);
      }
    }
    return results;
  }

  setModel_(selector: string) { this.setModel(selector); }
  getCurrentSelector() { return this.currentSelector; }
  getSendMessageCalls() { return this.sendMessageCalls; }
}

async function main() {
  const scenario = process.argv[2] ?? "quota-rule-loop";
  console.log(`=== Router Harness | scenario=${scenario} ===\n`);

  const harness = new Harness();
  const factory = (await import("../src/index.ts")).default;
  const api = harness.buildApi();
  // 加载扩展（factory 接收 pi ExtensionAPI）
  factory(api);

  // 覆写 loadConfig/getConfig 让扩展用我们的假配置
  // 简化：直接修改 cfg 走默认 → 我们注入 dummy pi-router.json 让 loadConfig 读它
  // 但 config.ts 用 homedir + ~/.pi/agent/pi-router.json；harness 里 cwd=/tmp，让 config 读 /tmp/.pi/pi-router.json
  // 先写一份 fake 配置到 harness cwd
  const fs = await import("node:fs");
  const harnessDir = "/tmp/router-harness-home";
  fs.mkdirSync(harnessDir + "/.pi", { recursive: true });
  fs.writeFileSync(harnessDir + "/.pi/pi-router.json", JSON.stringify(FAKE_CONFIG, null, 2));
  fs.mkdirSync(harnessDir + "/.pi/agent", { recursive: true });
  // 改 HOME 让 config 找 harness cwd
  process.env.HOME = harnessDir;
  process.env.USERPROFILE = harnessDir;

  console.log("[1] session_start");
  await harness.fire("session_start", { reason: "test" });

  console.log("\n[2] before_agent_start (ctx 160k → 规则 huge-context 应命中 volces)");
  const beforeResults = await harness.fire("before_agent_start", {
    prompt: "请分析这份长文档".repeat(200),
    images: [],
    systemPromptOptions: { selectedTools: ["bash", "edit"] },
  });
  console.log(`    current=${harness.getCurrentSelector()}`);
  console.log(`    setModel calls=${harness.getSendMessageCalls().length}`);

  console.log("\n[3] after_provider_response x3 (volces 429 quota × 3，模拟 pi retry)");
  for (let i = 0; i < 3; i++) {
    await harness.fire("after_provider_response", { status: 429, headers: {} });
    console.log(`    [${i+1}] status=429 → current=${harness.getCurrentSelector()} | notif=${harness.notifications.length}`);
  }

  console.log("\n[4] before_agent_start 再次触发（期望：probe 标 volces unavailable → 规则命中 fallback 切到 opencode）");
  const before2 = await harness.fire("before_agent_start", {
    prompt: "请继续分析".repeat(200),
    images: [],
    systemPromptOptions: { selectedTools: ["bash", "edit"] },
  });
  console.log(`    current=${harness.getCurrentSelector()} (期望 opencode/deepseek-v4-flash)`);

  console.log("\n[3b] message_end API 错误（真实链路：SDK 层 429 重试耗尽 → errorMessage 到达 message_end，after_provider_response 不触发）");
  await harness.fire("message_end", {
    message: { role: "assistant", stopReason: "error", errorMessage: 'Retry failed after 3 attempts: 429 {"error":{"code":"AccountQuotaExceeded","message":"You have exceeded the monthly usage quota. It will reset at 2026-09-06"}}', provider: "volces", model: "deepseek-v4-flash[1m]", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
  });
  console.log(`    after message_end-error: current=${harness.getCurrentSelector()} (期望非 volces)`);

  console.log("\n[5] 关键决策检查");
  const decisions = (before2 as any[]).map(r => ({ sel: r.selector, reason: r.reason, source: r.source, ruleId: r.ruleId }));
  console.log(`    decisions: ${JSON.stringify(decisions, null, 2)}`);

  // 断言
  const finalSel = harness.getCurrentSelector();
  const expected = "opencode/deepseek-v4-flash";
  console.log(`\n=== 断言 ===`);
  console.log(`  最终模型: ${finalSel}`);
  console.log(`  期望非 volces（应切到 ${expected} 或 fallback 链中其它）: ${finalSel !== "volces/deepseek-v4-flash[1m]" ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  setMessage 重发调用次数=${harness.getSendMessageCalls().length}`);
  if (harness.getSendMessageCalls().length > 0) {
    console.log(`  重发内容（首条）: ${harness.getSendMessageCalls()[0].slice(0,80)}...`);
  }

  console.log(`\n=== 最近 20 条通知 ===`);
  for (const n of harness.notifications.slice(-20)) console.log("  " + n);
}

main().catch((e) => { console.error("HARNESS ERR:", e); process.exit(1); });

// 部署建议：在 CI / 本地开发时用此脚本验证扩展链路
// 后续可拓展：multi-fallback exhaustion 场景、规则循环重置场景等
