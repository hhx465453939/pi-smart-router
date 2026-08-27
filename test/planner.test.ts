import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExecutionPlan, pickAvailableModel } from "../src/engine/planner.ts";
import { CooldownSet } from "../src/engine/registry.ts";

describe("createExecutionPlan", () => {
  it("off mode → single attempt", () => {
    const plan = createExecutionPlan({ primary: "a/b", fallback: { mode: "off" } });
    assert.equal(plan.attempts.length, 1);
    assert.equal(plan.attempts[0].selector, "a/b");
  });
  it("retry mode", () => {
    const plan = createExecutionPlan({ primary: "a/b", fallback: { mode: "retry", retryCount: 2 } });
    assert.equal(plan.attempts.length, 3);
    assert.equal(plan.attempts.every((a) => a.selector === "a/b"), true);
  });
  it("model-chain dedup and order", () => {
    const plan = createExecutionPlan({
      primary: "a/b",
      fallback: { mode: "model-chain", models: ["c/d", "a/b", "e/f"] },
    });
    assert.deepEqual(plan.attempts.map((a) => a.selector), ["a/b", "c/d", "e/f"]);
  });
  it("model-chain with no primary", () => {
    const plan = createExecutionPlan({ primary: undefined, fallback: { mode: "model-chain", models: ["c/d", "e/f"] } });
    assert.deepEqual(plan.attempts.map((a) => a.selector), ["c/d", "e/f"]);
  });
});

describe("pickAvailableModel", () => {
  it("skips cooldown", () => {
    const cs = new CooldownSet();
    cs.add("a/b", 10000, "x");
    const plan = createExecutionPlan({ primary: "a/b", fallback: { mode: "model-chain", models: ["a/b", "c/d"] } });
    assert.equal(pickAvailableModel(plan, cs), "c/d");
  });
  it("returns undefined when all cooling", () => {
    const cs = new CooldownSet();
    cs.add("a/b", 10000, "x");
    cs.add("c/d", 10000, "x");
    const plan = createExecutionPlan({ primary: "a/b", fallback: { mode: "model-chain", models: ["c/d"] } });
    assert.equal(pickAvailableModel(plan, cs), undefined);
  });
});
