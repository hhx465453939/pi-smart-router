/**
 * 路由规则编译与匹配（优先级排序 + 诊断）
 */
import type { RouterRule, NormalizedRouterConfig, TaskFeatures } from "../types.ts";
import { evaluateCondition } from "./conditions.ts";

export interface CompiledRule {
  rule: RouterRule;
  priority: number;
  active: boolean;
  diagnostics: string[];
}

/** 编译规则：校验、归一化优先级、生成诊断 */
export function compileRules(rules: RouterRule[] | undefined): { compiled: CompiledRule[]; diagnostics: string[] } {
  const allDiagnostics: string[] = [];
  const compiled: CompiledRule[] = (rules ?? []).map((rule) => {
    const diagnostics: string[] = [];
    if (!rule.id?.trim()) diagnostics.push(`rule missing id: ${rule.name ?? JSON.stringify(rule.when)}`);
    if (!rule.model?.trim()) diagnostics.push(`rule "${rule.id}" missing model`);
    if (!rule.when || typeof rule.when !== "object" || Object.keys(rule.when).length === 0) {
      diagnostics.push(`rule "${rule.id}" has empty when`);
    }
    const priority = Number.isFinite(rule.priority as number) ? (rule.priority as number) : 0;
    const active = rule.enabled !== false && diagnostics.length === 0;
    if (!active && diagnostics.length) allDiagnostics.push(...diagnostics);
    return { rule, priority, active, diagnostics };
  });

  compiled.sort((a, b) => b.priority - a.priority);
  return { compiled, diagnostics: allDiagnostics };
}

/** 匹配命中规则（按优先级返回首个） */
export function matchFirstRule(compiled: CompiledRule[], features: TaskFeatures): RouterRule | undefined {
  for (const entry of compiled) {
    if (!entry.active) continue;
    try {
      if (evaluateCondition(entry.rule.when, features)) return entry.rule;
    } catch {
      // 条件异常视为不命中
    }
  }
  return undefined;
}

/** 返回所有命中规则（调试用） */
export function matchAllRules(compiled: CompiledRule[], features: TaskFeatures): RouterRule[] {
  const out: RouterRule[] = [];
  for (const entry of compiled) {
    if (!entry.active) continue;
    try {
      if (evaluateCondition(entry.rule.when, features)) out.push(entry.rule);
    } catch {
      // ignore
    }
  }
  return out;
}

/** 工具：从归一化配置得到已排序的活跃规则 */
export function compiledFromConfig(config: NormalizedRouterConfig): CompiledRule[] {
  return compileRules(config.rules).compiled;
}
