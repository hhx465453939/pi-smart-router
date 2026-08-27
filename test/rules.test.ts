import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileRules, matchFirstRule } from "../src/engine/rules.ts";
import type { TaskFeatures } from "../src/types.ts";

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
    currentModel: "a/b",
    thinkingLevel: "medium",
    promptText: "implement fix",
    ...overrides,
  };
}

describe("compileRules", () => {
  it("sorts by priority desc", () => {
    const { compiled } = compileRules([
      { id: "low", priority: 1, when: { taskType: "code" }, model: "a/b" },
      { id: "high", priority: 100, when: { taskType: "code" }, model: "c/d" },
    ]);
    assert.equal(compiled[0].rule.id, "high");
    assert.equal(compiled[1].rule.id, "low");
  });
  it("diagnostics for missing fields", () => {
    const { compiled, diagnostics } = compileRules([{ id: "", when: {} as never, model: "" } as never]);
    assert.equal(compiled[0].active, false);
    assert.ok(diagnostics.length > 0);
  });
  it("disabled rule inactive", () => {
    const { compiled } = compileRules([{ id: "x", enabled: false, when: { taskType: "code" }, model: "a/b" }]);
    assert.equal(compiled[0].active, false);
    assert.equal(matchFirstRule(compiled, feat()), undefined);
  });
});

describe("matchFirstRule", () => {
  it("matches first priority hit", () => {
    const { compiled } = compileRules([
      { id: "general", priority: 1, when: { taskType: "general" }, model: "a/b" },
      { id: "code", priority: 10, when: { taskType: "code" }, model: "c/d" },
    ]);
    const hit = matchFirstRule(compiled, feat({ taskType: "code" }));
    assert.equal(hit?.id, "code");
  });
  it("no match returns undefined", () => {
    const { compiled } = compileRules([{ id: "x", when: { taskType: "research" }, model: "a/b" }]);
    assert.equal(matchFirstRule(compiled, feat({ taskType: "code" })), undefined);
  });
});
