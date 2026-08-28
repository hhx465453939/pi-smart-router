import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeTask, classifyDifficulty, detectScenario, difficultyScore } from "../src/engine/difficulty.ts";
import type { TaskFeatures } from "../src/types.ts";

function feat(over: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    taskType: "general",
    toolNames: [],
    contextTokens: 1000,
    messageCount: 2,
    turnIndex: 1,
    promptLength: 20,
    hasImage: false,
    explicitModel: undefined,
    currentModel: "zai-coding-cn/glm-5.3",
    thinkingLevel: "medium",
    promptText: "hello",
    ...over,
  };
}

describe("classifyDifficulty", () => {
  it("thresholds", () => {
    assert.equal(classifyDifficulty(0, 40, 120), "low");
    assert.equal(classifyDifficulty(40, 40, 120), "medium");
    assert.equal(classifyDifficulty(119, 40, 120), "medium");
    assert.equal(classifyDifficulty(120, 40, 120), "high");
  });
});

describe("difficultyScore", () => {
  it("simple chat is low", () => {
    const s = difficultyScore(feat({ promptText: "你好，今天天气如何" }));
    assert.ok(s < 40, `score=${s}`);
  });
  it("complex backend debug is high", () => {
    const s = difficultyScore(feat({
      promptText: "debug this deadlock race condition in the distributed transaction, check the stack trace and optimize performance",
      contextTokens: 90000,
      toolNames: ["bash", "edit"],
      turnIndex: 5,
      promptLength: 1200,
    }));
    assert.ok(s >= 120, `score=${s}`);
  });
  it("medium: ordinary code fix", () => {
    const s = difficultyScore(feat({
      promptText: "fix this bug in the api function",
      toolNames: ["edit"],
    }));
    assert.ok(s >= 40 && s < 120, `score=${s}`);
  });
});

describe("detectScenario", () => {
  it("frontend", () => {
    assert.equal(detectScenario(feat({ promptText: "写一个 react 组件，调整 css 样式" })), "frontend");
  });
  it("backend", () => {
    assert.equal(detectScenario(feat({ promptText: "优化数据库 sql 查询和 redis 缓存接口" })), "backend");
  });
  it("test", () => {
    assert.equal(detectScenario(feat({ promptText: "add unit test and e2e coverage for mock" })), "test");
  });
  it("ops", () => {
    assert.equal(detectScenario(feat({ promptText: "deploy to kubernetes, check grafana monitoring 排查" })), "ops");
  });
  it("general fallback", () => {
    assert.equal(detectScenario(feat({ promptText: "随便聊聊" })), "general");
  });
});

describe("analyzeTask", () => {
  it("combines difficulty + scenario", () => {
    const r = analyzeTask(feat({ promptText: "fix the react component css bug", toolNames: ["edit"] }), 40, 120);
    assert.equal(r.scenario, "frontend");
    assert.ok(["low", "medium"].includes(r.difficulty));
  });
});
