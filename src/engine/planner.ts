/**
 * 执行计划与 fallback 选择
 *
 * 提炼自 claude-code-router 的 createRouteExecutionPlan / classifyRouteFailure：
 * - off: 单次尝试
 * - retry: 主模型重试 N 次
 * - model-chain: 主模型 + 备用模型链（去重、有序）
 */
import type { FallbackConfig } from "../types.ts";
import { CooldownSet, normalizeRouteSelector } from "./registry.ts";

export interface PlanAttempt {
  index: number;
  selector: string | undefined;
}

export interface RouteExecutionPlan {
  primary: string | undefined;
  attempts: PlanAttempt[];
  fallback: FallbackConfig;
}

const MAX_RETRY = 9999;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(n) ? n : min)));
}

function uniqueSelectors(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeRouteSelector(v);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * 生成执行计划（主模型 + fallback 模型链）
 * 仅做"候选集合生成"，不判断可用性（可用性由决策层结合冷却集判断）
 */
export function createExecutionPlan(input: {
  primary: string | undefined;
  fallback: FallbackConfig;
}): RouteExecutionPlan {
  const primary = normalizeRouteSelector(input.primary);
  const mode = input.fallback?.mode ?? "off";

  if (mode === "off") {
    return { primary, attempts: [{ index: 0, selector: primary }], fallback: input.fallback };
  }

  if (mode === "retry") {
    const n = clamp(input.fallback.retryCount ?? 1, 0, MAX_RETRY);
    return {
      primary,
      attempts: Array.from({ length: n + 1 }, (_, i) => ({ index: i, selector: primary })),
      fallback: input.fallback,
    };
  }

  // model-chain
  const models = uniqueSelectors([primary, ...(input.fallback.models ?? []).map((m) => normalizeRouteSelector(m))]);
  const chain = models.length ? models : [primary];
  return {
    primary,
    attempts: (chain as Array<string | undefined>).map((selector, index) => ({ index, selector: selector as string | undefined })),
    fallback: input.fallback,
  };
}

/**
 * 从执行计划中选出第一个可用的模型
 *
 * `extraOk` 用于叠加冷却之外的可用性条件（probe 排除、池归属等）。
 * 必须由本函数逐个尝试判定：若先取"第一个未冷却"的再让调用方单独校验，
 * 链首被 probe 排除时整条链就会被放弃，链中后续健康模型被漏选。
 */
export function pickAvailableModel(
  plan: RouteExecutionPlan,
  cooldowns: CooldownSet,
  extraOk?: (selector: string) => boolean,
): string | undefined {
  for (const attempt of plan.attempts) {
    if (!attempt.selector) continue;
    if (cooldowns.isCooldown(attempt.selector)) continue;
    if (extraOk && !extraOk(attempt.selector)) continue;
    return attempt.selector;
  }
  return undefined;
}
