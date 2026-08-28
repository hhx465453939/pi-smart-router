/**
 * 任务难度与场景估算
 *
 * 特征 → 低/中/高 难度；识别前端/后端/测试/运维/研究/文档 场景。
 * 用于"拓荒 vs 攻坚"的模型分配：低难度倾向便宜模型，高难度倾向强模型。
 */
import type { Difficulty, Scenario, TaskFeatures } from "../types.ts";

const CODE_KEYWORDS = ["implement", "function", "class", "api", "fix", "bug", "refactor", "compile", "error", "test", "deploy", "migrate"];
const COMPLEX_KEYWORDS = ["debug", "trace", "stack", "deadlock", "race condition", "performance", "optimize", "architecture", "distributed", "concurrent", "async", "memory leak", "thread", "transaction", "consistency"];
const DEBUG_KEYWORDS = ["debug", "trace", "stack", "log", "crash", "exception", "segfault", "panic", "reproduce", "diagnose"];

/** 场景关键词 */
const SCENARIO_RULES: Record<Exclude<Scenario, "general">, string[]> = {
  frontend: ["frontend", "ui", "react", "vue", "svelte", "component", "css", "html", "jsx", "tsx", "tailwind", "页面", "组件", "样式", "前端"],
  backend: ["backend", "api", "server", "database", "db", "sql", "redis", "mq", "queue", "微服务", "接口", "后端", "schema", "migration", "auth", "oauth"],
  test: ["test", "spec", "unit test", "integration test", "e2e", "mock", "assert", "coverage", "测试", "用例", "pytest", "jest"],
  ops: ["deploy", "ops", "kubernetes", "k8s", "docker", "nginx", "devops", "ci", "pipeline", "monitoring", "grafana", "prometheus", "运维", "部署", "排查"],
  research: ["research", "analyze", "compare", "survey", "paper", "文献", "研究", "调研"],
  document: ["document", "readme", "doc", "explain", "summarize", "write", "文档", "说明", "注释"],
};

/** 估算难度分数（越大越难）
 *  校准目标（默认阈值 low<40≤medium<120≤high）：
 *  - 日常闲聊/简单问答 → < 40（low）
 *  - 普通编码修复（fix bug + edit 工具）→ 40~119（medium）
 *  - 复杂后端 debug/分布式/深度排查 → ≥ 120（high）
 */
export function difficultyScore(f: TaskFeatures): number {
  let score = 0;
  const lower = f.promptText.toLowerCase();
  // 复杂/调试关键词（强信号）
  for (const kw of COMPLEX_KEYWORDS) if (lower.includes(kw)) score += 12;
  for (const kw of DEBUG_KEYWORDS) if (lower.includes(kw)) score += 8;
  // 普通代码关键词：命中计数制 —— ≥2 个即正经编码任务
  let codeHits = 0;
  for (const kw of CODE_KEYWORDS) if (lower.includes(kw)) codeHits += 1;
  if (codeHits >= 4) score += 36;
  else if (codeHits >= 2) score += 18;
  else if (codeHits === 1) score += 3;
  // 上下文越大越难
  if (f.contextTokens !== undefined) {
    if (f.contextTokens > 80000) score += 15;
    else if (f.contextTokens > 20000) score += 8;
    else if (f.contextTokens > 5000) score += 3;
  }
  // 代码工具 + 多轮迭代
  if (f.toolNames.some((t) => ["bash", "edit", "write"].includes(t))) score += 6;
  if (f.turnIndex >= 4) score += 5;
  else if (f.turnIndex >= 2) score += 2;
  // prompt 越长越复杂
  if (f.promptLength > 1000) score += 6;
  else if (f.promptLength > 300) score += 3;
  return score;
}

export function classifyDifficulty(score: number, lowThreshold: number, highThreshold: number): Difficulty {
  if (score >= highThreshold) return "high";
  if (score >= lowThreshold) return "medium";
  return "low";
}

/** 识别任务场景（取命中最多的，默认 general） */
export function detectScenario(f: TaskFeatures): Scenario {
  const lower = f.promptText.toLowerCase();
  let best: Scenario = "general";
  let bestCount = 0;
  for (const [scenario, keywords] of Object.entries(SCENARIO_RULES) as Array<[Exclude<Scenario, "general">, string[]]>) {
    let count = 0;
    for (const kw of keywords) if (lower.includes(kw.toLowerCase())) count += 1;
    if (count > bestCount) { bestCount = count; best = scenario; }
  }
  return best;
}

/** 组合：输入特征 → { difficulty, scenario, score } */
export function analyzeTask(f: TaskFeatures, lowThreshold: number, highThreshold: number): { difficulty: Difficulty; scenario: Scenario; score: number } {
  const score = difficultyScore(f);
  return { difficulty: classifyDifficulty(score, lowThreshold, highThreshold), scenario: detectScenario(f), score };
}
