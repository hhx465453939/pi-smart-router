import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CacheManager, churnTokens, commonPrefixLength } from "../src/engine/cache.ts";
import { decide } from "../src/engine/decision.ts";
import { compileRules } from "../src/engine/rules.ts";
import { CooldownSet } from "../src/engine/registry.ts";
import { LearningManager } from "../src/engine/learn.ts";
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
    currentModel: "zai-coding-cn/glm-5.3",
    thinkingLevel: "medium",
    promptText: "implement fix",
    ...overrides,
  };
}

function cfg(overrides: Partial<NormalizedRouterConfig> = {}): NormalizedRouterConfig {
  return {
    enabled: true,
    defaultModel: "zai-coding-cn/glm-5.3",
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
    learn: { enabled: true, windowSize: 50, minSamples: 2, successWeight: 1.0, failureWeight: -2.0, cacheWeight: 0.0005, costWeight: -0.0001 },
    churn: { enabled: true, maxChurnTokens: 8000 },
    catalogPath: "/tmp/pi-router-catalog-churn-test.json",
    difficulty: { enabled: false, lowThreshold: 40, highThreshold: 120 },
    selfLearn: { enabled: false, minSamples: 3, decay: 0.9, successWeight: 1.0, failureWeight: -2.0, costWeight: -0.0001 },
    probe: { enabled: false, timeoutMs: 300000, probeOnStart: false, excludeUnavailable: true },
    ...overrides,
  };
}

describe("churnTokens", () => {
  it("approx 4 chars per token", () => {
    assert.equal(churnTokens(4000), 1000);
    assert.equal(churnTokens(0), 0);
  });
});

describe("commonPrefixLength + invalidatePrefix", () => {
  it("common prefix", () => {
    assert.equal(commonPrefixLength("hello world", "hello there"), 6);
  });
  it("invalidatePrefix resets commonPrefixChars", () => {
    const cm = new CacheManager();
    cm.trackPrompt("s1", "a".repeat(2000));
    cm.recordUsage("a/b", "s1", "a".repeat(2000), { cacheRead: 1000, cacheWrite: 0 });
    assert.equal(cm.getRecord("a/b")!.commonPrefixChars, 2000);
    cm.invalidatePrefix();
    assert.equal(cm.getRecord("a/b")!.commonPrefixChars, 0);
  });
});

describe("decide churn-aware", () => {
  it("learn picks warm model but churn keeps current when loss huge", () => {
    const lm = new LearningManager();
    // learn prefers a/different-model
    lm.recordOutcome({ taskType: "code", selector: "opencode-go/kimi-k3", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg().learn);
    lm.recordOutcome({ taskType: "code", selector: "opencode-go/kimi-k3", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg().learn);
    const cm = new CacheManager();
    // current model has huge prefix (warm cache) → switching to kimi-k3 would lose a lot
    cm.trackPrompt("s1", "a".repeat(50000));
    cm.recordUsage("zai-coding-cn/glm-5.3", "s1", "a".repeat(50000), { cacheRead: 20000, cacheWrite: 0 });
    const c = cfg();
    const d = decide({
      features: feat({ currentModel: "zai-coding-cn/glm-5.3" }),
      config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(),
      availableModels: new Set(["zai-coding-cn/glm-5.3", "opencode-go/kimi-k3"]),
      cacheManager: cm,
      learning: lm,
      sessionId: "s1",
      promptText: "a".repeat(50000),
    });
    // churn loss = 50000/4 = 12500 > 8000 → keep current
    assert.equal(d.selector, "zai-coding-cn/glm-5.3");
    assert.match(d.reason, /churn/);
  });

  it("rule hit still honored (respects priority despite churn)", () => {
    const cm = new CacheManager();
    cm.trackPrompt("s1", "a".repeat(50000));
    cm.recordUsage("zai-coding-cn/glm-5.3", "s1", "a".repeat(50000), { cacheRead: 20000, cacheWrite: 0 });
    const c = cfg({ rules: [{ id: "code-rule", priority: 10, when: { taskType: "code" }, model: "opencode-go/kimi-k3" }] });
    const d = decide({
      features: feat({ currentModel: "zai-coding-cn/glm-5.3" }),
      config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(),
      availableModels: new Set(["zai-coding-cn/glm-5.3", "opencode-go/kimi-k3"]),
      cacheManager: cm,
      sessionId: "s1",
      promptText: "a".repeat(50000),
    });
    // rule honored, reason notes churn
    assert.equal(d.selector, "opencode-go/kimi-k3");
    assert.equal(d.source, "rule");
    assert.match(d.reason, /churn/);
  });
});
