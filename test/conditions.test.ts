import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCondition } from "../src/engine/conditions.ts";
import type { TaskFeatures } from "../src/types.ts";

function feat(overrides: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    taskType: "general",
    toolNames: [],
    contextTokens: 1000,
    messageCount: 3,
    turnIndex: 1,
    promptLength: 20,
    hasImage: false,
    explicitModel: undefined,
    currentModel: "anthropic/claude-sonnet-4-5",
    thinkingLevel: "medium",
    promptText: "hello",
    ...overrides,
  };
}

describe("evaluateCondition", () => {
  it("scalar equality", () => {
    assert.equal(evaluateCondition({ taskType: "code" }, feat({ taskType: "code" })), true);
    assert.equal(evaluateCondition({ taskType: "code" }, feat({ taskType: "general" })), false);
  });

  it("numeric comparisons", () => {
    assert.equal(evaluateCondition({ contextTokens: { gt: 80000 } }, feat({ contextTokens: 90000 })), true);
    assert.equal(evaluateCondition({ contextTokens: { gt: 80000 } }, feat({ contextTokens: 1000 })), false);
    assert.equal(evaluateCondition({ turnIndex: { gte: 6 } }, feat({ turnIndex: 6 })), true);
    assert.equal(evaluateCondition({ turnIndex: { gte: 6 } }, feat({ turnIndex: 5 })), false);
    assert.equal(evaluateCondition({ promptLength: { lt: 500 } }, feat({ promptLength: 100 })), true);
    assert.equal(evaluateCondition({ promptLength: { lte: 100 } }, feat({ promptLength: 100 })), true);
    assert.equal(evaluateCondition({ messageCount: { eq: 3 } }, feat({ messageCount: 3 })), true);
  });

  it("in operator", () => {
    assert.equal(evaluateCondition({ taskType: { in: ["code", "research"] } }, feat({ taskType: "code" })), true);
    assert.equal(evaluateCondition({ taskType: { in: ["code", "research"] } }, feat({ taskType: "general" })), false);
  });

  it("contains and not-contains", () => {
    assert.equal(evaluateCondition({ prompt: { contains: "hello" } }, feat({ promptText: "hello world" })), true);
    assert.equal(evaluateCondition({ prompt: { contains: "hello" } }, feat({ promptText: "bye" })), false);
    assert.equal(evaluateCondition({ taskType: { "not-contains": "code" } }, feat({ taskType: "general" })), true);
    assert.equal(evaluateCondition({ taskType: { "not-contains": "code" } }, feat({ taskType: "code" })), false);
  });

  it("starts-with", () => {
    assert.equal(evaluateCondition({ taskType: { "starts-with": "cod" } }, feat({ taskType: "code" })), true);
    assert.equal(evaluateCondition({ taskType: { "starts-with": "cod" } }, feat({ taskType: "general" })), false);
  });

  it("not inversion", () => {
    assert.equal(evaluateCondition({ hasImage: { not: true } }, feat({ hasImage: false })), true);
    assert.equal(evaluateCondition({ hasImage: { not: true } }, feat({ hasImage: true })), false);
  });

  it("multiple fields AND", () => {
    assert.equal(
      evaluateCondition({ taskType: "code", hasImage: true }, feat({ taskType: "code", hasImage: true })),
      true,
    );
    assert.equal(
      evaluateCondition({ taskType: "code", hasImage: true }, feat({ taskType: "code", hasImage: false })),
      false,
    );
  });

  it("undefined field returns false for eq", () => {
    assert.equal(evaluateCondition({ contextTokens: { gt: 100 } }, feat({ contextTokens: undefined })), false);
  });
});
