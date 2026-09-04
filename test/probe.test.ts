import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityProbe, PROBE_TTL, type ProbeDeps } from "../src/probe/availability.ts";
import type { NormalizedProbeConfig } from "../src/types.ts";

const cfg: NormalizedProbeConfig = { enabled: true, timeoutMs: 300000, probeOnStart: true, excludeUnavailable: true };

function deps(baseUrls: Record<string, string>): ProbeDeps {
  return {
    config: cfg,
    getBaseUrl: (p) => baseUrls[p],
  };
}

describe("AvailabilityProbe", () => {
  it("markAuthFailure marks unavailable deterministically (401/402/403)", () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markAuthFailure("shudie/glm-5.2");
    assert.equal(probe.getAvailability("shudie/glm-5.2"), "unavailable");
    // filterAvailable excludes it, keeps uncertain others
    const filtered = probe.filterAvailable(["shudie/glm-5.2", "zai-coding-cn/glm-5.3"]);
    assert.deepEqual(filtered, ["zai-coding-cn/glm-5.3"]);
  });

  it("unreachable endpoint excluded; reachable kept (async background)", async () => {
    const probe = new AvailabilityProbe(deps({}));
    // 无 baseUrl 的 provider：不硬排除（保持可用/不确定，仅不标 unavailable）
    probe.start([{ selector: "a/none", provider: "none-provider" }]);
    await new Promise((r) => setTimeout(r, 50));
    const avail = probe.getAvailability("a/none");
    assert.ok(avail !== "unavailable", `a/none should not be excluded, got ${avail}`);
    assert.ok(probe.filterAvailable(["a/none"]).includes("a/none"), "not excluded");
  });

  it("probe unreachable → unavailable via fetch failure", async () => {
    const probe = new AvailabilityProbe(deps({ dead: "http://127.0.0.1:9" }));
    probe.start([{ selector: "x/dead", provider: "dead", baseUrl: "http://127.0.0.1:9" }]);
    // 等待后台探测完成
    for (let i = 0; i < 40 && probe.isRunning(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(probe.getAvailability("x/dead"), "unavailable");
    assert.deepEqual(probe.filterAvailable(["x/dead", "y/other"]), ["y/other"]);
  });

  it("disabled probe: start no-op", async () => {
    const probe = new AvailabilityProbe({ ...deps({}), config: { ...cfg, enabled: false } });
    probe.start([{ selector: "a/b", provider: "p", baseUrl: "http://127.0.0.1:9" }]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(probe.getAvailability("a/b"), "uncertain");
    assert.equal(probe.isRunning(), false);
  });

  // 旧实现断言 "markAvailable does not override unavailable"（永久拉黑不可逆），
  // 那正是级联失败后整个 session 报废、只能重启 pi 的根因，见 .debug/fallback-loop-debug.md L2。
  it("markAvailable clears the exclusion (real-call self-healing)", () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markAuthFailure("a/b");
    assert.equal(probe.getAvailability("a/b"), "unavailable");
    probe.markAvailable("a/b");
    assert.equal(probe.getAvailability("a/b"), "uncertain");
    assert.deepEqual(probe.filterAvailable(["a/b"]), ["a/b"]);
  });

  it("exclusion expires by TTL and the model rejoins candidates", async () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markUnavailable("a/b", 20, "transient");
    assert.equal(probe.getAvailability("a/b"), "unavailable");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(probe.getAvailability("a/b"), "uncertain");
    assert.deepEqual(probe.excluded(), []);
  });

  it("excluded() lists live exclusions ordered by soonest recovery", () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markUnavailable("slow/quota", PROBE_TTL.quota, "quota exhausted");
    probe.markUnavailable("fast/5xx", PROBE_TTL.server, "5xx");
    const list = probe.excluded();
    assert.deepEqual(list.map((e) => e.selector), ["fast/5xx", "slow/quota"]);
    assert.ok(list[0].remainingMs > 0 && list[0].remainingMs <= PROBE_TTL.server);
    assert.equal(list[1].reason, "quota exhausted");
  });

  it("clear()/clearAll() release exclusions manually", () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markUnavailable("a/b");
    probe.markUnavailable("c/d");
    assert.equal(probe.clear("a/b"), true);
    assert.equal(probe.clear("a/b"), false);
    assert.deepEqual(probe.excluded().map((e) => e.selector), ["c/d"]);
    probe.clearAll();
    assert.deepEqual(probe.excluded(), []);
  });

  it("selector matching is case/whitespace insensitive", () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markUnavailable("Shudie/GLM-5.2");
    assert.equal(probe.getAvailability("  shudie/glm-5.2 "), "unavailable");
  });

  it("every PROBE_TTL default is a positive finite duration", () => {
    for (const [k, v] of Object.entries(PROBE_TTL)) {
      assert.ok(Number.isFinite(v) && v > 0, `${k} TTL should be finite and positive, got ${v}`);
    }
  });

  it("snapshot is per-session independent (new instance fresh)", () => {
    const p1 = new AvailabilityProbe(deps({}));
    p1.markAuthFailure("a/b");
    const p2 = new AvailabilityProbe(deps({}));
    assert.equal(p2.getAvailability("a/b"), "uncertain");
  });
});
