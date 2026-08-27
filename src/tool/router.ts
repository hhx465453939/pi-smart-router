/**
 * LLM 工具：router_status
 * 让 LLM 也能查询路由状态（便于 agent 理解当前模型配置）。
 */
import { Type } from "typebox";
import type { NormalizedRouterConfig, DecisionRecord } from "../types.ts";
import type { CooldownSet } from "../engine/registry.ts";

export interface RouterToolDeps {
  getConfig(): NormalizedRouterConfig;
  getCurrentModel(): string | undefined;
  getAvailableModels(): string[];
  cooldowns: CooldownSet;
  getHistory(): DecisionRecord[];
}

export function buildRouterTool(deps: RouterToolDeps) {
  return {
    name: "router_status",
    label: "Router Status",
    description: "Show pi-smart-router status: current model, rules, cooldowns, and recent decisions",
    parameters: Type.Object({}),
    async execute() {
      const cfg = deps.getConfig();
      const payload = {
        enabled: cfg.enabled,
        routingLevel: cfg.routingLevel,
        currentModel: deps.getCurrentModel(),
        availableModels: deps.getAvailableModels(),
        rules: cfg.rules.map((r) => ({ id: r.id, name: r.name, priority: r.priority, when: r.when, model: r.model, enabled: r.enabled !== false })),
        fallback: cfg.fallback,
        cooldowns: deps.cooldowns.all(),
        recentDecisions: deps.getHistory().slice(-5),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };
}
