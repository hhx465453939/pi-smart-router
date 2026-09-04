/**
 * 启动异步可用性探测 — AvailabilityProbe
 *
 * 三层：
 * ① getAvailableSnapshot 立即排除无 key 模型（由调用方传入已过滤集合）
 * ② 后台异步连通性探测（不带 key，只判端点可达）
 * ③ 真实调用捕获 401/402/403/429/5xx → 带 TTL 的临时排除（调用方触发 markUnavailable）
 *
 * 排除一律**可逆**：每条排除都带过期时间，到期自动回到 uncertain 重新参与选型；
 * 真实调用成功可立即自愈（markAvailable）；`/router clear` 可手动清除。
 * 早期实现是"本 session 永久拉黑且 markAvailable 拒绝解除"，级联失败打穿模型池后
 * 整个 session 报废、只能重启 pi —— 详见 .debug/fallback-loop-debug.md 的 L2。
 */
import type { NormalizedProbeConfig, ProbeSnapshot, Availability } from "../types.ts";

export interface ProbeTarget {
  selector: string;
  provider: string;
  baseUrl?: string;
}

export interface ProbeDeps {
  config: NormalizedProbeConfig;
  getBaseUrl(provider: string): string | undefined;
  log?(msg: string): void;
}

/** 各类排除的默认存活时间：到期自动恢复候选资格 */
export const PROBE_TTL = {
  /** 401/402/403 套餐失效/欠费 */
  auth: 60 * 60 * 1000,
  /** 额度耗尽（调用方可传解析出的额度重置时间覆盖） */
  quota: 6 * 60 * 60 * 1000,
  /** 模型在该供应商无通道（503 model_not_found） */
  noChannel: 60 * 60 * 1000,
  /** 泛 5xx 服务端故障，可能瞬时恢复 */
  server: 10 * 60 * 1000,
  /** 端点不可达（后台连通性探测） */
  network: 5 * 60 * 1000,
} as const;

interface Mark {
  /** 原始大小写 selector，用于展示 */
  selector: string;
  state: Availability;
  /** 过期时间（epoch ms）；Infinity = 不过期（仅用于 available/uncertain 这类非排除态） */
  until: number;
  reason: string;
}

/** 归一化 map key */
function keyOf(selector: string): string {
  return selector.trim().toLowerCase();
}

/** 连通性探测：不带 key，收到任意 HTTP 响应=可达；超时/连接失败=不可达 */
async function probeReachability(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!baseUrl) return true; // 无 baseUrl 视为不确定（不硬排除）
  const url = baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${url}/v1/models`, { method: "GET", signal: ctrl.signal });
    // 任何 HTTP 响应（200/401/403/404...）都说明端点可达；网络不通才会 throw
    void res;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class AvailabilityProbe {
  private readonly marks = new Map<string, Mark>();
  private running = false;
  private readonly deps: ProbeDeps;

  constructor(deps: ProbeDeps) {
    this.deps = deps;
  }

  /** 写入一条状态标记 */
  private set(selector: string, state: Availability, ttlMs: number, reason: string): void {
    const k = keyOf(selector);
    if (!k) return;
    this.marks.set(k, {
      selector,
      state,
      until: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
      reason,
    });
  }

  /** 清理已过期的排除标记（到期即恢复候选资格） */
  private sweep(): void {
    const now = Date.now();
    for (const [k, m] of this.marks) {
      if (m.until <= now) this.marks.delete(k);
    }
  }

  /**
   * 临时排除一个模型。ttlMs 到期后自动恢复候选资格。
   * 传 Infinity 表示本 session 内不排除（用于标记 available/uncertain）。
   */
  markUnavailable(selector: string, ttlMs: number = PROBE_TTL.auth, reason = "unavailable"): void {
    this.set(selector, "unavailable", Math.max(0, ttlMs), reason);
    this.deps.log?.(`[probe] ${selector} excluded ${Math.round(ttlMs / 60000)}min — ${reason}`);
  }

  /** 真实调用后标记不可用（401/402/403 等）。保留旧名以兼容既有调用点。 */
  markAuthFailure(selector: string, ttlMs: number = PROBE_TTL.auth, reason = "auth failure"): void {
    this.markUnavailable(selector, ttlMs, reason);
  }

  /** 标记可用 —— 真实调用成功时的自愈出口，无条件清除既有排除 */
  markAvailable(selector: string): void {
    const k = keyOf(selector);
    const prev = this.marks.get(k);
    if (prev?.state === "unavailable") {
      this.marks.delete(k);
      this.deps.log?.(`[probe] ${selector} recovered (real call succeeded) — exclusion cleared`);
      return;
    }
    this.set(selector, "available", Infinity, "reachable");
  }

  getAvailability(selector: string): Availability {
    const k = keyOf(selector);
    const m = this.marks.get(k);
    if (!m) return "uncertain";
    if (m.until <= Date.now()) {
      this.marks.delete(k);
      return "uncertain";
    }
    return m.state;
  }

  /** 过滤：返回可用候选（uncertain 也保留，避免误杀） */
  filterAvailable(selectors: string[]): string[] {
    return selectors.filter((s) => this.getAvailability(s) !== "unavailable");
  }

  /** 手动解除单个模型的排除 */
  clear(selector: string): boolean {
    const k = keyOf(selector);
    const m = this.marks.get(k);
    if (!m) return false;
    this.marks.delete(k);
    return true;
  }

  /** 手动解除全部排除（`/router clear`） */
  clearAll(): void {
    this.marks.clear();
  }

  /**
   * 当前生效中的排除项，按剩余时间升序（最先恢复的排前面）。
   * 供候选耗尽时的"赦免最后一搏"挑选牺牲品，以及 /router probe 展示。
   */
  excluded(): Array<{ selector: string; until: number; remainingMs: number; reason: string }> {
    this.sweep();
    const now = Date.now();
    return [...this.marks.values()]
      .filter((m) => m.state === "unavailable")
      .map((m) => ({ selector: m.selector, until: m.until, remainingMs: m.until - now, reason: m.reason }))
      .sort((a, b) => a.until - b.until);
  }

  getSnapshot(): ProbeSnapshot {
    this.sweep();
    const out: ProbeSnapshot = {};
    for (const m of this.marks.values()) out[m.selector] = m.state;
    return out;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 启动后台探测（不 await，不阻塞） */
  start(targets: ProbeTarget[], onUpdate?: (snapshot: ProbeSnapshot) => void): void {
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.probeOnStart || this.running) return;
    if (targets.length === 0) return;
    this.running = true;
    const deadline = Date.now() + cfg.timeoutMs;
    // 异步 fire-and-forget
    void (async () => {
      const tasks = targets.map(async (t) => {
        if (Date.now() > deadline) { this.set(t.selector, "uncertain", Infinity, "probe timeout"); return; }
        const base = this.deps.getBaseUrl(t.provider);
        const reachable = await probeReachability(base ?? "", Math.min(cfg.timeoutMs, 30000));
        if (reachable) this.set(t.selector, "available", Infinity, "reachable");
        else {
          // 端点不可达可能只是网络抖动，短 TTL 后自动重试
          this.markUnavailable(t.selector, PROBE_TTL.network, "endpoint unreachable");
        }
      });
      await Promise.all(tasks);
      this.running = false;
      onUpdate?.(this.getSnapshot());
    })();
  }

  /**
   * 按 provider 去重探测（auto-profiling 拉取全量模型时调用）：
   * 同一 provider 端点探测一次，结果广播到其下所有模型 selector，不通的 provider 全部模型标 unavailable。
   * 供“拉取全部已注册模型时顺手检测连通性、不通的不纳入 rank”使用。
   */
  startByProvider(targets: ProbeTarget[], onUpdate?: (snapshot: ProbeSnapshot) => void): void {
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.probeOnStart || this.running) return;
    if (targets.length === 0) return;
    this.running = true;
    const deadline = Date.now() + cfg.timeoutMs;
    // 按 provider 分组
    const byProvider = new Map<string, ProbeTarget[]>();
    for (const t of targets) {
      const list = byProvider.get(t.provider) ?? [];
      list.push(t);
      byProvider.set(t.provider, list);
    }
    void (async () => {
      const tasks = [...byProvider.entries()].map(async ([provider, models]) => {
        if (Date.now() > deadline) {
          for (const t of models) this.set(t.selector, "uncertain", Infinity, "probe timeout");
          return;
        }
        const base = this.deps.getBaseUrl(provider);
        const reachable = await probeReachability(base ?? "", Math.min(cfg.timeoutMs, 30000));
        for (const t of models) {
          if (reachable) this.set(t.selector, "available", Infinity, "reachable");
          else {
            this.markUnavailable(t.selector, PROBE_TTL.network, `${provider} endpoint unreachable`);
          }
        }
      });
      await Promise.all(tasks);
      this.running = false;
      onUpdate?.(this.getSnapshot());
    })();
  }
}
