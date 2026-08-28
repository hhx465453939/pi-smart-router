# Change Brief — CHG-002

> status: approved (用户授权: "写新版本的chg，然后开发，测试，commitpush，之后直接部署到pi的全局框架中")

## 变更请求摘要

在 pi-smart-router v0.1.0（规则引擎 + 双级路由 + 冷却 + 缓存感知）基础上，升级到 v0.2.0，聚焦"让智能路由真正好用 + 更智能 + 不浪费缓存"：

1. **自适应学习路由**（`learn`）——记录每轮实际结果（成本、缓存命中、失败），自动调整"任务类型→模型"的偏好，不依赖用户手写全部规则。
2. **切换抖动成本量化**（`churn`）——把"切模型破坏缓存前缀"的损失显式量化进决策，让"是否切换"成为有成本收益判断的决策（缓存核心特色深化）。
3. **中文生态模板**（`examples/pi-router.cn.json`）——贴合用户实际模型环境（zai-coding-cn / opencode-go / kimi-coding / shudie / volces），一键上手。
4. **compaction 感知**——`session_before_compact` 后 prompt 前缀重写会致缓存失效，主动重置/降权缓存记录，避免旧前缀误导偏好。

## 目标

- 解决 v0.1.0 "rules=0、fallback off、价值未发挥" 的现状：开箱即用（模板）+ 自动学习（无需手写规则）。
- 把缓存感知从"偏好排序"升级为"带成本的权衡决策"，形成差异化卖点。
- 保持向后兼容：v0.1.0 配置零改动可用，新配置段全部可选。

## 非目标

- 不做外部网关 / 多模型并行 fusion / 凭证池。
- 不做单请求内换模型重试（pi 架构限制）。
- 不做跨模型物理缓存共享（provider 侧按模型隔离）。

## 范围

- 新增：`src/engine/learn.ts`、`src/engine/churn.ts`（或并入 cache.ts）、`examples/pi-router.cn.json`。
- 修改：`src/types.ts`、`src/config.ts`、`src/engine/decision.ts`、`src/engine/cache.ts`、`src/hooks/*`、`src/commands/router.ts`、`src/index.ts`、README。
- 测试：新增 `test/learn.test.ts`、`test/churn.test.ts`，扩展 cache/decision 测试。

## 约束与假设

- 学习状态存内存 + `pi.appendEntry` 持久化（与决策历史一致），会话级恢复。
- churn 估算基于 `CacheManager` 的 `commonPrefixChars`（字符数 → token 粗估算）。
- 学习/粘滞/规则优先级：显式 > 高优规则 > 学习偏好 > 粘滞 > 默认 > fallback > 保持。

## 风险

- 学习可能收敛到劣质模型（缓解：`minSamples` 门槛、失败强惩罚、可关闭 `learn.enabled`）。
- churn 阈值过严导致规则被忽略（缓解：churn 仅影响无规则决策 + reason 标注，规则仍优先）。
- 状态膨胀（缓解：`windowSize` 上限 + 会话级生命周期）。

## 成功信号

- `npm test` 全绿（含 learn/churn/compaction 测试）。
- `pi update --extensions` 后 `/router status` 显示 learn/churn 段。
- 连续同类任务自动收敛到"成本低 + 缓存命中高 + 少失败"的模型。
