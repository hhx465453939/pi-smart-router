# pi-smart-router

> 智能模型路由扩展 for [pi](https://github.com/earendil-works/pi) — 根据任务特征自动选择最优模型，支持规则引擎、模型链回退、失败冷却、**缓存感知路由** 与 **自适应学习路由**。逻辑提炼自 [claude-code-router](https://github.com/musistudio/claude-code-router)，原生继承 pi 的缓存机制，多跳转运中保留 `sessionId` 前缀缓存。

## 功能总览

**缓存感知路由（核心特色）** — 路由不应该让缓存清零。切模型只覆盖 `model`，透传全部缓存字段；同等规则下优先选缓存命中高的模型；同任务类型粘滞保缓存；多跳 fallback 共享 `sessionId` 前缀；`/router cache` 可观测每模型命中率。

**切换抖动量化（churn）** — 估算切走当前模型的缓存 token 损失，超过阈值时无规则决策倾向保持当前模型，规则命中仍优先。

**自适应学习路由（learn）** — 每轮记录实际结果（成本/缓存命中/成败），按任务类型累计得分，决策顺序：显式 > 规则 > 学习偏好 > 粘滞 > 默认 > fallback。

**难度感知** — prompt 特征 → 低/中/高难度，低中难度用便宜快模型拓荒，高难度攻坚走强模型，不为简单任务烧 k3/codex。

**场景识别** — 自动识别 前端/后端/测试/运维/研究/文档 场景，配合模型档案匹配。

**模型能力快照（catalog）** — 自动合并 modelRegistry（窗口/成本/输入类型）+ 场景标注 + self-learn 得分，持久化可编辑（`~/.pi/agent/pi-router-catalog.json`）。

**self-learn 多维评分** — 按「场景×难度」记录每个模型真实表现，跨会话收敛到「前端→k3、测试→codex、一般→flash」，无需写死规则。

**可用性探测（三层）** — ① 无 key 模型立即排除；② 启动后台异步连通性探测；③ 真实调用捕获 401/402/403/429（套餐失效/欠费/额度耗尽）→ 本 session 排除并秒切同类模型。

**auto-profiling** — 启动时遍历全部已注册模型自动画像（价格/能力/速度档 + 性价比评分），全部自动纳入路由 rank，`/router value` 一眼查看。

**模型池（Model Pool）— 自动路由的硬边界** — 60+ 模型太杂？`/router pool` 交互多选器圈一个可信池：池非空时所有自动决策只在池内选，池外模型即使规则命中也被跳过；`@model:` 显式指定不受限；空池 = 不过滤。

**命名预设池** — 把不同场景的池存成命名预设（日常/攻坚/省钱），`/router pool` 面板中选中回车一键切换，存全局 `~/.pi/agent/pi-router.json`。

**router_handoff 工具** — 当前模型可主动把工作交接给更适合的模型，上下文/缓存无缝保留，交接结果喂 self-learn。

> 后续功能更新直接在下面补充，不另列版本号。

## 安装

```bash
# 方式一：pi 包管理器（推荐）
pi install git:github.com/hhx465453939/pi-smart-router

# 方式二：本地路径（开发）
pi install /home/shpc_101170/Development/pi-smart-router

# 方式三：临时试用（不写入 settings）
pi -e ./src/index.ts
```

## 快速开始

```bash
# 1. 安装（已推送到 GitHub）
pi install git:github.com/hhx465453939/pi-smart-router
pi list   # 确认出现 git:github.com/hhx465453939/pi-smart-router

# 2. 部署配置（中文生态模板开箱即用）
cp examples/pi-router.cn.json ~/.pi/agent/pi-router.json

# 3. 热重载（无需重启 pi）
/reload            # 加载扩展最新代码
/router reload     # 热加载 pi-router.json 配置

# 4. 查看状态
/router status     # 总览：开关/当前模型/规则/冷却/缓存/学习/模型池
/router rules      # 已编译规则
/router value      # 全量模型性价比排名

# 5. 日常使用
# 正常聊天即可，路由按规则/自适应学习自动切模型
# 强制指定：@model:openai/gpt-5.1 帮我分析这段日志
# 手动控制：/router off（关闭路由）  /router on（重新开启）
```

> **额度耗尽**：遇到 `AccountQuotaExceeded`（429 月度额度耗尽）会自动排除该模型并秒切其他供应商同类模型，无需手动处理，配额重置后自动恢复。

## 核心功能使用

### 模型池 + 预设（圈定可信模型集合）

```bash
/router pool               # 直接打开预设管理面板，所有操作键位写在面板底部，无需记任何子命令
```

- `/router pool` 直接进入**预设管理面板**：预设列表 + 当前池一目了然，底部键位常驻标注——↑↓ 选中、enter 激活、`e` 编辑该预设模型（预勾选）、`r` 重命名（预填旧名）、`d` 删除（二次确认）、`n` 新建。操作完成自动刷新回到面板，esc 退出。

- 池非空时，**所有自动决策（规则/rank/self-learn/粘滞/默认/fallback/秒切）只在池内选**；池外规则模型被跳过。
- `@model:xxx` 手动指定仍是最高优先级（用户意志高于池）。
- 空池 = 不过滤（全部可用模型参与路由）。

**预设工作流**：`/router pool`（无子命令）进入预设管理面板，选中预设后回车即切换；或 `n` 新建（预勾选当前池 → 回车保存 → 弹命名框），把不同场景的池存成命名预设：

- **日常**：主力 + 兜底（8 个）—— 平时默认
- **攻坚**：k3 / codex / pro 级全上 —— 大重构、难调试时面板里选中回车切换
- **省钱**：纯 flash 档 —— 跑量任务、夜里挂机时切换

预设与池均存全局 `~/.pi/agent/pi-router.json`，切换热生效，`/router status` 一眼可见当前激活池。

### 无痛秒切 fallback

模型额度耗尽/欠费/超时不再卡死：`message_end` 可靠捕获 429/401/402/403 → 排除该模型 → **优先切其他供应商的同类模型**（`volces/dsv4-flash[1m]` → `opencode-go/deepseek-v4-flash` → `shudie/dsv4`，换供应商不换能力档）→ 静默重发原任务。同类全部不可用再按性价比 rank 兜底。

### 显式指定

在 prompt 中用 `@model:provider/model` 强制本次路由（绕过规则与冷却）：

```
@model:openai/gpt-5.1 帮我分析这段日志
```

前缀可在配置 `explicitModelPrefix` 自定义。

## /router 命令

```
/router                    — 状态：当前模型/可用模型/规则/冷却/缓存/学习/模型池/最近决策
/router rules             — 已编译规则列表
/router cache             — 每模型缓存命中统计
/router learn             — 每 taskType 学习得分
/router catalog           — 模型能力快照 + self-learn 得分
/router value [难度]      — 全部模型自动画像性价比排名
/router probe             — 本 session 可用性探测快照
/router handoff           — 最近交接事件
/router pool               — 预设管理面板（激活/编辑/重命名/删除/新建，键位见面板）
/router reload            — 从 pi-router.json 热加载配置
/router clear [model]     — 清除指定模型或全部冷却
/router clear-cache       — 清除缓存记录
/router clear-learn       — 清除学习状态
/router clear-history     — 清除决策历史
/router on / enable       — 开启路由（持久化）
/router off / disable     — 关闭路由（持久化，手动选模型）
/router toggle            — 切换开/关（持久化）
/router test <prompt>     — 干跑：对给定 prompt 做路由决策但不切模型
/router help              — 帮助
```

## 配置

配置文件分层加载：全局 `~/.pi/agent/pi-router.json`，项目级 `<cwd>/.pi/pi-router.json`（覆盖全局）。完整契约见 `examples/pi-router.cn.json` 或 `examples/pi-router.json`。

最小可用配置：

```json
{
  "enabled": true,
  "defaultModel": "volces/deepseek-v4-flash[1m]",
  "rules": [
    { "id": "code", "priority": 10, "when": { "taskType": "code" }, "model": "zai-coding-cn/glm-5.3" }
  ]
}
```

规则可带思考级别：`"thinkingLevel": "low"` 切换模型后自动应用（如 codex 低思考模式）。条件语法（`when`，全部字段 AND）：等值 / `in` 集合 / `gt`、`gte`、`lt`、`lte` / 布尔 `true`、`{ "not": true }` / `contains`、`not-contains`、`starts-with`。可用字段：`taskType`、`toolNames`、`contextTokens`、`messageCount`、`turnIndex`、`promptLength`、`hasImage`、`explicitModel`、`currentModel`、`thinkingLevel`、`prompt`。

## 开发

```bash
npm test              # node --test 引擎单测
npm run typecheck     # tsc --noEmit
```

**路由 Harness（e2e fallback 测试能力）**：`scripts/router-harness.ts` 直接驱动扩展、模拟 pi 事件链，本地秒级复现 401/402/403/429 quota 等场景，不依赖真实 LLM：

```bash
timeout 30 node --experimental-strip-types scripts/router-harness.ts        # 复现 429 → 秒切同类 → PASS
timeout 30 node --experimental-strip-types scripts/router-harness.ts pool-boundary  # 池外模型永不选中
```

## 致谢

- 路由决策模型提炼自 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)。
- 运行于 [earendil-works/pi](https://github.com/earendil-works/pi) 扩展 API。

## License

MIT
