/**
 * 决策层"耗尽恢复"回归测试 —— 守护闭环不变量：
 *   任何路径都不得把一个不可用的模型返回给调用方；池内还有活模型时必须兜底选出来。
 *
 * 对应 .debug/fallback-loop-debug.md 的 L3（主动决策盲区）：
 *   ① 规则目标冷却且 fallback 链为空时，旧实现直接把死模型返回；
 *   ② pool 旧实现只当"过滤器"，池内其余健康模型永不被当作兜底来源；
 *   ③ 候选耗尽后旧实现返回 undefined（= 保持当前），而当前往往正是死模型 → 每轮撞墙。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/engine/decision.ts";
import { compileRules } from "../src/engine/rules.ts";
import { CooldownSet } from "../src/engine/registry.ts";
import { AvailabilityProbe } from "../src/probe/availability.ts";
import type { TaskFeatures, NormalizedRouterConfig } from "../src/types.ts";

const RULE_TARGET = "volces/deepseek-v4-flash[1m]";
const CHAIN_1 = "opencode/deepseek-v4-flash";
const CHAIN_2 = "shudie/deepseek-v4-flash-0731";
const DEAD = [RULE_TARGET, CHAIN_1, CHAIN_2];
// 池内健康、但不在 fallback.models 里 —— 旧实现永远选不到它们
const POOL_ONLY_HEALTHY = ["zai/glm-5.3", "kimi/k3-256k", "openai-codex/gpt-5.6-sol", "opencode/minimax-m3"];
const POOL = [...DEAD, ...POOL_ONLY_HEALTHY];

function feat(over: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    taskType: "general", toolNames: [], contextTokens: 160000, messageCount: 10, turnIndex: 3,
    promptLength: 50, hasImage: false, explicitModel: undefined,
    currentModel: RULE_TARGET, thinkingLevel: undefined, promptText: "long doc", ...over,
  };
}

function cfg(over: Partial<NormalizedRouterConfig> = {}): NormalizedRouterConfig {
  return {
    enabled: true, defaultModel: RULE_TARGET, routingLevel: "turn",
    cooldownMs: 60000, cooldownOnStatus: [429], cooldownOnToolErrorPatterns: [],
    taskTypeRules: {},
    rules: [{ id: "huge-context", priority: 92, when: { contextTokens: { gt: 150000 } }, model: RULE_TARGET }],
    fallback: { mode: "model-chain", models: [CHAIN_1, CHAIN_2] },
    explicitModelPrefix: "@model:", verbose: false,
    cache: { enabled: false, preferCache: false, minHitChars: 1024, sticky: false, stickyTtlMs: 300000 },
    learn: { enabled: false, windowSize: 50, minSamples: 2, successWeight: 1, failureWeight: -2, cacheWeight: 0, costWeight: 0 },
    churn: { enabled: false, maxChurnTokens: 8000 },
    catalogPath: "/tmp/pi-router-recovery-test.json",
    difficulty: { enabled: false, lowThreshold: 40, highThreshold: 120 },
    selfLearn: { enabled: false, minSamples: 3, decay: 0.9, successWeight: 1, failureWeight: -2, costWeight: 0 },
    probe: { enabled: true, timeoutMs: 300000, probeOnStart: false, excludeUnavailable: true },
    pool: POOL, poolPresets: {},
    ...over,
  };
}

/** 级联失败后的真实状态：规则目标 + fallback 链全部被 probe 排除并冷却 1h */
function cascadeState(c: NormalizedRouterConfig): { probe: AvailabilityProbe; cooldowns: CooldownSet } {
  const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
  const cooldowns = new CooldownSet();
  for (const sel of DEAD) {
    probe.markUnavailable(sel, 3600_000, "quota/auth");
    cooldowns.add(sel, 3600_000, "cascade failure");
  }
  return { probe, cooldowns };
}

describe("池内兜底扫描（L3：pool 是候选来源，不只是过滤器）", () => {
  it("规则目标 + fallback 链全灭 → 从池内健康模型兜底，绝不返回死模型", () => {
    const c = cfg();
    const { probe, cooldowns } = cascadeState(c);
    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns, availableModels: new Set(POOL), probe,
    });
    assert.ok(d.selector, `池内还有 ${POOL_ONLY_HEALTHY.length} 个健康模型，不应返回 undefined (${d.reason})`);
    assert.ok(!DEAD.includes(d.selector as string), `返回了已死模型 ${d.selector} (${d.reason})`);
    assert.equal(d.source, "pool-sweep");
    assert.equal(d.selector, POOL_ONLY_HEALTHY[0], `应按候选宇宙顺序取首个健康模型，实得 ${d.selector} (${d.reason})`);
  });

  it("availableModels 只含池内健康模型（default/fallback 均不在候选集）→ 仍能选出", () => {
    const c = cfg();
    const { probe, cooldowns } = cascadeState(c);
    const healthyOnly = new Set(POOL_ONLY_HEALTHY);
    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns, availableModels: healthyOnly, probe,
    });
    assert.ok(d.selector, `旧实现在这里返回 undefined = 保持当前死模型，每轮撞墙 (${d.reason})`);
    assert.ok(healthyOnly.has(d.selector as string), `选出了候选集外的模型 ${d.selector}`);
  });

  it("当前模型健康时不做池内扫描（不打扰正常会话）", () => {
    const c = cfg();
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    const d = decide({
      features: feat({ currentModel: POOL_ONLY_HEALTHY[0] }), config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns: new CooldownSet(), availableModels: new Set(POOL), probe,
    });
    assert.equal(d.selector, RULE_TARGET, `规则应正常命中，实得 ${d.selector} (${d.reason})`);
    assert.equal(d.source, "rule");
  });

  it("probe 排除 TTL 到期后，曾被排除的模型重新进入兜底候选", async () => {
    const c = cfg();
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    const cooldowns = new CooldownSet();
    probe.markUnavailable(CHAIN_1, 20, "transient 5xx");
    cooldowns.add(RULE_TARGET, 3600_000, "quota");
    cooldowns.add(CHAIN_2, 3600_000, "503");

    await new Promise((r) => setTimeout(r, 40));
    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns, availableModels: new Set(POOL), probe,
    });
    assert.ok(d.selector, `TTL 到期后应有可用候选 (${d.reason})`);
    assert.notEqual(d.selector, RULE_TARGET);
  });
});

describe("全灭赦免（L2：耗尽必须有出路，不是无声停摆）", () => {
  it("池内全部冷却 → 赦免最先恢复者并清除其冷却，而不是返回 undefined", () => {
    const c = cfg();
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    const cooldowns = new CooldownSet();
    for (const sel of POOL) cooldowns.add(sel, 600_000, "all down");
    // 让 CHAIN_1 成为最先恢复者
    cooldowns.clear(CHAIN_1);
    cooldowns.add(CHAIN_1, 30_000, "recovering soon");

    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns, availableModels: new Set(POOL), probe,
    });
    assert.ok(d.selector, `候选全灭时应赦免推进，不应停摆 (${d.reason})`);
    assert.equal(d.source, "amnesty");
    assert.equal(d.selector, CHAIN_1, `应赦免最先恢复者，实得 ${d.selector} (${d.reason})`);
    assert.equal(cooldowns.isCooldown(CHAIN_1), false, "赦免后该模型的冷却必须已清除");
  });

  it("赦免跳过 current —— 刚失败的模型不原地重试（防 flip-flop）", () => {
    const c = cfg();
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    const cooldowns = new CooldownSet();
    for (const sel of POOL) cooldowns.add(sel, 600_000, "all down");
    // current 恢复最快，若不排除它就会被赦免 → 原地对撞
    cooldowns.clear(RULE_TARGET);
    cooldowns.add(RULE_TARGET, 1_000, "just failed, recovers first");

    const d = decide({
      features: feat({ currentModel: RULE_TARGET }), config: c,
      compiledRules: compileRules(c.rules).compiled,
      cooldowns, availableModels: new Set(POOL), probe,
    });
    assert.notEqual(d.selector, RULE_TARGET, `赦免选中了刚失败的 current (${d.reason})`);
    assert.equal(d.source, "amnesty");
  });

  it("候选宇宙只有 current 一个 → 无赦免对象，明确报出不可用而不是假装保持", () => {
    const c = cfg({ pool: [RULE_TARGET], fallback: { mode: "off" } });
    const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
    const cooldowns = new CooldownSet();
    cooldowns.add(RULE_TARGET, 60_000, "quota");

    const d = decide({
      features: feat(), config: c, compiledRules: compileRules(c.rules).compiled,
      cooldowns, availableModels: new Set([RULE_TARGET]), probe,
    });
    assert.equal(d.selector, undefined);
    // 终态必须点明死因，不能伪装成正常的"保持当前（无路由决策）"
    assert.match(d.reason, /cooling|unusable|unavailable|no usable candidate/i, `reason 应说明为何无路可走，实得 "${d.reason}"`);
    assert.doesNotMatch(d.reason, /keep current \(no routing decision\)/, `死路场景不得伪装成正常 keep: "${d.reason}"`);
  });
});

describe("闭环不变量：decide 永不返回不可用模型", () => {
  const scenarios: Array<{ name: string; build: () => Parameters<typeof decide>[0] }> = [
    {
      name: "规则目标死 + fallback 链死 + 池内有活的",
      build: () => {
        const c = cfg();
        const { probe, cooldowns } = cascadeState(c);
        return { features: feat(), config: c, compiledRules: compileRules(c.rules).compiled, cooldowns, availableModels: new Set(POOL), probe };
      },
    },
    {
      name: "规则目标死 + 无 fallback + 池内有活的",
      build: () => {
        const c = cfg({ fallback: { mode: "off" } });
        const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
        const cooldowns = new CooldownSet();
        cooldowns.add(RULE_TARGET, 3600_000, "quota");
        return { features: feat(), config: c, compiledRules: compileRules(c.rules).compiled, cooldowns, availableModels: new Set(POOL), probe };
      },
    },
    {
      name: "全池冷却（赦免路径）",
      build: () => {
        const c = cfg();
        const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
        const cooldowns = new CooldownSet();
        for (const sel of POOL) cooldowns.add(sel, 600_000, "all down");
        return { features: feat(), config: c, compiledRules: compileRules(c.rules).compiled, cooldowns, availableModels: new Set(POOL), probe };
      },
    },
    {
      name: "全池被 probe 排除（赦免路径）",
      build: () => {
        const c = cfg();
        const probe = new AvailabilityProbe({ config: c.probe, getBaseUrl: () => undefined });
        for (const sel of POOL) probe.markUnavailable(sel, 600_000, "all excluded");
        return { features: feat(), config: c, compiledRules: compileRules(c.rules).compiled, cooldowns: new CooldownSet(), availableModels: new Set(POOL), probe };
      },
    },
  ];

  for (const s of scenarios) {
    it(s.name, () => {
      const input = s.build();
      const d = decide(input);
      if (d.selector === undefined) return; // 保持当前是合法终态，调用方负责提示
      const { config, cooldowns, probe } = input;
      assert.equal(cooldowns.isCooldown(d.selector), false, `${s.name}: 返回了冷却中的 ${d.selector} (${d.reason})`);
      assert.notEqual(probe?.getAvailability(d.selector), "unavailable", `${s.name}: 返回了被排除的 ${d.selector} (${d.reason})`);
      if (config.pool.length) {
        assert.ok(config.pool.some((p) => p.toLowerCase() === (d.selector as string).toLowerCase()), `${s.name}: 返回了池外模型 ${d.selector}`);
      }
    });
  }
});
