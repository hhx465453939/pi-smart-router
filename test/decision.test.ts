import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/engine/decision.ts";
import { CooldownSet } from "../src/engine/registry.ts";
import { compileRules } from "../src/engine/rules.ts";
import type { TaskFeatures, NormalizedRouterConfig } from "../src/types.ts";

function feat(overrides: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    taskType: "code",
    toolNames: [],
    contextTokens: 1000,
    messageCount: 3,
    turnIndex: 1,
    promptLength: 20,
    hasImage: false,
    explicitModel: undefined,
    currentModel: "anthropic/claude-sonnet-4-5",
    thinkingLevel: "medium",
    promptText: "implement fix",
    ...overrides,
  };
}

function cfg(overrides: Partial<NormalizedRouterConfig> = {}): NormalizedRouterConfig {
  return {
    enabled: true,
    defaultModel: "anthropic/claude-sonnet-4-5",
    routingLevel: "turn",
    cooldownMs: 60000,
    cooldownOnStatus: [429, 500],
    cooldownOnToolErrorPatterns: [],
    taskTypeRules: {},
    rules: [],
    fallback: { mode: "off" },
    explicitModelPrefix: "@model:",
    verbose: false,
    ...overrides,
  };
}

describe("decide", () => {
  it("explicit model forced", () => {
    const f = feat({ explicitModel: "openai/gpt-5.1" });
    const c = cfg();
    const compiled = compileRules(c.rules).compiled;
    const d = decide({ features: f, config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: new Set(["openai/gpt-5.1"]) });
    assert.equal(d.selector, "openai/gpt-5.1");
    assert.equal(d.source, "explicit");
  });

  it("rule hit", () => {
    const c = cfg({ rules: [{ id: "code-rule", priority: 10, when: { taskType: "code" }, model: "anthropic/claude-opus-4-5" }] });
    const compiled = compileRules(c.rules).compiled;
    const d = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: new Set(["anthropic/claude-opus-4-5"]) });
    assert.equal(d.selector, "anthropic/claude-opus-4-5");
    assert.equal(d.source, "rule");
  });

  it("rule hit but cooling → fallback", () => {
    const c = cfg({
      rules: [{ id: "code-rule", when: { taskType: "code" }, model: "anthropic/claude-opus-4-5" }],
      fallback: { mode: "model-chain", models: ["anthropic/claude-sonnet-4-5"] },
    });
    const compiled = compileRules(c.rules).compiled;
    const cds = new CooldownSet();
    cds.add("anthropic/claude-opus-4-5", 60000, "429");
    const d = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: cds, availableModels: new Set(["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5"]) });
    assert.equal(d.selector, "anthropic/claude-sonnet-4-5");
    assert.equal(d.source, "cooldown-avoid");
  });

  it("default when no rule", () => {
    const c = cfg();
    const compiled = compileRules(c.rules).compiled;
    const d = decide({ features: feat({ taskType: "general" }), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: new Set(["anthropic/claude-sonnet-4-5"]) });
    assert.equal(d.selector, "anthropic/claude-sonnet-4-5");
    assert.equal(d.source, "default");
  });

  it("keep when no decision", () => {
    const c = cfg({ defaultModel: undefined, rules: [] });
    const compiled = compileRules(c.rules).compiled;
    const d = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: new Set() });
    assert.equal(d.source, "keep");
    assert.equal(d.selector, undefined);
  });
});
