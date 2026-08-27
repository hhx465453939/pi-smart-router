---
change_id: CHG-001
version: 2
status: approved
prd_ref: tasks/CHG-001/PRD.md
health_ref: null
supersedes: 1
approved_by: user (授权自动开发，缓存特色增补)
approved_at: 2026-08-27
---

# SPEC v2 — pi-smart-router 工程契约（增补：缓存感知的路由）

> 本版在 v1 基础上增补"缓存感知的路由"为核心特色，解决多模型转运中 cache 被清空问题，继承并优化 pi 优秀的缓存机制。

## 1. 上下文、目标、非目标、约束、假设、未决问题（v2 增补）

- **新增目标**：路由决策必须继承 pi 的缓存体系（Anthropic `cache_control` / Bedrock cachePoint / OpenAI `prompt_cache_key` / Mistral `promptCacheKey` / `x-affinity` 等），在模型切换与多跳转运中**保留 cache 前缀**，并通过缓存命中优化降低成本与延迟。**多 router 转运过程中的缓存留存作为本项目核心特色与竞争机制**。
- **新增非目标**：不改变 provider 端缓存语义；不尝试跨模型共享 provider 侧物理缓存（不同模型的缓存本身隔离），而是通过"粘滞 + 偏好命中"实现逻辑层缓存最优。
- **新增约束**：
  - `sessionId` 在一次会话内保持稳定（由 `sessionManager.getSessionId()` 提供），路由不得改写它；`cacheRetention` 透传；不得在 `before_provider_request` 中破坏 `cache_control` / `prompt_cache_key` / `promptCacheKey`。
  - `pi.setModel()` 会 append `model_change` 条目，但该条目不计入 LLM 上下文，**不得作为缓存失效的理由**；扩展的 `appendEntry` 决策历史同样不进入上下文。
- **假设**：pi 的各 provider 通过 `sessionId` + `cacheRetention` 实现前缀缓存（已在源码中验证：`promptCache: Map<sessionId, promptText>`、`commonPrefixLength`、`prompt_cache_key = sessionId` 等）。

## 2. 当前架构与债务影响（v2）

- 在 v1 架构上新增 `engine/cache.ts`（纯函数 + 轻量状态）与 hooks 中的缓存透传逻辑；不引入外部存储，状态保持内存 + 会话 entry 持久化，与现有冷却/历史一致。

## 3. 选定设计 + ADR（v2 新增）

### ADR-004 缓存感知的路由（Cache-Aware Routing）

| 维度 | 内容 |
|------|------|
| 背景 | pi 通过 `sessionId` 前缀缓存已实现显著成本/延迟收益；朴素路由每次切模型即冷启动，或在 fallback 链中丢失前缀，导致"用了路由反而更贵"。 |
| 选项 A — 朴素（否决） | 每次决策仅按规则选模型，不考虑缓存。优点简单；缺点：频繁切模型导致缓存命中率暴跌，多跳转运时缓存清零。 |
| 选项 B — 粘滞 + 偏好命中（选定） | 引入 `CacheManager`：跟踪每模型的前缀指纹与 `cacheRead/cacheWrite`，决策时在满足规则的候选中**偏好命中率高/前缀长的模型**；提供 `preferCache` 开关与每规则 `cacheAware` 覆盖；fallback 时复用同一 `sessionId` 前缀。 |
| 选项 C — 物理缓存共享（否决） | 尝试跨模型共享 provider 缓存。优点理想；缺点：provider 侧缓存按 model 隔离，无法共享，且需侵入 provider 协议。 |
| 决策 | 选 B。理由：与 pi 现有缓存语义对齐，零侵入、可解释、可度量；**可逆**（关闭 `preferCache` 即回退朴素）。 |
| 后果 | 新增 `CacheManager` 与 `cache` 配置段；决策路径增加一步"候选集缓存排序"；需在 `after_provider_response`/`tool_result` 后回填 usage 以更新命中统计。 |

### ADR-005 多跳缓存留存（Multi-Hop Cache Preservation）

- 单次 fallback 链中，所有尝试共享同一 `sessionId` 与原始 `promptText` 前缀；`CacheManager` 记录每跳的 `commonPrefixLength`，下一跳优先复用前缀最长的模型。
- 转运（turn → request 两级）之间通过会话级 `promptCache` 传递：`before_agent_start` 的决策结果可作为 `before_provider_request` 的提示，避免两级决策互相打架导致缓存抖动。

## 4. 接口、数据、安全、兼容性、迁移、可观测性、发布、回滚（v2 增补）

### 配置增补（向下兼容）

```jsonc
{
  "cache": {
    "enabled": true,                 // 总开关，默认 true（继承 pi 缓存）
    "preferCache": true,             // 决策时偏好缓存命中高的模型
    "minHitChars": 1024,             // 视为"有效命中"的最小公共前缀字符数
    "sticky": true,                  // 同 taskType 连续轮次粘滞在同一模型以保缓存
    "stickyTtlMs": 300000            // 粘滞窗口
  },
  "rules": [
    {
      "id": "code-task",
      "when": { "taskType": "code" },
      "model": "anthropic/claude-opus-4-5",
      "cacheAware": true             // 单规则覆盖：是否参与缓存偏好排序
    }
  ]
}
```

- 全部新增字段可选，未配置时按默认值启用，**不破坏 v1 配置**。

### 数据契约增补

```ts
interface CacheRecord {
  selector: string;            // model 选择器
  sessionId: string;
  promptHash: string;          // promptText 前缀 hash
  commonPrefixChars: number;   // 与上一轮同 sessionId 的公共前缀长度
  cacheRead: number;           // 最近一次 usage.cacheRead
  cacheWrite: number;
  hitRate: number;             // cacheRead / (cacheRead+cacheWrite)
  updatedAt: number;
}

interface CacheAwareDecisionMeta {
  cacheHitPreferred: boolean;
  candidateHits: Array<{ selector: string; commonPrefixChars: number; hitRate: number }>;
}
```

- 决策结果附加 `cache` 元信息，随 `DecisionRecord` 持久化，便于 `/router` 展示。

### 缓存透传契约（hooks 层）

- `before_agent_start`：若决策与当前模型相同，则**不调用** `pi.setModel()`（已在 v1 中实现），以避免无意义的缓存失效。
- `before_provider_request`：改写 `payload.model` 时**保留** `payload.cacheRetention`、`payload.sessionId`、`payload.promptCacheKey`、`prompt_cache_key` 以及 headers 中的 `x-affinity` / `x-session-id`；不得删除 `cache_control` 标记。实现上采用浅拷贝 + 仅覆盖 `model` 字段。
- `after_provider_response` / `tool_result`：从 `usage.cacheRead/cacheWrite` 回填 `CacheManager`，更新命中统计。

### 可观测性增补

- `/router status` 新增 `cache:` 段：每模型 `hitRate`、`commonPrefixChars`、`lastCacheRead/Write`。
- `/router cache` 子命令：展示详细缓存状态；`verbose` 时打印候选集的缓存排序依据。
- 决策历史中记录 `cacheHitPreferred` 与候选命中列表。

### 安全/兼容/迁移

- 新增配置段为可选，旧配置零改动可用。
- 不触碰 `sessionId` 生成与 `cacheRetention` 策略，仅透传与度量。

## 5. 里程碑（v2 增补）

| 里程碑 | 内容 | 文件 | 验收 | 检查 |
|--------|------|------|------|------|
| M1-M6 | v1 已有 | — | — | — |
| M7 缓存感知路由 | CacheManager + 决策偏好 + hooks 透传 + 可观测 | src/engine/cache.ts、src/types.ts、src/config.ts、src/engine/decision.ts、src/hooks/*、src/commands/router.ts | 单测覆盖缓存偏好与透传；多跳场景前缀保留 | npm test + 手动 cache 命中验证 |

## 6. DoR / DoD（增补）

- **DoD 增补**：R13（缓存感知）验收通过；`npm test` 含缓存单测全绿；`/router status` 可展示缓存命中信息；多跳转运中 `sessionId` 不变且前缀命中可度量。

## 7. Review 与 Delivery Gates（增补）

- Gate 4：缓存单测全绿 + 手动验证：连续两轮同 taskType 命中同一模型时 `cacheRead > 0`。

## 8. Traceability（增补）

- 新增 R13 → M7 → `src/engine/cache.ts` + `engine/decision.ts` + `hooks/*` → `test/cache.test.ts`。

验证命令不变，新增：
- `npm test` 需含 `test/cache.test.ts`
- 手工：`pi -e ./src/index.ts` 连续两轮同类任务，观察 `/router status` 中 `cacheRead` 增长且未因路由切模型而清零。
