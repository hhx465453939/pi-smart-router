# fallback 闭环 Debug 记录

## 元信息
- 模块名称: fallback / 失败恢复闭环（模型级联失败后的自动切换与重试驱动）
- 创建时间: 2026-09-04
- 最后更新: 2026-09-04
- 相关文件:
  - `src/index.ts`（`tryImmediateFallback` / `after_provider_response` / `message_end` / `tool_result` / `/router` 命令）
  - `src/engine/decision.ts`（`decide` / `fallbackAvailable` / `poolSweep` / `amnesty`）
  - `src/probe/availability.ts`（`AvailabilityProbe` / `PROBE_TTL`）
  - `src/engine/registry.ts`（`CooldownSet`）
  - `src/engine/planner.ts`（`createExecutionPlan` / `pickAvailableModel`）
  - `src/commands/router.ts`（`formatStatus` / `RouterCommandDeps`）
  - `src/hooks/agent.ts`、`src/hooks/provider.ts`、`src/hooks/failure.ts`
- 依赖模块: `engine/profile`（rankModels）、`engine/difficulty`、`catalog`、`selflearn`、`config`
- 长期回归资产（临时复现脚本已删除并折进这两处）:
  - `test/decision-recovery.test.ts` —— 决策层 L3/L3b/赦免/闭环不变量
  - `test/probe.test.ts`、`test/probe-guard.test.ts` —— probe TTL、自愈、排除期不回选
  - `scripts/router-harness.ts` 的 `cascade` / `dup-injection-guard` 场景 —— 事件链 L1/L2
- 开发/部署文档路径: `README.md`（功能总览 / 快速开始 / 失败闭环 / 命令清单）；`docs/` 目前为空目录

## 运行上下文与测试规则
- 运行环境: 本机 Linux 服务器（`/home/shpc_101170`），非远程/NAS
- 仓库路径: `/home/shpc_101170/Development/pi-smart-router`（开发真源，git remote = GitHub）
- **实际生效路径**: pi 通过 `settings.json` 的 `packages: ["git:github.com/hhx465453939/pi-smart-router"]`
  安装到 `~/.pi/agent/git/github.com/hhx465453939/pi-smart-router/`。
  ⚠️ 该副本与开发仓库是**两份工作树**；改开发仓库不会影响正在跑的 pi，必须 push 后由 pi 侧更新 + `/reload`。
- ⚠️ **pi 进程内存缓存**: 扩展代码在 pi 启动/`/reload` 时载入内存。实测 2026-09-04 存在已运行 1 天 5 小时的
  pi 进程（PID 3610009），其内存中仍是 8/29 之前的旧代码 —— 表现为线上日志出现仓库 HEAD 已删除的旧文案
  「同一指令已自动重试过一次，不再重复注入…」。判断"修复是否生效"时必须先确认 pi 已 `/reload`，
  否则会误判为"修了没用"。
- 验证/Checkfix 执行方式（全部在开发仓库内，不打扰运行中的 pi）:
  ```bash
  cd /home/shpc_101170/Development/pi-smart-router
  npm test                       # node --experimental-strip-types --test test/*.test.ts
  npm run typecheck              # tsc --noEmit
  # harness 五场景（node 或 bun 均可；任一断言失败 → 退出码 1）
  for s in quota-rule-loop no-channel-503 dup-injection-guard cascade pool-boundary; do
    timeout 40 node --experimental-strip-types scripts/router-harness.ts "$s"; echo "$s EXIT=$?"
  done
  ```
- 主人明确要求：**不动正在使用的 pi agent**，只在开发仓库改+测，完成后 commit push。

## 上下文关系网络

### 两条互不相通的选型链路（问题根源所在）

```
【主动链路】每个 turn 开始时选模型
before_agent_start ─→ resolveTurnDecision(hooks/agent.ts)
                        └─→ decide(engine/decision.ts)
                              候选宇宙 = explicit > rule > selfLearn > learn > sticky
                                        > defaultModel > {defaultModel ∪ fallback.models}
                              ⚠️ pool 只作为【过滤器】(L86-89)，从不作为【候选来源】
                        └─→ pi.setModel()

before_provider_request ─→ resolveProviderDecision(hooks/provider.ts) ─→ 同一个 decide()

【被动链路】模型调用失败后抢救
after_provider_response (401/402/403, 429×2) ─┐
message_end (stopReason=error 正则分类)      ─┼─→ tryImmediateFallback(index.ts)
tool_result (AccountQuotaExceeded)           ─┘        ├─ availableSelectors ∩ pool ∩ probe.filterAvailable
                                                       ├─ 排除 cooldowns + recentFallbackFails
                                                       ├─ rankModels 排序 + 同家族优先
                                                       ├─ pi.setModel(next)
                                                       └─ pi.sendUserMessage(prompt) ← 唯一驱动新 turn 的手段
```

**两条链路的候选宇宙不一致**：被动链路能看到整个池（28 个模型），主动链路只能看到
`defaultModel + fallback.models`（部署配置里只有 1 + 3 = 4 个）。这是"切几次就卡死"的结构性原因。

### 失败状态的两个存储
- `CooldownSet`（engine/registry.ts）：带 `until` 时间戳，**会自动过期**。
- `AvailabilityProbe.snapshot`：**无时间概念**，`markAuthFailure` 写入 `"unavailable"` 后
  `markAvailable` 明确拒绝覆盖（`if (snapshot[s] !== "unavailable")`）→ 本 session 不可逆。
- 两者都会阻断选型，但只有前者会自愈。`/router clear-cooldown` 只清前者。

## Debug 历史

### [2026-09-04] 连续切模型失败后 router 停摆 —— 系统性闭环缺失

#### 问题描述
主人报告两类现象：
1. 火山区 `dsv4flash` 套餐无额度时，"一直重试三次卡住了"。
2. 某几个模型连续 4xx 快速切换后，router 就停下来了，不再工作。
3. 补充实时日志：`opencode-go/gpt-5.6-luna` 额度耗尽 → 秒切 `shudie/gpt-5.6-luna` 并重试 →
   `shudie/gpt-5.6-luna` 也额度耗尽 → 提示"请手动重发指令" → **同一个 shudie 模型继续反复失败**
   （第三次 quota exceeded + 一次 403）→ 主人只能手动把模型从 pool 里移除才能恢复。

git log 显示同类问题已被"critical 修复"三次（`00801d3` 重复注入、`f5d4df0` 429 秒切失效、
`e7b8e4c` 崩壳包装），每次都只堵住一个触发点，复发不断 → 判定为**系统性架构缺陷**而非单点 bug。

#### 根因定位（三层断链，均已实测取证）

**L1 — 重试驱动断链：切了模型但不驱动 turn（`src/index.ts:229-233`）**
```ts
const tries = recentFallbackTries.get(promptHash) ?? 0;
if (tries >= 1) {
  ctx.ui.notify(`…请直接手动重发`, "info");
  return true;            // ← 切了模型，但不再 sendUserMessage
}
```
同一条 prompt 只允许自动重试 **1 次**。第 2 个模型失败后，router 把模型切走了却不再驱动新 turn，
对话直接停在那里等用户手动重发 —— 这就是"router 停下来了"。

实测（`scripts/repro-cascade-stall.ts`，跑在当前 HEAD e7b8e4c 上）：
```
[失败1] volces 额度耗尽 → 模型 = opencode/deepseek-v4-flash      | 注入次数 = 1
[失败2] 403 套餐失效   → 模型 = shudie/deepseek-v4-flash-0731    | 注入次数 = 1  ← 停在这里
[失败3] 503 无通道     → 模型 = zai/glm-5.3                      | 注入次数 = 1
[失败4] 429 限流       → 模型 = opencode/minimax-m3              | 注入次数 = 1
自动重试注入总次数 = 1（级联 4 次失败，闭环应 ≈4）
```
模型切换 4 次全对，重试驱动只有 1 次 → 第 2 次起彻底停摆。

**这个 `tries>=1` 是 `00801d3` 为修"重复指令堆积"而加的**。当时结论是
「pi 没有无痕重试 API，`sendUserMessage` 是唯一触发新 turn 的方式，且必然持久化为用户消息」，
于是在"堆积重复消息"和"闭环重试"之间选择了前者，把闭环砍掉。
**该前提不成立**：`pi.sendMessage({customType, content, display}, {triggerTurn:true, deliverAs:"followUp"})`
可以注入 **custom message** —— 参与 LLM 上下文、能驱动新 turn，但**不是用户消息**，不会堆积重复指令
（见 `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1397-1419`）。
两者本可兼得，不必二选一。

**L2 — 排除不可逆且无终态（`src/probe/availability.ts:115-122`）**
```ts
markAuthFailure(selector) { this.snapshot[selector] = "unavailable"; }   // 无 TTL
markAvailable(selector)  { if (this.snapshot[selector] !== "unavailable") … }  // 明确拒绝解除
```
实测（`scripts/repro-exhaustion.ts`）：
```
markAuthFailure 后调 markAvailable → 状态 = unavailable   ❌ 不可逆
冷却已过期 isCooldown = false，但 decide() selector = undefined（probe 仍拉黑 → 选不回来）
/router clear-cooldown（index.ts:950-960）只调 cooldowns.clear()，不碰 probe.snapshot
→ 用户没有任何命令能解除永久拉黑，唯一解法是重启 pi
```
后果：一次瞬时 403（聚合网关抖动很常见）就把该模型本 session 判死；级联打穿池子后
router 对整个 session 永久失能。且候选耗尽时 `tryImmediateFallback` 只
`ctx.ui.notify("无可用模型可 fallback")` + `return false`（`index.ts:168-171`），
**把已死模型留在原位** —— 正是主人日志里 shudie 被"excluded"后仍反复失败的原因。
无赦免、无降级、无恢复。

**L3 — 主动决策盲区：pool 是过滤器不是来源（`src/engine/decision.ts`）**
实测同一脚本：
```
场景：规则目标 + fallback 链 3 个模型全部 probe 拉黑 + 1h 冷却，池内另有 4 个完全健康模型
decide() 返回 selector = "volces/deepseek-v4-flash[1m]"      ← 已死模型本身！
reason = rule "huge-context" hit → "…" (cooling, no fallback)
```
`decision.ts:142-146` 在"规则目标冷却中且无 fallback"时，**直接把冷却中/已拉黑的模型返回**，
且该分支不查 `probeOk`。`f5d4df0` 声称"probe 排除未覆盖全部选型路径"已修，但漏了这条。

即便把 `availableModels` 正确过滤掉死模型（真实钩子路径就是这样）：
```
传入 availableModels = 4 个健康模型
decide() 返回 selector = undefined
reason = rule "huge-context" hit but model "…" unavailable/cooling
→ undefined = 保持当前模型。若当前正是死模型 → 每轮撞墙，永不恢复
```
根因：`decide()` 的兜底宇宙恒等于 `defaultModel ∪ fallback.models`（`planner.ts:68`），
部署配置里只有 4 个；池内其余 24 个健康模型**永远不会被主动链路当作兜底来源**。

#### 结论
不是单点 bug，是**闭环三处同时断开**：驱动断（L1）、状态不可逆且无终态（L2）、主动选型无兜底（L3）。
任何一处不修，级联失败都能让 router 停摆。三次"critical 修复"都在补触发点（429/5xx/崩溃），
没有一处补闭环本身，所以持续复发。

#### 解决方案
见下方各次变更记录。核心四条：
1. 用 custom message + `triggerTurn` 驱动重试 → 链路可持续推进且不堆积用户指令（解 L1）
2. probe 排除加 TTL + 成功响应自愈 + `/router clear` 连带清除（解 L2 不可逆）
3. 候选耗尽时按剩余冷却最短做**赦免**，仍无解才进终态并给出可执行指引（解 L2 无终态）
4. `decide()` 加统一 `usable()` 门禁 + **池内兜底扫描**，pool 升级为候选来源（解 L3）

#### 变更与验证（2026-09-04 落地）

**代码变更**

| 文件 | 变更 |
|---|---|
| `src/probe/availability.ts` | 排除改为带 TTL 的 `marks: Map<selector,{state,until,reason}>`；新增 `PROBE_TTL`（auth/quota 6h、noChannel 1h、server 10min、network 5min）、`markUnavailable(sel,ttl,reason)`、`excluded()`（按 until 升序 + remainingMs）、`clear()/clearAll()`；`markAvailable()` 改为**无条件清除排除**（唯一权威自愈出口）；key 统一 trim+lowercase |
| `src/engine/registry.ts` | `CooldownSet.remainingMs(sel)` —— 赦免排序需要"谁最先恢复" |
| `src/engine/decision.ts` | 统一 `usable()` 门禁（候选集内 + 未冷却 + probe 未排除）贯穿**全部** return 路径；新增 `orderedUniverse()`（defaultModel → fallback.models → 池内其余，pool 升级为候选来源）、`poolSweep()`（池内兜底扫描，缓存感知排序）、`amnesty()`（全灭赦免最先恢复者，**跳过 current** 防原地对撞）、`unusableWhy()`（终态 reason 点明死因）；`RouteDecision.source` 扩为 `pool-sweep`/`amnesty` |
| `src/engine/planner.ts` | `pickAvailableModel()` 增 `extraOk` 回调，让 fallback 链也走 probe 门禁 |
| `src/index.ts` | 重试驱动换 custom message（ADR-1）；`MAX_CHAIN_ATTEMPTS=8` 链路预算取代"同 prompt 只重试 1 次"；`fallbackChain` promise 串行队列 + 5s 失败事件去重（解双钩子竞态 D5）；全灭赦免（每 prompt 一次）+ `notifyTerminal()` 终态指引；四处失败标记按类型给差异化 TTL；`message_end` 成功路径 `markAvailable` + `cooldowns.clear` 自愈；`before_agent_start` 仅在 prompt 非空时更新 `lastPromptText`（重试 turn 的 prompt 为空，旧写法会把 promptHash 冲成 `""` 导致预算失效）；`/router probe`、`/router clear`、`/router help` 文案与行为同步 |
| `src/commands/router.ts` | `RouterCommandDeps.getExcluded?()` + `/router status` 新增 `excluded` 段（排除表现在是路由门禁，排障必须一眼可见） |
| `src/hooks/failure.ts` | 导出 `parseQuotaResetMs()`，供 index.ts 把 probe TTL 对齐真实额度重置时间 |

**验证证据（Debug-Checkfix 闭环）**

- `npm run typecheck` → EXIT=0
- `npm test` → **206 tests / 50 suites / 0 fail**（改动前基线 189/47；本轮 +11 为 `test/decision-recovery.test.ts`，+6 为 probe TTL/自愈用例）
- 新增 `test/decision-recovery.test.ts`：池内兜底（L3）、候选集只含池内健康模型（L3b）、TTL 到期恢复、赦免选中最先恢复者、**赦免跳过 current**、候选宇宙只剩 current 时终态 reason 不得伪装成正常 keep，以及 4 个场景的「decide 永不返回不可用模型」不变量
- `test/probe.test.ts` / `test/probe-guard.test.ts`：删除两个把 bug 编码成断言的用例（`markAvailable does not override unavailable`、`unavailable 标记本 session 不可逆`），换成自愈/TTL 到期恢复用例
- `scripts/router-harness.ts` 五场景全绿（node 与 bun 均验证），断言失败以退出码 1 结束：
  - `cascade`（用户真实故障）：4 次连续失败 → **4 次重试驱动**、模型轨迹 volces → opencode → shudie → zai → minimax-m3，**访问 5 次 / 不同 5 个**（一路向前不回头撞死模型）、伪造用户消息 **0 次**、链路预算显示 `[2/8] [3/8] [4/8]`
  - `dup-injection-guard`：4 个钩子触发同一失败 → 伪造用户消息 0 次、同一故障模型无重复驱动
  - `no-channel-503` / `quota-rule-loop` / `pool-boundary`：秒切 + 排除 + `triggerTurn=true` 驱动
- 对比修复前：`cascade` 场景在第 2 次失败后驱动数即停在 1（旧实现的停摆点），死模型被留在原位

**测试产物与残留清扫（T1/T3）**

- 删除本轮临时取证脚本 `scripts/repro-exhaustion.ts`、`scripts/repro-cascade-stall.ts`：场景已分别折进 `test/decision-recovery.test.ts`（决策层）与 harness `cascade`（事件链）。两脚本内含修复前的过时判定文案（如"probe 仍拉黑 → 依然选不回来"、"`/router clear-cooldown` 不碰 probe"），留在仓库会误导后续排查
- 仓库内无测试生成物残留（catalogPath 等均指向 `/tmp`）；本轮 diff 新增的 `console.log` 全部位于 harness（CLI 诊断脚本的正常输出）或 `cfg.verbose` 守卫内，无 `debugger`/TODO/FIXME/注释掉的旧实现

**文档同步**

- `README.md`：「无痛秒切 fallback」整节重写为闭环流程图 + 差异化 TTL 时长表 + 自愈说明；可用性探测第 ③ 层改为"带 TTL 排除"；`/router probe`、`/router clear` 命令说明更新；Harness 段列出全部 5 个场景
- `src/index.ts` 内 `/router help` 文案同步（删除已失效的"排除至下次会话"）

## 待追踪问题
- 部署副本 `~/.pi/agent/git/github.com/hhx465453939/pi-smart-router/` 需 push 后更新 + `/reload` 才生效；
  主人当前有长寿命 pi 进程在跑，更新时机由主人决定。
- 长寿命 pi 进程内存中的旧代码会让"修复无效"的假象反复出现，后续排查先确认 `/reload`。
- **tool_result 失败归因可能错位（本轮发现，刻意未改）**：`tool_result` 钩子用 `currentModelSelector()` 归因，
  而秒切是同步完成的 —— 若一条属于**旧模型**的 tool_result 错误在切换之后才到达，会被算到**新模型**头上，
  多排除一个健康模型并多消耗一次链路预算。
  - 为什么这次不动：正确的修法是记录"本轮起始模型"（`before_agent_start` 时快照）并按它归因，
    但前提是重试 turn（`deliverAs:"followUp"` 的 custom message）确实会触发 `before_agent_start`；
    pi 文档只说该钩子"Fired after user submits prompt"，followUp 驱动的空 prompt turn 是否触发未经证实。
    若它不触发，快照会一直停在死模型上，反而让每次 tool_result 失败都重复归因给已排除的模型 —— 比现状更糟。
    主人有生产 pi 进程在跑，不能靠试错验证，故先记录不盲改。
  - 影响面已被兜住：多排除的模型有 TTL、会被成功调用自愈、可 `/router clear`；链路预算 8 次 + 全灭赦免 +
    终态指引保证最坏情况是"多切一次"而不是停摆。harness `dup-injection-guard` 场景已把这个行为显式记录在注释里，
    不会被误当成预期正确语义。
  - 后续验证步骤：在**空闲**的 pi 会话里发一条 custom message（`triggerTurn:true, deliverAs:"followUp"`），
    观察 `before_agent_start` 是否被触发（可在钩子里打 verbose 日志）。确认触发后再改为按轮起始模型归因。

## 技术债务记录
- `decide()` 有 10+ 个 return 点，每个都各自实现一遍可用性判断，已经漏过两次（`f5d4df0` 与本次）。
  本次引入统一 `usable()` 门禁收敛，但仍建议后续把 `decide()` 重构为"生成候选 → 统一过滤 → 排序取首"
  的单管道结构，彻底消除分支间语义漂移。
- `scripts/router-harness.ts` 未导出 `Harness` 类，因此无法被 `node --test` 直接复用，只能作为独立脚本跑。
  本轮已偿还的部分：临时复现脚本（各自重写一份 mock ctx）已删除并折进 harness 场景，配置写入抽成 `installConfig()`、
  断言抽成 `check()`（失败累加 → 退出码 1，可挂 CI）、异步排空抽成 `settle()`。
  仍建议后续把 `Harness` 导出并在 `test/` 下加一个 e2e 用例，让它进 `npm test` 而不是靠人记得手动跑。
- `lastPromptText` 为空时 `promptHash` 为 `""`，所有 prompt 共用一个 key（本次已改为不依赖 prompt 文本驱动重试，
  影响面收窄，但计数 key 仍值得后续换成 turnId）。

## 架构决策记录
- **ADR-1 重试驱动用 custom message 而非 user message**
  `sendUserMessage` 必然持久化为用户消息，链式推进 N 次就堆积 N 条重复指令（`00801d3` 的原始病症）。
  `sendMessage({customType:"pi-smart-router-retry"}, {triggerTurn:true, deliverAs:"followUp"})`
  同样能驱动新 turn 且参与 LLM 上下文，但语义上是 router 自己的消息，不污染用户指令流。
  重试内容也不再复读原始 prompt（原始 user 消息本就在上下文里），只告知"上一个模型不可用、已切换、请继续"，
  上下文成本近乎为零。
- **ADR-2 排除必须可逆**
  "本 session 永久拉黑"的设计前提是"失败原因在 session 内不会消失"，但额度会重置、网关 403 会恢复、
  网络会通。不可逆排除 + 无赦免 = 级联失败后整个 session 报废。改为 TTL + 成功自愈 + 手动清除三重出口。
- **ADR-3 pool 既是边界也是兜底来源**
  pool 原本只做过滤（"自动路由的硬边界"），导致主动链路的候选宇宙与用户实际圈定的池严重脱节。
  升级为：池内过滤照旧，但在所有优先路径失败后，池本身就是最后兜底候选集。
  例外：用户手动选了池外模型时不做强拉回，尊重手动意志。
