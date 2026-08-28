# TRACEABILITY — CHG-003 pi-smart-router v0.3.0

## 需求 → 里程碑 → 验证证据

| PRD ID | 需求 | 里程碑 | 实现文件 | 验证证据 |
|--------|------|--------|----------|----------|
| R21 | 模型目录快照 | M2 | src/catalog/catalog.ts、src/types.ts、src/config.ts | test/catalog.test.ts：合并 modelRegistry + 用户标注 + 持久化 |
| R22 | 难度估算 | M2 | src/engine/difficulty.ts | test/difficulty.test.ts：低/中/高边界 |
| R23 | self-learn 多维评分 | M3 | src/engine/selflearn.ts | test/selflearn.test.ts：场景×难度得分、handoff 学习、收敛 |
| R24 | 可用性探测 | M4 | src/probe/availability.ts | test/probe.test.ts：三层标记、session 独立、401/402/403 |
| R25 | handoff 工具 | M4 | src/tool/handoff.ts | test/handoff.test.ts：目标校验、记录、喂 self-learn |
| R26 | 联合决策 | M3/M4 | src/engine/decision.ts | test/decision.test.ts 扩展：难度+场景+learn 联合 |
| R27 | 回落机制 | M3/M4 | src/engine/decision.ts、src/hooks/agent.ts | 单测 + 手动 |
| R28 | 配置兼容 | M2 | src/config.ts | test/config.test.ts 扩展：旧配置零改动 |
| R29 | 单测闭环 | M2-M5 | test/*.test.ts | `npm test` 全绿 |

## 架构决策记录（ADR 摘要）

| 决策 | 选择 | 理由 | 可逆性 |
|------|------|------|--------|
| 模型目录（ADR-009） | catalog 文件为唯一事实源 | 判定有数据底座、可编辑 | 高 |
| 难度估算（ADR-010） | 特征→低/中/高 | 区分拓荒与攻坚 | 高 |
| self-learn（ADR-011） | 场景×难度多维评分 | 表达前端/后端/测试差异 | 高（可关） |
| 可用性探测（ADR-012） | 三层组合 | 安全+可靠+不阻塞 | 高（probe 可关） |
| handoff（ADR-013） | 模型自判交接工具 | "把决定权交给模型" | 高（可关） |

## 验证命令

```bash
npm test                # node --test 全量单测（含 catalog/difficulty/selflearn/probe/handoff）
npm run typecheck       # tsc --noEmit
pi update --extensions  # 部署全局
# pi 内
/router catalog
/router probe
/router handoff
/router status
```
