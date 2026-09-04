/* eslint-disable */
// Router Harness: 直接驱动 pi-smart-router 扩展，模拟 pi 事件链，复现 fallback 场景
// 用法：node --experimental-strip-types scripts/router-harness.ts <scenario>   （或 bun scripts/router-harness.ts <scenario>）
//   scenarios:
//     quota-rule-loop    — volces 额度耗尽 + huge-context 规则反复切回（默认）
//     no-channel-503     — 503 model_not_found 应触发秒切 + 排除 + 自动续跑
//     dup-injection-guard— 同一次失败命中 4 个钩子，只允许驱动 1 次重试
//     cascade            — 级联 4 个模型连续挂掉，链路必须一路推进不停摆
//     pool-boundary      — 池硬边界下的秒切候选
//
// 闭环重试的驱动方式是 pi.sendMessage(customType) + triggerTurn，**不是**重发用户 prompt。
// 因此所有场景都断言 sendUserMessage 调用数为 0（session 里不堆积重复用户指令）。

import type { ExtensionAPI } from "../src/index.ts";

/** src/index.ts 内 RETRY_ENTRY 的字面值（闭包常量，harness 侧只能按字面匹配） */
const RETRY_CUSTOM_TYPE = "pi-smart-router-retry";

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
  // 显式空池：bun 的 os.homedir() 不理会 process.env.HOME，会读到真实全局配置；
  // 若不显式覆盖，真实 pool 会按 key 合并泄漏进来，导致候选过滤依赖运行机器的环境（测试不可复现）
  pool: [],
} as Record<string, unknown> & { pool?: string[] };

class Harness {
  private handlers = new Map<string, Handler[]>();
  private ctx: FakeCtx;
  private initialModel = { provider: "volces", id: "deepseek-v4-flash[1m]" };
  private setModel: (sel: string) => Promise<boolean> = async () => false;
  private currentSelector = `${this.initialModel.provider}/${this.initialModel.id}`;
  /** pi.sendUserMessage 调用（伪造用户消息）—— 新闭环设计要求恒为 0 */
  private userMessageCalls: string[] = [];
  /** pi.sendMessage 调用（custom message 驱动重试）—— 记录 customType 与投递选项 */
  private sentMessages: Array<{ customType?: string; content: string; triggerTurn: boolean; deliverAs?: string }> = [];
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
      sendUserMessage: (text: string, opts?: any) => { this.userMessageCalls.push(text); this.notifications.push(`[sendUserMessage] ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`); },
      sendMessage: (msg: any, opts?: any) => {
        const rec = {
          customType: typeof msg === "string" ? undefined : msg?.customType,
          content: typeof msg === "string" ? msg : String(msg?.content ?? ""),
          triggerTurn: Boolean(opts?.triggerTurn),
          deliverAs: opts?.deliverAs,
        };
        this.sentMessages.push(rec);
        this.notifications.push(`[sendMessage:${rec.customType ?? "?"}] triggerTurn=${rec.triggerTurn} deliverAs=${rec.deliverAs ?? "-"} :: ${rec.content.slice(0, 50)}`);
      },
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
  /** 当前 ctx.model（构造 message_end 失败事件时按真实在跑的模型归因） */
  getCurrentModel() { return this.ctx.model; }
  /** 伪造用户消息 —— 新闭环重试不重发 prompt，此值应恒为 0 */
  getUserMessageCalls() { return this.userMessageCalls; }
  /** 驱动重试的 custom message（customType = pi-smart-router-retry） */
  getRetryMessages() { return this.sentMessages.filter((m) => m.customType === RETRY_CUSTOM_TYPE); }
}

/** 把 FAKE_CONFIG 同时写到 harness cwd 与 HOME，并把 HOME 指过去（各场景共用） */
async function installConfig(): Promise<void> {
  const fs = await import("node:fs");
  const harnessCwd = "/tmp/router-harness";
  fs.mkdirSync(harnessCwd + "/.pi", { recursive: true });
  fs.writeFileSync(harnessCwd + "/.pi/pi-router.json", JSON.stringify(FAKE_CONFIG, null, 2));
  const harnessDir = "/tmp/router-harness-home";
  fs.mkdirSync(harnessDir + "/.pi/agent", { recursive: true });
  fs.writeFileSync(harnessDir + "/.pi/agent/pi-router.json", JSON.stringify(FAKE_CONFIG, null, 2));
  process.env.HOME = harnessDir;
  process.env.USERPROFILE = harnessDir;
}

let failures = 0;
/** 统一断言输出：失败累加计数，最后由 main 决定退出码 */
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * 等 fallback 串行链排空。tryImmediateFallback 是 fire-and-forget：钩子返回时
 * 切模型已同步完成，但 await 之后的 sendMessage（重试驱动）还在微任务队列里。
 */
async function settle(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const scenario = process.argv[2] ?? "quota-rule-loop";
  console.log(`=== Router Harness | scenario=${scenario} ===\n`);

  if (scenario === "no-channel-503") {
    // 回归场景：503 model_not_found（new_api_error "No available channel"）应触发秒切 + 长排除 + 自动续跑。
    // 旧实现 message_end 正则不匹配 503/model_not_found → 无冷却、无切档、指令丢失。
    const harness = new Harness();
    const factory = (await import("../src/index.ts")).default;
    factory(harness.buildApi());
    await installConfig();

    await harness.fire("session_start", { reason: "test" });
    const prompt = "分析一下这段配置".repeat(100);
    await harness.fire("before_agent_start", { prompt, images: [], systemPromptOptions: { selectedTools: ["bash", "edit"] } });
    const errText = 'Retry failed after 3 attempts: 503 {"error":{"code":"model_not_found","message":"No available channel for model deepseek-v4-flash[1m] under group default (distributor) (request id: 202608290915209043788268d9d6YahpFfhl)","type":"new_api_error"}}';
    await harness.fire("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: errText, provider: "volces", model: "deepseek-v4-flash[1m]", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    });
    await settle();

    const finalSel = harness.getCurrentSelector();
    const retries = harness.getRetryMessages();
    console.log(`  最终模型: ${finalSel}`);
    console.log(`\n=== 断言 ===`);
    check("已秒切离故障模型", finalSel !== "volces/deepseek-v4-flash[1m]", finalSel);
    check("未伪造用户消息（不重发 prompt）", harness.getUserMessageCalls().length === 0, `${harness.getUserMessageCalls().length} 次`);
    check("恰好一条重试驱动（custom message）", retries.length === 1, `${retries.length} 条`);
    check("重试驱动带 triggerTurn", retries.every((r) => r.triggerTurn), retries.map((r) => `triggerTurn=${r.triggerTurn}`).join(","));
    console.log(`\n=== 最近 6 条通知 ===`);
    for (const n of harness.notifications.slice(-6)) console.log("  " + n);
    return;
  }

  if (scenario === "dup-injection-guard") {
    // 回归场景：一次失败会同时命中 after_provider_response(429×2) / message_end / tool_result 四个钩子。
    // 守护的不变量：① 绝不伪造用户消息（旧实现重发 prompt，链路越长 session 里重复指令越多，
    //   commit 00801d3 为此把自动重试砍到 1 次，代价是停摆）；② 同一故障模型只驱动一次重试。
    // 已知风险（见 .debug/fallback-loop-debug.md 待追踪问题）：tool_result 钩子按"当前模型"归因，
    //   秒切之后到达的 tool_result 会算到新模型头上，因此本场景允许 2 个不同 driver。
    const harness = new Harness();
    const factory = (await import("../src/index.ts")).default;
    factory(harness.buildApi());
    await installConfig();

    await harness.fire("session_start", { reason: "test" });
    const prompt = "请分析这份长文档".repeat(200);
    await harness.fire("before_agent_start", { prompt, images: [], systemPromptOptions: { selectedTools: ["bash", "edit"] } });

    // 触发 1+2：连续 429 ×2 → n>=2 → tryImmediateFallback（driver #1: volces）
    await harness.fire("after_provider_response", { status: 429, headers: {} });
    await harness.fire("after_provider_response", { status: 429, headers: {} });
    const afterChainSwitch = harness.getCurrentSelector();

    // 触发 3：message_end 同一轮失败，payload 显式带 volces → 应被去重拦住
    await harness.fire("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: 'Retry failed: 429 AccountQuotaExceeded', provider: "volces", model: "deepseek-v4-flash[1m]", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    });

    // 触发 4：tool_result 额度耗尽（归因到当前模型 = 已切换后的模型）
    await harness.fire("tool_result", { isError: true, content: [{ type: "text", text: "Error: AccountQuotaExceeded — quota exceeded" }] });
    await settle();

    const retries = harness.getRetryMessages();
    const drivers = retries.map((r) => (r.content.match(/上一个模型 (\S+) 不可用/) ?? [])[1]).filter(Boolean);
    const dupDrivers = drivers.filter((d, i) => drivers.indexOf(d) !== i);
    console.log(`  fallback 链首次切换后模型: ${afterChainSwitch}`);
    console.log(`  重试 driver 序列: ${drivers.join(" → ") || "(无)"}`);
    console.log(`\n=== 断言 ===`);
    check("未伪造用户消息（不重发 prompt）", harness.getUserMessageCalls().length === 0, `${harness.getUserMessageCalls().length} 次`);
    check("同一故障模型不重复驱动重试", dupDrivers.length === 0, dupDrivers.join(","));
    check("首次触发即完成秒切", afterChainSwitch !== "volces/deepseek-v4-flash[1m]", afterChainSwitch);
    check("每条重试驱动都带 triggerTurn", retries.length > 0 && retries.every((r) => r.triggerTurn), `${retries.length} 条`);
    console.log(`\n=== 最近 10 条通知 ===`);
    for (const n of harness.notifications.slice(-10)) console.log("  " + n);
    return;
  }

  if (scenario === "cascade") {
    // 回归场景（用户真实故障）：连续 4 个模型挨个挂掉，router 必须一路推进到活模型。
    // 旧实现在第 2 次失败后只切模型不驱动 turn → 对话停摆，用户必须手动重发指令，
    // 且候选耗尽后死模型被留在原位继续挨打（.debug/fallback-loop-debug.md L1/L2）。
    FAKE_CONFIG.pool = FAKE_MODELS.map((m) => `${m.provider}/${m.id}`);
    const harness = new Harness();
    const factory = (await import("../src/index.ts")).default;
    factory(harness.buildApi());
    await installConfig();

    await harness.fire("session_start", { reason: "test" });
    const prompt = "请分析这份长文档".repeat(200);
    await harness.fire("before_agent_start", { prompt, images: [], systemPromptOptions: { selectedTools: ["bash", "edit"] } });

    const failures: Array<{ label: string; errorMessage: string }> = [
      { label: "额度耗尽 429", errorMessage: 'Retry failed after 3 attempts: 429 {"error":{"code":"AccountQuotaExceeded","message":"You have exceeded the monthly usage quota"}}' },
      { label: "套餐失效 403", errorMessage: 'Retry failed after 3 attempts: 403 {"error":{"message":"Forbidden — plan expired"}}' },
      { label: "无可用通道 503", errorMessage: 'Retry failed after 3 attempts: 503 {"error":{"code":"model_not_found","message":"No available channel"}}' },
      { label: "限流 429", errorMessage: "Retry failed after 3 attempts: 429 TooManyRequests" },
    ];

    const visited: string[] = [harness.getCurrentSelector()];
    for (let i = 0; i < failures.length; i++) {
      const cur = harness.getCurrentModel();
      await harness.fire("message_end", {
        message: { role: "assistant", stopReason: "error", provider: cur.provider, model: cur.id, errorMessage: failures[i].errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
      });
      await settle();
      // 闭环驱动的新 turn：prompt 为空（followUp 不携带用户输入）
      await harness.fire("before_agent_start", { prompt: "", images: [], systemPromptOptions: { selectedTools: ["bash", "edit"] } });
      const sel = harness.getCurrentSelector();
      visited.push(sel);
      console.log(`[失败${i + 1}] ${failures[i].label} → 模型 = ${sel}`);
    }

    const retries = harness.getRetryMessages();
    const drivers = retries.map((r) => (r.content.match(/上一个模型 (\S+) 不可用/) ?? [])[1]).filter(Boolean);
    const distinct = new Set(visited);
    console.log(`\n  模型轨迹: ${visited.join(" → ")}`);
    console.log(`  重试 driver 数: ${retries.length}（失败 ${failures.length} 次）`);
    console.log(`\n=== 断言 ===`);
    check("每次失败都驱动了一次重试（无停摆）", retries.length === failures.length, `${retries.length}/${failures.length}`);
    check("未伪造用户消息（不重发 prompt）", harness.getUserMessageCalls().length === 0, `${harness.getUserMessageCalls().length} 次`);
    check("链路一路向前，不回头撞已死模型", distinct.size === visited.length, `访问 ${visited.length} 次 / 不同 ${distinct.size} 个`);
    check("driver 序列无重复", new Set(drivers).size === drivers.length, drivers.join(" → "));
    check("最终停在非 volces 模型", harness.getCurrentSelector() !== "volces/deepseek-v4-flash[1m]", harness.getCurrentSelector());
    console.log(`\n=== 最近 12 条通知 ===`);
    for (const n of harness.notifications.slice(-12)) console.log("  " + n);
    FAKE_CONFIG.pool = [];
    return;
  }

  if (scenario === "pool-boundary") {
    FAKE_CONFIG.pool = ["opencode/deepseek-v4-flash", "zai/glm-5.3", "shudie/deepseek-v4-flash-0731"];
    console.log("    pool-boundary: 已启用模型池 → " + FAKE_CONFIG.pool.join(", "));
  }

  const harness = new Harness();
  const factory = (await import("../src/index.ts")).default;
  const api = harness.buildApi();
  // 加载扩展（factory 接收 pi ExtensionAPI）
  factory(api);
  await installConfig();

  console.log("[1] session_start");
  await harness.fire("session_start", { reason: "test" });

  console.log("\n[2] before_agent_start (ctx 160k → 规则 huge-context 应命中 volces)");
  const beforeResults = await harness.fire("before_agent_start", {
    prompt: "请分析这份长文档".repeat(200),
    images: [],
    systemPromptOptions: { selectedTools: ["bash", "edit"] },
  });
  console.log(`    current=${harness.getCurrentSelector()}`);

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
  await settle();
  const finalSel = harness.getCurrentSelector();
  const retries = harness.getRetryMessages();
  console.log(`\n=== 断言 ===`);
  console.log(`  最终模型: ${finalSel}`);
  check("已切离耗尽模型", finalSel !== "volces/deepseek-v4-flash[1m]", finalSel);
  check("未伪造用户消息（不重发 prompt）", harness.getUserMessageCalls().length === 0, `${harness.getUserMessageCalls().length} 次`);
  check("重试驱动带 triggerTurn", retries.every((r) => r.triggerTurn), `${retries.length} 条`);

  console.log(`\n=== 最近 20 条通知 ===`);
  for (const n of harness.notifications.slice(-20)) console.log("  " + n);
}

function report(): void {
  console.log(`\n=== 结果：${failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`} ===`);
  process.exitCode = failures === 0 ? 0 : 1;
  // probe 后台探测 timer 会挂住事件循环，必须显式退出（带上失败计数，别用 exit(0) 掩盖红）
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300).unref?.();
}

main().then(report).catch((e) => { console.error("HARNESS ERR:", e); failures++; report(); });
