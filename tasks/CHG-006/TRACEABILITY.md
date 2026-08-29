# TRACEABILITY — CHG-006

> change_id: CHG-006 | version: 1
> 需求（PRD AC）→ 实现 → 验证证据 → 状态映射

## 需求 → 实现 → 验证

| 需求 / AC | 实现（文件 / commit） | 验证证据 | 状态 |
|---|---|---|---|
| 可靠捕获 429/401/402/403（AC1） | `src/index.ts` `message_end` 错误检测（errorMessage + 模式匹配） | harness `[3b]` message_end 路径断言 `期望非 volces` ✅ PASS | ✅ |
| 秒切其他供应商（AC1） | `tryImmediateFallback`（setModel 对象 + sendUserMessage followUp 重试） | harness `已秒切 opencode/deepseek-v4-flash 并重试` | ✅ |
| setModel 契约（对象而非字符串） | `src/index.ts` `modelRegistry.find` 解析对象再 `pi.setModel` | harness setModel mock 兼容对象；手工环境修复 | ✅ |
| 同类模型优先（AC2） | `normalizeModelBase` + same-family 优先（`src/index.ts`） | `test/same-family.test.ts`（volces→opencode/dsv4 非 minimax）；harness | ✅ |
| 池硬边界（AC3） | `decide()` pool 过滤 + matchFirstPooledRule；`tryImmediateFallback`/handoff/auto-rank 过滤 | `test/decision.test.ts`（池外规则跳过/默认池外走 fallback/显式绕过）；harness `pool-boundary` | ✅ |
| `/router pool` 多选器（AC3） | `src/tui/multipick.ts` `PoolPickerComponent` + `src/index.ts` 命令 | `test/pool-picker.test.ts`（搜索/空格勾选/导航/确认/中文）；harness | ✅ |
| getAvailable 修复（AC 前置） | `src/index.ts` `registryInfos` `getAvailableSnapshot ?? getAvailable` + 兜底 | `npm test`；用户实测 `/router pool` 列出 60+ | ✅ |
| theme.fg 不崩溃（AC5） | `src/tui/multipick.ts` 闭包包装 theme.fg 保 this | `test/pool-picker.test.ts` theme 绑定回归（this 依赖 fake theme 不抛） | ✅ |
| 命名预设（AC4） | `poolPresets` 配置 + `persistPoolPreset/remove/apply` + 命名框 + 预设单选器 | `test/pool.test.ts`（roundtrip+normalize）；`test/pool-picker.test.ts`（name prompt/preset picker） | ✅ |
| 全局生效（AC6） | `persistPool*` 写 `~/.pi/agent/pi-router.json` | `test/pool.test.ts`（fake HOME 持久化断言） | ✅ |
| harness 自身可用 | `scripts/router-harness.ts`（配置路径修复 + pool-boundary 场景） | `node .../router-harness.ts` 与 `pool-boundary` 均 PASS | ✅ |

## 里程碑达成

| 里程碑 | 交付物 | 状态 |
|---|---|---|
| M1 | scripts/router-harness.ts（FakeCtx+fire，双路径，配置路径修复） | ✅ |
| M2 | message_end 捕获 / setModel 对象 / same-family | ✅ |
| M3 | /router pool 多选器 + 池硬边界 + getAvailable + theme.fg | ✅ |
| M4 | 命名预设池 + README | ✅ |

## 测试规模变化

- 131 → **167** tests（新增 same-family + pool 系列 + picker + name/preset + theme 回归）。
- harness 场景：`quota-rule-loop`（默认）+ `pool-boundary`（新增）。

## 残留 / 后续

- pi SDK 层 3 次重试仍会先显示错误提示再秒切（扩展无法拦截客户端层重试）；后续可评估能否缩短。
- `pool`/`poolPresets` 建议用户按场景维护；`/router pool list` 可查看当前。
