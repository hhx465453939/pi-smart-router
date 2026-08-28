import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { ModelCatalog } from "../src/catalog/catalog.ts";

const TMP = "/tmp/pi-catalog-test.json";

function regInfo(over: Partial<Parameters<typeof ModelCatalog.prototype.merge>[0][number]> = {}) {
  return {
    selector: "zai-coding-cn/glm-5.3",
    provider: "zai-coding-cn",
    contextWindow: 128000,
    cost: { input: 1, output: 2, cacheRead: 0.1 },
    input: ["text"],
    ...over,
  };
}

describe("ModelCatalog", () => {
  beforeEach(() => { rmSync(TMP, { force: true }); });

  it("merge seeds entries and persists", () => {
    const c = new ModelCatalog(TMP);
    c.merge([regInfo(), regInfo({ selector: "opencode-go/kimi-k3", provider: "opencode-go" })]);
    assert.equal(c.get("zai-coding-cn/glm-5.3")?.contextWindow, 128000);
    assert.ok(existsSync(TMP), "should persist to file");
  });

  it("merge preserves user annotations and learn scores", () => {
    const c = new ModelCatalog(TMP);
    c.merge([regInfo()]);
    c.annotate("zai-coding-cn/glm-5.3", { scenarios: ["backend"], difficultyTier: "high", note: "主力" });
    c.record("zai-coding-cn/glm-5.3", "backend", "high", 1.0, 0.9);
    // 再次 merge（registry 刷新）不应丢失标注
    c.merge([regInfo()]);
    const e = c.get("zai-coding-cn/glm-5.3");
    assert.deepEqual(e?.scenarios, ["backend"]);
    assert.equal(e?.difficultyTier, "high");
    assert.equal(e?.note, "主力");
    assert.ok((e?.learnScore["backend×high"] ?? 0) > 0);
  });

  it("record accumulates with decay and samples count", () => {
    const c = new ModelCatalog(TMP);
    c.merge([regInfo()]);
    c.record("zai-coding-cn/glm-5.3", "frontend", "low", 1, 0.9);
    c.record("zai-coding-cn/glm-5.3", "frontend", "low", 1, 0.9);
    const e = c.get("zai-coding-cn/glm-5.3")!;
    assert.equal(e.samples["frontend×low"], 2);
    assert.ok(e.learnScore["frontend×low"] > 0);
  });

  it("ranked returns scores desc and includes scenario-tagged models", () => {
    const c = new ModelCatalog(TMP);
    c.merge([
      regInfo({ selector: "a/k3", provider: "a" }),
      regInfo({ selector: "b/flash", provider: "b" }),
    ]);
    c.annotate("a/k3", { scenarios: ["frontend"] });
    c.record("a/k3", "frontend", "low", 2, 0.9);
    const ranked = c.ranked("frontend", "low");
    assert.equal(ranked[0]?.selector, "a/k3");
    // b/flash 无分也无标注 → 不出现
    assert.ok(!ranked.some((r) => r.selector === "b/flash"));
  });

  it("corrupt file tolerated (rebuild empty)", () => {
    writeFileSync(TMP, "{not json", "utf8");
    const c = new ModelCatalog(TMP);
    assert.equal(c.all().length, 0);
  });
});
