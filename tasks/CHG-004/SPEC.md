# SPEC — CHG-004 auto-profiling（全部模型自动入 rank）

> change_id: CHG-004 | status: approved | prd_ref: tasks/CHG-004/CHANGE.md
> 用户需求: "把能看见的模型，都自动去看，自动取纳入路由的rank里面吧"

## 设计

- **数据源**：`ctx.modelRegistry.getAll()` 全量模型（覆盖 models.json/extensions/providers），含 cost/contextWindow/maxTokens/input/reasoning。
- **画像（profileModel）**：价格档（cost.input: <0.5 cheap / <5 medium / ≥5 expensive）、能力档（ID 启发式）、速度档（flash/highspeed/1m→fast）、vision（input 含 image）、longContext（≥200k）。
- **value score**：难度适配的性价比——
  - low/medium：便宜快优先（cheap+fast 高），贵能力强模型扣分（杀鸡不用牛刀）
  - high：能力优先（high 档+reasoning 高），价格次要
  - 叠加 self-learn 实测得分（selftune）
- **入 rank**：session_start 生成全部画像存内存；before_agent_start 按当前难度 rank 前 8 名并入候选集，fallback 层自动可选。
- **命令**：`/router value [low|medium|high]` 展示性价比排名。

## 验证（TRACEABILITY）

- test/profile.test.ts（8 tests）：画像启发式（flash/sol/luna/vision/价格边界）、valueScore 不同难度排序、selftune 提升。
- 真实数据端到端：44 模型 low 难度 → glm-5.3-flash/deepseek-v4-flash ($0.075-0.22) 居前、gpt-5.6-luna 靠前；high → k3-256k/deepseek-v4-pro 居前 ✅。

## 里程碑

M1 profile.ts + catalog 合并 | M2 decision rank 接入 + /router value | M3 闭环 commit/push/部署