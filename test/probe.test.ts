import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityProbe, type ProbeDeps } from "../src/probe/availability.ts";
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

  it("markAvailable does not override unavailable", () => {
    const probe = new AvailabilityProbe(deps({}));
    probe.markAuthFailure("a/b");
    probe.markAvailable("a/b");
    assert.equal(probe.getAvailability("a/b"), "unavailable");
  });

  it("snapshot is per-session independent (new instance fresh)", () => {
    const p1 = new AvailabilityProbe(deps({}));
    p1.markAuthFailure("a/b");
    const p2 = new AvailabilityProbe(deps({}));
    assert.equal(p2.getAvailability("a/b"), "uncertain");
  });
});
