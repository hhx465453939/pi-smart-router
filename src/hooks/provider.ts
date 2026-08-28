/**
 * before_provider_request 钩子：request 级路由（改写 payload.model）
 * 仅当 routingLevel 含 request 时才评估。
 */
import type { NormalizedRouterConfig, DecisionRecord, TaskFeatures } from "../types.ts";
import { buildTaskFeatures } from "../context/task.ts";
import { decide } from "../engine/decision.ts";
import type { CompiledRule } from "../engine/rules.ts";
import type { CooldownSet } from "../engine/registry.ts";
import type { CacheManager } from "../engine/cache.ts";
import type { LearningManager } from "../engine/learn.ts";
import type { SelfLearnManager } from "../engine/selflearn.ts";
import type { AvailabilityProbe } from "../probe/availability.ts";

export interface ProviderHookDeps {
  config: NormalizedRouterConfig;
  compiledRules: CompiledRule[];
  cooldowns: CooldownSet;
  cacheManager?: CacheManager;
  learning?: LearningManager;
  selfLearn?: SelfLearnManager;
  probe?: AvailabilityProbe;
  sessionId?: string;
}

export interface ProviderHookInput {
  payload: Record<string, unknown>;
  currentModelSelector?: string;
  thinkingLevel?: string;
  messageCount?: number;
  turnIndex?: number;
  contextTokens?: number;
  availableModels: Set<string>;
  deps: ProviderHookDeps;
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m?.role === "user") {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return (c as Array<Record<string, unknown>>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");
      }
    }
  }
  return typeof messages === "string" ? String(messages) : "";
}

function hasImageInMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages as Array<Record<string, unknown>>) {
    const c = m?.content;
    if (Array.isArray(c) && (c as Array<Record<string, unknown>>).some((p) => p.type === "image" || p.type === "image_url")) return true;
  }
  return false;
}

export function resolveProviderDecision(input: ProviderHookInput): { selector: string; record: DecisionRecord } | undefined {
  const { deps, payload } = input;
  const cfg = deps.config;
  if (!cfg.enabled || (cfg.routingLevel !== "request" && cfg.routingLevel !== "both")) return undefined;

  const promptText = typeof payload.prompt === "string" ? payload.prompt
    : lastUserText((payload as Record<string, unknown>).messages);

  const images: unknown[] = hasImageInMessages((payload as Record<string, unknown>).messages) ? [{}] : [];
  const requestedModel = typeof payload.model === "string" ? String(payload.model) : undefined;

  const features: TaskFeatures = buildTaskFeatures({
    prompt: promptText,
    images,
    currentModelSelector: input.currentModelSelector ?? requestedModel,
    thinkingLevel: input.thinkingLevel,
    messageCount: input.messageCount,
    turnIndex: input.turnIndex,
    contextTokens: input.contextTokens,
    explicitModelPrefix: cfg.explicitModelPrefix,
    taskTypeRules: cfg.taskTypeRules,
  });

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
    selfLearn: deps.selfLearn,
    probe: deps.probe,
    sessionId: deps.sessionId,
    promptText: features.promptText,
  });

  if (!decision.selector || decision.source === "keep") return undefined;

  const record: DecisionRecord = {
    ...decision,
    previousSelector: features.currentModel ?? requestedModel,
    taskType: features.taskType,
    contextTokens: features.contextTokens,
  };

  return { selector: decision.selector, record };
}
