# PRD — CHG-006 模型路由治理（fallback 测试 + 模型池 + 预设）

> change_id: CHG-006 | version: 1 | status: approved
> supersedes: none

## 背景与问题

- **问题1（死循环卡死）**：某 provider（volces/deepseek-v4-flash[1m]）月度额度耗尽（429 `AccountQuotaExceeded`，9-06 才重置）时，`huge-context` 规则仍反复选中它 → 每次任务都 3 次重试失败 → router 探测不到、无法秒切 → 用户只能手动 `/router off` 或反复换模型。根因：SDK 层自动重试吞掉了错误响应，导致 `after_provider_response` / `tool_result` 永远收不到 429。
- **问题2（不可控）**：环境有 60+ 可用模型（kimi / opencode-go / zai / shudie / volces ...），自动路由（rank / learn / 秒切）会在用户不认识的模型里挑，规则会打到不想要的模型（如误切 k3-256k、或 min 性价比跳到 minimax）。
- **问题3（不能个性化）**：用户想按场景维护不同的「可信模型集合」（日常 / 攻坚 / 省钱），快速切换。

## 目标

1. 可靠捕获 429/401/402/403（额度耗尽 / 欠费）→ 本 session 排除该模型 → 秒切其他供应商。
2. 秒切优先「其他供应商的同类模型」（换供应商不换能力），同类耗尽再按性价比 rank。
3. `/router pool` 交互多选器：用户挑选可信模型集合，成为**自动路由的硬边界**（rank/规则/fallback/秒切只在池内）。
4. 命名预设池：把不同场景的池保存成预设，`/router pool use <名>` 一键切换。

## 非目标

- 不做计费/成本核算。
- 不自动修改用户已有的规则优先级。
- 不 mock 扩展内部（harness 测真实扩展 + 事件链路）。

## 用户故事

- 作为用户，当某模型额度耗尽时，我希望 router 自动切到其他供应商的同类模型并静默重试原任务，而不是报 429 让我手动处理。
- 作为用户，面对 60+ 模型，我希望先挑选一个可信的小集合（如 7 个），router 在这个集合内智能路由，行为可预测。
- 作为用户，我希望把「日常 / 攻坚 / 省钱」等场景的池保存成命名预设，一键切换。

## 成功指标

- 触发 429 后：router 不再反复选中已耗尽模型；秒切到池内可用模型并完成当前任务。
- `/router pool save/use/list/rm` 全套可用，预设切换后 `/router status` 能立即看到激活池变化。
- `npm test` 全绿（含 harness、same-family、pool、预设、picker、theme 回归测试）。

## 验收标准（Acceptance Criteria）

1. **AC1 秒切**：模拟某模型 429，router 检测到后排除它并切到其他供应商同类模型，重发原任务（harness 证明）。
2. **AC2 同类优先**：`volces/dsv4-flash[1m]` 失败 → 首选 `opencode-go/deepseek-v4-flash` / `shudie/dsv4`，而非 minimax。
3. **AC3 池硬边界**：池内不含 minimax，则任何场景都不会切到 minimax；池外规则模型被跳过。
4. **AC4 预设**：`/router pool` 勾选回车后弹命名框保存预设；`use` 切换后激活池更新并持久化。
5. **AC5 不崩溃**：`/router pool` / `use` 在真实 pi（theme.fg 是 this 依赖方法）下不闪退。
6. **AC6 全局生效**：预设与池存 `~/.pi/agent/pi-router.json`，重启/`/reload` 后仍在。
