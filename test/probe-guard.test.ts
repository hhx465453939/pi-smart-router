/**
 * probe 排除回归测试（429 额度耗尽"秒切后又自动切回"根因修复）
 *
 * 场景：volces 模型额度耗尽 → message_end 标 unavailable → probe 排除。
 * 旧版 decide() 只有规则路径和 selfLearn 路径检查 probe，learn / sticky / defaultModel /
 * fallback 链完全不看 probe —— 1 小时冷却一过，耗尽模型又被自动选中，429 反复复现。
 * 修复后：任何选型路径（learn/sticky/default/fallback 链）遇到 probe=unavailable 一律跳过。
 *
 * 守护的不变量是「排除生效期间不得 flip-flop 回选死模型」，**不是**「排除永不可逆」。
 * 排除现在带 TTL（到期自动恢复候选资格），且真实调用成功（markAvailable）可立即自愈 ——
 * 早期的永久拉黑会让级联失败打穿模型池后整个 session 报废、只能重启 pi，
 * 见 .debug/fallback-loop-debug.md 的 L2。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/engine/decision.ts";
import { compileRules } from "../src/engine/rules.ts";
import { CooldownSet } from "../src/engine/registry.ts";
import { CacheManager } from "../src/engine/cache.ts";
import { LearningManager } from "../src/engine/learn.ts";
import { AvailabilityProbe } from "../src/probe/availability.ts";
import type { TaskFeatures, NormalizedRouterConfig } from "../src/types.ts";

const VOLCES = "volces/deepseek-v4-flash[1m]";
const HEALTHY = "zai-coding-cn/glm-5.3";
const ALT = "opencode-go/deepseek-v4-flash";

function feat(over: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    taskType: "general", toolNames: [], contextTokens: 5000, messageCount: 4, turnIndex: 2,
    promptLength: 80, hasImage: false, explicitModel: undefined,
    currentModel: HEALTHY, thinkingLevel: undefined,
    promptText: "帮我看看这段日志", ...over,
  };
}

function cfg(over: Partial<NormalizedRouterConfig> = {}): NormalizedRouterConfig {
  return {
    enabled: true, defaultModel: VOLCES, routingLevel: "turn",
    cooldownMs: 60000, cooldownOnStatus: [429], cooldownOnToolErrorPatterns: [],
    taskTypeRules: {}, rules: [], fallback: { mode: "model-chain", models: [ALT, HEALTHY] },
    explicitModelPrefix: "@model:", verbose: false,
    cache: { enabled: true, preferCache: true, minHitChars: 1024, sticky: true, stickyTtlMs: 300000 },
    learn: { enabled: true, windowSize: 50, minSamples: 2, successWeight: 1, failureWeight: -2, cacheWeight: 0, costWeight: 0 },
    churn: { enabled: false, maxChurnTokens: 8000 },
    catalogPath: "/tmp/pi-router-probe-guard-test.json",
    difficulty: { enabled: false, lowThreshold: 40, highThreshold: 120 },
    selfLearn: { enabled: false, minSamples: 3, decay: 0.9, successWeight: 1, failureWeight: -2, costWeight: 0 },
    probe: { enabled: true, timeoutMs: 300000, probeOnStart: false, excludeUnavailable: true },
    pool: [],
    poolPresets: {},
    ...over,
  };
}

function exhaustedProbe(c: NormalizedRouterConfig): AvailabilityProbe {
  const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
  probe.markAuthFailure(VOLCES); // 模拟 429 额度耗尽被标记（等价 message_end 的 markAuthFailure）
  return probe;
}

describe("probe 排除生效期间不得回选（冷却过期也不 flip-flop）", () => {
  it("defaultModel 被标 unavailable → fallback 链接管，不回选耗尽模型", () => {
    const c = cfg();
    const probe = exhaustedProbe(c);
    const d = decide({
      features: feat(), config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(), // 关键：冷却集为空 = 冷却已过期
      availableModels: new Set([VOLCES, ALT, HEALTHY]),
      probe,
    });
    assert.notEqual(d.selector, VOLCES);
    assert.equal(d.selector, ALT, `expected first healthy fallback ${ALT}, got ${d.selector} (${d.reason})`);
  });

  it("fallback 链首个模型 unavailable → 跳到链中下一个健康模型", () => {
    const c = cfg({ defaultModel: HEALTHY, fallback: { mode: "model-chain", models: [VOLCES, ALT] } });
    const probe = exhaustedProbe(c);
    const d = decide({
      features: feat(), config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(),
      availableModels: new Set([VOLCES, ALT, HEALTHY]),
      probe,
    });
    assert.equal(d.selector, HEALTHY);
  });

  it("learn 偏好的模型 unavailable → 跳过 learn 命中，落到健康 default/fallback", () => {
    const c = cfg();
    const lm = new LearningManager();
    // 把 VOLCES 学习成 code 任务最高分（≥ minSamples）
    for (let i = 0; i < 3; i++) {
      lm.recordOutcome({ taskType: "general", selector: VOLCES, cost: 0, cacheRead: 0, success: true, timestamp: Date.now() }, c.learn);
    }
    assert.equal(lm.preferred("general", c.learn), VOLCES); // 前置：learn 确实偏好耗尽模型
    const probe = exhaustedProbe(c);
    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(), availableModels: new Set([VOLCES, ALT, HEALTHY]),
      learning: lm, probe, sessionId: "s1", promptText: "帮我看看这段日志",
    });
    assert.notEqual(d.selector, VOLCES);
  });

  it("sticky 偏好的模型 unavailable → 跳过粘滞，落到健康模型", () => {
    const c = cfg({ defaultModel: HEALTHY, fallback: { mode: "model-chain", models: [ALT] } });
    const cm = new CacheManager();
    cm.recordDecision("general", VOLCES); // 上一轮粘在耗尽模型上
    assert.equal(cm.stickyPreferred("general", c), VOLCES); // 前置：sticky 确实偏好耗尽模型
    const probe = exhaustedProbe(c);
    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(), availableModels: new Set([VOLCES, ALT, HEALTHY]),
      cacheManager: cm, probe, sessionId: "s1", promptText: "帮我看看这段日志",
    });
    assert.notEqual(d.selector, VOLCES);
  });

  it("多轮决策一致性：冷却过期 + probe unavailable → 永不回选（flip-flop 回归）", () => {
    const c = cfg();
    const probe = exhaustedProbe(c);
    const compiled = compileRules(c.rules).compiled;
    const avail = new Set([VOLCES, ALT, HEALTHY]);
    for (let round = 0; round < 5; round++) {
      const d = decide({
        features: feat(), config: c, compiledRules: compiled,
        cooldowns: new CooldownSet(), availableModels: avail, probe,
        sessionId: `s-${round}`, promptText: `第 ${round} 轮 prompt`,
      });
      assert.notEqual(d.selector, VOLCES, `round ${round} 回选了已耗尽模型: ${d.reason}`);
    }
  });

  it("排除生效期间不回选；真实调用成功（markAvailable 自愈）后才解除", () => {
    const c = cfg({ defaultModel: VOLCES, fallback: { mode: "model-chain", models: [ALT] } });
    const probe = exhaustedProbe(c);
    const compiled = compileRules(c.rules).compiled;
    const avail = new Set([VOLCES, ALT]);

    assert.equal(probe.getAvailability(VOLCES), "unavailable");
    const before = decide({
      features: feat(), config: c, compiledRules: compiled,
      cooldowns: new CooldownSet(), availableModels: avail, probe,
    });
    assert.notEqual(before.selector, VOLCES);

    // markAvailable 只应来自真实调用成功（message_end 成功路径），是唯一权威自愈信号
    probe.markAvailable(VOLCES);
    assert.equal(probe.getAvailability(VOLCES), "uncertain");
    const after = decide({
      features: feat({ currentModel: ALT }), config: c, compiledRules: compiled,
      cooldowns: new CooldownSet(), availableModels: avail, probe,
    });
    assert.equal(after.selector, VOLCES, `恢复后应可回选 defaultModel，实得 ${after.selector} (${after.reason})`);
  });

  it("排除 TTL 到期后模型自动重新成为候选", async () => {
    const c = cfg({ defaultModel: VOLCES, fallback: { mode: "model-chain", models: [ALT] } });
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    probe.markUnavailable(VOLCES, 20, "transient 5xx");
    const compiled = compileRules(c.rules).compiled;
    const avail = new Set([VOLCES, ALT]);

    const during = decide({
      features: feat(), config: c, compiledRules: compiled,
      cooldowns: new CooldownSet(), availableModels: avail, probe,
    });
    assert.notEqual(during.selector, VOLCES);

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(probe.getAvailability(VOLCES), "uncertain");
    const after = decide({
      features: feat({ currentModel: ALT }), config: c, compiledRules: compiled,
      cooldowns: new CooldownSet(), availableModels: avail, probe,
    });
    assert.equal(after.selector, VOLCES, `TTL 到期后应恢复候选资格，实得 ${after.selector} (${after.reason})`);
  });
});
