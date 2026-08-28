# CHANGE — CHG-005

> status: approved (用户: "马上切光速切其他供应商的同类模型，之后再根据这个rank，一个一个fallback，指导有能用的模型适应场景位置，而不是让我一个劲的在这里被一个403卡住，我要的是无痛切换")

## 摘要

实现 **无痛秒切 fallback**：当模型调用失败为 401/402/403（套餐失效/欠费）或 429 AccountQuotaExceeded（额度耗尽）时，**当场** 标 `unavailable` 并按当前场景/难度 rank 逐个试下一个可用模型，直至成功，不卡任务、不弹错给用户看。

补齐 v0.4.0 的缺口：之前只在**下次决策**排除，本次失败仍弹错；现在**本次失败当场重试**。

## 目标

- 401/402/403/429-quota 失败 → 立刻 `probe.markAuthFailure` + 长冷却 → 取 rank 下一个可用同类模型 → `pi.setModel` + 静默重试本轮 prompt。
- 按 rank 逐个 fallback，直到有能用的模型担起该场景；全部不可用才提示。
- 每 session 独立快照，不写死；下次启动/重置后自动恢复。
- 防循环：单次原始 prompt 最多重试 N 次（默认 3，取 fallback 链长与 rank 候选较小者）。

## 非目标

- 不改正常 429 限流/500 的短冷却重试（仍 60s）。
- 不触碰 apiKey；不改 pricing。

## 范围

- 修改：`src/index.ts` 的 `after_provider_response` / `tool_result` 失败分支（加当场重试）、`src/probe/availability.ts` 已有 `markAuthFailure` 复用、`src/config.ts` 可选重试上限。
- 测试：新增 fallback-retry 单测。

## 约束

- 重试用 `pi.sendUserMessage(lastPromptText)` 触发新 turn（保留 session/缓存）。
- 需防重入：同 prompt 短时间内不重复触发；全部候选耗尽则停止并提示。
