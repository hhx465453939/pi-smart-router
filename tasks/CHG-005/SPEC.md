# SPEC — CHG-005 无痛秒切 fallback

> change_id: CHG-005 | version: 1 | status: approved
> prd_ref: tasks/CHG-005/PRD.md

## 设计

- **触发点**：
  - `after_provider_response`：status 401/402/403 → 立刻 `probe.markAuthFailure`
  - `tool_result`：`isQuotaExceeded(content)`（含 429 AccountQuotaExceeded）→ 同上
- **当场重试**：
  - 失败后取 `probe.filterAvailable([...available])` 排除已标 unavailable
  - 按当前 `scenario×difficulty`（`analyzeTask(lastPromptText)`）对排除后的可用集 `rankModels`，取首个未试过的
  - `pi.setModel(next)` 失败则试 rank 下一个；成功则 `pi.sendUserMessage(lastPromptText, { deliverAs: "followUp" })` 静默重试
  - 防重入：`Map<promptHash, count>`，同 prompt 60s 内超过 N 次不再重试；`lastPromptText` 去重
- **候选耗尽**：提示“该场景暂无可用模型，请检查套餐/网络”

## 里程碑

- M1 契约 | M2 实现+单测 | M3 commit/push/部署

## 验证

- `npm test` 全绿（含 fallback-retry）
- 手工：让某模型 401/403，观察自动切到 rank 下一个且不弹错
