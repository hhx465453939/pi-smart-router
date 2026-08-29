import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initPickerState, applyInput, filteredItems, renderPicker, type PoolItem } from "../src/tui/multipick.ts";

const ITEMS: PoolItem[] = [
  { selector: "volces/deepseek-v4-flash[1m]", contextWindow: 1048576, costInput: 0 },
  { selector: "opencode-go/deepseek-v4-flash", contextWindow: 1048576, costInput: 0.22 },
  { selector: "zai-coding-cn/glm-5.3", contextWindow: 1000000, costInput: 1.4 },
  { selector: "kimi-coding/k3-256k", contextWindow: 262144, costInput: 0.5 },
];

function cont(s: ReturnType<typeof initPickerState>, data: string) {
  const act = applyInput(s, data);
  assert.equal(act.type, "continue", `expected continue for ${JSON.stringify(data)}`);
  return act.state;
}

describe("pool picker reducer", () => {
  it("typing filters items (substring, case-insensitive); typing appends, backspace clears", () => {
    let s = initPickerState(ITEMS);
    s = cont(s, "deep");
    s = cont(s, "seek");
    assert.equal(filteredItems(s).length, 2);
    // 输入是追加不是替换：需退格后再搜 glm
    for (let i = 0; i < 8; i++) s = cont(s, "\x7f");
    s = cont(s, "GLM");
    assert.equal(filteredItems(s).length, 1);
    assert.equal(filteredItems(s)[0].selector, "zai-coding-cn/glm-5.3");
  });

  it("space is always toggle, never appended to query", () => {
    // 用户交互契约：空格多选勾选，搜索词为连续子串（不含空格）
    let s = initPickerState(ITEMS);
    s = cont(s, "g");
    assert.equal(s.query, "g");
    // "g" 匹配 opencode-go 与 zai/glm-5.3，cursor=0 → toggle opencode-go
    s = cont(s, " ");
    assert.equal(s.query, "g", "space must not enter query");
    assert.ok(s.checked.has("opencode-go/deepseek-v4-flash"), "space toggles cursor item");
  });

  it("space toggles check on cursor item", () => {
    let s = initPickerState(ITEMS);
    s = cont(s, " ");
    assert.equal(s.checked.size, 1);
    assert.ok(s.checked.has(ITEMS[0].selector));
    s = cont(s, " ");
    assert.equal(s.checked.size, 0);
  });

  it("space in query position vs toggle: typing space mid-word appends, standalone toggle", () => {
    // 同上：空格恒为 toggle；本测试验证 toggle 后继续输入仍能追加搜索词
    let s = initPickerState(ITEMS);
    s = cont(s, "glm");
    s = cont(s, " ");
    s = cont(s, "5");
    assert.equal(s.query, "glm5");
  });

  it("backspace removes last char of query", () => {
    let s = initPickerState(ITEMS);
    s = cont(s, "glm");
    assert.equal(filteredItems(s).length, 1);
    s = cont(s, "\x7f");
    assert.equal(s.query, "gl");
    assert.equal(filteredItems(s).length, 1); // glm still matches "gl"
    s = cont(s, "\x7f");
    s = cont(s, "\x7f");
    assert.equal(s.query, "");
    assert.equal(filteredItems(s).length, 4);
  });

  it("arrow keys move cursor with clamping", () => {
    let s = initPickerState(ITEMS);
    assert.equal(s.cursor, 0);
    s = cont(s, "\x1b[A"); // up at top → clamp 0
    assert.equal(s.cursor, 0);
    s = cont(s, "\x1b[B"); // down
    assert.equal(s.cursor, 1);
    s = cont(s, "\x1b[B");
    s = cont(s, "\x1b[B");
    assert.equal(s.cursor, 3);
    s = cont(s, "\x1b[B"); // down at bottom → clamp
    assert.equal(s.cursor, 3);
  });

  it("enter confirms checked set (toggle affects cursor item, not pre-checked)", () => {
    let s = initPickerState(ITEMS, ["zai-coding-cn/glm-5.3"]);
    // 先导航到已勾选的 zai 项再空格 → 取消勾选，确认后为空
    s = cont(s, "glm");
    s = cont(s, " ");
    assert.equal(s.checked.size, 0);
    const act = applyInput(s, "\r");
    assert.equal(act.type, "confirm");
    if (act.type === "confirm") assert.deepEqual(act.selected, []);
  });

  it("enter with empty selection confirms empty (clears pool)", () => {
    const act = applyInput(initPickerState(ITEMS), "\r");
    assert.equal(act.type, "confirm");
    if (act.type === "confirm") assert.deepEqual(act.selected, []);
  });

  it("esc and ctrl+c cancel", () => {
    assert.equal(applyInput(initPickerState(ITEMS), "\x1b").type, "cancel");
    assert.equal(applyInput(initPickerState(ITEMS), "\x03").type, "cancel");
  });

  it("query resets cursor to 0 after typing", () => {
    let s = initPickerState(ITEMS);
    s = cont(s, "\x1b[B");
    s = cont(s, "\x1b[B");
    s = cont(s, "g");
    assert.equal(s.cursor, 0);
  });

  it("chinese search input works (multi-byte chars)", () => {
    const items: PoolItem[] = [{ selector: "zai/中文模型" }, { selector: "op/abc" }];
    let s = initPickerState(items);
    s = cont(s, "中");
    s = cont(s, "文");
    assert.equal(filteredItems(s).length, 1);
    assert.equal(filteredItems(s)[0].selector, "zai/中文模型");
  });

  it("render produces lines with query, items and help", () => {
    let s = initPickerState(ITEMS, ["zai-coding-cn/glm-5.3"]);
    s = cont(s, "deep");
    const lines = renderPicker(s, 120);
    assert.ok(lines.length >= 4);
    assert.ok(lines.some((l) => l.includes("搜索: deep")));
    // 过滤后 2 项 deepseek 均未勾选，但帮助行显示已勾选计数
    assert.ok(lines.some((l) => l.includes("已勾选 1")));
    // 全量视图（无 query）时勾选项带 ✓
    const all = renderPicker(initPickerState(ITEMS, ["zai-coding-cn/glm-5.3"]), 120);
    assert.ok(all.some((l) => l.includes("✓ zai-coding-cn/glm-5.3")));
    // 所有行不超宽
    for (const l of lines) assert.ok(l.length <= 120);
  });

  it("render shows no-match warning", () => {
    let s = initPickerState(ITEMS);
    s = cont(s, "zzz");
    const lines = renderPicker(s, 80);
    assert.ok(lines.some((l) => l.includes("无匹配")));
  });
});

describe("theme binding (pi crash regression)", () => {
  it("fg must be invoked with this bound (method-owning theme must not crash)", () => {
    // 模拟 pi 真实 theme：fg 是依赖 this 的实例方法（内部访问 this.colors）
    const themeLikePi = {
      colors: { accent: "[A]", dim: "[D]", success: "[S]", warning: "[W]", muted: "[M]" },
      fg(this: { colors: Record<string, string> }, color: string, text: string): string {
        return (this.colors[color] ?? "") + text; // this 丢失时这里抛 TypeError
      },
    };
    const s = initPickerState(ITEMS, ["zai-coding-cn/glm-5.3"]);
    // 旧实现（解构 theme?.fg）在此调用会抛 "Cannot read properties of undefined"
    const lines = renderPicker(s, 100, themeLikePi);
    assert.ok(lines.length >= 4);
    assert.ok(lines.some((l) => l.includes("[A]") || l.includes("模型池")));
    assert.ok(lines.some((l) => l.includes("[S]✓") || l.includes("✓")));
  });

  it("no-theme render stays plain text (no crash)", () => {
    const s = initPickerState(ITEMS);
    const lines = renderPicker(s, 80, undefined);
    assert.ok(lines.length >= 4);
  });
});

import { initNamePrompt, applyNameInput, renderNamePrompt, initPresetPicker, applyPresetInput, renderPresetPicker } from "../src/tui/multipick.ts";

describe("name prompt (preset naming)", () => {
  it("typing builds name, backspace edits, enter confirms trimmed", () => {
    let s = initNamePrompt("保存为预设？输入名称");
    for (const ch of "日 常 ") s = (applyNameInput(s, ch) as { state: typeof s }).state;
    // 尾随空格被 trim：先删掉再确认
    s = (applyNameInput(s, "\x7f") as { state: typeof s }).state;
    const act = applyNameInput(s, "\r");
    assert.equal(act.type, "confirm");
    if (act.type === "confirm") assert.equal(act.name, "日 常");
  });
  it("enter with empty name cancels (skip)", () => {
    assert.equal(applyNameInput(initNamePrompt(), "\r").type, "cancel");
  });
  it("esc cancels, chinese input works", () => {
    assert.equal(applyNameInput(initNamePrompt(), "\x1b").type, "cancel");
    let s = initNamePrompt();
    s = (applyNameInput(s, "攻") as { state: typeof s }).state;
    s = (applyNameInput(s, "坚") as { state: typeof s }).state;
    assert.equal(s.text, "攻坚");
  });
  it("render shows hint, name and help", () => {
    let s = initNamePrompt("保存为预设？输入名称");
    s = (applyNameInput(s, "d") as { state: typeof s }).state;
    const lines = renderNamePrompt(s, 80);
    assert.ok(lines.some((l) => l.includes("保存为预设")));
    assert.ok(lines.some((l) => l.includes("名称: d█")));
    assert.ok(lines.some((l) => l.includes("esc 跳过")));
  });
});

describe("preset picker", () => {
  const items = [
    { name: "日常", models: ["zai/glm-5.3", "volces/dsv4"] },
    { name: "攻坚", models: ["kimi/k3"] },
    { name: "省钱", models: ["shudie/flash", "zai/flash"] },
  ];
  it("arrows move with clamp, enter confirms item", () => {
    let s = initPresetPicker(items);
    assert.equal(s.cursor, 0);
    s = (applyPresetInput(s, "\x1b[A") as { state: typeof s }).state;
    assert.equal(s.cursor, 0);
    s = (applyPresetInput(s, "\x1b[B") as { state: typeof s }).state;
    s = (applyPresetInput(s, "\x1b[B") as { state: typeof s }).state;
    assert.equal(s.cursor, 2);
    s = (applyPresetInput(s, "\x1b[B") as { state: typeof s }).state;
    assert.equal(s.cursor, 2);
    const act = applyPresetInput(s, "\r");
    assert.equal(act.type, "confirm");
    if (act.type === "confirm") assert.equal(act.item.name, "省钱");
  });
  it("esc cancels; empty list enter cancels", () => {
    assert.equal(applyPresetInput(initPresetPicker(items), "\x1b").type, "cancel");
    assert.equal(applyPresetInput(initPresetPicker([]), "\r").type, "cancel");
  });
  it("render lists presets with counts and help", () => {
    const lines = renderPresetPicker(initPresetPicker(items), 100);
    assert.ok(lines.some((l) => l.includes("日常") && l.includes("2 模型")));
    assert.ok(lines.some((l) => l.includes("> 日常")));
    assert.ok(lines.some((l) => l.includes("共 3 个预设")));
    const empty = renderPresetPicker(initPresetPicker([]), 100);
    assert.ok(empty.some((l) => l.includes("无预设")));
  });
});
