import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig, persistPool, filterByPool, globalConfigPath } from "../src/config.ts";

const HOME_BACKUP = process.env.HOME;
let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "pi-router-pool-"));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = HOME_BACKUP;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("pool config", () => {
  it("pool defaults to empty array (no filtering)", () => {
    const cfg = normalizeConfig({});
    assert.deepEqual(cfg.pool, []);
  });

  it("pool normalizes: trims, dedupes (case-insensitive kept first), drops empties", () => {
    const cfg = normalizeConfig({ pool: [" volces/a ", "volces/a", "", "zai/b"] });
    assert.deepEqual(cfg.pool, ["volces/a", "zai/b"]);
  });

  it("filterByPool: empty pool returns all as-is", () => {
    assert.deepEqual(filterByPool(["a/1", "b/2"], []), ["a/1", "b/2"]);
  });

  it("filterByPool: case-insensitive membership, keeps original casing", () => {
    assert.deepEqual(filterByPool(["A/One", "b/two", "c/three"], ["a/one", "C/THREE"]), ["A/One", "c/three"]);
  });

  it("persistPool writes to global config, reloadable via normalizeConfig", () => {
    persistPool(["volces/a", "opencode-go/b"]);
    const path = globalConfigPath();
    assert.ok(existsSync(path), "global config written under fake HOME");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pool?: string[] };
    assert.deepEqual(raw.pool, ["volces/a", "opencode-go/b"]);
    const cfg = normalizeConfig(raw);
    assert.deepEqual(cfg.pool, ["volces/a", "opencode-go/b"]);
  });

  it("persistPool overwrites pool but preserves other fields", () => {
    persistPool(["x/y"]);
    persistPool(["z/w"]);
    const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.pool, ["z/w"]);
  });
});

import { persistPoolPreset, removePoolPreset, applyPoolPreset } from "../src/config.ts";

describe("pool presets", () => {
  it("save → list → activate → remove roundtrip", () => {
    persistPool(["volces/a", "zai/b"]);
    persistPoolPreset("日常", ["volces/a", "zai/b"]);
    persistPoolPreset("攻坚", ["kimi/k3", "opencode/pro"]);

    // applyPoolPreset 激活 "日常" → 全局 pool 变为该预设
    const applied = applyPoolPreset("日常");
    assert.deepEqual(applied, ["volces/a", "zai/b"]);
    const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as { pool?: string[]; poolPresets?: Record<string, string[]> };
    assert.deepEqual(raw.pool, ["volces/a", "zai/b"]);

    // 预设仍在，未激活的不受影响
    assert.ok(raw.poolPresets && raw.poolPresets["攻坚"]);

    // 未知预设 → undefined，不动配置
    assert.equal(applyPoolPreset("不存在"), undefined);

    // 删除
    assert.equal(removePoolPreset("日常"), true);
    assert.equal(removePoolPreset("不存在"), false);
    const raw2 = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as { poolPresets?: Record<string, string[]> };
    assert.ok(!raw2.poolPresets?.["日常"]);
    assert.ok(raw2.poolPresets?.["攻坚"]);
  });

  it("normalizeConfig parses poolPresets (drop empty/invalid)", () => {
    const cfg = normalizeConfig({ poolPresets: { a: ["x/1", "x/1", "  "], bad: "not-array" as never, "": ["y/2"] } });
    assert.deepEqual(cfg.poolPresets, { a: ["x/1"] });
  });
});
