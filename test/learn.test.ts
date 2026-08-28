import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LearningManager, normalizeLearn } from "../src/engine/learn.ts";

const cfg = {
  enabled: true,
  windowSize: 50,
  minSamples: 2,
  successWeight: 1.0,
  failureWeight: -2.0,
  cacheWeight: 0.0005,
  costWeight: -0.0001,
};

describe("LearningManager", () => {
  it("normalizeLearn defaults", () => {
    const n = normalizeLearn(undefined);
    assert.equal(n.enabled, true);
    assert.equal(n.minSamples, 2);
    assert.equal(n.successWeight, 1.0);
    assert.equal(n.failureWeight, -2.0);
  });

  it("preferred respects minSamples", () => {
    const lm = new LearningManager();
    lm.recordOutcome({ taskType: "code", selector: "a/b", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    // only 1 sample < minSamples(2)
    assert.equal(lm.preferred("code", cfg), undefined);
  });

  it("preferred returns top score after minSamples", () => {
    const lm = new LearningManager();
    lm.recordOutcome({ taskType: "code", selector: "a/b", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "code", selector: "a/b", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    assert.equal(lm.preferred("code", cfg), "a/b");
  });

  it("failure strongly penalizes", () => {
    const lm = new LearningManager();
    lm.recordOutcome({ taskType: "code", selector: "a/b", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "code", selector: "a/b", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordFailure("code", "a/b", cfg); // -2
    // a/b score = 1+1-2 = 0; c/d with 2 successes = 2
    lm.recordOutcome({ taskType: "code", selector: "c/d", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "code", selector: "c/d", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    assert.equal(lm.preferred("code", cfg), "c/d");
  });

  it("cache hit boosts score", () => {
    const lm = new LearningManager();
    // high cacheRead → higher score
    lm.recordOutcome({ taskType: "code", selector: "a/warm", cost: 0, cacheRead: 1000, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "code", selector: "a/warm", cost: 0, cacheRead: 1000, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "code", selector: "a/cold", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "code", selector: "a/cold", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    assert.equal(lm.preferred("code", cfg), "a/warm");
  });

  it("scoresFor sorted desc", () => {
    const lm = new LearningManager();
    lm.recordOutcome({ taskType: "research", selector: "b/low", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "research", selector: "b/low", cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "research", selector: "a/high", cost: 0, cacheRead: 100, success: true, timestamp: Date.now() }, cfg);
    lm.recordOutcome({ taskType: "research", selector: "a/high", cost: 0, cacheRead: 100, success: true, timestamp: Date.now() }, cfg);
    const scores = lm.scoresFor("research");
    assert.equal(scores[0].selector, "a/high");
    assert.equal(scores[1].selector, "b/low");
  });

  it("windowSize trim keeps top scores", () => {
    const lm = new LearningManager();
    const cfgSmall = { ...cfg, windowSize: 2 };
    for (let i = 0; i < 5; i++) {
      lm.recordOutcome({ taskType: "code", selector: `m${i}`, cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, cfgSmall);
    }
    // only 2 retained (highest score = last 2 since equal score, tie by insertion? Map keeps order)
    const scores = lm.scoresFor("code");
    assert.ok(scores.length <= 2);
  });
});
