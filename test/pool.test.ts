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
