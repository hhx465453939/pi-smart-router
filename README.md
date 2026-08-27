# pi-smart-router

> 智能模型路由扩展 for [pi](https://github.com/earendil-works/pi) — 根据任务特征自动选择最优模型，支持规则引擎、模型链回退、失败冷却与**缓存感知的路由（核心特色）**。逻辑提炼自 [claude-code-router](https://github.com/musistudio/claude-code-router)，原生继承 pi 优秀的缓存机制，多跳转运中保留 `sessionId` 前缀缓存。

## 核心特色：缓存感知的路由

> **路由不应该让缓存清零。**

pi 通过 `sessionId` 前缀缓存（Anthropic `cache_control` / OpenAI `prompt_cache_key` / Mistral `promptCacheKey` / `x-affinity` 等）实现了显著的成本与延迟收益。朴素的路由每次切模型即冷启动，多跳 fallback 更会丢失前缀。

本扩展将**缓存感知的路由**作为核心机制：

- **继承 pi 缓存**：`before_provider_request` 仅覆盖 `model`，透传 `cacheRetention` / `sessionId` / `prompt_cache_key` / `cache_control` 等全部缓存字段
- **偏好命中**：同等规则下优先选择缓存命中高（`commonPrefixChars` / `hitRate`）的模型
- **粘滞（sticky）**：同 `taskType` 连续轮次保持同一模型以保缓存（可配置 `stickyTtlMs`）
- **多跳保留**：`turn` → `request` 两级与 `model-chain` fallback 共享同一 `sessionId` 前缀，`message_end` 回填 `cacheRead/cacheWrite` 更新命中统计
- **可观测**：`/router status` 与 `/router cache` 展示每模型 `hitRate` / `prefix` / `read/write`

详见 `tasks/CHG-001/SPEC-v2.md` 的 ADR-004 / ADR-005。

## 为什么

pi 自带的模型切换是手动的（`/model`、`Ctrl+P`）。当你配置了多个模型（coding / 通用 / 多模态 / 长上下文）时，需要一个智能调度层自动选择。

本扩展把 claude-code-router 的路由决策引擎（条件评估、规则编译、模型解析、执行计划、失败分类与冷却）提炼并原生化进 pi 的扩展事件生命周期 —— **无需外部网关进程**。

## 安装

```bash
# 方式一：pi 包管理器（推荐）
pi install git:github.com/hhx465453939/pi-smart-router

# 方式二：本地路径（开发）
pi install /home/shpc_101170/Development/pi-smart-router

# 方式三：临时试用（不写入 settings）
pi -e ./src/index.ts
```

验证：

```bash
pi -e ./src/index.ts
# 进入 pi 后输入
/router status
```

## 配置

配置文件为 `pi-router.json`，支持分层：

- 全局：`~/.pi/agent/pi-router.json`
- 项目级：`<cwd>/.pi/pi-router.json`（覆盖全局）

示例见 `examples/pi-router.json`，可直接复制为起点：

```bash
cp examples/pi-router.json ~/.pi/agent/pi-router.json
```

最小可用配置（仅默认模型 + 一条规则）：

```json
{
  "enabled": true,
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "rules": [
    { "id": "code", "priority": 10, "when": { "taskType": "code" }, "model": "anthropic/claude-opus-4-5" }
  ]
}
```

### 完整配置契约

```jsonc
{
  "enabled": true,
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "routingLevel": "turn", // turn | request | both
  "cooldownMs": 60000,
  "failure": {
    "cooldownOnStatus": [429, 500, 502, 503, 504],
    "cooldownOnToolErrorPatterns": ["rate.?limit", "overloaded", "timeout"]
  },
  "taskTypeRules": {
    "code": ["implement", "fix", "bug", "refactor"],
    "document": ["readme", "doc", "explain"]
  },
  "rules": [
    {
      "id": "code-task",
      "name": "编码任务用强模型",
      "priority": 100,
      "when": { "taskType": "code" },
      "model": "anthropic/claude-opus-4-5"
    },
    {
      "id": "long-context",
      "priority": 90,
      "when": { "contextTokens": { "gt": 80000 } },
      "model": "openrouter/anthropic/claude-sonnet-4"
    }
  ],
  "fallback": {
    "mode": "model-chain", // off | retry | model-chain
    "models": ["openrouter/anthropic/claude-sonnet-4", "deepseek/deepseek-v4"]
  },
  "explicitModelPrefix": "@model:",
  "verbose": false,
  "cache": {
    "enabled": true,
    "preferCache": true,
    "minHitChars": 1024,
    "sticky": true,
    "stickyTtlMs": 300000
  }
}
```

### 条件语法（when）

`when` 为字段到条件值的映射，**所有字段 AND**：

```jsonc
{ "taskType": "code" }                          // 等值
{ "taskType": { "in": ["code", "research"] } }  // 集合成员
{ "contextTokens": { "gt": 80000 } }            // lt / lte / gt / gte / eq
{ "hasImage": true }                            // 布尔
{ "hasImage": { "not": true } }                 // 取反
{ "prompt": { "contains": "hello" } }           // contains / not-contains / starts-with
{ "turnIndex": { "gte": 6 } }
```

可用字段：`taskType`、`toolNames`、`contextTokens`、`messageCount`、`turnIndex`、`promptLength`、`hasImage`、`explicitModel`、`currentModel`、`thinkingLevel`、`prompt`。

### 显式指定

在 prompt 中用 `@model:provider/model` 强制本次路由（绕过规则与冷却）：

```
@model:openai/gpt-5.1 帮我分析这段日志
```

可在配置中通过 `explicitModelPrefix` 自定义前缀。

### 缓存配置（cache）

```jsonc
{
  "cache": {
    "enabled": true,       // 总开关，继承 pi 缓存，默认 true
    "preferCache": true,   // 偏好缓存命中高的模型
    "minHitChars": 1024,   // 视为有效命中的最小公共前缀字符数
    "sticky": true,        // 同 taskType 粘滞以保缓存
    "stickyTtlMs": 300000   // 粘滞窗口（毫秒）
  }
}
```

单规则可覆盖：`"cacheAware": false` 表示该规则不参与缓存偏好排序。


## 命令

扩展注册 `/router` 命令：

```
/router                 — 状态（当前模型、可用模型、规则、冷却、缓存、最近决策）
/router rules           — 已编译规则列表
/router cache           — 每模型缓存命中统计
/router reload          — 从 pi-router.json 热加载配置
/router clear [model]   — 清除指定模型或全部冷却
/router clear-cache     — 清除缓存记录
/router clear-history   — 清除决策历史
/router toggle          — 启用/禁用（内存）
/router test <prompt>   — 干跑：对给定 prompt 做路由决策但不切模型
/router help            — 帮助
```

## LLM 工具

扩展注册 `router_status` 工具，LLM 可调用以了解当前路由状态。

## 行为

- **Turn 级路由**（`before_agent_start`）：基于完整任务上下文（prompt、工具、上下文大小、轮次）做决策 → `pi.setModel()`。为默认与推荐模式。
- **Request 级路由**（`before_provider_request`）：当 `routingLevel` 含 `request` 时，改写 `payload.model`，适合细粒度场景。
- **失败冷却**：`after_provider_response` 收到 429/5xx 时，或 `tool_result` 命中错误特征时，标记模型冷却 `cooldownMs`，下次决策自动规避并走 fallback 链。
- **Fallback**：`off`（单次）、`retry`（重试 N 次）、`model-chain`（按序尝试备用模型）。
- **可观测**：决策历史与缓存记录持久化到会话（`pi.appendEntry`），状态条 `⚡ model → reason`，`/router cache` 展示命中率，`verbose` 时控制台日志。
- **缓存感知**：见上节核心特色，`message_end` 回填 `cacheRead/cacheWrite` 更新 `hitRate`，多跳共享 `sessionId`。

## 架构

```
src/
  index.ts            # 扩展入口：事件注册、命令、工具
  types.ts            # 类型契约
  config.ts           # 配置加载（分层 + 归一化 + 热加载）
  engine/
    cache.ts          # 缓存感知（CacheManager，前缀/命中率/粘滞/多跳保留）
    conditions.ts     # 条件评估（提炼自 CCR）
    registry.ts       # 选择器归一化与冷却集合
    planner.ts        # 执行计划（retry / model-chain）
    rules.ts          # 规则编译与匹配
    decision.ts       # 决策引擎（显式 > 粘滞 > 规则 > 默认 > fallback，缓存感知）
    failure.ts        # 失败分类
  context/
    task.ts           # 任务特征提取（prompt → TaskFeatures）
  hooks/
    agent.ts          # before_agent_start
    provider.ts       # before_provider_request
    failure.ts        # after_provider_response / tool_result
  commands/
    router.ts         # /router 命令
  tool/
    router.ts         # router_status 工具
```

详细契约见 `tasks/CHG-001/SPEC.md` 与 `TRACEABILITY.md`。

## 开发

```bash
npm test        # node --test（引擎单测，65 tests，含 cache）
npm run typecheck  # tsc --noEmit
```

## 致谢

- 路由决策模型提炼自 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) 的 `packages/core/src/routing`（`policy-engine`、`model-registry`、`config-compiler`、`execution-plan`、`failure-classifier`、`rewrite`）。
- 运行于 [earendil-works/pi](https://github.com/earendil-works/pi) 的扩展 API（`registerProvider` / `setModel` / `before_agent_start` / `before_provider_request` / `after_provider_response` / `registerCommand` / `registerTool`）。

## License

MIT
