import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskFeatures, classifyTaskType, extractExplicitModel } from "../src/context/task.ts";

describe("classifyTaskType", () => {
  it("code", () => {
    assert.equal(classifyTaskType("implement the fix for bug", {}), "code");
  });
  it("document", () => {
    assert.equal(classifyTaskType("write a readme guide", {}), "document");
  });
  it("research", () => {
    assert.equal(classifyTaskType("research and compare the options", {}), "research");
  });
  it("general fallback", () => {
    assert.equal(classifyTaskType("hello there", {}), "general");
  });
  it("custom rules override", () => {
    assert.equal(classifyTaskType("foo task", { code: ["foo"] }), "code");
  });
});

describe("extractExplicitModel", () => {
  it("extracts token after prefix", () => {
    assert.equal(extractExplicitModel("hello @model:anthropic/claude-opus-4-5 do this", "@model:"), "anthropic/claude-opus-4-5");
  });
  it("no prefix → undefined", () => {
    assert.equal(extractExplicitModel("hello world", "@model:"), undefined);
  });
  it("strips trailing punctuation", () => {
    assert.equal(extractExplicitModel("use @model:openai/gpt-5.1, please", "@model:"), "openai/gpt-5.1");
  });
});

describe("buildTaskFeatures", () => {
  it("builds features", () => {
    const f = buildTaskFeatures({
      prompt: "implement fix @model:anthropic/claude-opus-4-5",
      images: [],
      selectedTools: ["bash", "edit"],
      currentModelSelector: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
      messageCount: 5,
      turnIndex: 2,
      contextTokens: 5000,
      explicitModelPrefix: "@model:",
      taskTypeRules: {},
    });
    assert.equal(f.taskType, "code");
    assert.equal(f.explicitModel, "anthropic/claude-opus-4-5");
    assert.equal(f.hasImage, false);
    assert.equal(f.turnIndex, 2);
    assert.deepEqual(f.toolNames, ["bash", "edit"]);
  });
  it("hasImage detection", () => {
    const f = buildTaskFeatures({
      prompt: "describe image",
      images: [{}],
      explicitModelPrefix: "@model:",
      taskTypeRules: {},
    });
    assert.equal(f.hasImage, true);
  });
});
