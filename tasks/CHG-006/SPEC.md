# SPEC — CHG-006 模型路由治理

> change_id: CHG-006 | version: 1 | status: approved
> prd_ref: tasks/CHG-006/PRD.md
> change_ref: tasks/CHG-006/CHANGE.md

## 上下文

用户环境 volces/deepseek-v4-flash[1m] 额度耗尽（429 AccountQuotaExceeded，月配额 2026-09-06 重置），huge-context 规则仍反复选中它，导致每轮任务 3 次重试失败、router 无法秒切，用户被迫手动 `/router off`。同时 60+ 可用模型使自动路由不可控。

## 设计与 ADR

### 架构

```
事件链：message_end (errorMessage 429/401/402/403)
        → probe.markUnavailable(selector) ──本 session 排除──┐
        → tryImmediateFallback:                              │
            candidates = pool ∩ available - cooldown         │
            same-family 优先（normalizeModelBase 跨供应商）  │
            rank 兜底                                        │
            setModel(modelObj) + sendUserMessage(followUp)   ▼
before_agent_start / request 决策:
        decide(input)  → pool 硬边界过滤 availableModels
        → matchFirstPooledRule（跳过池外规则模型）
        → same-family / default / fallback 全在池内
```

### ADR-014：可靠错误捕获点 = message_end（拒绝 after_provider_response / tool_result）

- 决策：捕获 429/401/402/403 的可靠位置是 `message_end`（读 `errorMessage`，匹配 `AccountQuotaExceeded|quota.*exceeded|rate.?limit|...`），而非 `after_provider_response` / `tool_result`。
- 理由：pi 的 SDK 层会对部分错误自动重试，**响应在重试中被吞掉**，`after_provider_response` 收不到最终态；只有重试耗尽、错误作为 `errorMessage` 进入 `message_end` 才可靠。
- 后果：错误提示仍会先出现一次（pi 内部 3 次重试是客户端层行为，扩展无法拦截），之后 router 秒切 + 静默重发。
- 可逆性：低；捕获点集中，易改。
- 被拒方案：`after_provider_response`（死代码）、`tool_result`（API 错误不是工具错误）。

### ADR-015：秒切优先同类模型（same-family）

- 决策：失败后不是纯性价比 rank，而是先找「其他供应商的同类模型」（`normalizeModelBase` 归一化后相等），同类全部不可用才退回 rank。
- 理由：用户原话「秒切其他供应商的**同类**模型」；同类耗尽说明任务需要该能力档，换供应商保留能力。
- `normalizeModelBase`：`lowercase` + 去 `[1m]` / `-0731` 日期后缀 → `volces/dsv4-flash[1m]` ≡ `opencode-go/deepseek-v4-flash` ≡ `shudie/dsv4-0731`。
- 被拒方案：纯 rank（会被 minimax 这类 learn 分数高的无关模型抢跑——本环境实测发生）。

### ADR-016：模型池是硬边界（不是软偏好）

- 决策：`pool` 非空时，**所有自动决策**（规则/难度 rank/self-learn/sticky/default/fallback/秒切）只在池内选。
- 理由：用户信任的模型集合应由用户显式圈定；自动路由不应越界。`@model:` 手动指定仍最高优先（用户明确意志 > 池），显式指定不受池限制。
- 池外规则模型跳过 = 继续匹配下一条可用规则（`matchFirstPooledRule` 语义）。
- 空池 = 不过滤（默认行为，兼容旧配置）。

### ADR-017：命名预设池（场景化一键切换）

- 决策：`poolPresets: {名称: [模型]}` 存全局配置；`/router pool` 勾选回车后弹命名框（本地输入组件），`use [名]` 激活（写 `pool` 并持久化）。
- 理由：用户要「保存并读取为预设，名称自行命名」；场景化（日常/攻坚/省钱）快速切换。
- 被拒方案：预设与池合一（无法复用）；仅 CLI 无交互（配合多选器/单选器体验更好）。

## 接口与数据

- 配置结构（`~/.pi/agent/pi-router.json`）：
  ```json
  { "pool": ["zai-coding-cn/glm-5.3", ...],
    "poolPresets": { "日常": ["..."], "攻坚": ["..."] } }
  ```
- `NormalizedRouterConfig.pool: string[]`，`.poolPresets: Record<string, string[]>`。
- `config.ts`：`persistPool / persistPoolPreset / removePoolPreset / applyPoolPreset / filterByPool`。
- `tui/multipick.ts`：`PoolPickerComponent / NamePromptComponent / PresetPickerComponent`（纯状态机 reducer + 渲染分离，零依赖 ANSI 按键处理）。

## 安全/兼容

- 池只影响自动路由，不影响用户显式指定；不含认证/密钥处理，无新攻击面。
- 兼容：`pool`/`poolPresets` 均缺省为空/`{}`，旧配置无缝升级。

## 里程碑

| ID | 内容 | 依赖 | 验收 |
|---|---|---|---|
| M1 | e2e harness（FakeCtx+fire，覆盖 message_end/after_provider_response 路径 + 配置路径修复） | — | harness 断言 PASS |
| M2 | message_end 错误捕获 + setModel 传对象 + same-family | M1 | 单测+harness 验证秒切同类 |
| M3 | `/router pool` 多选器 + 池硬边界 + getAvailable 修复 + theme.fg 修复 | M2 | 单测（picker/池语义/theme）+ 手册 |
| M4 | 命名预设池（save/use/list/rm + 命名框 + 单选器）+ README | M3 | 单测（preset/name/presetpicker）+ 手册 |

## 验证

- `npm test` 全绿（167 tests：pool 解析/持久化/filter、decide 池语义、picker reducer 含中文搜索、same-family、name prompt、preset picker、theme this 绑定回归）。
- `node --experimental-strip-types scripts/router-harness.ts`（quota-rule-loop）与 `... pool-boundary` 均 PASS。
- `npm run typecheck` 干净。

## Rollback

- 任一功能异常：删 `pool`/`poolPresets` 字段恢复全量；回退 commit（如 `git revert a1d5545` 起）。
