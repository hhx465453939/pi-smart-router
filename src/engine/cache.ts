/**
 * 缓存感知的路由 — CacheManager
 *
 * 继承 pi 优秀的缓存机制（sessionId 前缀缓存），在多模型转运中保留 cache：
 * - 跟踪每模型的公共前缀长度与命中率
 * - 决策时偏好缓存命中高的模型
 * - 粘滞（sticky）：同 taskType 连续轮次保持同一模型以保缓存
 * - 多跳转运：fallback 链共享同一 sessionId 前缀
 */
import type { CacheRecord, NormalizedRouterConfig } from "../types.ts";

/** 估算切换丢失的缓存 token（公共前缀字符 → token 粗估：~4 字符/token） */
export function churnTokens(commonPrefixChars: number): number {
  return Math.round(commonPrefixChars / 4);
}

function hashPrompt(text: string): string {
  // 轻量 hash：前 4K 字符的简单哈希，避免大文本开销
  const slice = text.slice(0, 4096);
  let h = 5381;
  for (let i = 0; i < slice.length; i++) h = ((h << 5) + h) ^ slice.charCodeAt(i);
  return (h >>> 0).toString(36);
}

export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export class CacheManager {
  private readonly records = new Map<string, CacheRecord>();
  private lastPromptBySession = new Map<string, string>();
  private lastDecision: { taskType: string; selector: string; at: number } | null = null;

  /** 记录 prompt 前缀，用于下次计算公共前缀 */
  trackPrompt(sessionId: string, promptText: string): void {
    if (!sessionId) return;
    this.lastPromptBySession.set(sessionId, promptText);
  }

  /** compaction 后重置前缀：旧前缀不再有效，清空 lastPrompt 并将 commonPrefixChars 降 0 */
  invalidatePrefix(): void {
    this.lastPromptBySession.clear();
    for (const rec of this.records.values()) {
      rec.commonPrefixChars = 0;
    }
  }

  /** 回填 usage 后的缓存统计 */
  recordUsage(selector: string, sessionId: string, promptText: string, usage: { cacheRead?: number; cacheWrite?: number }): void {
    if (!selector || !sessionId) return;
    const key = selector.toLowerCase();
    const prevPrompt = this.lastPromptBySession.get(sessionId) ?? "";
    const prefixChars = prevPrompt ? commonPrefixLength(prevPrompt, promptText) : promptText.length;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const total = cacheRead + cacheWrite;
    const hitRate = total > 0 ? cacheRead / total : prefixChars > 0 ? Math.min(1, prefixChars / Math.max(1, promptText.length)) : 0;

    const existing = this.records.get(key);
    const merged: CacheRecord = {
      selector,
      sessionId,
      promptHash: hashPrompt(promptText),
      commonPrefixChars: prefixChars,
      cacheRead,
      cacheWrite,
      hitRate: existing ? (existing.hitRate * 0.7 + hitRate * 0.3) : hitRate,
      updatedAt: Date.now(),
    };
    this.records.set(key, merged);
    this.lastPromptBySession.set(sessionId, promptText);
  }

  /** 估算候选模型的缓存命中 */
  estimate(selector: string, sessionId: string, promptText: string): { commonPrefixChars: number; hitRate: number } {
    const key = selector.toLowerCase();
    const rec = this.records.get(key);
    if (!rec || rec.sessionId !== sessionId) {
      // 无历史，基于当前前缀估算
      const prev = this.lastPromptBySession.get(sessionId) ?? "";
      const prefix = prev ? commonPrefixLength(prev, promptText) : 0;
      return { commonPrefixChars: prefix, hitRate: 0 };
    }
    // 若 prompt 变化，重新估算前缀
    const prev = this.lastPromptBySession.get(sessionId) ?? "";
    const prefix = prev ? commonPrefixLength(prev, promptText) : rec.commonPrefixChars;
    return { commonPrefixChars: prefix, hitRate: rec.hitRate };
  }

  /** 在候选集中按缓存偏好排序（不改变优先级，仅在同优先级或 fallback 时生效） */
  rankCandidates(candidates: string[], sessionId: string, promptText: string, config: NormalizedRouterConfig): string[] {
    if (!config.cache.enabled || !config.cache.preferCache || candidates.length <= 1) return candidates;
    const scored = candidates.map((sel) => {
      const est = this.estimate(sel, sessionId, promptText);
      const isWarm = est.commonPrefixChars >= config.cache.minHitChars;
      return { sel, ...est, isWarm, score: est.hitRate * 1000 + est.commonPrefixChars };
    });
    // 仅当有显著差异时才重排，避免破坏优先级语义：按 score 降序，但保留原始 priority 的稳定排序
    scored.sort((a, b) => b.score - a.score);
    // 若最高分与最低分差距很小（< 512 字符或 <0.1 hitRate），保持原序以尊重优先级
    const maxScore = scored[0]?.score ?? 0;
    const minScore = scored[scored.length - 1]?.score ?? 0;
    if (maxScore - minScore < 512) return candidates;
    return scored.map((s) => s.sel);
  }

  /** 粘滞：同 taskType 在 TTL 内优先保持 */
  stickyPreferred(currentTaskType: string, config: NormalizedRouterConfig): string | undefined {
    if (!config.cache.enabled || !config.cache.sticky || !this.lastDecision) return undefined;
    if (this.lastDecision.taskType !== currentTaskType) return undefined;
    if (Date.now() - this.lastDecision.at > config.cache.stickyTtlMs) return undefined;
    return this.lastDecision.selector;
  }

  recordDecision(taskType: string, selector: string): void {
    this.lastDecision = { taskType, selector, at: Date.now() };
  }

  getRecords(): CacheRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getRecord(selector: string): CacheRecord | undefined {
    return this.records.get(selector.toLowerCase());
  }

  clear(): void {
    this.records.clear();
    this.lastPromptBySession.clear();
    this.lastDecision = null;
  }
}
