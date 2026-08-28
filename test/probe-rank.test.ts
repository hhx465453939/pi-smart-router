import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityProbe } from "../src/probe/availability.ts";

describe("AvailabilityProbe — not-通 excluded from rank", () => {
  it("all-models target unreachable → excluded via filterAvailable", async () => {
    const probe = new AvailabilityProbe({ config: { enabled: true, timeoutMs: 300000, probeOnStart: true, excludeUnavailable: true }, getBaseUrl: () => "http://127.0.0.1:9" });
    probe.startByProvider([{ selector: "x/a", provider: "p", baseUrl: "http://127.0.0.1:9" }, { selector: "x/b", provider: "p", baseUrl: "http://127.0.0.1:9" }]);
    for (let i = 0; i < 30 && probe.isRunning(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(probe.getAvailability("x/a"), "unavailable");
    assert.equal(probe.getAvailability("x/b"), "unavailable");
    assert.deepEqual(probe.filterAvailable(["x/a", "x/b", "y/c"]), ["y/c"]);
  });

  it("available provider models kept", async () => {
    // 无 baseUrl → 不硬排除（uncertain/available）
    const probe = new AvailabilityProbe({ config: { enabled: true, timeoutMs: 300000, probeOnStart: true, excludeUnavailable: true }, getBaseUrl: () => undefined });
    probe.startByProvider([{ selector: "y/a", provider: "py" }, { selector: "y/b", provider: "py" }]);
    for (let i = 0; i < 20 && probe.isRunning(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(probe.getAvailability("y/a"), "available");
    assert.equal(probe.getAvailability("y/b"), "available");
    assert.deepEqual(probe.filterAvailable(["y/a", "y/b"]).length, 2);
  });
});
