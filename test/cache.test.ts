import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CacheManager, commonPrefixLength } from "../src/engine/cache.ts";

describe("commonPrefixLength", () => {
  it("identical", () => assert.equal(commonPrefixLength("hello", "hello"), 5));
  it("prefix", () => assert.equal(commonPrefixLength("hello world", "hello there"), 6));
  it("none", () => assert.equal(commonPrefixLength("abc", "xyz"), 0));
  it("empty", () => assert.equal(commonPrefixLength("", "hello"), 0));
});

describe("CacheManager", () => {
  it("trackPrompt and recordUsage", () => {
    const cm = new CacheManager();
    cm.trackPrompt("sess-1", "hello world, this is a long prompt that will be cached");
    cm.recordUsage("anthropic/claude-sonnet-4-5", "sess-1", "hello world, this is a long prompt that will be cached", { cacheRead: 800, cacheWrite: 200 });
    const rec = cm.getRecord("anthropic/claude-sonnet-4-5");
    assert.ok(rec);
    assert.equal(rec!.hitRate > 0, true);
    assert.equal(rec!.selector, "anthropic/claude-sonnet-4-5");
  });

  it("estimate with no history returns prefix based on lastPrompt", () => {
    const cm = new CacheManager();
    cm.trackPrompt("sess-1", "hello world");
    const est = cm.estimate("openai/gpt-5.1", "sess-1", "hello world, extended");
    assert.equal(est.commonPrefixChars, 11); // "hello world" length
    assert.equal(est.hitRate, 0);
  });

  it("rankCandidates prefers warm cache", () => {
    const cm = new CacheManager();
    const cfg = { cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 300000 } } as unknown as import("../src/types.ts").NormalizedRouterConfig;
    // warm model: large prefix + high hitRate
    cm.trackPrompt("sess-1", "a".repeat(2000));
    cm.recordUsage("a/model-warm", "sess-1", "a".repeat(2000) + " extra", { cacheRead: 1500, cacheWrite: 500 });
    // cold model: no history
    const ranked = cm.rankCandidates(["a/model-cold", "a/model-warm"], "sess-1", "a".repeat(2000) + " extra", cfg);
    assert.equal(ranked[0], "a/model-warm");
  });

  it("rankCandidates no reorder when scores close", () => {
    const cm = new CacheManager();
    const cfg = { cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 300000 } } as unknown as import("../src/types.ts").NormalizedRouterConfig;
    const ranked = cm.rankCandidates(["a/first", "a/second"], "sess-1", "hello", cfg);
    // scores close (both 0), should keep original order
    assert.deepEqual(ranked, ["a/first", "a/second"]);
  });

  it("stickyPreferred within TTL", () => {
    const cm = new CacheManager();
    const cfg = { cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 300000 } } as unknown as import("../src/types.ts").NormalizedRouterConfig;
    cm.recordDecision("code", "anthropic/claude-opus-4-5");
    assert.equal(cm.stickyPreferred("code", cfg), "anthropic/claude-opus-4-5");
    assert.equal(cm.stickyPreferred("research", cfg), undefined);
  });

  it("sticky expires after TTL", async () => {
    const cm = new CacheManager();
    const cfg = { cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 10 } } as unknown as import("../src/types.ts").NormalizedRouterConfig;
    cm.recordDecision("code", "a/b");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cm.stickyPreferred("code", cfg), undefined);
  });

  it("cache disabled does not rank", () => {
    const cm = new CacheManager();
    const cfg = { cache: { enabled: false, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 300000 } } as unknown as import("../src/types.ts").NormalizedRouterConfig;
    cm.trackPrompt("sess-1", "a".repeat(2000));
    cm.recordUsage("a/warm", "sess-1", "a".repeat(2000), { cacheRead: 1000, cacheWrite: 100 });
    const ranked = cm.rankCandidates(["a/cold", "a/warm"], "sess-1", "a".repeat(2000), cfg);
    assert.deepEqual(ranked, ["a/cold", "a/warm"]);
  });

  it("multi-hop preservation: same sessionId retains prefix", () => {
    const cm = new CacheManager();
    const sid = "sess-multi";
    cm.trackPrompt(sid, "prefix ".repeat(500));
    cm.recordUsage("a/model-1", sid, "prefix ".repeat(500) + " turn1", { cacheRead: 900, cacheWrite: 100 });
    // second hop same session should estimate high prefix
    const est = cm.estimate("a/model-1", sid, "prefix ".repeat(500) + " turn2");
    assert.ok(est.commonPrefixChars > 1000);
  });
});
