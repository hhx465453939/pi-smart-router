---
change_id: CHG-003
version: 1
status: approved
prd_ref: tasks/CHG-003/PRD.md
health_ref: null
supersedes: null
approved_by: user (确认方案 + 补充需求)
approved_at: 2026-08-28
---

# SPEC — CHG-003 pi-smart-router v0.3.0 全自动无缝智能路由

## 1. 上下文、目标、非目标、约束、假设、未决问题

- 目标：R21-R29，见 CHANGE/PRD。
- 非目标：每次 prompt 常驻小模型判定、跨模型物理缓存共享、外部网关、触碰凭据。
- 约束：探测三层（getAvailableSnapshot 立即 + 后台连通性 + 被动 401/402/403）；探测异步每 session 独立 timeout 5min 不阻塞；决策优先级 显式 > 高优规则 > handoff 意图 > self-learn > 难度兜底 > 默认 > fallback。
- 假设：self-learn 收敛在跨会话累计下成立；连通性探测失败仅标"不确定"不硬排除。
- 未决问题：小模型仲裁（规则拿不准时）列为后续版本，不在本版。

## 2. 当前架构与债务影响

- v0.2.0 已有：decision 优先级链、LearningManager、CacheManager、CooldownSet、CN 模板。
- 本版增量：catalog（模型档案底座）、difficulty（难度信号）、selflearn（多维评分，替代/增强现有 Learn 的单一 taskType 评分）、probe（可用性快照）、handoff 工具。无迁移债务。

## 3. 选定设计 + ADR

### ADR-009 模型能力快照（Model Catalog）

| 维度 | 内容 |
|------|------|
| 背景 | 80+ 模型无统一档案，判定无数据底座。 |
| 方案 | `ModelCatalog`：自动合并 pi modelRegistry 的 contextWindow/cost/input 到基础字段；用户可编辑擅长场景/难度评级/评价；self-learn 动态更新得分。持久化 `~/.pi/agent/pi-router-catalog.json`。 |
| 数据 | `{ selector, provider, contextWindow, cost, input, scenarios: [], difficultyTier, note, learnScore: { scenario→score }, lastSeen }` |
| 决策 | 选：catalog 作唯一事实源，决策引擎读它。可逆：纯 JSON 可改可删。 |

### ADR-010 难度估算（Difficulty Estimation）

- 特征：prompt 长度、代码块数/关键词、是否 debug/trace/stack、工具集（bash/edit/write 高）、上下文大小、turnIndex 迭代深度。
- 输出：`low | medium | high`，阈值可配。
- 作用：低/中难度倾向便宜模型，高难度倾向强模型；配合 self-learn 调权。

### ADR-011 self-learn 多维评分（替换/增强现有 Learn）

| 维度 | 内容 |
|------|------|
| 背景 | 现有 learn 只按 taskType 单维；无法表达"前端→k3、测试→codex、一般→flash"的场景差异。 |
| 方案 | `SelfLearnManager`：键为 `scenario × difficulty`（如 `frontend×low`、`backend×high`、`test×high`），值为模型得分；每次真实结果（成败/成本/缓存/handoff 方向）更新。场景由 difficulty.ts 的 `detectScenario`（前端/后端/测试/运维/一般）提供。 |
| handoff 学习 | 记录 `from→to + scenario`：to 加分、from 在该场景减分。 |
| 决策 | 选：多维 self-learn 替代单维 learn（向后兼容：旧 learn 配置仍识别，映射到 general 场景）。可逆：可关。 |

### ADR-012 可用性探测（Availability Probe）

| 维度 | 内容 |
|------|------|
| 背景 | 套餐失效/网络不可达需自动检测，但扩展不能碰 apiKey。 |
| 方案 | 三层：① getAvailableSnapshot 立即排除无 key 模型（已有）；② session_start 后台异步对已配 key provider 做连通性探测（fetch baseUrl 不带 key，收到任意 HTTP 响应=可达，超时/连接失败=不可达），写入本 session 快照；③ 真实调用 after_provider_response 捕获 401/402/403 → 确定性标记不可用 + 持久化最近不可用（下次启动预排除）。 |
| 快照 | 每 session 独立 `Map<selector, 'available'|'unavailable'|'uncertain'>`；不可用从路由候选排除。 |
| 决策 | 选：三层组合（安全 + 可靠 + 不阻塞）。可逆：probe.enabled 可关。 |

### ADR-013 router_handoff 工具

- 工具参数：`target`（模型选择器）、`reason`、`summary`（交接说明）。
- 执行：校验 target 可用（catalog + 快照 + 冷却）→ 记录 handoff → `pi.setModel(target)` → `pi.sendMessage(summary)` 交给新模型 → 更新状态条。
- 安全网：target 不可用拒绝并提示；同 session 频繁 handoff 限流；结果喂 self-learn。
- 决策：选。这是"把决定权交给模型"的核心载体。

## 4. 接口、数据、安全、兼容性、迁移、可观测性、发布、回滚

### 配置增补（全部可选，v0.2.0 配置零改动）

```jsonc
{
  "catalogPath": "~/.pi/agent/pi-router-catalog.json",
  "difficulty": { "enabled": true, "lowThreshold": 40, "highThreshold": 120 },
  "selfLearn": { "enabled": true, "minSamples": 3, "decay": 0.9 },
  "probe": { "enabled": true, "timeoutMs": 300000, "probeOnStart": true, "excludeUnavailable": true }
}
```

### 数据契约

```ts
interface ModelCatalogEntry {
  selector: string; provider: string;
  contextWindow?: number; cost?: { input: number; output: number; cacheRead: number };
  input?: string[]; // text/image
  scenarios: string[]; difficultyTier?: 'low'|'medium'|'high';
  note?: string;
  learnScore: Record<string, number>; // `${scenario}×${difficulty}` -> score
  samples: Record<string, number>;
  lastSeen?: number;
}
type Availability = 'available' | 'unavailable' | 'uncertain';
interface ProbeSnapshot { [selector: string]: Availability }
interface HandoffEvent { from: string; to: string; scenario: string; difficulty: string; reason: string; ts: number }
```

### 安全

- 探测 fetch 不带 apiKey；不读/写 auth.json；不触碰凭据。
- 目录/探测路径 resolve 防穿越。

### 兼容性与迁移

- 旧 learn 配置映射 general 场景；catalog 缺失自动从 modelRegistry 生成初始条目。
- probe 层 ①②③ 顺序降级（① 必行，②③ 失败不影响启动）。

### 可观测性

- `/router catalog`：列出模型档案 + self-learn 得分 + 可用性。
- `/router probe`：查看本 session 可用性快照。
- `/router handoff`：历史。
- `/router status`：集成可用性/self-learn 摘要。

### 发布与回滚

- push → `pi update --extensions` 部署全局。
- 回滚：`pi remove git:...` 或删配置段。

## 5. 里程碑

| 里程碑 | 内容 | 文件 | 验收 | 检查 |
|--------|------|------|------|------|
| M1 | 契约文档 | tasks/CHG-003/* | 完整 | 人工 |
| M2 | catalog + difficulty | src/catalog/catalog.ts、src/engine/difficulty.ts、src/types.ts、src/config.ts | 单测 | npm test |
| M3 | self-learn + decision 集成 | src/engine/selflearn.ts、src/engine/decision.ts | 单测 | npm test |
| M4 | probe + handoff + 命令 | src/probe/availability.ts、src/tool/handoff.ts、src/commands/router.ts、src/index.ts | 单测 + 冒烟 | npm test |
| M5 | 闭环 + 发布 | 全仓 | npm test 全绿、push、部署 | npm test + git |

## 6. DoR / DoD

- DoR：PRD APPROVED；ADR 已记录。
- DoD：R21-R29 满足；typecheck 0 错误；`npm test` 全绿；push 成功；`pi update --extensions` 部署。

## 7. Review 与 Delivery Gates

- Gate 1：M2-M4 单测全绿 → 继续。
- Gate 2：`/router catalog` 与 `/router probe` 可用 → 完成。
- commit/push/部署：用户已授权自动执行。

## 8. Traceability

见 TRACEABILITY.md。验证：`npm test`、`npm run typecheck`、`pi update --extensions`。
