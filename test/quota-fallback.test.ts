import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/engine/decision.ts";
import { compileRules } from "../src/engine/rules.ts";
import { CooldownSet } from "../src/engine/registry.ts";
import { AvailabilityProbe } from "../src/probe/availability.ts";
import type { TaskFeatures, NormalizedRouterConfig } from "../src/types.ts";

function feat(over: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    taskType: "general", toolNames: [], contextTokens: 160000, messageCount: 10, turnIndex: 3,
    promptLength: 50, hasImage: false, explicitModel: undefined,
    currentModel: "volces/deepseek-v4-flash[1m]", thinkingLevel: undefined,
    promptText: "long doc", ...over,
  };
}

function cfg(over: Partial<NormalizedRouterConfig> = {}): NormalizedRouterConfig {
  return {
    enabled: true, defaultModel: "volces/deepseek-v4-flash[1m]", routingLevel: "turn",
    cooldownMs: 60000, cooldownOnStatus: [429], cooldownOnToolErrorPatterns: [],
    taskTypeRules: {}, rules: [], fallback: { mode: "model-chain", models: ["opencode-go/deepseek-v4-flash", "shudie/deepseek-v4-flash"] },
    explicitModelPrefix: "@model:", verbose: false,
    cache: { enabled: false, preferCache: false, minHitChars: 1024, sticky: false, stickyTtlMs: 300000 },
    learn: { enabled: false, windowSize: 50, minSamples: 2, successWeight: 1, failureWeight: -2, cacheWeight: 0, costWeight: 0 },
    churn: { enabled: false, maxChurnTokens: 8000 },
    catalogPath: "/tmp/x.json",
    difficulty: { enabled: false, lowThreshold: 40, highThreshold: 120 },
    selfLearn: { enabled: false, minSamples: 3, decay: 0.9, successWeight: 1, failureWeight: -2, costWeight: 0 },
    probe: { enabled: true, timeoutMs: 300000, probeOnStart: false, excludeUnavailable: true },
    pool: [],
    ...over,
  };
}

describe("quota-exhausted rule target fallback", () => {
  it("rule target probe-unavailable → fallback to another provider's same model", () => {
    const c = cfg({ rules: [{ id: "huge-context", priority: 92, when: { contextTokens: { gt: 150000 } }, model: "volces/deepseek-v4-flash[1m]" }] });
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    probe.markAuthFailure("volces/deepseek-v4-flash[1m]");
    const d = decide({
      features: feat(),
      config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(),
      availableModels: new Set(["volces/deepseek-v4-flash[1m]", "opencode-go/deepseek-v4-flash", "shudie/deepseek-v4-flash"]),
      probe,
    });
    assert.equal(d.selector, "opencode-go/deepseek-v4-flash");
    assert.match(d.reason, /unavailable/);
  });

  it("probe unavailable persists across decisions within session (no flip-flop back)", () => {
    const c = cfg({ rules: [{ id: "huge-context", priority: 92, when: { contextTokens: { gt: 150000 } }, model: "volces/deepseek-v4-flash[1m]" }] });
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    probe.markAuthFailure("volces/deepseek-v4-flash[1m]");
    const compiled = compileRules(c.rules).compiled;
    const avail = new Set(["volces/deepseek-v4-flash[1m]", "opencode-go/deepseek-v4-flash", "shudie/deepseek-v4-flash"]);
    const d1 = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: avail, probe });
    const d2 = decide({ features: feat(), config: c, compiledRules: compiled, cooldowns: new CooldownSet(), availableModels: avail, probe });
    assert.notEqual(d1.selector, "volces/deepseek-v4-flash[1m]");
    assert.notEqual(d2.selector, "volces/deepseek-v4-flash[1m]");
  });
});
