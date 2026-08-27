/**
 * pi-smart-router — 核心类型定义
 *
 * 数据契约（engine 层与 pi API 解耦，仅 hooks 层依赖 pi）。
 * 逻辑提炼自 claude-code-router 的路由决策模型。
 */

/** 任务类型（基于 prompt 关键词分类） */
export type TaskType = "code" | "document" | "research" | "analysis" | "translate" | "general";

/** 从 pi turn 上下文提取的任务特征 */
export interface TaskFeatures {
  /** 分类后的任务类型 */
  taskType: TaskType;
  /** 当前使用的工具名集合 */
  toolNames: string[];
  /** 上下文 token 估算（undefined 表示未知） */
  contextTokens: number | undefined;
  /** 消息总数 */
  messageCount: number;
  /** 当前轮次序号（从 1 开始） */
  turnIndex: number;
  /** prompt 文本长度（字符） */
  promptLength: number;
  /** 是否包含图片输入 */
  hasImage: boolean;
  /** 用户显式指定的模型选择器（如 "anthropic/claude-opus-4-5"），无则 undefined */
  explicitModel: string | undefined;
  /** 当前模型选择器（provider/model） */
  currentModel: string | undefined;
  /** 当前思考级别 */
  thinkingLevel: string | undefined;
  /** 附加原始 prompt 文本（供条件 contains 等使用） */
  promptText: string;
}

/** 条件操作符（对应 CCR 的 RouterRuleOperator 子集，语义相同） */
export type ConditionOperator =
  | "eq" | "neq"      // == / !=
  | "lt" | "lte" | "gt" | "gte"  // 数值/字符串比较
  | "in"              // 属于集合
  | "contains"        // 字符串/数组包含
  | "not-contains"
  | "starts-with";

/** 单个条件：{ 字段: 值 } 或 { 字段: { 操作符: 值 } } */
export type Condition =
  | Record<string, ConditionValue>;

/** 条件值：标量 / 比较对象 / 集合 */
export type ConditionValue =
  | string | number | boolean
  | { in?: unknown[]; not?: unknown }
  | { lt?: number; lte?: number; gt?: number; gte?: number; eq?: unknown }
  | { contains?: unknown; "not-contains"?: unknown; "starts-with"?: string };

/** 缓存配置 */
export interface CacheConfig {
  enabled?: boolean;
  preferCache?: boolean;
  minHitChars?: number;
  sticky?: boolean;
  stickyTtlMs?: number;
}

/** 归一化缓存配置 */
export interface NormalizedCacheConfig {
  enabled: boolean;
  preferCache: boolean;
  minHitChars: number;
  sticky: boolean;
  stickyTtlMs: number;
}

/** 缓存记录（每模型） */
export interface CacheRecord {
  selector: string;
  sessionId: string;
  promptHash: string;
  commonPrefixChars: number;
  cacheRead: number;
  cacheWrite: number;
  hitRate: number;
  updatedAt: number;
}

/** 路由规则 */
export interface RouterRule {
  id: string;
  name?: string;
  /** 优先级，数值越大越先评估 */
  priority?: number;
  /** 条件（字段名 → 条件值），全部匹配才命中 */
  when: Condition;
  /** 目标模型选择器 "provider/model" 或 "model" */
  model: string;
  /** 命中后是否同时更新思考级别（可选） */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 规则开关 */
  enabled?: boolean;
  /** 是否参与缓存偏好排序（默认 true） */
  cacheAware?: boolean;
}

/** fallback 模式 */
export type FallbackMode = "off" | "retry" | "model-chain";

/** fallback 配置 */
export interface FallbackConfig {
  mode: FallbackMode;
  retryCount?: number;
  models?: string[];
}

/** 失败分类 */
export type FailureClass = "rate-limit" | "retryable" | "server" | "client";

/** 失败决策 */
export interface FailureDecision {
  failureClass: FailureClass;
  shouldFallback: boolean;
}

/** 冷却条目 */
export interface CooldownEntry {
  selector: string;
  until: number;
  reason: string;
}

/** 路由决策结果 */
export interface RouteDecision {
  /** 决策出的模型选择器 */
  selector: string | undefined;
  /** 决策原因（人类可读） */
  reason: string;
  /** 命中规则 id（若有） */
  ruleId: string | undefined;
  /** 决策来源 */
  source: "explicit" | "cooldown-avoid" | "rule" | "default" | "keep";
  /** 决策时间戳 */
  timestamp: number;
}

/** 决策历史条目（持久化到会话） */
export interface DecisionRecord extends RouteDecision {
  previousSelector: string | undefined;
  taskType: TaskType;
  contextTokens: number | undefined;
}

/** 完整配置（pi-router.json） */
export interface RouterConfig {
  cache?: CacheConfig;
  enabled?: boolean;
  defaultModel?: string;
  /** turn | request | both */
  routingLevel?: "turn" | "request" | "both";
  cooldownMs?: number;
  failure?: {
    cooldownOnStatus?: number[];
    cooldownOnToolErrorPatterns?: string[];
  };
  taskTypeRules?: Partial<Record<TaskType, string[]>>;
  rules?: RouterRule[];
  fallback?: FallbackConfig;
  explicitModelPrefix?: string;
  verbose?: boolean;
}

/** 归一化后的配置（默认值已填充） */
export interface NormalizedRouterConfig {
  cache: NormalizedCacheConfig;
  enabled: boolean;
  defaultModel: string | undefined;
  routingLevel: "turn" | "request" | "both";
  cooldownMs: number;
  cooldownOnStatus: number[];
  cooldownOnToolErrorPatterns: RegExp[];
  taskTypeRules: Partial<Record<TaskType, string[]>>;
  rules: RouterRule[];
  fallback: FallbackConfig;
  explicitModelPrefix: string;
  verbose: boolean;
}
