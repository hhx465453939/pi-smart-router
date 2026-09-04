/**
 * 模型选择器归一化与冷却集合
 *
 * 提炼自 claude-code-router 的 normalizeRouteSelector / parseProviderModelSelector：
 * - "provider, model" → "provider/model"
 * - "provider/model" → { provider, model }
 * - 大小写不敏感匹配
 */
import type { CooldownEntry } from "../types.ts";

/** 归一化路由选择器：兼容 "provider, model" 逗号写法 */
export function normalizeRouteSelector(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex > 0 && commaIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, commaIndex).trim();
    const model = trimmed.slice(commaIndex + 1).trim();
    return provider && model ? `${provider}/${model}` : undefined;
  }
  return trimmed;
}

/** 解析 "provider/model" → { provider, model } */
export function parseProviderModelSelector(value: string | undefined): { model: string; provider: string } | undefined {
  const normalized = normalizeRouteSelector(value);
  if (!normalized) return undefined;
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator >= normalized.length - 1) return undefined;
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  return provider && model ? { model, provider } : undefined;
}

/** 比较选择器是否等价（大小写不敏感 + 忽略空白） */
export function selectorsEqual(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeRouteSelector(a)?.toLowerCase().replace(/\s+/g, "");
  const nb = normalizeRouteSelector(b)?.toLowerCase().replace(/\s+/g, "");
  if (!na || !nb) return false;
  return na === nb;
}

/** 冷却集合：管理模型冷却状态 */
export class CooldownSet {
  private readonly entries = new Map<string, CooldownEntry>();

  /** 标记模型冷却，selector 归一化后存储 */
  add(selector: string, durationMs: number, reason: string): void {
    const key = normalizeRouteSelector(selector)?.toLowerCase();
    if (!key) return;
    this.entries.set(key, { selector, until: Date.now() + durationMs, reason });
  }

  /** 手动清除冷却 */
  clear(selector: string): boolean {
    const key = normalizeRouteSelector(selector)?.toLowerCase();
    if (!key) return false;
    return this.entries.delete(key);
  }

  clearAll(): void {
    this.entries.clear();
  }

  /** 查询冷却信息（含过期清理） */
  get(selector: string): CooldownEntry | undefined {
    const key = normalizeRouteSelector(selector)?.toLowerCase();
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** 是否处于冷却 */
  isCooldown(selector: string): boolean {
    return this.get(selector) !== undefined;
  }

  /** 冷却剩余毫秒数；未在冷却返回 0（供"候选全灭时赦免最先恢复者"排序用） */
  remainingMs(selector: string): number {
    const entry = this.get(selector);
    if (!entry) return 0;
    return Math.max(0, entry.until - Date.now());
  }

  /** 当前所有有效冷却（含已清理过期项） */
  all(): CooldownEntry[] {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.until <= now) this.entries.delete(key);
    }
    return [...this.entries.values()];
  }
}
