# Change Brief — CHG-003

> status: approved (用户确认方案并补充需求: "这个方案好" + self-learn/可用性探测/纯自适应分配)

## 变更请求摘要

在 pi-smart-router v0.2.0（规则 + learn + churn + cache）基础上，升级到 v0.3.0，实现"全自动无缝智能路由"，核心目标**提升模型性价比**：

1. **模型能力快照（Model Catalog）+ self-learn 自我评估**：建立每模型档案（性能/参数/擅长场景/难度评级/经验评价），随使用自动更新得分，越用越智能。
2. **纯自适应任务分配（难度感知，无定式）**：不做"if 前端 then k3"式硬编码，改为"难度 + 场景 + self-learn 得分"联合决策，收敛到"最适合的模型做最适合的工作"。低中难度默认便宜快模型，高难度复杂走强模型。
3. **启动异步可用性探测（套餐失效检测）**：每 session 启动后台异步检测哪些模型可用（不阻塞用户），网络不可达/套餐失效模型从本 session 路由排除；每 session 独立快照。
4. **router_handoff 交接工具**：把决定权交给当前模型——它可主动把工作和缓存交接给更适合的模型，无缝切换。

## 目标

- 从"线性规则为主"升级为"规则兜底 + 自适应学习 + 模型自判 + 可用性守护"的分层智能。
- 达到用户描述的效果：一般任务 dsv4 拓荒 → 复杂后端 glm-5.3 → 前端 k3-256k → 写完前端自动回落 dsv4 → 复杂测试迭代交接 codex → 全程自动无缝。

## 非目标

- 不做每次 prompt 都调小模型判定的常驻路由（延迟/成本违背性价比目标）；小模型仅作"规则拿不准时的可选仲裁"（后续版本）。
- 不做跨模型物理缓存共享；不做外部网关/进程。
- 不触碰 apiKey 等凭据（安全边界：探测只用连通性 + auth 存在性 + 被动 401/402/403）。

## 范围

- 新增：`src/catalog/catalog.ts`（模型目录 + 持久化）、`src/engine/difficulty.ts`（难度估算）、`src/engine/selflearn.ts`（多维评分）、`src/probe/availability.ts`（启动异步探测）、`src/tool/handoff.ts`。
- 修改：`src/types.ts`、`src/config.ts`、`src/engine/decision.ts`、`src/hooks/*`、`src/commands/router.ts`、`src/index.ts`、README、示例。
- 测试：新增 catalog/difficulty/selflearn/probe 单测。

## 约束与假设

- 可用性探测三层：`getAvailableSnapshot` 立即过滤（无 key）→ 后台连通性探测（不带 key）→ 被动 401/402/403（真实调用）。
- 探测异步、每 session 独立、timeout 5 分钟、不阻塞用户聊天。
- self-learn 数据持久化（appendEntry + catalog 文件），会话级 + 跨会话累计。

## 风险

- 连通性探测可能误报（网络抖动）→ 缓解：探测失败仅标记"不确定"，路由时用 learn/catalog 兜底；401/402/403 才是确定性不可用。
- self-learn 收敛到次优 → 缓解：难度分级门槛 + 可关闭 + catalog 人工标注可覆盖。
- handoff 被滥用 → 缓解：冷却/频率限制 + 目标可用性检查 + 可关闭。

## 成功信号

- `npm test` 全绿（新增 catalog/difficulty/selflearn/probe）。
- 启动后异步完成探测，`/router status` 展示每模型可用性。
- 连续使用后 `/router catalog` 展示 self-learn 收敛的"场景→模型"得分。
- 部署全局，`pi update --extensions` 后无报错。
