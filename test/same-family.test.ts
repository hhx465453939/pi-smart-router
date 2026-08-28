import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** 同类模型归一化 + 优先选择逻辑（提炼自 index.ts 的 normalizeModelBase + sameFamily） */
function normalizeModelBase(id: string): string {
  return id.toLowerCase().replace(/\[[^\]]*\]/g, "").replace(/-\d{3,4}(?=$|-)/g, "").replace(/[-_]+$/g, "").trim();
}

/** 模拟 tryImmediateFallback 的 next 选择：同类优先，同类多时取 rank 首个 */
function pickNext(failed: string, ranked: string[]): string | undefined {
  const failedBase = normalizeModelBase(failed.split("/").slice(1).join("/"));
  const sameFamily = ranked.filter((s) => s.toLowerCase() !== failed.toLowerCase() && normalizeModelBase(s.split("/").slice(1).join("/")) === failedBase);
  if (sameFamily.length > 0) return sameFamily[0];
  return ranked.find((s) => s.toLowerCase() !== failed.toLowerCase());
}

describe("same-family fallback preference", () => {
  it("normalize strips variant suffixes", () => {
    assert.equal(normalizeModelBase("deepseek-v4-flash[1m]"), "deepseek-v4-flash");
    assert.equal(normalizeModelBase("deepseek-v4-flash-0731"), "deepseek-v4-flash");
    assert.equal(normalizeModelBase("DeepSeek-V4-Flash-0731"), "deepseek-v4-flash");
    assert.equal(normalizeModelBase("GLM-5.3-Flash"), "glm-5.3-flash");
    assert.equal(normalizeModelBase("gpt-5.6-sol"), "gpt-5.6-sol");
  });

  it("volces dsv4 exhausted → prefers same-family opencode dsv4 over cheaper minimax", () => {
    // rank 顺序：minimax 性价比第一（learn 分高），dsv4 第二
    const ranked = ["opencode-go/minimax-m3", "opencode-go/deepseek-v4-flash", "shudie/deepseek-v4-flash", "zai-coding-cn/glm-5.3"];
    assert.equal(pickNext("volces/deepseek-v4-flash[1m]", ranked), "opencode-go/deepseek-v4-flash");
  });

  it("shudie dsv4-0731 exhausted → same family across providers", () => {
    const ranked = ["opencode-go/minimax-m3", "shudie/deepseek-v4-flash", "opencode-go/deepseek-v4-flash"];
    assert.equal(pickNext("shudie/deepseek-v4-flash-0731", ranked), "shudie/deepseek-v4-flash");
  });

  it("no same-family → falls back to rank order", () => {
    const ranked = ["opencode-go/minimax-m3", "zai-coding-cn/glm-5.3"];
    assert.equal(pickNext("volces/deepseek-v4-flash[1m]", ranked), "opencode-go/minimax-m3");
  });

  it("glm family matches glm variants", () => {
    const ranked = ["zai-coding-cn/glm-5.3", "opencode-go/glm-5.3", "opencode-go/minimax-m3"];
    assert.equal(pickNext("zai-coding-cn/glm-5.3", ranked), "opencode-go/glm-5.3");
  });
});
