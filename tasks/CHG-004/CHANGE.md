# CHANGE — CHG-004

> status: approved (用户: "把能看见的模型，都自动去看，自动取纳入路由的rank里面吧")

## 摘要

让路由**自动遍历所有已注册模型**（无需手写规则），从 pi 模型注册表全量元数据（cost/contextWindow/maxTokens/input/thinkingLevelMap）自动生成画像与性价比评分，全部纳入路由 rank。解决"80+ 模型没被考虑到、不知性能"的现状。

## 目标

1. **auto-profiling**：启动时遍历 `ctx.modelRegistry.getAll()`（全量模型，覆盖 models.json/extensions/providers 所有来源），为每个模型生成画像：价格档、能力档、速度档、长上下文、多模态、value score（性价比）。
2. **自动纳入 rank**：决策链的 fallback/自适用层直接在"画像评分"上选，不依赖人工规则；self-learn 实测在其上修正。
3. **可观测**：`/router value` 展示全部模型画像 + 性价比排名；catalog 合并画像字段。

## 非目标

- 不改 pricing（用注册表实际 cost）。
- 不做人工标注强制（画像自动，人工可覆盖）。

## 数据源

- 主：`ctx.modelRegistry.getAll()` → { provider, id, contextWindow, maxTokens, cost{input,output,cacheRead}, input[], thinkingLevelMap, reasoning }
- 兜底：`models-store.json`（若 registry 不可用）。

## 画像启发式

- 价格档：按 cost.input（$/M）：<0.5→cheap，<5→medium，≥5→expensive
- 能力档：id 含 pro/code/k3/k2.6/max/sol/opus 或 reasoning 且价高 → high；含 flash/highspeed/mini/lite → low；否则 medium
- 速度档：flash/highspeed/mini/1m → fast；其余 normal
- 多模态：input 含 image → vision
- 长上下文：contextWindow ≥ 200k → long
- **value score**：`capability 档分 - 价格档罚 - 延迟罚 + self-learn 修正`（低难度配 cheap+fast 权重高，高难度配 high capability 权重高）

## 里程碑

| M | 内容 | 验证 |
|---|------|------|
| M1 | profile.ts（画像+value score）+ catalog 合并 | 单测 |
| M2 | decision 自动 rank 接入 + /router value | 单测+冒烟 |
| M3 | 闭环 commit/push/部署 | npm test 全绿 |