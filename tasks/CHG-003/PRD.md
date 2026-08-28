# PRD v0.3.0 — pi-smart-router 全自动无缝智能路由

> version: 3 | status: APPROVED (用户确认方案 + 补充需求)
> change_ref: CHG-003

## 1. 背景与问题

- v0.2.0 已有规则 + learn + churn + cache，但判定仍以"线性规则为主"，无法处理"任务难度/复杂后端/前端场景"这类需要语义与经验判断的分配。
- 用户目标：**提升模型性价比**，全自动无缝切换——一般任务用便宜快的 dsv4-flash，复杂后端用 glm-5.3，前端用 k3-256k，复杂测试迭代用 codex；写完前端自动回落便宜模型；套餐失效自动检测排除。
- 用户明确："规则没有定式，纯粹自适应"，"把决定权交给模型"。

## 2. 用户故事

1. 作为用户，我发一个简单任务，路由自动用便宜模型（dsv4-flash）处理，不用 k3/codex 拓荒。
2. 作为用户，遇到复杂后端逻辑，路由自动升到 glm-5.3；前端任务自动用 k3-256k。
3. 作为用户，写完前端代码，路由自动回落到 dsv4，不为后续普通对话烧强模型。
4. 作为用户，测试逻辑复杂时，当前模型主动把工作交接给 codex 继续迭代。
5. 作为用户，某个套餐没续订/欠费，路由检测到后本 session 后续不再用它，自动走别的可用模型。
6. 作为用户，启动 pi 后我可以直接开聊，后台几十秒内把可用模型列表刷好，之后自动静默智能路由。
7. 作为用户，使用越多，路由越懂"什么任务该用什么模型"（self-learn）。

## 3. 范围

### In scope
- 模型能力快照（catalog）：自动拉 pi modelRegistry 的 context/cost/input，叠加擅长场景/难度/评价，持久化 + 可编辑。
- self-learn：多维评分（模型×场景×难度×结果），handoff 学习，跨会话累计，收敛到最优分配。
- 难度估算：prompt 特征 → 低/中/高。
- 启动异步可用性探测：三层（getAvailableSnapshot 立即 + 后台连通性 + 被动 401/402/403），每 session 独立，timeout 5 分钟，不阻塞。
- router_handoff 工具：模型自判交接，无缝切换。
- 决策引擎升级：难度 + 场景 + catalog/self-learn 得分 + 可用性快照联合决策。

### Out of scope
- 每次 prompt 常驻小模型判定（延迟/成本）；跨模型物理缓存共享；外部网关；触碰凭据。

## 4. 需求与验收标准

| ID | 需求 | 验收标准 |
|----|------|----------|
| R21 | 模型目录快照 | `pi-router-catalog.json` 自动合并 pi modelRegistry 基础字段 + 用户标注；`/router catalog` 查看编辑 |
| R22 | 难度估算 | prompt 特征 → 低/中/高，单测覆盖边界 |
| R23 | self-learn 多维评分 | 记录模型×场景×难度×结果；得分可查；随使用收敛；可关闭 |
| R24 | 可用性探测 | 启动异步探测；不可用模型本 session 排除；401/402/403 被动标记；每 session 独立；不阻塞 |
| R25 | handoff 工具 | 模型可调用交接；目标可用性校验；记录并喂 self-learn |
| R26 | 联合决策 | 难度+场景+learn 得分+可用性联合；低难度默认便宜模型；高难度强模型；前端→k3；测试→codex |
| R27 | 回落机制 | 高难度任务完成/降级后自动回落默认便宜模型 |
| R28 | 配置兼容 | v0.2.0 配置零改动可用；新配置段可选 |
| R29 | 单测闭环 | `npm test` 全绿（新增 catalog/difficulty/selflearn/probe） |

## 5. 依赖与约束

- 探测不碰 apiKey；`getAvailableSnapshot` 已含"有 key 的模型"（现有行为）。
- self-learn 持久化到 catalog 文件 + appendEntry。
- 决策优先级（v0.3.0）：显式 > 高优规则 > handoff 意图 > self-learn 得分 > 难度兜底 > 默认 > fallback；冷却/churn 横切。

## 6. 成功指标

- 单测覆盖核心（catalog/difficulty/selflearn/probe）。
- 部署全局后 `/router status` 展示可用性 + `/router catalog` 展示 self-learn 得分。
- 连续使用后路由分配明显收敛到用户描述的"性价比最优"模式。
