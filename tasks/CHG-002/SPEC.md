---
change_id: CHG-002
version: 1
status: approved
prd_ref: tasks/CHG-002/PRD.md
health_ref: null
supersedes: null
approved_by: user (授权自动开发)
approved_at: 2026-08-27
---

# SPEC — CHG-002 pi-smart-router v0.2.0 智能升级

## 1. 上下文、目标、非目标、约束、假设、未决问题

- 见 CHANGE/PRD。目标：R14-R20。
- 非目标：外部网关、fusion、凭证池、单请求换模型、跨模型物理缓存共享。
- 约束：向后兼容 v0.1.0 配置；决策顺序 显式 > 高优规则 > 学习 > 粘滞 > 默认 > fallback > 保持。
- 假设：学习状态会话级内存 + appendEntry 持久化足够；churn 用 commonPrefixChars 粗估 token。
- 未决问题：无阻塞项。

## 2. 当前架构与债务影响

- v0.1.0 已交付：decision.ts（优先级链）、cache.ts（CacheManager）、hooks、commands。
- 本版增量：新增 learn.ts / churn 能力，改造 decision.ts 优先级链，扩展 cache.ts 与 hooks；无迁移债务，全部可选配置。

## 3. 选定设计 + ADR

### ADR-006 学习路由（Learning-Aware Routing）

| 维度 | 内容 |
|------|------|
| 背景 | 静态规则门槛高，用户 rules=0；需要"用数据养路由"。 |
| 选项 A | 纯静态规则（现状）——简单但不自适应。 |
| 选项 B（选定） | LearningManager：每轮记录 outcome（cost/cacheRead/success），按 taskType 累计得分，`preferred(taskType)` 返回得分最高模型；失败强惩罚、`minSamples` 门槛、`windowSize` 上限、时间衰减。 |
| 决策 | 选 B。理由：与缓存/冷却闭环（失败自动降权），零配置即可用，可关闭回退纯规则。可逆性高。 |

得分公式：`score += successWeight*(success?1:0) + failureWeight*(fail?1:0) + cacheWeight*cacheRead + costWeight*cost`；`minSamples` 前不生效。

### ADR-007 切换抖动量化（Churn-Aware）

| 维度 | 内容 |
|------|------|
| 背景 | 切模型破坏 session 前缀缓存，但"偏好排序"未显式量化损失。 |
| 选项 A | 仅 hitRate 偏好（现状）。 |
| 选项 B（选定） | 决策时若目标模型 ≠ 当前模型，估算 `churnTokens = currentModel.commonPrefixChars 折算`；`churn.enabled && churnTokens > maxChurnTokens` 时：无规则决策倾向保持当前（保缓存），并 reason 标注 `churn:X tokens`；规则命中仍优先（尊重规则）。 |
| 决策 | 选 B。理由：把"是否切换"变成有成本收益判断，深化缓存特色；规则优先保证不牺牲确定性。可逆：关闭 churn 即回退。 |

### ADR-008 compaction 感知

- `session_before_compact` 触发 `CacheManager.invalidatePrefix()`：清空 `lastPromptBySession` 并把各记录 `commonPrefixChars` 降为 0（旧前缀不再有效），保留 hitRate 历史以软衰减。避免 compact 后旧前缀误导偏好。

## 4. 接口、数据、安全、兼容性、迁移、可观测性、发布、回滚

### 配置增补（全部可选）

```jsonc
{
  "learn": {
    "enabled": true,
    "windowSize": 50,
    "minSamples": 2,
    "successWeight": 1.0,
    "failureWeight": -2.0,
    "cacheWeight": 0.0005,
    "costWeight": -0.0001
  },
  "churn": {
    "enabled": true,
    "maxChurnTokens": 8000
  }
}
```

### 数据契约增补

```ts
interface LearnOutcome {
  taskType: string;
  selector: string;
  cost: number;
  cacheRead: number;
  success: boolean;
  timestamp: number;
}
```

- 学习得分持久化：`pi.appendEntry("pi-smart-router-learn", {...})`。

### 决策优先级（v0.2.0）

1. 显式指定
2. 高优规则（priority 规则，cacheAware 控制）
3. 学习偏好（learn.preferred(taskType)，minSamples 门槛）
4. 粘滞（sticky，缓存）
5. 默认模型
6. fallback 链（缓存 + 学习排序）
7. 保持当前

churn 作为横切权衡：在 3-6 层，若目标 ≠ 当前且 churn 超阈值，无规则时倾向保持并标注。

### 可观测性

- `/router status`：learn/churn 段 + 当前得分。
- `/router learn`：每 taskType 模型得分/样本数。
- 决策 reason 可含 `learn:` / `churn:X tokens`。

### 安全/兼容/迁移

- 新配置可选，v0.1.0 配置零改动。
- 学习状态不含敏感信息（仅模型选择器 + 聚合得分）。

### 发布与回滚

- GitHub push → `pi update --extensions` 部署全局。
- 回滚：`pi remove git:github.com/hhx465453939/pi-smart-router` 或删除配置段。

## 5. 里程碑

| 里程碑 | 内容 | 文件 | 验收 | 检查 |
|--------|------|------|------|------|
| M1 | 契约文档 | tasks/CHG-002/* | 文档完整 | 人工 |
| M2 | learn 引擎 + churn + compaction | src/engine/learn.ts、src/engine/cache.ts、src/engine/decision.ts、src/types.ts、src/config.ts | 单测通过 | npm test |
| M3 | hooks 接线 + 可观测 | src/index.ts、src/hooks/*、src/commands/router.ts | 事件正确、/router 展示 | 手动 + 单测 |
| M4 | 中文模板 + 文档 | examples/pi-router.cn.json、README | 复制即用 | 手动 |
| M5 | 闭环 + 发布 | 全仓 | npm test 全绿、push、pi update --extensions | npm test + git |

## 6. DoR / DoD

- **DoR**：CHG-002 PRD 已 APPROVED；ADR 已记录。
- **DoD**：R14-R20 满足；`npm test` 全绿；typecheck 通过（补 typescript 依赖）；已 push；已 `pi update --extensions` 部署全局。

## 7. Review 与 Delivery Gates

- Gate 1：learn/churn/compaction 单测全绿 → 继续。
- Gate 2：`pi update --extensions` 后 `/router status` 显示 learn/churn 段 → 完成。
- commit/push/部署：用户已授权自动执行。

## 8. Traceability

见 TRACEABILITY.md。验证命令：
- `npm test`（node --test，含 learn/churn/compaction）
- `npm run typecheck`（补 typescript 依赖后）
- `pi update --extensions` + `/router status`
