import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capabilityTier, isFast, isVision, priceTier, profileModel, rankModels, valueScore, type RegistryModel } from "../src/engine/profile.ts";
import type { Difficulty } from "../src/types.ts";

function reg(over: Partial<RegistryModel> = {}): RegistryModel {
  return { provider: "opencode-go", id: "deepseek-v4-flash", cost: { input: 0.22, output: 0.66, cacheRead: 0.007 }, contextWindow: 1000000, reasoning: true, input: ["text"], ...over };
}

describe("profileModel auto-profiling", () => {
  it("flash → cheap/low/fast/long", () => {
    const p = profileModel(reg());
    assert.equal(p.priceTier, "cheap");
    assert.equal(p.capabilityTier, "low");
    assert.equal(p.speed, "fast");
    assert.equal(p.longContext, true);
    assert.equal(p.contextWindow, 1000000);
  });

  it("codex-sol → expensive/high", () => {
    const p = profileModel(reg({ provider: "openai-codex", id: "gpt-5.6-sol", cost: { input: 8, output: 30, cacheRead: 0.8 }, contextWindow: 272000, reasoning: true }));
    assert.equal(p.priceTier, "expensive");
    assert.equal(p.capabilityTier, "high");
  });

  it("luna (low-cost but capable) → medium/medium", () => {
    const p = profileModel(reg({ provider: "openai-codex", id: "gpt-5.6-luna", cost: { input: 1.5, output: 8, cacheRead: 0.15 }, contextWindow: 128000, reasoning: true }));
    assert.equal(p.priceTier, "medium");
    assert.equal(p.capabilityTier, "medium");
  });

  it("glm-5.3 (flagship) → high", () => {
    const p = profileModel(reg({ id: "glm-5.3", cost: { input: 1.4, output: 0, cacheRead: 0 }, contextWindow: 1000000, reasoning: true }));
    assert.equal(p.capabilityTier, "high");
  });

  it("mimo-v2.5 mid-range → medium; qwen3.7-max flagship → high", () => {
    const mid = profileModel(reg({ id: "mimo-v2.5", cost: { input: 0.14, output: 0.28, cacheRead: 0 }, contextWindow: 1000000, reasoning: true }));
    assert.equal(mid.capabilityTier, "medium");
    const flag = profileModel(reg({ id: "qwen3.7-max", cost: { input: 2.5, output: 0, cacheRead: 0 }, contextWindow: 1000000, reasoning: true }));
    assert.equal(flag.capabilityTier, "high");
  });

  it("vision model detection", () => {
    assert.equal(isVision(["text", "image"], "deepseek-v4-flash-vision-exp"), true);
    assert.equal(isVision(["text"], "glm-5.3"), false);
  });

  it("priceTier boundaries", () => {
    assert.equal(priceTier(0.4), "cheap");
    assert.equal(priceTier(0.5), "medium");
    assert.equal(priceTier(5), "expensive");
  });
});

describe("valueScore + rankModels", () => {
  const cheap = profileModel(reg({ id: "deepseek-v4-flash", cost: { input: 0.22, output: 0.66, cacheRead: 0.007 }, contextWindow: 1000000 }));
  const expensive = profileModel(reg({ provider: "openai-codex", id: "gpt-5.6-sol", cost: { input: 8, output: 30, cacheRead: 0.8 }, contextWindow: 272000, reasoning: true }));
  const luna = profileModel(reg({ provider: "openai-codex", id: "gpt-5.6-luna", cost: { input: 1.5, output: 8, cacheRead: 0.15 }, contextWindow: 128000, reasoning: true }));

  it("low difficulty: cheap fast wins over expensive", () => {
    assert.ok(valueScore(cheap, "low", 0) > valueScore(expensive, "low", 0), "cheap should dominate low difficulty");
    const ranked = rankModels([expensive, cheap, luna], "low" as Difficulty, () => 0);
    assert.equal(ranked[0].selector, "opencode-go/deepseek-v4-flash");
  });

  it("high difficulty: capable wins", () => {
    assert.ok(valueScore(expensive, "high", 0) > valueScore(cheap, "high", 0), "high capability dominates high difficulty");
    const ranked = rankModels([cheap, expensive], "high" as Difficulty, () => 0);
    assert.equal(ranked[0].selector, "openai-codex/gpt-5.6-sol");
  });

  it("selftune can boost a model", () => {
    const r1 = rankModels([luna, cheap], "medium" as Difficulty, () => 0);
    const r2 = rankModels([luna, cheap], "medium" as Difficulty, (sel) => (sel.includes("luna") ? 200 : 0));
    assert.notEqual(r1[0].selector, undefined);
    assert.equal(r2[0].selector, "openai-codex/gpt-5.6-luna");
  });
});