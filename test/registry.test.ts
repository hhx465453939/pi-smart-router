import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRouteSelector, parseProviderModelSelector, selectorsEqual, CooldownSet } from "../src/engine/registry.ts";

describe("normalizeRouteSelector", () => {
  it("trims and passes through", () => {
    assert.equal(normalizeRouteSelector(" anthropic/claude-sonnet-4-5 "), "anthropic/claude-sonnet-4-5");
  });
  it("comma form", () => {
    assert.equal(normalizeRouteSelector("anthropic, claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  });
  it("undefined for empty", () => {
    assert.equal(normalizeRouteSelector(""), undefined);
    assert.equal(normalizeRouteSelector(undefined), undefined);
  });
});

describe("parseProviderModelSelector", () => {
  it("parses provider/model", () => {
    assert.deepEqual(parseProviderModelSelector("openai/gpt-5.1"), { provider: "openai", model: "gpt-5.1" });
  });
  it("rejects missing parts", () => {
    assert.equal(parseProviderModelSelector("onlymodel"), undefined);
    assert.equal(parseProviderModelSelector("a/"), undefined);
    assert.equal(parseProviderModelSelector("/b"), undefined);
  });
});

describe("selectorsEqual", () => {
  it("case insensitive", () => {
    assert.equal(selectorsEqual("Anthropic/Claude-Sonnet", "anthropic/claude-sonnet"), true);
    assert.equal(selectorsEqual("a/b", "a/c"), false);
  });
});

describe("CooldownSet", () => {
  it("add and check", () => {
    const cs = new CooldownSet();
    cs.add("anthropic/claude-sonnet-4-5", 10000, "HTTP 429");
    assert.equal(cs.isCooldown("anthropic/claude-sonnet-4-5"), true);
    assert.equal(cs.isCooldown("openai/gpt-5"), false);
  });
  it("clear", () => {
    const cs = new CooldownSet();
    cs.add("a/b", 10000, "x");
    assert.equal(cs.clear("a/b"), true);
    assert.equal(cs.isCooldown("a/b"), false);
  });
  it("all filters expired", async () => {
    const cs = new CooldownSet();
    cs.add("a/b", 10, "x");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(cs.all().length, 0);
    assert.equal(cs.isCooldown("a/b"), false);
  });
  it("comma selector normalization", () => {
    const cs = new CooldownSet();
    cs.add("anthropic, claude-sonnet", 10000, "x");
    assert.equal(cs.isCooldown("anthropic/claude-sonnet"), true);
  });
});
