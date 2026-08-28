/**
 * 启动异步可用性探测 — AvailabilityProbe
 *
 * 三层：
 * ① getAvailableSnapshot 立即排除无 key 模型（由调用方传入已过滤集合）
 * ② 后台异步连通性探测（不带 key，只判端点可达）
 * ③ 真实调用 after_provider_response 捕获 401/402/403 → 确定性不可用（调用方触发 markAuthFailure）
 *
 * 每 session 独立快照，timeout 可配（默认 5 分钟），不阻塞用户聊天。
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
  private snapshot: ProbeSnapshot = {};
  private running = false;
  private readonly deps: ProbeDeps;

  constructor(deps: ProbeDeps) {
    this.deps = deps;
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
        if (Date.now() > deadline) { this.snapshot[t.selector] = "uncertain"; return; }
        const base = this.deps.getBaseUrl(t.provider);
        const reachable = await probeReachability(base ?? "", Math.min(cfg.timeoutMs, 30000));
        this.snapshot[t.selector] = reachable ? "available" : "unavailable";
        if (!reachable) this.deps.log?.(`[probe] ${t.selector} unreachable → excluded`);
      });
      await Promise.all(tasks);
      this.running = false;
      onUpdate?.(this.snapshot);
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
          for (const t of models) this.snapshot[t.selector] = "uncertain";
          return;
        }
        const base = this.deps.getBaseUrl(provider);
        const reachable = await probeReachability(base ?? "", Math.min(cfg.timeoutMs, 30000));
        for (const t of models) {
          this.snapshot[t.selector] = reachable ? "available" : "unavailable";
          if (!reachable) this.deps.log?.(`[probe] ${provider} unreachable → ${t.selector} excluded`);
        }
      });
      await Promise.all(tasks);
      this.running = false;
      onUpdate?.(this.snapshot);
    })();
  }

  /** 真实调用后标记确定性不可用（401/402/403） */
  markAuthFailure(selector: string): void {
    this.snapshot[selector] = "unavailable";
  }

  /** 标记可用 */
  markAvailable(selector: string): void {
    if (this.snapshot[selector] !== "unavailable") this.snapshot[selector] = "available";
  }

  getAvailability(selector: string): Availability {
    return this.snapshot[selector] ?? "uncertain";
  }

  /** 过滤：返回可用候选（uncertain 也保留，避免误杀） */
  filterAvailable(selectors: string[]): string[] {
    return selectors.filter((s) => this.getAvailability(s) !== "unavailable");
  }

  getSnapshot(): ProbeSnapshot {
    return { ...this.snapshot };
  }

  isRunning(): boolean {
    return this.running;
  }
}
