---
change_id: CHG-001
version: 1
status: approved
prd_ref: tasks/CHG-001/PRD.md
health_ref: null
supersedes: null
approved_by: user (授权自动开发)
approved_at: 2026-08-27
---

# SPEC — pi-smart-router 工程契约

## 1. 上下文、目标、非目标、约束、假设、未决问题

- **上下文**：pi 目前模型切换为手动。目标用户配置了多模型。本扩展把 claude-code-router 的智能路由决策逻辑提炼并原生化进 pi 的 extension 事件生命周期。
- **目标**：见 PRD §2/§4（R1-R12）。
- **非目标**：外部网关、多模型融合、凭证池、单请求内换模型重试。
- **约束**：
  - 运行在 pi extension 运行时，TS 经 jiti 加载，无需编译即可使用。
  - 事件时序约束：`before_agent_start` 早于 `_runAgentPrompt`，此时 `pi.setModel()` 生效（已验证源码）。
  - `before_provider_request` 的 `onPayload` 返回值即最终请求 payload，可改写 `payload.model`（已验证源码）。
  - `after_provider_response` 提供 HTTP status，用于失败分类。
- **假设**：pi 已注册多个模型；Node ≥ 20；测试用 node:test。
- **未决问题**：无阻塞性未决问题。兼容性随 pi API 演进，通过 peerDependencies + 文档声明基线版本。

## 2. 当前架构与债务影响

- 当前：无该能力（新项目）。无需迁移。
- 债务影响：新增独立模块化代码；通过清晰分层（engine/context/hooks/commands/tool）控制耦合；引擎为纯 TS，与 pi API 解耦（仅 hooks 层依赖 pi），便于移植与单测。

## 3. 选定设计 + ADR

### 架构权衡：外部网关 vs 原生 extension

| 方案 | 说明 | 优缺点 |
|------|------|--------|
| A. 原生 extension（选定） | 提炼决策引擎进 extension，挂钩 pi 事件 | 无需进程、安装即用、决策可解释、与 pi 深度融合；缺点：受 pi 事件模型约束（无单请求内换模型） |
| B. 本地网关（CCR 原样） | 启动本地代理，pi 指向网关 | 能力最全（fusion/凭证池）；缺点：额外进程、配置复杂、与本次"提炼逻辑"目标不符 |

**决策**：选 A。理由：用户需求是"提炼 CCR 的逻辑做一个 pi extension"，A 最契合；且 pi 的 `before_provider_request`/`before_agent_start` 已覆盖 turn 级 + request 级路由，足够支撑核心价值。**可逆性**：高——引擎为纯 TS，未来若需网关形态可复用同一引擎。**后果**：放弃单请求内换模型、fusion。

### 架构权衡：turn 级 vs request 级路由主从

- **turn 级（主）**：`before_agent_start` 用完整任务上下文做粗路由 → `pi.setModel()`。稳定、可解释、对 provider 无侵入。
- **request 级（辅）**：`before_provider_request` 改写 `payload.model`，用于细粒度/上下文变化场景。
- **决策**：双级并存，turn 级优先；request 级仅当配置了 request-scope 规则时启用。避免两级打架：request 级规则匹配到显式 request-scope 规则才覆盖。

### 架构权衡：模型冷却存储

- 内存 Map（进程内）+ 会话 entry 持久化。**决策**：冷却状态存内存（turn 间足够），决策历史用 `pi.appendEntry` 持久化到会话，便于 `/router` 展示与恢复。简单、无外部存储。

## 4. 接口、数据、安全、兼容性、迁移、可观测性、发布、回滚

### 配置数据契约（~/.pi/agent/pi-router.json + .pi/pi-router.json）

```jsonc
{
  "enabled": true,
  "defaultModel": "anthropic/claude-sonnet-4-5",   // 兜底模型（可省略 → 保持当前）
  "routingLevel": "turn" | "request" | "both",      // 默认 turn
  "cooldownMs": 60000,                              // 失败冷却时长
  "failure": {
    "cooldownOnStatus": [429, 500, 502, 503, 504],  // after_provider_response 触发冷却的状态码
    "cooldownOnToolErrorPatterns": ["rate.?limit", "context.?length", "overloaded", "503", "429"] // tool_result 错误特征
  },
  "taskTypeRules": {                                 // 关键词分类（prompt → task type）
    "code": ["implement", "fix", "bug", "refactor", "function", "api", "test", "type", "error", "compile"],
    "document": ["document", "readme", "doc", "explain", "summarize", "write"],
    "research": ["research", "investigate", "analyze", "compare", "find", "search"]
  },
  "rules": [
    {
      "id": "code-uses-coding-model",
      "name": "编码任务用 coding 模型",
      "priority": 100,
      "when": { "taskType": "code" },
      "model": "anthropic/claude-opus-4-5"          // 或 "provider/model"
    },
    {
      "id": "long-context",
      "name": "长上下文用大窗口模型",
      "priority": 90,
      "when": { "contextTokens": { "gt": 80000 } },
      "model": "openrouter/anthropic/claude-sonnet-4"
    },
    {
      "id": "image-task",
      "when": { "hasImage": true },
      "model": "openai/gpt-5.1"
    }
  ],
  "fallback": {
    "mode": "model-chain",                          // off | retry | model-chain
    "retryCount": 2,
    "models": ["openrouter/anthropic/claude-sonnet-4", "deepseek/deepseek-v4"]
  },
  "explicitModelPrefix": "@model:",                 // prompt 显式指定前缀
  "verbose": true
}
```

### 条件语法（when）

```jsonc
{ "taskType": "code" }                          // 等值
{ "taskType": { "in": ["code", "research"] } }  // 多值
{ "contextTokens": { "gt": 80000 } }            // 数值比较 lt/gt/lte/gte/eq
{ "hasImage": true }                            // 布尔
{ "hasImage": { "contains": false } }           // 取反 (not)
{ "messageCount": { "gte": 10 } }
{ "turnIndex": { "gte": 5 } }
{ "promptLength": { "gt": 500 } }
{ "taskType": { "startsWith": "cod" } }
{ "modelId": { "contains": "claude" } }
```

### 路由优先级（PolicyEngine）

1. 显式指定（`@model:` in prompt）→ 强制，不参与冷却规避
2. 冷却规避（主候选在冷却中）→ 选 fallback 链中第一个未冷却的
3. 规则（按 priority 降序，规则内 when 全匹配）
4. defaultModel / 保持当前

### 失败分类与冷却

- `after_provider_response`: status ∈ cooldownOnStatus → 冷却该模型。
- `tool_result`: isError 且 content 匹配任一 errorPattern（大小写不敏感 regex）→ 冷却该模型（限当前模型）。
- 冷却中的模型在决策中避开；冷却期到自动恢复。

### 安全

- 不触碰 apiKey/凭据（由 pi 管理）。
- 配置热加载，路径防目录穿越（resolve + startsWith 校验）。
- 规则中 model 值必须通过 `ctx.modelRegistry.find` 解析成功才生效，未配置的模型产生诊断并忽略。

### 兼容性与迁移

- peerDependencies：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`（`*`）。
- 无历史版本迁移（新项目）。
- pi-package 清单：package.json `pi.extensions` 指向 `src/index.ts`。

### 可观测性

- 决策历史：`pi.appendEntry("pi-smart-router-decision", {...})`，`/router` 展示最近 N 条。
- 状态条：`ctx.ui.setStatus("router", "⚡ model→reason")`。
- `verbose` 时 console 日志决策细节。

### 发布与回滚

- 发布：GitHub 仓库 `hhx465453939/pi-smart-router`，用户经 `pi install git:...` 安装。
- 回滚：`pi remove git:github.com/hhx465453939/pi-smart-router` 或删除 settings 条目。配置为纯 JSON，可随时删除。

## 5. 里程碑

| 里程碑 | 内容 | 文件 | 验收 | 检查 |
|--------|------|------|------|------|
| M1 契约 | CHANGE/PRD/SPEC/TRACEABILITY | tasks/CHG-001/* | 文档完整、需求可追踪 | 人工审阅 |
| M2 引擎核心 | types/conditions/registry/rules/planner/failure/decision | src/engine/*、src/types.ts | 单测通过、operator 语义正确 | npm test |
| M3 上下文与钩子 | task 特征提取 + before_agent_start/before_provider_request/失败检测 | src/context/task.ts、src/hooks/* | 事件正确调用引擎、setModel 生效 | npm test + 手动 |
| M4 命令与工具 | /router 命令 + LLM 工具 + 状态条 | src/commands/*、src/tool/* | 命令可用、决策可展示 | 手动 |
| M5 配置与打包 | 配置加载/热更新、package.json、README、示例 | src/config.ts、package.json、README.md、examples/* | pi install 可加载、配置分层生效 | 手动 + pi -e |
| M6 闭环 | 全量单测 + 文档 + commit/push | 全仓 | npm test 全绿、push 成功 | npm test + git |

## 6. Definition of Ready / Done

- **DoR**：PRD 已 APPROVED；架构权衡已记录；接口契约已定义。
- **DoD**：R1-R12 验收标准满足；`npm test` 全绿；`pi install`（本地路径）可加载无报错；README 与示例齐全；已 commit 并 push。

## 7. Review 与 Delivery Gates

- Gate 1：引擎单测全绿 → 继续。
- Gate 2：`pi -e ./src/index.ts` 加载无报错、`/router` 可用 → 进入打包。
- Gate 3：`pi install`（本地）验证通过 → 发布。
- commit/push：用户已授权自动执行（本任务范围内）。

## 8. Traceability 与验证证据

见 TRACEABILITY.md。验证命令：
- `npm test` → node --test（引擎单测）
- `npm run typecheck` → tsc --noEmit（若启用）
- `pi -e ./src/index.ts` → 加载冒烟
- `pi install <path>` → 打包安装验证
