# PRD — CHG-005 无痛秒切 fallback

> version: 1 | status: APPROVED
> change_ref: CHG-005

## 1. 背景

- 用户被 `muse-spark 429 AccountQuotaExceeded` 卡住，需手动 `关掉 router` 绕过。
- 原因：额度耗尽可能被冷却 60s 后重试死循环；401/402/403 虽标 unavailable 但只在下次决策生效，本次报错仍弹给用户。

## 2. 用户故事

1. 作为用户，某模型 401/402/403/429-quota 失败时，路由当场静默切到 rank 下一个同类模型并重试本轮 prompt，我无感知。
2. 作为用户，若 rank 后续模型也失败，逐个试直到有能用的担起该场景；全部失败才提示。
3. 作为用户，单次 prompt 最多重试有限次，不无限循环。

## 3. 验收标准

| ID | 验收 |
|----|------|
| R30 | 401/402/403/429-quota → 当场标 unavailable + 按当前场景/难度 rank 取下一个可用模型重试本轮 |
| R31 | 逐个 fallback 直至成功，全部耗尽才提示 |
| R32 | 防循环：同 prompt 最多 N 次（N = min(3, 候选数)），不重入 |
| R33 | 每 session 独立，不写死；重置后下次会话自动恢复 |
| R34 | `npm test` 全绿，新增 fallback-retry 单测 |

## 4. 依赖

- 已有 `probe.markAuthFailure` / `rankModels` / `analyzeTask` / `lastPromptText`。
