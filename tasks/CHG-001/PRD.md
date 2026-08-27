# PRD — pi-smart-router 智能模型路由扩展

> version: 1 | status: APPROVED (用户授权自动开发)
> change_ref: CHG-001

## 1. 背景与问题

- pi 是强大的 coding agent，但**模型选择是手动的**（`/model`、`Ctrl+P` 循环）。用户在真实工作流中注册了多个 provider/model（如 coding 模型、通用模型、多模态模型、长上下文模型），需要一个智能调度层根据任务特征自动选择最优模型。
- claude-code-router (CCR) 提供了成熟的"智能路由决策引擎"（条件规则、模型解析、fallback 模型链、失败分类、凭证/模型冷却），但其形态是**外部网关进程**。我们不需要额外进程——把同样的决策逻辑**原生化**进 pi 的 extension 事件生命周期，即可获得同等能力。
- 目标用户：已配置多模型的 pi 重度用户；希望自动在"编码 / 通用 / 多模态 / 长上下文"模型间切换的用户。

## 2. 用户故事

1. 作为 pi 用户，我在写代码时，路由扩展自动选用 coding 模型；切换为写文档/研究时，自动切到通用模型，无需手动 `/model`。
2. 作为 pi 用户，我的主模型连续 429/5xx，扩展自动把它标记冷却，并在下一轮自动切换到备用模型，工作不中断。
3. 作为 pi 用户，我可以通过 `/router` 查看当前路由状态、最近决策原因、哪些模型在冷却，并可一键开关/刷新。
4. 作为 pi 用户，我可以写路由规则（YAML/JSON），按任务类型、上下文大小、图片、轮次等特征路由。
5. 作为 pi 用户，我可以在 prompt 里显式 `@model:provider/model` 强制指定本次模型，绕过自动路由。
6. 作为 pi 用户，LLM 也可以通过工具查看路由规则和状态（利于 agent 理解当前模型配置）。
7. 作为 pi 用户，我在多轮连续同类任务中，路由保持同一模型以最大化缓存命中；切换模型时，之前模型的缓存不被清空，切回时仍可命中；fallback 多跳中缓存前缀在同一 session 内保留。

## 3. 范围

### In scope
- 任务特征提取（task features）：任务类型分类、上下文大小、工具集、图片、轮次、显式模型。
- 路由规则引擎：条件（operator: ==/!=/>/>=/</<=/contains/not-contains/starts-with）+ 目标模型 + fallback。
- 模型解析与冷却：从 pi 模型注册表解析模型；失败后冷却。
- 两级路由钩子：`before_agent_start`（turn 级）、`before_provider_request`（request 级）。
- 失败检测与冷却：`after_provider_response`（HTTP 429/5xx）、`tool_result`（错误特征）。
- `/router` 命令 + TUI 状态 + LLM 工具。
- **缓存感知的路由（核心特色）**：继承 pi 前缀缓存（`cache_control` / `prompt_cache_key` / `promptCacheKey` / `x-affinity`），在 turn/request 两级与 fallback 多跳中保留 `sessionId` 前缀；偏好缓存命中高的模型、粘滞同 taskType 以保缓存、多跳共享前缀。
- 配置：全局 `~/.pi/agent/pi-router.json` + 项目级 `.pi/pi-router.json`（项目覆盖全局）。
- 测试（node:test 单测）闭环。

### Out of scope
- 外部网关/进程、多模型并行 fusion、凭证池、MCP 工具融合。
- 单请求内自动换模型重试（pi 架构限制，仅 turn 间 failover）。

## 4. 需求与验收标准

| ID | 需求 | 验收标准 |
|----|------|----------|
| R1 | 扩展可安装加载 | `pi install git:github.com/hhx465453939/pi-smart-router` 后 `/router` 命令存在且无报错 |
| R2 | 任务特征提取 | 给定 prompt+上下文，能正确分类 task type、估算 context tokens、检测图片/工具/显式模型 |
| R3 | 条件评估引擎 | 所有 operator 语义正确（数值/字符串/contains/深度 contains/前缀） |
| R4 | 规则匹配与决策 | 按优先级匹配规则，命中后决策含目标模型+原因；无命中回落到默认模型 |
| R5 | turn 级路由 | `before_agent_start` 中按规则调用 `pi.setModel()` 且生效 |
| R6 | request 级路由 | `before_provider_request` 改写 `payload.model` 且生效 |
| R7 | 失败冷却 | 429/5xx 后模型进入冷却；决策时规避冷却模型；冷却自动过期 |
| R8 | fallback 模型链 | 主模型不可用/冷却时，按链依次选择备用模型 |
| R9 | 用户显式指定 | prompt 中 `@model:provider/model` 强制路由，忽略规则 |
| R10 | 可观测性 | `/router` 展示当前模型、规则、冷却状态、最近决策（原因/命中规则） |
| R11 | 配置分层 | 项目级配置覆盖全局；热加载（无需重启） |
| R12 | 单元测试闭环 | `npm test` 全绿，覆盖引擎核心逻辑 |
| R13 | 缓存感知的路由（核心特色） | 同 session 连续轮次保持前缀缓存；`preferCache` 时 fallback 偏好命中高者；`sticky` 同 taskType 粘滞；`/router cache` 与 `status` 展示命中率；`before_provider_request` 仅改 `model` 保留 `cacheRetention/sessionId/prompt_cache_key/cache_control` |

## 5. 依赖与约束

- pi 版本：基于当前安装版本（@earendil-works/pi-coding-agent）的 extension API。
- 运行时：Node ≥ 20（pi 要求），TS 经 jiti 加载。
- 依赖：peerDependencies 声明 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`。
- 安全：扩展拥有完整系统权限——仅从可信源安装；不读取/写入敏感凭据（apiKey 由 pi 管理）。

## 6. 成功指标

- 单测覆盖率：引擎核心（conditions/rules/planner/failure）≥ 90%。
- 安装链路验证：本地 `pi -e` / 目录安装无错误。
- 决策可解释：每次模型切换有可读 reason 展示。
