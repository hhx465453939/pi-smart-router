# Change Brief — CHG-001

> status: approved (用户授权自动开发: "自动开发，自动闭环测试，自动commitpush")

## 变更请求摘要

将 claude-code-router (CCR) 的"智能模型路由决策引擎"逻辑提炼、原生化，构建一个 pi (earendil-works/pi) 扩展——`pi-smart-router`。它根据任务特征（任务类型、上下文大小、工具需求、图片、轮次）自动选择最优模型，支持条件路由规则、模型链回退、失败检测与冷却、可观测性，并可通过 `/router` 命令与 LLM 工具交互。无需外部网关进程。

## 目标

- 提供 pi 原生的智能模型路由层（当前 pi 模型切换是手动的 `/model`、`Ctrl+P`，无自动路由能力）。
- 复用并提炼 CCR 的路由决策核心：条件评估、规则编译、模型解析、执行计划（fallback）、失败分类、冷却（cooldown）。
- 两级路由：`before_agent_start` 做 turn 级路由（`pi.setModel()`），`before_provider_request` 做 request 级细粒度路由（改写 `payload.model`）。
- 可观测：记录每次路由决策（规则命中、模型选择、原因），通过 `/router` 命令与 TUI 状态展示。
- 打包为标准 pi-package，可通过 `pi install git:github.com/hhx465453939/pi-smart-router` 安装。

## 非目标

- 不做外部网关/代理进程（那是 CCR 本身）。
- 不做多模型并行融合（fusion）/ MCP 工具融合。
- 不做凭证池/密钥轮换（pi 自带 auth 管理）。
- 不做 per-request 的重试到不同模型（pi 单请求内无法换模型；只在 turn 间 failover）。

## 当前行为（现状基线）

- pi 无智能路由：模型选择为手动，无规则引擎、无自动回退、无失败冷却。

## 范围

- 新建独立仓库 `pi-smart-router`（GitHub: hhx465453939/pi-smart-router）。
- 核心引擎 + 事件钩子 + 命令 + 工具 + 配置 + 测试 + 文档 + 示例配置。

## 约束与假设

- 假设 pi 已注册多个 provider/model（通过 models.json 或 extensions）。
- 假设运行环境为 pi 的 extension 运行时（TS 经 jiti 加载，无需编译）。
- 依赖 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`（peerDependencies）。
- 测试使用 Node 内置 test runner（node:test），避免重依赖。

## 风险

- pi 扩展 API 版本演进可能导致 breakage（缓解：peerDependencies 声明、文档记录兼容版本）。
- 自动切模型可能让用户意外（缓解：默认仅对"已配置规则且用户启用"生效；`/router` 可查看每次决策与原因；可一键关闭）。
- 冷却误判（缓解：可配置阈值、白名单；提供手动清除冷却命令）。

## 成功信号

- `pi install git:github.com/hhx465453939/pi-smart-router` 后可加载，无报错。
- 规则命中时自动切换模型，`/router` 显示决策原因。
- 429/5xx 后模型进入冷却，下个 turn 自动避开并选择 fallback。
- 单元测试全绿（node --test）。
