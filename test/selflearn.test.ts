import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { ModelCatalog } from "../src/catalog/catalog.ts";
import { SelfLearnManager } from "../src/engine/selflearn.ts";
import type { NormalizedSelfLearnConfig } from "../src/types.ts";

const TMP = "/tmp/pi-selflearn-test.json";

const cfg: NormalizedSelfLearnConfig = {
  enabled: true,
  minSamples: 3,
  decay: 0.9,
  successWeight: 1.0,
  failureWeight: -2.0,
  costWeight: -0.0001,
};

function makeSl() {
  rmSync(TMP, { force: true });
  const catalog = new ModelCatalog(TMP);
  catalog.merge([
    { selector: "volces/dsv4-flash", provider: "volces" },
    { selector: "opencode-go/kimi-k3", provider: "opencode-go" },
    { selector: "openai-codex/gpt-5.3-codex", provider: "openai-codex" },
  ]);
  return new SelfLearnManager(catalog, cfg);
}

describe("SelfLearnManager", () => {
  beforeEach(() => { rmSync(TMP, { force: true }); });

  it("minSamples gate: best undefined before enough samples", () => {
    const sl = makeSl();
    sl.record({ selector: "volces/dsv4-flash", scenario: "general", difficulty: "low", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    sl.record({ selector: "volces/dsv4-flash", scenario: "general", difficulty: "low", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    assert.equal(sl.best("general", "low"), undefined); // 2 < minSamples 3
    sl.record({ selector: "volces/dsv4-flash", scenario: "general", difficulty: "low", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    assert.equal(sl.best("general", "low"), "volces/dsv4-flash");
  });

  it("success converges per scenario×difficulty (frontend→k3, general→flash)", () => {
    const sl = makeSl();
    // general×low: flash 3 次成功，k3 1 次
    for (let i = 0; i < 3; i++) sl.record({ selector: "volces/dsv4-flash", scenario: "general", difficulty: "low", success: true, cost: 0.01, cacheRead: 0, timestamp: Date.now() });
    sl.record({ selector: "opencode-go/kimi-k3", scenario: "general", difficulty: "low", success: true, cost: 0.5, cacheRead: 0, timestamp: Date.now() });
    // frontend×low: k3 3 次成功
    for (let i = 0; i < 3; i++) sl.record({ selector: "opencode-go/kimi-k3", scenario: "frontend", difficulty: "low", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    assert.equal(sl.best("general", "low"), "volces/dsv4-flash");
    assert.equal(sl.best("frontend", "low"), "opencode-go/kimi-k3");
  });

  it("failure strongly penalizes (flash fails → k3 wins)", () => {
    const sl = makeSl();
    for (let i = 0; i < 3; i++) sl.record({ selector: "volces/dsv4-flash", scenario: "backend", difficulty: "high", success: false, cost: 0, cacheRead: 0, timestamp: Date.now() });
    for (let i = 0; i < 3; i++) sl.record({ selector: "opencode-go/kimi-k3", scenario: "backend", difficulty: "high", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    assert.equal(sl.best("backend", "high"), "opencode-go/kimi-k3");
    const ranked = sl.ranked("backend", "high");
    assert.equal(ranked[0].selector, "opencode-go/kimi-k3");
  });

  it("handoff learning: to gains, from loses", () => {
    const sl = makeSl();
    // 先给 from 攒样本
    for (let i = 0; i < 4; i++) sl.record({ selector: "volces/dsv4-flash", scenario: "test", difficulty: "high", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    assert.equal(sl.best("test", "high"), "volces/dsv4-flash");
    // flash → codex 交接 3 次：codex 应反超
    for (let i = 0; i < 3; i++) sl.recordHandoff("volces/dsv4-flash", "openai-codex/gpt-5.3-codex", "test", "high");
    assert.equal(sl.best("test", "high"), "openai-codex/gpt-5.3-codex");
  });

  it("disabled: no learning", () => {
    rmSync(TMP, { force: true });
    const catalog = new ModelCatalog(TMP);
    catalog.merge([{ selector: "a/b", provider: "a" }]);
    const sl = new SelfLearnManager(catalog, { ...cfg, enabled: false });
    for (let i = 0; i < 5; i++) sl.record({ selector: "a/b", scenario: "general", difficulty: "low", success: true, cost: 0, cacheRead: 0, timestamp: Date.now() });
    assert.equal(sl.best("general", "low"), undefined);
  });
});
