import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initPresetManager, applyPresetManagerInput, renderPresetManager, initNamePrompt, applyNameInput } from "../src/tui/multipick.ts";

const ITEMS = [
  { name: "日常", models: ["zai/glm-5.3", "volces/dsv4"] },
  { name: "攻坚", models: ["kimi/k3"] },
  { name: "省钱", models: ["shudie/flash", "zai/flash"] },
];

function cont(s: ReturnType<typeof initPresetManager>, data: string) {
  const act = applyPresetManagerInput(s, data);
  assert.equal(act.type, "continue", `expected continue for ${JSON.stringify(data)}`);
  if (act.type !== "continue") throw new Error("unreachable");
  return act.state;
}

describe("preset manager reducer", () => {
  it("arrows move cursor with clamping", () => {
    let s = initPresetManager(ITEMS, []);
    assert.equal(s.cursor, 0);
    s = cont(s, "\x1b[A");
    assert.equal(s.cursor, 0);
    s = cont(s, "\x1b[B");
    s = cont(s, "\x1b[B");
    assert.equal(s.cursor, 2);
    s = cont(s, "\x1b[B");
    assert.equal(s.cursor, 2);
  });

  it("enter activates cursor item", () => {
    const act = applyPresetManagerInput(initPresetManager(ITEMS, []), "\r");
    assert.equal(act.type, "activate");
    if (act.type === "activate") assert.equal(act.item.name, "日常");
  });

  it("esc / ctrl+c cancel", () => {
    assert.equal(applyPresetManagerInput(initPresetManager(ITEMS, []), "\x1b").type, "cancel");
    assert.equal(applyPresetManagerInput(initPresetManager(ITEMS, []), "\x03").type, "cancel");
  });

  it("e selects current item for edit", () => {
    let s = initPresetManager(ITEMS, []);
    s = cont(s, "\x1b[B"); // cursor → 1 (攻坚)
    const act = applyPresetManagerInput(s, "e");
    assert.equal(act.type, "edit");
    if (act.type === "edit") assert.equal(act.item.name, "攻坚");
  });

  it("r selects current item for rename", () => {
    const act = applyPresetManagerInput(initPresetManager(ITEMS, []), "r");
    assert.equal(act.type, "rename");
    if (act.type === "rename") assert.equal(act.item.name, "日常");
  });

  it("d enters delete-confirm sub-state; second d confirms; other key cancels", () => {
    let s = initPresetManager(ITEMS, []);
    // 第一下 d → 进入确认子状态（continue）
    s = cont(s, "d");
    assert.equal(s.pendingDelete, "日常");
    // 第二下 d → 确认删除
    const act = applyPresetManagerInput(s, "d");
    assert.equal(act.type, "delete");
    if (act.type === "delete") assert.equal(act.name, "日常");
  });

  it("d then esc cancels delete-confirm (back to menu, no delete)", () => {
    let s = initPresetManager(ITEMS, []);
    s = cont(s, "d");
    s = cont(s, "\x1b"); // 取消确认
    assert.equal(s.pendingDelete, null);
    // 再按 esc → 这次是取消整个菜单
    assert.equal(applyPresetManagerInput(s, "\x1b").type, "cancel");
  });

  it("d then enter confirms delete", () => {
    let s = initPresetManager(ITEMS, []);
    s = cont(s, "d");
    const act = applyPresetManagerInput(s, "\r");
    assert.equal(act.type, "delete");
    if (act.type === "delete") assert.equal(act.name, "日常");
  });

  it("n emits create action", () => {
    assert.equal(applyPresetManagerInput(initPresetManager(ITEMS, []), "n").type, "create");
  });

  it("empty items: enter/operation keys are no-ops (continue)", () => {
    const s = initPresetManager([], []);
    assert.equal(applyPresetManagerInput(s, "\r").type, "continue");
    assert.equal(applyPresetManagerInput(s, "e").type, "continue");
    assert.equal(applyPresetManagerInput(s, "r").type, "continue");
    assert.equal(applyPresetManagerInput(s, "d").type, "continue");
  });

  it("render shows items with counts, active marker, and help", () => {
    const lines = renderPresetManager(initPresetManager(ITEMS, ["zai/glm-5.3", "volces/dsv4"]), 100);
    assert.ok(lines.some((l) => l.includes("日常")));
    assert.ok(lines.some((l) => l.includes("2 模型")));
    // 当前激活池与「日常」预设模型一致 → 显示 ● 当前
    assert.ok(lines.some((l) => l.includes("● 当前")));
    assert.ok(lines.some((l) => l.includes("enter 激活")));
    assert.ok(lines.some((l) => l.includes("esc 退出")));
    // 所有行不超宽
    for (const l of lines) assert.ok(l.length <= 100);
  });

  it("render shows empty-state hint and current pool info", () => {
    const lines = renderPresetManager(initPresetManager([], ["volces/dsv4"]), 80);
    assert.ok(lines.some((l) => l.includes("暂无预设")));
    assert.ok(lines.some((l) => l.includes("volces/dsv4")));
  });

  it("render pendingDelete shows confirm hint", () => {
    let s = initPresetManager(ITEMS, []);
    s = cont(s, "d");
    const lines = renderPresetManager(s, 100);
    assert.ok(lines.some((l) => l.includes("确认删除")));
    assert.ok(lines.some((l) => l.includes("日常")));
  });
});

describe("name prompt with initial text (rename prefilled)", () => {
  it("initNamePrompt accepts initialText and state holds it", () => {
    const s = initNamePrompt("重命名预设？输入新名称", "日常");
    assert.equal(s.text, "日常");
    assert.equal(s.hint, "重命名预设？输入新名称");
  });

  it("applyNameInput with prefilled text: backspace edits, enter confirms trimmed", () => {
    let s = initNamePrompt("重命名预设", "日常");
    assert.equal(s.text, "日常");
    // 追加 "2"
    s = (applyNameInput(s, "2") as { state: typeof s }).state;
    assert.equal(s.text, "日常2");
    const act = applyNameInput(s, "\r");
    assert.equal(act.type, "confirm");
    if (act.type === "confirm") assert.equal(act.name, "日常2");
  });
});
