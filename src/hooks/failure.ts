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
  deps.cooldowns.add(selector, cfg.cooldownMs, `tool_error: ${truncate(text, 120)}`);
  const msg = `⚡ router: "${selector}" cooling ${Math.round(cfg.cooldownMs / 1000)}s — tool error`;
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
