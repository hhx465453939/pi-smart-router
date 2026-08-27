/**
 * 条件评估引擎
 *
 * 提炼自 claude-code-router 的 routerRuleConditionMatches：
 * 支持等值、数值/字符串比较、in、contains、not-contains、starts-with，
 * 以及 "not" 取反语义。
 */
import type { Condition, ConditionValue, TaskFeatures } from "../types.ts";

/** 从 TaskFeatures 取值（大小写不敏感字段名） */
function fieldValue(features: TaskFeatures, field: string): unknown {
  const key = field.trim();
  const lower = key.toLowerCase();
  switch (lower) {
    case "tasktype": return features.taskType;
    case "toolnames": return features.toolNames;
    case "contexttokens": return features.contextTokens;
    case "messagecount": return features.messageCount;
    case "turnindex": return features.turnIndex;
    case "promptlength": return features.promptLength;
    case "hasimage": return features.hasImage;
    case "explicitmodel": return features.explicitModel;
    case "currentmodel": return features.currentModel;
    case "thinkinglevel": return features.thinkingLevel;
    case "prompt": return features.promptText;
    case "prompttext": return features.promptText;
    default: return undefined;
  }
}

/** 深度包含：在对象/数组/字符串中递归查找值 */
function valueContainsDeep(haystack: unknown, needle: unknown): boolean {
  if (haystack === needle) return true;
  if (Array.isArray(haystack)) {
    return haystack.some((item) => valueContainsDeep(item, needle));
  }
  if (haystack && typeof haystack === "object") {
    return Object.values(haystack).some((item) => valueContainsDeep(item, needle));
  }
  if (typeof haystack === "string" && typeof needle === "string") {
    return haystack.includes(needle);
  }
  return false;
}

/** 浅层包含：字符串 includes 或数组/Set 成员 */
function valueContains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") {
    return typeof needle === "string" && haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    return haystack.some((item) => item === needle);
  }
  return valueContainsDeep(haystack, needle);
}

function comparableText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** 计算单条件表达式：actual (feature 值) 与 spec (条件值) 的匹配 */
function matchValue(actual: unknown, spec: ConditionValue): boolean {
  // 比较对象形式：{ lt, lte, gt, gte, eq, in, not, contains, not-contains, starts-with }
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    const obj = spec as Record<string, unknown>;
    const keys = Object.keys(obj);

    // 取反
    if ("not" in obj) {
      return !matchValue(actual, obj["not"] as ConditionValue);
    }
    // 集合成员
    if ("in" in obj) {
      const list = obj["in"];
      return Array.isArray(list) && list.some((item) => item === actual);
    }
    // 数值/字符串比较
    const numActual = num(actual);
    for (const op of ["lt", "lte", "gt", "gte"] as const) {
      if (op in obj) {
        const bound = num(obj[op]);
        if (numActual === undefined || bound === undefined) return false;
        if (op === "lt") return numActual < bound;
        if (op === "lte") return numActual <= bound;
        if (op === "gt") return numActual > bound;
        return numActual >= bound;
      }
    }
    if ("eq" in obj) {
      return actual === obj["eq"];
    }
    if ("contains" in obj) {
      return valueContains(actual, obj["contains"]);
    }
    if ("not-contains" in obj) {
      return !valueContains(actual, obj["not-contains"]);
    }
    if ("starts-with" in obj) {
      const a = comparableText(actual);
      const b = comparableText(obj["starts-with"]);
      return a !== undefined && b !== undefined && a.startsWith(b);
    }
    return false;
  }

  // 标量形式：等值比较（数组用成员比较）
  if (Array.isArray(actual)) {
    return actual.includes(spec as never);
  }
  return actual === spec;
}

/** 评估一整条 when 条件（字段与字段之间 AND） */
export function evaluateCondition(condition: Condition, features: TaskFeatures): boolean {
  for (const [field, spec] of Object.entries(condition)) {
    const actual = fieldValue(features, field);
    if (!matchValue(actual, spec)) {
      return false;
    }
  }
  return true;
}

/** 评估所有规则，返回命中规则的 id 列表（按 priority 降序） */
export function matchingRules(rules: Array<{ id: string; priority?: number; when: Condition; enabled?: boolean }>, features: TaskFeatures): string[] {
  return rules
    .filter((rule) => rule.enabled !== false && evaluateCondition(rule.when, features))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((rule) => rule.id);
}
