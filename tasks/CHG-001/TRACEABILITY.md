# TRACEABILITY — CHG-001 pi-smart-router

## 需求 → 里程碑 → 验证证据

| PRD ID | 需求 | 里程碑 | 实现文件 | 验证证据 |
|--------|------|--------|----------|----------|
| R1 | 可安装加载 | M5/M6 | package.json, src/index.ts | `pi -e ./src/index.ts` 无报错；`pi install <path>` 成功；`/router` 存在 |
| R2 | 任务特征提取 | M3 | src/context/task.ts | test/task.test.ts：task type 分类、context tokens 估算、图片/工具/显式模型检测 |
| R3 | 条件评估引擎 | M2 | src/engine/conditions.ts | test/conditions.test.ts：全部 operator 语义 |
| R4 | 规则匹配决策 | M2 | src/engine/rules.ts, src/engine/decision.ts | test/rules.test.ts, test/decision.test.ts：优先级、命中/回落 |
| R5 | turn 级路由 | M3 | src/hooks/agent.ts | 手动冒烟 + 事件调用引擎的单测 |
| R6 | request 级路由 | M3 | src/hooks/provider.ts | 手动冒烟 + payload 改写单测 |
| R7 | 失败冷却 | M2/M3 | src/engine/failure.ts, src/hooks/failure.ts | test/failure.test.ts：冷却设置/规避/过期 |
| R8 | fallback 模型链 | M2 | src/engine/planner.ts | test/planner.test.ts：model-chain/retry/off |
| R9 | 用户显式指定 | M3 | src/context/task.ts, src/engine/decision.ts | test/task.test.ts + test/decision.test.ts：`@model:` 强制 |
| R10 | 可观测性 | M4 | src/commands/router.ts | 手动冒烟：`/router` 展示状态/冷却/最近决策 |
| R11 | 配置分层 | M5 | src/config.ts | test/config.test.ts：全局+项目合并、热加载 |
| R12 | 单测闭环 | M2-M6 | test/*.test.ts | `npm test` 全绿 |
| R13 | 缓存感知的路由（核心特色） | M7 | src/engine/cache.ts、src/engine/decision.ts、src/hooks/*、src/commands/router.ts | test/cache.test.ts：前缀保留、偏好命中、粘滞、多跳留存；`/router status` 与 `/router cache` 展示命中率 |

## 架构决策记录（ADR 摘要）

| 决策 | 选择 | 理由 | 可逆性 |
|------|------|------|--------|
| 形态 | 原生 extension（非网关） | 契合"提炼逻辑"目标；零额外进程 | 高（引擎纯 TS 可复用） |
| 路由层级 | turn 级主 + request 级辅 | 完整任务上下文 vs 细粒度，两者互补 | 高（可配置 routingLevel） |
| 冷却存储 | 内存 + 会话 entry | 简单、turn 间足够、决策历史可恢复 | 高 |
| 测试框架 | node:test | 零依赖、Node 内置 | 高 |
| 缓存感知 | 粘滞 + 偏好命中（ADR-004） | 继承 pi 前缀缓存，多跳保留 | 高（关闭 preferCache 即回退） |

## 验证命令

```bash
npm test              # node --test 全量单测（65 tests，含 cache）
npm run typecheck     # tsc --noEmit（如启用）
pi -e ./src/index.ts  # 扩展加载冒烟；连续两轮同类任务验证 cacheRead>0
pi install /home/shpc_101170/Development/pi-smart-router  # 打包安装验证
```
