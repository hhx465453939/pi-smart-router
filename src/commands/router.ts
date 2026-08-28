/**
 * /router 命令：状态、规则、冷却、最近决策
 * 通过 ExtensionCommandContext 的 ui 与 sessionManager 交互。
 */
import type { NormalizedRouterConfig, DecisionRecord } from "../types.ts";
import type { CooldownSet } from "../engine/registry.ts";
import type { CompiledRule } from "../engine/rules.ts";
import type { CacheManager } from "../engine/cache.ts";
import type { LearningManager } from "../engine/learn.ts";

export interface RouterCommandDeps {
  getConfig(): NormalizedRouterConfig;
  reloadConfig(): NormalizedRouterConfig;
  recompileRules(): CompiledRule[];
  cooldowns: CooldownSet;
  cacheManager?: CacheManager;
  learning?: LearningManager;
  getHistory(): DecisionRecord[];
  clearHistory(): void;
  getCurrentModel(): string | undefined;
  getAvailableModels(): string[];
}

export function formatStatus(deps: RouterCommandDeps): string {
  const cfg = deps.getConfig();
  const lines: string[] = [];
  lines.push(`pi-smart-router ${cfg.enabled ? "✅ enabled" : "⏸️  disabled"}  (level=${cfg.routingLevel})`);
  const cache = (cfg as unknown as { cache?: { enabled?: boolean; preferCache?: boolean; sticky?: boolean } }).cache;
  if (cache) {
    lines.push(`cache: ${cache.enabled ? "✅" : "⏸️ "} prefer=${cache.preferCache ? "on" : "off"} sticky=${cache.sticky ? "on" : "off"}`);
  }
  const learn = (cfg as unknown as { learn?: { enabled?: boolean } }).learn;
  if (learn) lines.push(`learn: ${learn.enabled ? "✅" : "⏸️ "}`);
  const churn = (cfg as unknown as { churn?: { enabled?: boolean; maxChurnTokens?: number } }).churn;
  if (churn) lines.push(`churn: ${churn.enabled ? "✅" : "⏸️ "}${churn.maxChurnTokens ? ` max=${churn.maxChurnTokens}tok` : ""}`);
  lines.push(`current: ${deps.getCurrentModel() ?? "(none)"}`);
  lines.push(`available: ${deps.getAvailableModels().join(", ") || "(none)"}`);
  lines.push(`rules: ${cfg.rules.length}  fallback: ${cfg.fallback?.mode ?? "off"}${cfg.fallback?.models?.length ? ` → ${cfg.fallback.models.join(", ")}` : ""}`);
  const pool = (cfg as unknown as { pool?: string[] }).pool;
  lines.push(`pool: ${!pool?.length ? "(全部可用模型)" : `${pool.length} 个 → ${pool.join(", ")}`}`);
  const cds = deps.cooldowns.all();
  if (cds.length) {
    lines.push(`cooldowns (${cds.length}):`);
    for (const c of cds) lines.push(`  - ${c.selector} until ${new Date(c.until).toLocaleTimeString()} — ${c.reason}`);
  } else {
    lines.push("cooldowns: none");
  }
  if (deps.cacheManager) {
    const recs = deps.cacheManager.getRecords();
    if (recs.length) {
      lines.push(`cache records (${recs.length}):`);
      for (const r of recs.slice(0, 5)) {
        lines.push(`  - ${r.selector} hit=${(r.hitRate * 100).toFixed(1)}% prefix=${r.commonPrefixChars} read=${r.cacheRead} write=${r.cacheWrite}`);
      }
    } else {
      lines.push("cache: no records yet");
    }
  }
  const hist = deps.getHistory();
  if (hist.length) {
    lines.push(`recent decisions (${hist.length}):`);
    for (const h of hist.slice(-8)) {
      lines.push(`  [${new Date(h.timestamp).toLocaleTimeString()}] ${h.previousSelector ?? "?"} → ${h.selector ?? "?"} (${h.source}) — ${h.reason} [${h.taskType}]`);
    }
  } else {
    lines.push("recent decisions: none");
  }
  return lines.join("\n");
}

export function formatRules(deps: RouterCommandDeps): string {
  const cfg = deps.getConfig();
  const compiled = deps.recompileRules();
  if (!cfg.rules.length) return "No rules configured.";
  return compiled.map((c) => {
    const flag = c.active ? "●" : "○";
    return `${flag} [p${c.priority}] ${c.rule.id}${c.rule.name ? ` — ${c.rule.name}` : ""}\n   when=${JSON.stringify(c.rule.when)} → ${c.rule.model}${c.diagnostics.length ? `  ⚠ ${c.diagnostics.join("; ")}` : ""}`;
  }).join("\n");
}
