/**
 * 模型池多选器（/router pool）
 *
 * 纯状态机 + 渲染分离：
 * - reducer: applyInput(state, data) → { state, action } 可单测
 * - renderPicker(state, width, theme?) → string[] TUI 渲染
 * - PoolPickerComponent: pi-tui 组件壳（供 ctx.ui.custom 使用）
 *
 * 交互：输入字符搜索（子串、大小写不敏感）· backspace 删字符 · ↑↓ 移动
 *       空格 toggle 勾选 · 回车确认全部勾选 · esc 取消
 */
// 标准 ANSI 按键序列（零依赖，避免 peer 依赖 pi-tui；esc 为单独 \x1b，与方向键前缀不冲突）
const KEY = {
  enter: "\r",
  enterAlt: "\n",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  space: " ",
  backspace: "\x7f",
  backspaceAlt: "\b",
  ctrlC: "\x03",
} as const;

function matchesKey(data: string, key: string): boolean {
  return data === key;
}

export interface PoolItem {
  selector: string;
  contextWindow?: number;
  costInput?: number;
}

export interface PickerState {
  query: string;
  cursor: number; // 过滤后列表内的光标下标
  checked: Set<string>;
  items: PoolItem[]; // 全量（未过滤）
}

export type PickerAction =
  | { type: "continue"; state: PickerState }
  | { type: "confirm"; selected: string[] }
  | { type: "cancel" };

export function initPickerState(items: PoolItem[], initialChecked: Iterable<string> = []): PickerState {
  return { query: "", cursor: 0, checked: new Set(initialChecked), items };
}

/** 过滤：query 按空格分词，全部子串命中（小写）才保留 */
export function filteredItems(state: PickerState): PoolItem[] {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return state.items;
  return state.items.filter((it) => {
    const s = it.selector.toLowerCase();
    return terms.every((t) => s.includes(t));
  });
}

function clampCursor(state: PickerState): PickerState {
  const n = filteredItems(state).length;
  if (n === 0) return { ...state, cursor: 0 };
  return { ...state, cursor: Math.min(Math.max(0, state.cursor), n - 1) };
}

/** 输入 reducer：处理一次按键。返回 continue（新状态）/ confirm（确认勾选集合）/ cancel */
export function applyInput(state: PickerState, data: string): PickerAction {
  if (matchesKey(data, KEY.esc) || matchesKey(data, KEY.ctrlC)) {
    return { type: "cancel" };
  }
  if (matchesKey(data, KEY.enter) || matchesKey(data, KEY.enterAlt)) {
    return { type: "confirm", selected: [...state.checked] };
  }
  if (matchesKey(data, KEY.up)) {
    return { type: "continue", state: clampCursor({ ...state, cursor: state.cursor - 1 }) };
  }
  if (matchesKey(data, KEY.down)) {
    return { type: "continue", state: clampCursor({ ...state, cursor: state.cursor + 1 }) };
  }
  if (matchesKey(data, KEY.space)) {
    const list = filteredItems(state);
    const it = list[state.cursor];
    if (it) {
      const checked = new Set(state.checked);
      if (checked.has(it.selector)) checked.delete(it.selector);
      else checked.add(it.selector);
      return { type: "continue", state: { ...state, checked } };
    }
    return { type: "continue", state };
  }
  if (matchesKey(data, KEY.backspace) || matchesKey(data, KEY.backspaceAlt)) {
    if (state.query.length === 0) return { type: "continue", state };
    return { type: "continue", state: clampCursor({ ...state, query: state.query.slice(0, -1), cursor: 0 }) };
  }
  // 可打印字符（含中文，多字节 UTF-8 解码后 length>=1）追加搜索词；忽略其它控制序列
  if (data.length >= 1 && !data.startsWith("\x1b") && !/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data)) {
    return { type: "continue", state: clampCursor({ ...state, query: state.query + data, cursor: 0 }) };
  }
  return { type: "continue", state };
}

export interface PickerTheme {
  fg: (color: string, text: string) => string;
}

// 注：pi theme.fg 是实例方法（内部访问 this.fgColors），必须闭包调用保持 this 绑定；
// 直接解构 theme?.fg 会丢失 this → "Cannot read properties of undefined (reading 'fgColors')" → pi 崩溃

function fmtCtx(n?: number): string {
  if (!n) return "";
  if (n >= 1000) return `${Math.round(n / 1000)}M`;
  return `${Math.floor(n)}k`;
}

function fmtCost(n?: number): string {
  if (n === undefined || n === null) return "";
  if (n === 0) return "$0";
  return `$${n < 1 ? n.toFixed(2) : n}`;
}

const MAX_VISIBLE = 12;

/** 渲染：搜索行 + 勾选列表（滚动窗口）+ 帮助行 */
export function renderPicker(state: PickerState, width: number, theme?: PickerTheme): string[] {
  // 闭包包装保持 this 绑定（见文件头注释）；无 theme 时纯文本
  const fg: (color: string, text: string) => string = theme ? (c, t) => theme.fg(c, t) : (_c, t) => t;
  const lines: string[] = [];
  lines.push(fg("accent", "模型池") + fg("dim", " ─ 输入搜索 · ↑↓移动 · 空格勾选 · 回车保存 · esc取消"));
  lines.push(fg("muted", `搜索: ${state.query || ""}█`));
  const list = filteredItems(state);
  if (list.length === 0) {
    lines.push(fg("warning", "  (无匹配模型)"));
  } else {
    // 滚动窗口：保持 cursor 可见
    let start = Math.max(0, state.cursor - Math.floor(MAX_VISIBLE / 2));
    const maxStart = Math.max(0, list.length - MAX_VISIBLE);
    start = Math.min(start, maxStart);
    const end = Math.min(list.length, start + MAX_VISIBLE);
    for (let i = start; i < end; i++) {
      const it = list[i];
      const mark = state.checked.has(it.selector) ? "✓" : " ";
      const cursorMark = i === state.cursor ? "> " : "  ";
      const meta: string[] = [];
      const ctxStr = fmtCtx(it.contextWindow);
      if (ctxStr) meta.push(ctxStr);
      const costStr = fmtCost(it.costInput);
      if (costStr) meta.push(costStr);
      const metaStr = meta.length ? fg("dim", `  ${meta.join("  ")}`) : "";
      const selStr = state.checked.has(it.selector)
        ? fg("success", `${cursorMark}${mark} ${it.selector}`)
        : i === state.cursor
          ? fg("accent", `${cursorMark}${mark} ${it.selector}`)
          : `${cursorMark}${mark} ${it.selector}`;
      lines.push(selStr + metaStr);
    }
    if (list.length > MAX_VISIBLE) {
      lines.push(fg("dim", `  … ${list.length - MAX_VISIBLE} more (共${list.length} 匹配)`));
    }
  }
  lines.push(fg("dim", `已勾选 ${state.checked.size} 个模型${state.checked.size === 0 ? "（空 = 不过滤，全部可用模型参与路由）" : " · 空格切换勾选 · 回车保存到全局配置"}`));
  return lines.map((l) => (l.length > width ? l.slice(0, width) : l));
}

/** pi-tui 组件壳（render 每次现算，无需 invalidate 缓存） */
export class PoolPickerComponent {
  private state: PickerState;
  onConfirm: (selected: string[]) => void = () => {};
  onCancel: () => void = () => {};

  constructor(items: PoolItem[], initialChecked: Iterable<string> = []) {
    this.state = initPickerState(items, initialChecked);
  }

  handleInput(data: string, requestRender: () => void): void {
    const act = applyInput(this.state, data);
    if (act.type === "cancel") { this.onCancel(); return; }
    if (act.type === "confirm") { this.onConfirm(act.selected); return; }
    this.state = act.state;
    requestRender();
  }

  render(width: number, theme?: PickerTheme): string[] {
    return renderPicker(this.state, width, theme);
  }
}
