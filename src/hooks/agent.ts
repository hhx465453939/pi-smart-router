/**
 * before_agent_start 钩子：turn 级路由
 * - 构造 TaskFeatures → 决策 → 若有 selector 则 pi.setModel
 * - 记录决策历史、更新状态条
 */
import type { NormalizedRouterConfig, DecisionRecord } from "../types.ts";
import { buildTaskFeatures } from "../context/task.ts";
import { decide } from "../engine/decision.ts";
import type { CompiledRule } from "../engine/rules.ts";
import type { CooldownSet } from "../engine/registry.ts";
import type { CacheManager } from "../engine/cache.ts";
import type { LearningManager } from "../engine/learn.ts";

export interface TurnHookDeps {
  config: NormalizedRouterConfig;
  compiledRules: CompiledRule[];
  cooldowns: CooldownSet;
  cacheManager?: CacheManager;
  learning?: LearningManager;
  sessionId?: string;
  pushDecision(record: DecisionRecord): void;
  setStatus(text: string): void;
  verboseLog(msg: string): void;
}

export interface TurnHookInput {
  prompt: string;
  images?: unknown[];
  systemPromptOptions?: {
    selectedTools?: string[];
    toolSnippets?: unknown[];
  };
  currentModelSelector?: string;
  thinkingLevel?: string;
  messageCount?: number;
  turnIndex?: number;
  contextTokens?: number;
  availableModels: Set<string>;
  deps: TurnHookDeps;
}

export function resolveTurnDecision(input: TurnHookInput): DecisionRecord | undefined {
  const { deps } = input;
  const cfg = deps.config;
  if (!cfg.enabled || cfg.routingLevel === "request") return undefined;

  const features = buildTaskFeatures({
    prompt: input.prompt ?? "",
    images: input.images,
    selectedTools: input.systemPromptOptions?.selectedTools,
    currentModelSelector: input.currentModelSelector,
    thinkingLevel: input.thinkingLevel,
    messageCount: input.messageCount,
    turnIndex: input.turnIndex,
    contextTokens: input.contextTokens,
    explicitModelPrefix: cfg.explicitModelPrefix,
    taskTypeRules: cfg.taskTypeRules,
  });

  // 缓存：跟踪 prompt 前缀（用于多跳保留）
  if (deps.cacheManager && deps.sessionId) {
    deps.cacheManager.trackPrompt(deps.sessionId, features.promptText);
  }

  const decision = decide({
    features,
    config: cfg,
    compiledRules: deps.compiledRules,
    cooldowns: deps.cooldowns,
    availableModels: input.availableModels,
    cacheManager: deps.cacheManager,
    learning: deps.learning,
    sessionId: deps.sessionId,
    promptText: features.promptText,
  });

  if (!decision.selector || decision.source === "keep") return undefined;

  const record: DecisionRecord = {
    ...decision,
    previousSelector: features.currentModel,
    taskType: features.taskType,
    contextTokens: features.contextTokens,
  };

  if (cfg.verbose) deps.verboseLog(`[router] turn → ${decision.selector} (${decision.reason})`);
  return record;
}
