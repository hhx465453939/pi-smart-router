# CHANGE — CHG-006

> status: implemented (用户: "设计一个开发+模型fallback测试的能力，你这么瞎猫撞死耗子写到猴年马月")
> 注：原始 status 为 approved；本次会话在 harness 基础上完成了从 fallback 修复到 Model Pool / 预设池的一整套路由治理，故标记 implemented。用户明确授权补全此文档记录全部完成工作。

## 摘要

建立 **e2e fallback 测试 harness**，并在其驱动下完成一系列真实环境缺陷修复 + 新功能：从「volces 429 额度耗尽仍被反复选中」的秒切，到「60+ 模型不可控」的模型池硬边界，再到「场景化一键切换」的命名预设池。

## 实际完成（按时间线）

### A. e2e fallback harness（原计划，实现方式有偏差）
- **产物**：`scripts/router-harness.ts`
- **实现方式与计划的偏差**：原计划用 pi SDK `createAgentSession` + pi-ai `fauxProvider`；实际采用**自研轻量 harness**（`FakeCtx` + 手动 `fire(event, payload)` 注入事件链），因为：
  1. 无需真实 SDK 会话，事件注入更精确可控（能精确模拟 SDK 层重试吞错、message_end 才到达错误）
  2. `fauxProvider` 的可编程响应序列在「模拟 message_end 而不是 after_provider_response」这条关键路径上不如手动 fire 直接
  - 该 harness 覆盖两条路径：`after_provider_response (SDK retry 层)` vs `message_end errorMessage（真实耗尽路径）`
- **关键发现**：最初 harness 的配置写错路径（`/tmp/router-harness-home/.pi` vs watcher 读的 `cwd/.pi`），导致 **harness 一直在空配置下运行**——规则/池从未被真正执行过，只有硬编码的秒切路径在跑。修复后将 fake 配置写入与 `FakeCtx.cwd` 匹配的路径，新增 `pool-boundary` 场景，规则/池才真正被测到。

### B. 可靠错误捕获点（429/401 检测）
- **缺陷**：`after_provider_response` / `tool_result` 检测 429 是**死代码**——SDK 层自动重试吞掉了错误响应，这些事件根本收不到 429；只有重试耗尽、错误到达 `message_end` 时才可靠。
- **修复**：错误捕获移到 `message_end`（读 `errorMessage`，识别 `AccountQuotaExceeded / quota exceeded` 等模式），→ `probe.markUnavailable` → 本 session 排除。

### C. setModel 传对象（真实 pi API 契约）
- **缺陷**：`pi.setModel(selector字符串)` 在真实 pi 被拒绝（内部 `checkAuth(model.provider)`，字符串无 `.provider`）→ 报「切换失败 / 无权限或找不到」。
- **修复**：先 `modelRegistry.find(provider, id)` 解析为**对象**再调用（与 `before_agent_start` / handoff 工具一致），字符串仅作兼容兜底。

### D. same-family fallback（同类模型优先）
- 用户核心需求：「秒切其他供应商的**同类**模型」。
- 新增 `normalizeModelBase`：小写、去 `[1m]`、去 `-0731` 日期后缀，使跨供应商同款可匹配（`volces/dsv4-flash[1m]` ≡ `opencode-go/deepseek-v4-flash` ≡ `shudie/dsv4-0731`）。
- `tryImmediateFallback` 先取同类候选（不同供应商），同类全部不可用再退回 rank；避免仅凭 learn 分数跳到无关模型（如 minimax-m3）。

### E. Model Pool（模型挑选集合 — 硬边界）
- 用户痛点：60+ 可用模型让自动路由不可控（rank/learn/秒切挑到不认识的模型，规则打到不想要的模型）。
- `/router pool` 交互多选器（搜索含中文 / ↑↓ / **空格勾选** / 回车保存到全局 `~/.pi/agent/pi-router.json`），纯状态机 reducer 可单测。
- **硬边界语义**：池非空时**所有自动决策**（规则/难度 rank/self-learn/sticky/default/fallback/秒切）只在池内选；规则命中的池外模型被跳过（继续匹配下一条可用规则）；`@model:` 手动指定仍最高优先（用户意志高于池）。空池 = 不过滤（默认行为）。

### F. registryInfos getAvailable 修复
- **缺陷**：`registryInfos` 只调 `getAvailableSnapshot`（harness mock 提供的名字），真实 pi 的 API 是 **`getAvailable()`** → 返回空 → `/router pool` 报「无可用模型（modelRegistry 为空）」。
- **修复**：`getAvailableSnapshot ?? getAvailable`；`/router pool` 终级兜底从 `availableSelectors` 字符串构造列表（无窗口/价格但绝不死路）。`availableSelectors` 本就带兜底所以 `/router status` 一直正常。

### G. theme.fg this 绑定崩溃（致命）
- **缺陷**：`theme?.fg` 解构为独立函数调用，丢失 `this` → pi 的 `fg` 是实例方法（内部读 `this.fgColors`）→ `Cannot read properties of undefined (reading 'fgColors')` → **pi 闪退**。
- **修复**：闭包包装 `theme ? (c,t) => theme.fg(c,t) : plain`，保持 this 绑定（即 tui.md 官方模式 `(t) => theme.fg("accent", t)`）。新增 this 依赖的 fake theme 回归测试。

### H. 命名预设池（场景化一键切换）
- 满足「保存并读取为预设」：`/router pool` 勾选回车后弹**命名框**（esc 跳过），把当前池存为命名预设；`/router pool use [名]` 一键切换（单选器 or 直接指定），`list`/`rm`/`save` 管理。
- 存全局 `poolPresets: {名称: [模型]}`；激活即写 `pool`。

## 目标 vs 实际

| 原目标 | 实际 |
|---|---|
| e2e fallback harness（SDK+fauxProvider） | scripts/router-harness.ts（自研 FakeCtx+fire，更精确） |
| 复现 volces 额度耗尽仍被选中 | ✅ 复现 + 修复（message_end 捕获） |
| 修复经 harness 验证后部署 | ✅ 且新增 Model Pool / same-family / 预设池 |

## 非目标（确认维持）
- 不 mock 扩展内部；测的就是真实扩展与 pi 事件链路的集成。
