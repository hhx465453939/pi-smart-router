/**
 * 自适应学习路由 — LearningManager
 *
 * 记录每轮实际结果（成本、缓存命中、成败），按 taskType 累计得分，
 * `preferred(taskType)` 返回得分最高模型。失败强惩罚、minSamples 门槛、windowSize 上限。
 */
import type { LearnConfig, LearnOutcome, LearnScore, NormalizedLearnConfig } from "../types.ts";

interface ModelState {
  score: number;
  samples: number;
}

export class LearningManager {
  private readonly states = new Map<string, Map<string, ModelState>>();

  /** 记录一次结果并更新得分 */
  recordOutcome(outcome: LearnOutcome, config: NormalizedLearnConfig): void {
    if (!config.enabled) return;
    const byTask = this.states.get(outcome.taskType) ?? new Map<string, ModelState>();
    const st = byTask.get(outcome.selector) ?? { score: 0, samples: 0 };
    // 得分增量：成功加权 + 失败强惩罚 + 缓存命中加成 + 成本惩罚
    const delta =
      (outcome.success ? config.successWeight : 0) +
      (outcome.success ? 0 : config.failureWeight) +
      config.cacheWeight * outcome.cacheRead +
      config.costWeight * outcome.cost;
    st.score += delta;
    st.samples += 1;
    byTask.set(outcome.selector, st);
    this.states.set(outcome.taskType, byTask);
    this.trim(outcome.taskType, byTask, config);
  }

  /** 记录一次失败（未走完整 usage 时快速降权） */
  recordFailure(taskType: string, selector: string, config: NormalizedLearnConfig): void {
    this.recordOutcome({
      taskType,
      selector,
      cost: 0,
      cacheRead: 0,
      success: false,
      timestamp: Date.now(),
    }, config);
  }

  /** 返回某 taskType 得分最高模型（需过 minSamples 门槛） */
  preferred(taskType: string, config: NormalizedLearnConfig): string | undefined {
    const byTask = this.states.get(taskType);
    if (!byTask || byTask.size === 0) return undefined;
    let best: { selector: string; st: ModelState } | undefined;
    for (const [selector, st] of byTask) {
      if (st.samples < config.minSamples) continue;
      if (!best || st.score > best.st.score) best = { selector, st };
    }
    return best?.selector;
  }

  /** 某 taskType 全部模型得分（降序，调试/展示用） */
  scoresFor(taskType: string): LearnScore[] {
    const byTask = this.states.get(taskType);
    if (!byTask) return [];
    return [...byTask.entries()]
      .map(([selector, st]) => ({ selector, score: st.score, samples: st.samples }))
      .sort((a, b) => b.score - a.score);
  }

  /** 所有 taskType 的得分概览 */
  all(): Array<{ taskType: string; scores: LearnScore[] }> {
    return [...this.states.entries()].map(([taskType, byTask]) => ({
      taskType,
      scores: [...byTask.entries()].map(([selector, st]) => ({ selector, score: st.score, samples: st.samples })),
    }));
  }

  clear(): void {
    this.states.clear();
  }

  private trim(taskType: string, byTask: Map<string, ModelState>, config: NormalizedLearnConfig): void {
    if (byTask.size <= config.windowSize) return;
    // 保留得分最高的 windowSize 个
    const sorted = [...byTask.entries()].sort((a, b) => b[1].score - a[1].score);
    const next = new Map(sorted.slice(0, config.windowSize));
    this.states.set(taskType, next);
  }
}

/** 从 LearnConfig 构建归一化（供默认路径使用） */
export function normalizeLearn(config: LearnConfig | undefined): NormalizedLearnConfig {
  return {
    enabled: config?.enabled !== false,
    windowSize: Number.isFinite(config?.windowSize as number) ? Math.max(1, Math.trunc(config!.windowSize as number)) : 50,
    minSamples: Number.isFinite(config?.minSamples as number) ? Math.max(1, Math.trunc(config!.minSamples as number)) : 2,
    successWeight: Number.isFinite(config?.successWeight as number) ? (config!.successWeight as number) : 1.0,
    failureWeight: Number.isFinite(config?.failureWeight as number) ? (config!.failureWeight as number) : -2.0,
    cacheWeight: Number.isFinite(config?.cacheWeight as number) ? (config!.cacheWeight as number) : 0.0005,
    costWeight: Number.isFinite(config?.costWeight as number) ? (config!.costWeight as number) : -0.0001,
  };
}
