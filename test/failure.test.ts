import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, classifyRouteFailure, compileErrorPatterns, matchesToolErrorPatterns } from "../src/engine/failure.ts";

describe("classifyStatus", () => {
  it("rate-limit", () => assert.equal(classifyStatus(429), "rate-limit"));
  it("retryable", () => { assert.equal(classifyStatus(408), "retryable"); assert.equal(classifyStatus(409), "retryable"); });
  it("server", () => assert.equal(classifyStatus(500), "server"));
  it("client", () => assert.equal(classifyStatus(400), "client"));
});

describe("classifyRouteFailure", () => {
  it("model-chain: >=400 fallback", () => {
    assert.equal(classifyRouteFailure(400, "model-chain").shouldFallback, true);
    assert.equal(classifyRouteFailure(200, "model-chain").shouldFallback, false);
  });
  it("retry: only rate-limit/retryable/server", () => {
    assert.equal(classifyRouteFailure(429, "retry").shouldFallback, true);
    assert.equal(classifyRouteFailure(408, "retry").shouldFallback, true);
    assert.equal(classifyRouteFailure(500, "retry").shouldFallback, true);
    assert.equal(classifyRouteFailure(400, "retry").shouldFallback, false);
  });
  it("off: never fallback (except rate-limit etc) — off behaves like retry for shouldFallback contract", () => {
    // In spec, off still uses retry semantics; actual planner will produce single attempt anyway
    assert.equal(classifyRouteFailure(400, "off").shouldFallback, false);
  });
});

describe("matchesToolErrorPatterns", () => {
  it("matches compiled patterns", () => {
    const pats = compileErrorPatterns(["rate.?limit", "overloaded"]);
    assert.equal(matchesToolErrorPatterns("Rate limit exceeded", pats), true);
    assert.equal(matchesToolErrorPatterns("service overloaded", pats), true);
    assert.equal(matchesToolErrorPatterns("hello world", pats), false);
  });
  it("empty text", () => {
    const pats = compileErrorPatterns(["rate"]);
    assert.equal(matchesToolErrorPatterns(undefined, pats), false);
  });
});
