/**
 * auto-profiling — 模型自动画像与性价比评分
 *
 * 遍历所有已注册模型，从 registry 元数据自动生成画像：
 *   价格档 / 能力档 / 速度档 / 长上下文 / 多模态 / value score
 * 让路由"看见"全部模型（无需手写规则），self-learn 实测在其上修正。
 */
import type { Difficulty } from "../types.ts";

export interface ModelProfile {
  selector: string;
  provider: string;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  reasoning: boolean;
  priceTier: "cheap" | "medium" | "expensive";
  capabilityTier: "low" | "medium" | "high";
  speed: "fast" | "normal";
  vision: boolean;
  longContext: boolean;
}

export interface RegistryModel {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number };
  input?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
}

export function priceTier(costInput: number): ModelProfile["priceTier"] {
  if (costInput < 0.5) return "cheap";
  if (costInput < 5) return "medium";
  return "expensive";
}

export function capabilityTier(id: string, reasoning: boolean, price: number): ModelProfile["capabilityTier"] {
  const lower = id.toLowerCase();
  // 强能力信号
  const strong = /(pro|codex|k3|k2\.[0-9]|max|sol|opus|sonnet|deepseek-v4-pro)/.test(lower);
  const weak = /(flash|highspeed|mini|lite|contributor|free|spark|muse)/.test(lower);
  if (weak && !strong) return "low";
  if (strong || (reasoning && price >= 5)) return "high";
  return "medium";
}

export function isFast(id: string): boolean {
  return /(flash|highspeed|mini|1m|fast|quick|lite)/.test(id.toLowerCase());
}

export function isVision(input: string[] | undefined, id: string): boolean {
  if (Array.isArray(input) && input.includes("image")) return true;
  return /(vision|v\d|gemini|gpt-4o|flash-vision)/.test(id.toLowerCase());
}

/** 生成单个模型画像 */
export function profileModel(m: RegistryModel): ModelProfile {
  const selector = `${m.provider}/${m.id}`;
  const costInput = m.cost?.input ?? 0;
  const contextWindow = m.contextWindow ?? 0;
  return {
    selector,
    provider: m.provider,
    costInput,
    costOutput: m.cost?.output ?? 0,
    costCacheRead: m.cost?.cacheRead ?? 0,
    contextWindow,
    maxTokens: m.maxTokens ?? 0,
    input: m.input ?? ["text"],
    reasoning: m.reasoning ?? false,
    priceTier: priceTier(costInput),
    capabilityTier: capabilityTier(m.id, m.reasoning ?? false, costInput),
    speed: isFast(m.id) ? "fast" : "normal",
    vision: isVision(m.input, m.id),
    longContext: contextWindow >= 200000,
  };
}

/**
 * 价值评分：难度适配的性价比
 *   low/medium 难度：便宜快 → high score；贵模型 → 低 score
 *   high 难度：能力优先（reasoning/强档），价格其次
 */
export function valueScore(p: ModelProfile, difficulty: Difficulty, selftune: number): number {
  let score = 0;
  if (difficulty === "high") {
    // 攻坚：能力 > 价格
    score += p.capabilityTier === "high" ? 100 : p.capabilityTier === "medium" ? 60 : 20;
    if (p.reasoning) score += 30;
    score -= p.priceTier === "expensive" ? 15 : p.priceTier === "medium" ? 5 : 0;
    if (p.longContext) score += 10;
  } else {
    // 拓荒：便宜快 > 能力
    score += p.priceTier === "cheap" ? 100 : p.priceTier === "medium" ? 55 : 10;
    score += p.speed === "fast" ? 25 : 0;
    if (p.capabilityTier === "high") score -= 45; // 杀鸡不用牛刀
  }
  if (p.vision) score += 5;
  return score + selftune;
}

/** 全局 rank：对给定难度排序所有模型（value score 降序） */
export function rankModels(profiles: ModelProfile[], difficulty: Difficulty, selftune: (sel: string) => number): ModelProfile[] {
  return [...profiles]
    .map((p) => ({ p, score: valueScore(p, difficulty, selftune(p.selector)) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}