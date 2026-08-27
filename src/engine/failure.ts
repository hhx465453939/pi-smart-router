/**
 * 失败分类与冷却判定
 *
 * 提炼自 claude-code-router 的 classifyRouteFailure：
 * - 429 → rate-limit
 * - 408/409 → retryable
 * - >=500 → server
 * - 其余 → client
 * shouldFallback: model-chain 模式下 status >= 400 即回退；retry 模式仅 retryable/rate-limit/server。
 */
import type { FailureClass, FailureDecision, FallbackMode } from "../types.ts";

export function classifyStatus(statusCode: number): FailureClass {
  if (statusCode === 429) return "rate-limit";
  if (statusCode === 408 || statusCode === 409) return "retryable";
  if (statusCode >= 500) return "server";
  return "client";
}

export function classifyRouteFailure(statusCode: number, mode: FallbackMode): FailureDecision {
  const failureClass = classifyStatus(statusCode);
  return {
    failureClass,
    shouldFallback: mode === "model-chain"
      ? statusCode >= 400
      : failureClass === "retryable" || failureClass === "rate-limit" || failureClass === "server",
  };
}

/** 检查工具错误文本是否命中任一错误特征（正则，大小写不敏感） */
export function matchesToolErrorPatterns(text: string | undefined, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

/** 把配置的字符串模式编译为正则（大小写不敏感）
 *  模式本身即为正则片段（如 "rate.?limit"），直接编译；若非法则回退为字面匹配。
 */
export function compileErrorPatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns) return [];
  return patterns.map((p) => {
    const raw = p.trim();
    if (!raw) return /$^/;
    try {
      return new RegExp(raw, "i");
    } catch {
      return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}
