import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, deepMerge } from "../src/config.ts";

describe("normalizeConfig", () => {
  it("defaults filled when empty", () => {
    const c = normalizeConfig({});
    assert.equal(c.enabled, true);
    assert.equal(c.routingLevel, "turn");
    assert.equal(c.cooldownMs, 60000);
    assert.deepEqual(c.cooldownOnStatus, [429, 500, 502, 503, 504]);
    assert.equal(c.explicitModelPrefix, "@model:");
    assert.equal(c.cache.enabled, true);
    assert.equal(c.cache.preferCache, true);
    assert.equal(c.cache.sticky, true);
    assert.equal(c.learn.enabled, true);
    assert.equal(c.learn.minSamples, 2);
    assert.equal(c.churn.enabled, true);
    assert.equal(c.churn.maxChurnTokens, 8000);
  });

  it("v0.1.0 config (no learn/churn) still works", () => {
    const c = normalizeConfig({ enabled: true, defaultModel: "a/b", rules: [{ id: "r", when: { taskType: "code" }, model: "c/d" }] });
    assert.equal(c.defaultModel, "a/b");
    assert.equal(c.rules.length, 1);
    assert.equal(c.learn.enabled, true);
    assert.equal(c.churn.enabled, true);
  });

  it("custom cache/learn/churn honored", () => {
    const c = normalizeConfig({
      cache: { enabled: false, preferCache: false, sticky: false },
      learn: { enabled: false, minSamples: 5 },
      churn: { enabled: false, maxChurnTokens: 1000 },
    });
    assert.equal(c.cache.enabled, false);
    assert.equal(c.cache.preferCache, false);
    assert.equal(c.cache.sticky, false);
    assert.equal(c.learn.enabled, false);
    assert.equal(c.learn.minSamples, 5);
    assert.equal(c.churn.enabled, false);
    assert.equal(c.churn.maxChurnTokens, 1000);
  });

  it("cooldownMs clamps minimum 1000", () => {
    const c = normalizeConfig({ cooldownMs: 100 });
    assert.equal(c.cooldownMs, 1000);
  });
});

describe("deepMerge", () => {
  it("project overrides global; nested sections merge", () => {
    const globalCfg = {
      cache: { enabled: true, preferCache: true, sticky: true, stickyTtlMs: 300000 },
      learn: { enabled: true, minSamples: 3 },
      rules: [{ id: "a", when: { taskType: "code" }, model: "x/y" }],
    };
    const projectCfg = {
      cache: { preferCache: false },  // override only preferCache
      rules: [{ id: "b", when: { taskType: "research" }, model: "z/w" }],
    };
    const merged = deepMerge(globalCfg, projectCfg);
    // cache merged: enabled from global, preferCache overridden
    assert.equal((merged.cache as Record<string, unknown>).enabled, true);
    assert.equal((merged.cache as Record<string, unknown>).preferCache, false);
    assert.equal((merged.cache as Record<string, unknown>).sticky, true);
    // learn merged from global
    assert.equal((merged.learn as Record<string, unknown>).enabled, true);
    assert.equal((merged.learn as Record<string, unknown>).minSamples, 3);
    // rules replaced (top-level array)
    assert.equal(merged.rules?.length, 1);
    assert.equal(merged.rules?.[0]?.id, "b");
  });
});
