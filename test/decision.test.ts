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
    cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 300000 },
    learn: { enabled: false, windowSize: 50, minSamples: 2, successWeight: 1.0, failureWeight: -2.0, cacheWeight: 0.0005, costWeight: -0.0001 },
    churn: { enabled: false, maxChurnTokens: 8000 },
    catalogPath: "/tmp/pi-router-catalog-test.json",
    difficulty: { enabled: false, lowThreshold: 40, highThreshold: 120 },
    selfLearn: { enabled: false, minSamples: 3, decay: 0.9, successWeight: 1.0, failureWeight: -2.0, costWeight: -0.0001 },
    probe: { enabled: false, timeoutMs: 300000, probeOnStart: false, excludeUnavailable: true },
    pool: [],
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

  it("rule hit propagates thinkingLevel", () => {
    const c = cfg({ rules: [{ id: "codex-low", when: { taskType: "code" }, model: "openai-codex/gpt-5.6-sol", thinkingLevel: "low" }] });
    const compiled = compileRules(c.rules).compiled;
    const d = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: new Set(["openai-codex/gpt-5.6-sol"]) });
    assert.equal(d.selector, "openai-codex/gpt-5.6-sol");
    assert.equal(d.thinkingLevel, "low");
  });

  it("rule without thinkingLevel leaves it undefined", () => {
    const c = cfg({ rules: [{ id: "code-rule", when: { taskType: "code" }, model: "anthropic/claude-opus-4-5" }] });
    const compiled = compileRules(c.rules).compiled;
    const d = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: new Set(["anthropic/claude-opus-4-5"]) });
    assert.equal(d.thinkingLevel, undefined);
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

describe("model pool (hard boundary)", () => {
  const avail = new Set(["volces/a", "opencode/b", "zai/c"]);

  it("pool empty → no filtering, rule hits normally", () => {
    const rules = compileRules([{ id: "r1", name: "n", priority: 100, when: { taskType: "code" }, model: "volces/a" }]).compiled;
    const d = decide({ features: feat(), config: cfg(), compiledRules: rules, cooldowns: new CooldownSet(), availableModels: avail });
    assert.equal(d.selector, "volces/a");
  });

  it("rule target outside pool → rule skipped, next matching rule wins", () => {
    const rules = compileRules([
      { id: "high", name: "n1", priority: 110, when: { taskType: "code" }, model: "volces/a" },
      { id: "low", name: "n2", priority: 90, when: { taskType: "code" }, model: "opencode/b" },
    ]).compiled;
    const d = decide({ features: feat(), config: cfg({ pool: ["opencode/b", "zai/c"] }), compiledRules: rules, cooldowns: new CooldownSet(), availableModels: avail });
    assert.equal(d.selector, "opencode/b");
    assert.equal(d.ruleId, "low");
  });

  it("all rule targets outside pool → falls through to default (if in pool)", () => {
    const rules = compileRules([{ id: "r1", name: "n", priority: 100, when: { taskType: "code" }, model: "volces/a" }]).compiled;
    const d = decide({ features: feat(), config: cfg({ pool: ["zai/c"], defaultModel: "zai/c" }), compiledRules: rules, cooldowns: new CooldownSet(), availableModels: avail });
    assert.equal(d.selector, "zai/c");
    assert.equal(d.source, "default");
  });

  it("default outside pool → fallback chain picks first pooled model", () => {
    const d = decide({
      features: feat(),
      config: cfg({ pool: ["opencode/b"], defaultModel: "volces/a", fallback: { mode: "model-chain", models: ["volces/a", "opencode/b"] } }),
      compiledRules: [],
      cooldowns: new CooldownSet(),
      availableModels: avail,
    });
    assert.equal(d.selector, "opencode/b");
  });

  it("pool matching is case-insensitive", () => {
    const rules = compileRules([{ id: "r1", name: "n", priority: 100, when: { taskType: "code" }, model: "Volces/A" }]).compiled;
    const d = decide({ features: feat(), config: cfg({ pool: ["volces/a"] }), compiledRules: rules, cooldowns: new CooldownSet(), availableModels: avail });
    assert.equal(d.selector, "Volces/A");
  });

  it("explicit model bypasses pool (user force)", () => {
    const d = decide({ features: feat({ explicitModel: "volces/a" }), config: cfg({ pool: ["opencode/b"] }), compiledRules: [], cooldowns: new CooldownSet(), availableModels: avail });
    assert.equal(d.selector, "volces/a");
    assert.equal(d.source, "explicit");
  });
});
