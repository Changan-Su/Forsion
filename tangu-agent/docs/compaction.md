# 上下文压缩(compaction)

2026-09-15 对标 pi-mono / Codex CLI 重做。代码:`src/services/compaction.ts`(摘要 / 转写 / 检查点)、`src/services/compactionSettings.ts`(旋钮)、`src/services/contextBudget.ts`(触发线)、`src/services/agentLoop.ts`(何时压、何时落库)、`src/services/historyReplay.ts`(`dropCoveredCalls`,行内切点回放)。

## 机制

| 环节 | 做法 |
|---|---|
| 触发线 | `窗口 − max(reserveTokens, 5% 窗口)`,且不低于窗口一半。272k 窗缺省 255.6k;200k → 183.6k;1M → 950k。每轮调用模型前按「上次实测 prompt_tokens + 新增消息粗估」判;run 首轮没有实测时把工具定义头也粗估进去。 |
| 压什么 | 从最新往回累计到 `keepRecentTokens`(缺省 20k)原样保留,其余总结成一条 system 摘要;工具调用与结果批次绝不拆开;对话以一批工具结果收尾时退到发起它们的 assistant。有 provider 实测时按 实测/(粗估+工具头) 的比例换算预算(截图按定额估、实测十几万那类;纯粗估不冒充实测);越线已成立,按估算全装得下也强制压一次 → 只保留最后一条(或最后一批)。 |
| 摘要请求 | 先 resolve 摘要模型(可换便宜模型),按它**自己**的窗口算预算:输出上限 = min(summaryMaxTokens, 有效预留/2, 窗口/4),输入预算 = 触发线 − 输出上限 − 开销。结构化交接(Goal 段逐字引用用户当前请求 / Done / In progress·Next steps / Facts)+ 增量 PRESERVE/UPDATE 附注;转写为 pi 式行格式(`[User]` / `[Assistant]` / `[Assistant tool calls] name(args…)` / `[Tool result: name]` 头 3000 尾 1000 字符),`[Existing Summary]` 永不截,超预算从最旧条目丢并留标记(最后一条自己超预算则按头尾截)。文件操作清单机械提取、跨压缩单调累积。 |
| 持久化 | 摘要落 `session_summaries`:`through_timestamp` + `through_message_id` = 边界行(**按 id 认**:严格早于它的行被覆盖;与它同一毫秒的邻行原样回放 —— 时间戳不是全序,重复安全、吞掉才丢数据;时间戳缺失的行一律回放);`through_tool_call_id` 表示**行内切点**(该行只覆盖到这个调用,其后的工具轮原样回放)。run 内总结覆盖到尚未落库的助手段 → 等该段 finalize(收尾 / 中止落半截 / steer 拆段)后读回时间戳再落。切点 id 在行里对不上或出现 ≠1 次 → 该行整体回放。边界只前进:整行 > 靠后的切点 > 靠前的切点。范围里有**有损消息**(机械折叠过 / hydrate 按 100k 硬帽截过)→ 摘要只留 run 内存,不落检查点。 |
| 溢出重试 | 上游 400/413「输入超窗口」(`contextWindowStore.isContextOverflowError`,措辞表借 pi)→ 强制压缩一次后重进本轮,每 run 一次;真实上限同时回学进 `context-windows.json`。 |
| 惰性检查点 | run 收尾后,下个 run 的 hydrate 窗口(最近 50 行,10 行块对齐)之外若还有未被覆盖的老行 → fire-and-forget 做一份持久摘要(增量)。**下个 run hydrate 前先等在飞的这份落库**(上限 45s);hydrate 读到的检查点若没覆盖到窗口起点,窗口再往前扩到覆盖处(最多 +100 行)—— 宁可多回放,不静默丢。摘要期间历史被删改(删消息 / 编辑重发 / 删会话都 bump `historyRevision`)→ 结果作废不落库。 |
| 手动 `/compact [关注点]` | 总结到最后一行;转写与自动压缩同一份(工具调用/结果都进摘要输入;超 100k 硬帽的行读原文);关注点追加为 `Additional focus`(一次性)。旋钮同自动压缩(会话 agent_config > Agent `[compaction]` > config.json)。TUI / 桌面 / `POST /agent/sessions/:id/compact { instructions }` 三处都收;会话有在飞 run 时 409。 |
| 兜底 | 摘要失败 → `compactContext` 机械折叠(状态事件如实标 `fallback:true`);PreCompact hook 可否决;`compaction.enabled=false` 只关 LLM 摘要,越线 / 溢出仍走机械折叠。 |

09-15 之前:自动压缩只活在 run 内存里(下个 run 把整段原样回放再总结一遍)、50% 就开始机械折叠(每轮改写、前缀缓存逐轮断)、摘要 1200 token、按「最近 12 条」切、上游拒收即 run 失败、什么都不可配。

## 旋钮

三层,前者压过后者:run 级 `agentConfig.compaction`(会话;Agent 文件夹 `config.toml` 的 `[compaction]` 表由 agentActivation 并入)→ `~/.tangu/config.json` 的 `compaction` 段 → 缺省。每层逐字段归一化,非法字段各自丢弃。

| 字段 | 缺省 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不做 LLM 摘要(满载仍走机械折叠兜底,溢出照报错) |
| `reserveTokens` | `16384` | 触发线 = 窗口 − max(此值, 5% 窗口);范围 2048–200000 |
| `keepRecentTokens` | `20000` | 压缩后原样保留的最近上下文(token);0–500000 |
| `summaryMaxTokens` | `6144` | 摘要输出上限;另受 reserveTokens/2 封顶;512–32000 |
| `thinking` | `"off"` | 摘要调用的思考档:`off` / `minimal` … `max` / `inherit`(跟随本 run) |
| `model` | (本 run 模型) | 摘要改用另一个(更便宜的)模型 id |
| `instructions` | — | 持久的 `Additional focus`(≤ 4000 字符) |
| `prompt` | — | 整体替换内置摘要指令(Codex `compact_prompt`);增量附注照加 |

```json
// ~/.tangu/config.json
{ "compaction": { "reserveTokens": 24000, "keepRecentTokens": 30000, "thinking": "low" } }
```

```toml
# ~/.tangu/agents/<slug>/config.toml
[compaction]
keepRecentTokens = 40000
instructions = "always keep ticket ids and the failing test names"
```

窗口本身另有一套:`modelOverrides.<id>.contextWindow` / 环境变量 `TANGU_MODEL_CONTEXT_WINDOWS` / 上游回学 / 族表(见 `contextBudget.ts` 头注)。

## 事件

`status` 事件:`compacting`(`reason: threshold|overflow`)→ `compacted`(`persisted` 是否已落检查点;`fallback:true` = 机械折叠)→ `compaction_budget`(前后 token);`compaction_skipped`(hook 否决);`context_info` 带 `compactAt` / `compactionEnabled`。摘要调用的用量走 `phase: 'compaction'` 的 usage 事件(无 run 上下文的手动 / 惰性路径不上台账)。

## 仪器

- 单测:`src/services/compaction*.test.ts`、`contextBudget.test.ts`、`historyReplay.test.ts`(`dropCoveredCalls`)、`contextWindowStore.test.ts`(溢出判别);`test/agentLoopCompaction.test.ts`(真 SQLite + fake llm 驱动主 loop:行内切点落库与回放、溢出重试、惰性检查点、检查点没覆盖到窗口起点时的窗口前扩)。
- 真模型:`npm run live:harness -- --only compact`(手动)与 `--only autocompact --window 32000`(把台架模型窗口钉小灌满:两个 run 各压一次并落库、第三个 run 从两次链式摘要里答出标记、主循环 prompt 变小)。

## 已知边界

- 行的先后按 `chat_messages.timestamp`(ms)判、边界行按 id 认:同一毫秒的邻行只会**多回放**(重复安全),不会被吞。
- thin worker(httpStateStore,无本地库):`session_summaries` 读写与行时间戳回读都走本地 `query()` → 检查点整套不落(fail-safe,行为同改前:仍按最近 50 行窗口回放)。要在云端启用得把 summary CRUD 收进 StateStore / HTTP 接缝(未做)。
- 图片只在转写里留占位;模型无原生视觉时历史图片本就已转文字。
- 手动 `/compact` 路由没有 run 上下文,不触发 PreCompact hook。
- `historyRevision` 是进程内计数:删改与摘要在同一引擎进程里才互斥(桌面 / TUI / standalone 都是)。
