# TRACEABILITY — CHG-002 pi-smart-router v0.2.0

## 需求 → 里程碑 → 验证证据

| PRD ID | 需求 | 里程碑 | 实现文件 | 验证证据 |
|--------|------|--------|----------|----------|
| R14 | 学习路由（learn） | M2/M3 | src/engine/learn.ts、src/engine/decision.ts、src/index.ts、src/hooks/* | test/learn.test.ts：得分、preferred、minSamples、失败惩罚、衰减 |
| R15 | churn 量化 | M2/M3 | src/engine/cache.ts、src/engine/decision.ts | test/churn.test.ts：切换损失估算、超阈值保持、reason 标注 |
| R16 | 中文模板 | M4 | examples/pi-router.cn.json | 手动：复制即用，模型名匹配用户环境 |
| R17 | compaction 感知 | M2/M3 | src/engine/cache.ts、src/index.ts | test/churn.test.ts / cache.test.ts：invalidatePrefix 重置 |
| R18 | 配置兼容 | M2 | src/config.ts、src/types.ts | test/config 相关：v0.1.0 配置零改动归一化 |
| R19 | 可观测 | M3/M4 | src/commands/router.ts | 手动：/router status + /router learn |
| R20 | 单测闭环 | M2-M5 | test/*.test.ts | `npm test` 全绿 |

## 架构决策记录（ADR 摘要）

| 决策 | 选择 | 理由 | 可逆性 |
|------|------|------|--------|
| 学习路由（ADR-006） | LearningManager 按 taskType 累计得分 | 零配置自适应、与冷却闭环 | 高（learn.enabled 可关） |
| churn 量化（ADR-007） | 切换丢失缓存 token 估算 + 规则优先 | 把"是否切换"变成成本判断 | 高（churn.enabled 可关） |
| compaction 感知（ADR-008） | invalidatePrefix 重置旧前缀 | 避免 compact 后误导偏好 | 高 |

## 验证命令

```bash
npm test                # node --test 全量单测（含 learn/churn/compaction）
npm run typecheck       # tsc --noEmit（补 typescript 依赖后）
pi update --extensions  # 部署全局
# pi 内
/router status
/router learn
```
