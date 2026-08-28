# PRD v0.2.0 — pi-smart-router 智能升级

> version: 2 | status: APPROVED (用户授权自动开发)
> change_ref: CHG-002

## 1. 背景与问题

- v0.1.0 骨架完整（规则/双级路由/冷却/缓存感知），但用户环境 **rules=0、fallback off**，静态规则门槛高，价值未发挥。
- 用户环境有 80+ 模型（zai-coding-cn / opencode-go / kimi-coding / shudie / volces），手动配置规则成本高。
- 缓存是核心特色，但目前"偏好排序"未显式量化"切换破坏缓存"的损失。

## 2. 用户故事（新增）

1. 作为用户，我不写任何规则，扩展通过**学习**自动收敛到"每个任务类型性价比最高的模型"。
2. 作为用户，路由在切模型前会**权衡缓存损失**：切走会丢 8K token 缓存但任务收益不高时，倾向保持。
3. 作为用户，复制一个中文模板即可开箱即用，规则直接引用我现有的 provider/model。
4. 作为用户，compaction 后缓存偏好不会被旧前缀误导。

## 3. 范围

### In scope
- 学习路由（learn）：记录结果、得分、偏好、失败惩罚、minSamples 门槛、可关闭。
- 切换抖动量化（churn）：估算切模型丢失的缓存 token，影响无规则决策，reason 标注。
- 中文生态模板：`examples/pi-router.cn.json`。
- compaction 感知：`session_before_compact` 重置缓存前缀。
- 决策顺序更新 + 可观测（/router 展示 learn/churn）。

### Out of scope
- 外部网关、fusion、凭证池、单请求内换模型。
- 跨模型物理缓存共享。

## 4. 需求与验收标准

| ID | 需求 | 验收标准 |
|----|------|----------|
| R14 | 学习路由（learn） | `learn.enabled` 时记录每轮 cost/cache/失败；`preferred(taskType)` 返回得分最高模型；`minSamples` 门槛前不生效；失败强惩罚 |
| R15 | churn 量化 | `churn.enabled` 时估算切换丢失缓存 token；无规则决策中超过 `maxChurnTokens` 倾向保持；reason 标注 churn |
| R16 | 中文模板 | `examples/pi-router.cn.json` 引用用户现有 provider 模型；复制即用 |
| R17 | compaction 感知 | `session_before_compact` 后缓存前缀重置/降权，不再以旧前缀做偏好 |
| R18 | 配置兼容 | v0.1.0 配置零改动可用；learn/churn 段可选 |
| R19 | 可观测 | `/router status` 展示 learn/churn 段与学习得分；`/router learn` 展示每 taskType 模型得分 |
| R20 | 单测闭环 | `npm test` 全绿（含 learn/churn/compaction 测试） |

## 5. 依赖与约束

- 沿用 v0.1.0 依赖；新增配置段可选。
- 学习/粘滞/规则优先级：显式 > 高优规则 > 学习偏好 > 粘滞 > 默认 > fallback > 保持。
- 学习状态会话级持久化（appendEntry）。

## 6. 成功指标

- 单测覆盖 learn/churn 核心逻辑。
- 决策可解释（reason 含 learn/churn 依据）。
- 全局部署 `pi update --extensions` 后无报错。
