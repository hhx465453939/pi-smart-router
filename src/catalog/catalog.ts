/**
 * 模型能力快照 — ModelCatalog
 *
 * 唯一事实源：合并 pi modelRegistry 基础字段（context/cost/input）+ 用户标注（场景/难度/评价）+ self-learn 得分。
 * 持久化到 ~/.pi/agent/pi-router-catalog.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Difficulty, ModelCatalogEntry, Scenario } from "../types.ts";

export interface RegistryModelInfo {
  selector: string;
  provider: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number };
  input?: string[];
}

export class ModelCatalog {
  private entries = new Map<string, ModelCatalogEntry>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as ModelCatalogEntry[];
      this.entries = new Map();
      for (const e of raw) if (e?.selector) this.entries.set(e.selector.toLowerCase(), e);
    } catch { /* 损坏时重建 */ this.entries = new Map(); }
  }

  /** 合并 registry 信息，保留既有 learnScore/用户标注 */
  merge(registry: RegistryModelInfo[]): void {
    for (const info of registry) {
      const key = info.selector.toLowerCase();
      const existing = this.entries.get(key);
      const entry: ModelCatalogEntry = {
        selector: info.selector,
        provider: info.provider,
        contextWindow: existing?.contextWindow ?? info.contextWindow,
        cost: existing?.cost ?? info.cost,
        input: existing?.input ?? info.input,
        scenarios: existing?.scenarios ?? [],
        difficultyTier: existing?.difficultyTier,
        note: existing?.note,
        learnScore: existing?.learnScore ?? {},
        samples: existing?.samples ?? {},
        lastSeen: Date.now(),
      };
      this.entries.set(key, entry);
    }
    this.save();
  }

  save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.entries.values()], null, 2), "utf8");
    } catch { /* 静默失败：内存态仍可用 */ }
  }

  get(selector: string): ModelCatalogEntry | undefined {
    return this.entries.get(selector.toLowerCase());
  }

  /** 用户标注：场景/难度/评价 */
  annotate(selector: string, patch: Partial<Pick<ModelCatalogEntry, "scenarios" | "difficultyTier" | "note">>): ModelCatalogEntry | undefined {
    const key = selector.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (patch.scenarios) entry.scenarios = patch.scenarios;
    if (patch.difficultyTier) entry.difficultyTier = patch.difficultyTier;
    if (patch.note !== undefined) entry.note = patch.note;
    this.save();
    return entry;
  }

  /** self-learn 更新得分：key = `${scenario}×${difficulty}` */
  record(selector: string, scenario: Scenario, difficulty: Difficulty, score: number, decay: number): void {
    const key = selector.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return;
    const k = `${scenario}×${difficulty}`;
    entry.learnScore[k] = (entry.learnScore[k] ?? 0) * decay + score;
    entry.samples[k] = (entry.samples[k] ?? 0) + 1;
    entry.lastSeen = Date.now();
    this.save();
  }

  /** 查询某 场景×难度 的模型得分（降序） */
  ranked(scenario: Scenario, difficulty: Difficulty): Array<{ selector: string; score: number; samples: number }> {
    const k = `${scenario}×${difficulty}`;
    const out: Array<{ selector: string; score: number; samples: number }> = [];
    for (const e of this.entries.values()) {
      const score = e.learnScore[k] ?? 0;
      if (score === 0 && !e.scenarios.includes(scenario)) continue;
      out.push({ selector: e.selector, score, samples: e.samples[k] ?? 0 });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  all(): ModelCatalogEntry[] {
    return [...this.entries.values()];
  }

  /** 从 registry 生成初始条目（若文件为空） */
  ensureSeed(registry: RegistryModelInfo[]): void {
    if (this.entries.size > 0) return;
    this.merge(registry);
  }
}
