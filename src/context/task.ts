/**
 * 从 pi turn 上下文提取任务特征
 *
 * 适配 pi 的 before_agent_start / ExtensionContext（含 modelRegistry、model、thinkingLevel、sessionManager）。
 * 任务类型分类采用关键词规则（taskTypeRules），promptText + 显式 @model: 解析。
 */
import type { TaskFeatures, TaskType, NormalizedRouterConfig } from "../types.ts";

/** 默认任务类型关键词（可用配置覆盖/扩展） */
export const DEFAULT_TASK_TYPE_RULES: Record<TaskType, string[]> = {
  code: ["implement", "fix", "bug", "refactor", "function", "api", "test", "type", "error", "compile", "stack", "trace", "exception", "class", "interface", "module", "import", "export", "hook", "handler", "middleware", "route", "endpoint", "database", "migrate", "schema"],
  document: ["document", "readme", "doc", "explain", "summarize", "write", "draft", "proposal", "report", "describe", "overview", "guide", "tutorial", "changelog"],
  research: ["research", "investigate", "analyze", "compare", "find", "search", "explore", "survey", "collect", "audit", "review", "evaluate", "assess", "benchmark"],
  analysis: ["why", "reason", "root cause", "diagnose", "debug", "trace", "profile", "measure", "metric", "stat", "trend", "correlate", "regression", "insight"],
  translate: ["translate", "translation", "翻译", "本地化", "i18n"],
  general: [],
};

const CODE_TOOLS = new Set(["bash", "edit", "write", "grep", "find", "ls", "read", "powershell"]);

export interface BuildFeaturesInput {
  prompt: string;
  images?: unknown[];
  selectedTools?: string[];
  toolNames?: string[];
  /** 从 ctx.model 推断，如 "anthropic/claude-sonnet-4-5" */
  currentModelSelector?: string;
  thinkingLevel?: string;
  messageCount?: number;
  turnIndex?: number;
  contextTokens?: number;
  explicitModelPrefix: string;
  taskTypeRules: Partial<Record<TaskType, string[]>>;
}

export function classifyTaskType(promptText: string, rules: Partial<Record<TaskType, string[]>>): TaskType {
  const lower = promptText.toLowerCase();
  const effective: Record<TaskType, string[]> = {
    code: rules.code ?? DEFAULT_TASK_TYPE_RULES.code,
    document: rules.document ?? DEFAULT_TASK_TYPE_RULES.document,
    research: rules.research ?? DEFAULT_TASK_TYPE_RULES.research,
    analysis: rules.analysis ?? DEFAULT_TASK_TYPE_RULES.analysis,
    translate: rules.translate ?? DEFAULT_TASK_TYPE_RULES.translate,
    general: [],
  };
  const scores: Record<TaskType, number> = { code: 0, document: 0, research: 0, analysis: 0, translate: 0, general: 0 };
  for (const type of ["code", "document", "research", "analysis", "translate"] as TaskType[]) {
    for (const kw of effective[type] ?? []) {
      if (!kw) continue;
      if (lower.includes(kw.toLowerCase())) scores[type] += 1;
    }
  }
  let best: TaskType = "general";
  let bestScore = 0;
  for (const t of ["code", "document", "research", "analysis", "translate"] as TaskType[]) {
    if (scores[t] > bestScore) { bestScore = scores[t]; best = t; }
  }
  return best;
}

export function extractExplicitModel(promptText: string, prefix: string): string | undefined {
  if (!promptText || !prefix) return undefined;
  const idx = promptText.indexOf(prefix);
  if (idx === -1) return undefined;
  const tail = promptText.slice(idx + prefix.length).trim();
  if (!tail) return undefined;
  const token = tail.split(/\s+/)[0]?.trim();
  if (!token || token.length < 2) return undefined;
  // 去掉尾随标点
  return token.replace(/[.,;!?)]+$/g, "").trim() || undefined;
}

export function buildTaskFeatures(input: BuildFeaturesInput): TaskFeatures {
  const promptText = input.prompt ?? "";
  const explicitModel = extractExplicitModel(promptText, input.explicitModelPrefix);
  const taskType = classifyTaskType(promptText, input.taskTypeRules);
  const toolNames = (input.selectedTools ?? input.toolNames ?? []).map((t) => String(t));
  const hasImage = Array.isArray(input.images) && input.images.length > 0;
  return {
    taskType,
    toolNames,
    contextTokens: input.contextTokens,
    messageCount: input.messageCount ?? 0,
    turnIndex: input.turnIndex ?? 1,
    promptLength: promptText.length,
    hasImage,
    explicitModel,
    currentModel: input.currentModelSelector,
    thinkingLevel: input.thinkingLevel,
    promptText,
  };
}

/** 是否属于编码任务（快捷判断） */
export function isCodeTask(f: TaskFeatures): boolean {
  if (f.taskType === "code") return true;
  return f.toolNames.some((t) => CODE_TOOLS.has(t));
}
