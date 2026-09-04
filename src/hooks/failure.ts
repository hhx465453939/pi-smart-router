/**
 * 失败检测：after_provider_response + tool_result → 冷却模型
 */
import type { NormalizedRouterConfig } from "../types.ts";
import { CooldownSet } from "../engine/registry.ts";
import { classifyStatus, matchesToolErrorPatterns } from "../engine/failure.ts";

export interface FailureHookDeps {
  config: NormalizedRouterConfig;
  cooldowns: CooldownSet;
  currentModelSelector(): string | undefined;
  notify?(msg: string, level?: "info" | "warning" | "error"): void;
  log?(msg: string): void;
}

export function onProviderResponse(
  event: { status: number; headers?: Record<string, string> },
  deps: FailureHookDeps,
): string | undefined {
  const cfg = deps.config;
  if (!cfg.enabled) return undefined;
  if (!cfg.cooldownOnStatus.includes(event.status)) return undefined;
  const selector = deps.currentModelSelector();
  if (!selector) return undefined;
  const failureClass = classifyStatus(event.status);
  deps.cooldowns.add(selector, cfg.cooldownMs, `HTTP ${event.status} (${failureClass})`);
  const msg = `⚡ router: "${selector}" cooling ${Math.round(cfg.cooldownMs / 1000)}s — HTTP ${event.status} (${failureClass})`;
  deps.log?.(msg);
  deps.notify?.(msg, "warning");
  return selector;
}

export function onToolResult(
  event: { isError?: boolean; content?: unknown; details?: unknown },
  deps: FailureHookDeps,
): string | undefined {
  const cfg = deps.config;
  if (!cfg.enabled) return undefined;
  if (!event.isError) return undefined;
  const text = extractText(event.content);
  if (!matchesToolErrorPatterns(text, cfg.cooldownOnToolErrorPatterns)) return undefined;
  const selector = deps.currentModelSelector();
  if (!selector) return undefined;
  // 套餐额度耗尽（AccountQuotaExceeded）需要更长冷却，避免 60s 后重试死循环
  const isQuota = /AccountQuotaExceeded|quota.*exceeded|exceeded.*quota|monthly.*quota/i.test(text);
  const resetMs = isQuota ? parseQuotaResetMs(text) ?? 24 * 60 * 60 * 1000 : cfg.cooldownMs;
  const effectiveMs = isQuota ? Math.max(resetMs, 60 * 60 * 1000) : cfg.cooldownMs; // 至少 1h
  deps.cooldowns.add(selector, effectiveMs, isQuota ? `quota_exceeded: ${truncate(text, 120)}` : `tool_error: ${truncate(text, 120)}`);
  const msg = isQuota
    ? `⚡ router: "${selector}" quota exceeded — cooling ${Math.round(effectiveMs / 3600000)}h (will reset, excluded from rank)`
    : `⚡ router: "${selector}" cooling ${Math.round(cfg.cooldownMs / 1000)}s — tool error`;
  deps.log?.(msg);
  deps.notify?.(msg, "warning");
  return selector;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.message === "string") return o.message;
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 解析额度重置时间，返回距今毫秒数，未能解析返回 null（供 probe 排除 TTL 对齐真实重置时间） */
export function parseQuotaResetMs(text: string): number | null {
  // 匹配 "reset at 2026-09-06 23:59:59 +0800 CST" 等
  const m = text.match(/reset at\s+([\d-]+\s+[\d:]+\s*[+\-]\d+[^\n]*)/i);
  if (!m) return null;
  const d = new Date(m[1].trim());
  if (isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return ms > 0 ? ms : null;
}

/** 供外部判断是否为额度耗尽（用于 probe 标记 unavailable） */
export function isQuotaExceeded(text: string): boolean {
  return /AccountQuotaExceeded|quota.*exceeded|exceeded.*quota|monthly.*quota/i.test(text);
}
