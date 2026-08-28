/**
 * self-learn 多维评分
 *
 * 键：`scenario × difficulty`，值：模型得分。每次真实结果更新（成败/成本/缓存/handoff 方向）。
 * 收敛到"最适合的模型做最适合的工作"（前端→k3、测试→codex、一般→flash）。
 */
import type { Difficulty, NormalizedSelfLearnConfig, Scenario } from "../types.ts";
import { ModelCatalog } from "../catalog/catalog.ts";

export interface SelfLearnOutcome {
  selector: string;
  scenario: Scenario;
  difficulty: Difficulty;
  success: boolean;
  cost: number;
  cacheRead: number;
  timestamp: number;
}

export class SelfLearnManager {
  private readonly catalog: ModelCatalog;
  private readonly config: NormalizedSelfLearnConfig;

  constructor(catalog: ModelCatalog, config: NormalizedSelfLearnConfig) {
    this.catalog = catalog;
    this.config = config;
  }

  /** 记录一次结果，更新 catalog 得分 */
  record(o: SelfLearnOutcome): void {
    if (!this.config.enabled) return;
    const score =
      (o.success ? this.config.successWeight : 0) +
      (o.success ? 0 : this.config.failureWeight) +
      this.config.costWeight * o.cost +
      // 缓存命中作为正向信号（该模型在此场景缓存友好）
      this.config.costWeight * o.cacheRead * -1 * 0; // costWeight 已含成本惩罚；缓存不加分避免误偏
    // 简化：成功 +1，失败 -2，成本轻惩罚
    const base = o.success ? 1 : -2;
    const adjusted = base + this.config.costWeight * o.cost;
    this.catalog.record(o.selector, o.scenario, o.difficulty, adjusted, this.config.decay);
  }

  /** handoff 学习：from→to，to 加分、from 减分 */
  recordHandoff(from: string, to: string, scenario: Scenario, difficulty: Difficulty): void {
    if (!this.config.enabled) return;
    this.catalog.record(to, scenario, difficulty, 1.5, this.config.decay);
    this.catalog.record(from, scenario, difficulty, -1, this.config.decay);
  }

  /** 查询某 场景×难度 的最佳模型（minSamples 门槛） */
  best(scenario: Scenario, difficulty: Difficulty): string | undefined {
    if (!this.config.enabled) return undefined;
    const ranked = this.catalog.ranked(scenario, difficulty);
    const qualified = ranked.find((r) => r.samples >= this.config.minSamples);
    return qualified?.selector;
  }

  /** 查询某 场景×难度 的排序（调试用） */
  ranked(scenario: Scenario, difficulty: Difficulty) {
    return this.catalog.ranked(scenario, difficulty);
  }
}
