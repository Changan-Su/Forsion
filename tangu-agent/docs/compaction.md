# 上下文压缩(compaction)

2026-09-15 对标 pi-mono / Codex CLI 重做。代码:`src/services/compaction.ts`(摘要 / 转写 / 检查点)、`src/services/compactionSettings.ts`(旋钮)、`src/services/contextBudget.ts`(触发线)、`src/services/agentLoop.ts`(何时压、何时落库)、`src/services/historyReplay.ts`(`dropCoveredCalls`,行内切点回放)。

## 机制

| 环节 | 做法 |
|---|---|
| 触发线 | `窗口 − max(reserveTokens, 5% 窗口)`,且不低于窗口一半。272k 窗缺省 255.6k;200k → 183.6k;1M(手动开启后)→ 950k。窗口指 run 实际用的窗口:09-22 起自动识别的一律封顶 272k(见下「窗口」)。每轮调用模型前按「上次实测 prompt_tokens + 新增消息粗估」判;run 首轮没有实测时把工具定义头也粗估进去。**`thresholdPercent`(09-20)只会把线往下拉**:`min(上式, max(窗口 × X%, 2 × keepRecentTokens + 24k))` —— 缺省 95 对任何窗口都 ≥ 上式(行为不变);1M 窗调到 30 → 300k。地板(缺省 64k)= 压缩后的体量(固定头 ~16k + 摘要 ~6k + keepRecent)之上留一段余量,线低于它就每轮都压。 |
| 压什么 | 从最新往回累计到 `keepRecentTokens`(缺省 20k)原样保留,其余总结成一条 system 摘要;工具调用与结果批次绝不拆开;对话以一批工具结果收尾时退到发起它们的 assistant。有 provider 实测时按 实测/(粗估+工具头) 的比例换算预算(截图按定额估、实测十几万那类;纯粗估不冒充实测);越线已成立,按估算全装得下也强制压一次 → 只保留最后一条(或最后一批)。 |
| 摘要请求 | 先 resolve 摘要模型(可换便宜模型),按它**自己**的窗口算预算:输出上限 = min(summaryMaxTokens, 有效预留/2, 窗口/4),输入预算 = 触发线 − 输出上限 − 开销。结构化交接(Goal 段逐字引用用户当前请求 / Done / In progress·Next steps / Facts)+ 增量 PRESERVE/UPDATE 附注;转写为 pi 式行格式(`[User]` / `[Assistant]` / `[Assistant tool calls] name(args…)` / `[Tool result: name]` 头 3000 尾 1000 字符),`[Existing Summary]` 永不截,超预算从最旧条目丢并留标记(最后一条自己超预算则按头尾截)。文件操作清单机械提取、跨压缩单调累积。 |
| 持久化 | 摘要落 `session_summaries`:`through_timestamp` + `through_message_id` = 边界行(**按 id 认**:严格早于它的行被覆盖;与它同一毫秒的邻行原样回放 —— 时间戳不是全序,重复安全、吞掉才丢数据;时间戳缺失的行一律回放);`through_tool_call_id` 表示**行内切点**(该行只覆盖到这个调用,其后的工具轮原样回放)。run 内总结覆盖到尚未落库的助手段 → 等该段 finalize(收尾 / 中止落半截 / steer 拆段)后读回时间戳再落。切点 id 在行里对不上或出现 ≠1 次 → 该行整体回放。边界只前进:整行 > 靠后的切点 > 靠前的切点。范围里有**有损消息**(机械折叠过 / hydrate 按 100k 硬帽截过)→ 摘要只留 run 内存,不落检查点。 |
| 溢出重试 | 上游 400/413「输入超窗口」(`contextWindowStore.isContextOverflowError`,措辞表借 pi)→ 强制压缩一次后重进本轮,每 run 一次;真实上限同时回学进 `context-windows.json`。 |
| 惰性检查点 | run 收尾后,下个 run 的 hydrate 窗口(最近 50 行,10 行块对齐)之外若还有未被覆盖的老行 → fire-and-forget 做一份持久摘要(增量)。**下个 run hydrate 前先等在飞的这份落库**(上限 45s);hydrate 读到的检查点若没覆盖到窗口起点,窗口再往前扩到覆盖处(最多 +100 行)—— 宁可多回放,不静默丢。摘要期间历史被删改(删消息 / 编辑重发 / 删会话都 bump `historyRevision`)→ 结果作废不落库。 |
| 手动 `/compact [关注点]` | 总结到最后一行;转写与自动压缩同一份(工具调用/结果都进摘要输入;超 100k 硬帽的行读原文);关注点追加为 `Additional focus`(一次性)。旋钮同自动压缩(会话 agent_config > Agent `[compaction]` > config.json)。TUI / 桌面 / `POST /agent/sessions/:id/compact { instructions }` 三处都收;会话有在飞 run 时 409。 |
| 兜底 | 摘要失败 → `compactContext` 机械折叠(状态事件如实标 `fallback:true`);PreCompact hook 可否决;`compaction.enabled=false` 只关 LLM 摘要,越线 / 溢出仍走机械折叠。 |

09-15 之前:自动压缩只活在 run 内存里(下个 run 把整段原样回放再总结一遍)、50% 就开始机械折叠(每轮改写、前缀缓存逐轮断)、摘要 1200 token、按「最近 12 条」切、上游拒收即 run 失败、什么都不可配。

## 旋钮

三层,前者压过后者:run 级 `agentConfig.compaction`(会话;Agent 文件夹 `config.toml` 的 `[compaction]` 表由 agentActivation 并入)→ config.json 的 `compaction` 段 → 缺省。每层逐字段归一化,非法字段各自丢弃。config.json 住**共享域**(`tanguHome.configFile()`:桌面托管形态 = `~/.forsion/config.json`,即引擎 home 的父目录;纯 standalone = `~/.tangu/config.json`)。

全局层的读写口(设置页用):`GET /agent/compaction` → `{ settings, defaults, writable }`;`PUT /agent/compaction { thresholdPercent: 30 }`(某键给 `null` = 删掉交还缺省;不认识的键 400)。锁内读改写,段里手写的其它键原样保留;对下一个 run 生效,不用重启。云端 worker(hostExec=false)一律 404 —— 那里一个进程服务所有用户。

| 字段 | 缺省 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不做 LLM 摘要(满载仍走机械折叠兜底,溢出照报错) |
| `reserveTokens` | `16384` | 触发线 = 窗口 − max(此值, 5% 窗口);范围 2048–200000 |
| `thresholdPercent` | `95` | 上下文占到窗口的 X% 就压(与客户端进度环同一分母);10–95,只会把触发线往下拉。桌面「设置 → 模型 → 分组与显示 → 自动压缩阈值」写的就是全局层的这个字段 |
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
09-22 起 run 用 `effectiveContextWindowInfo`(对标 Codex 目录的 `context_window` 272k / `max_context_window` 分离):**自动识别**出的窗口(模型自报 / 回学 / 族表 / 兜底)封顶 `CONTEXT_WINDOW_TOKENS`(272k,env `TANGU_CONTEXT_WINDOW_TOKENS` 同调兜底与上限);**人填的覆盖**(`modelOverrides` / env 表)不封顶 —— 桌面聊天框模型菜单的「上下文上限」与设置页窗口输入框写的都是 `modelOverrides`。`context_info` 多带 `ctxWindowMax`(封顶前的模型窗口),`/agent/models` 多带 `maxContextWindow` 与顶层 `contextWindowCap` / `modelOverridesWritable`(= PUT 覆盖的 hostExec 门,模型菜单据此露不露开关)。Historian fork 判官与自我脑暴分身的超窗护栏也按会话实际窗口算(它们是本会话的请求)。摘要目标(`resolveSummaryTarget` 换了摘要模型时)仍按未封顶的 `modelContextWindow` 算:它问的是摘要模型吃得下多少。

## 事件

**进度环在压缩之后读什么**(09-20 反馈「压缩完进度圈不更新,要发新消息才更新」)。环的缺省来源是「最近一条主循环 usage 的 prompt」,而三条压缩路径里只有 run 内那条之后才有 usage,还得等那次调用整轮跑完:

| 路径 | 环上的数从哪来 |
|---|---|
| 手动 `/compact` | 响应里的 `contextTokens`(摘要粗估 + 上次实测的固定头),客户端就地写进环;重开应用走 `GET /usage`,同一个函数 `sessionContextTokens`(`routes/sessions.ts`):检查点**整行覆盖到最后一行**时报这个粗估,否则报实测 |
| run 内自动压缩 | 紧跟 `compacted` 的 `compaction_budget.afterTokens`(`changed:false` 不动),下一条 usage 用实测校正。live:估 13379 → 实测 12722 |
| run 收尾的惰性检查点 | 不动:它只盖 hydrate 窗口之外的老行,窗口内照样回放,上一条实测 prompt 仍是最好的估计。⚠️ 别把 `/usage` 的判据放宽成「检查点比 usage 新」—— 惰性检查点也满足,粗估会把 30 万报成 1 万 |

`status` 事件:`compacting`(`reason: threshold|overflow`)→ `compacted`(`persisted` 是否已落检查点;`fallback:true` = 机械折叠)→ `compaction_budget`(前后 token);`compaction_skipped`(hook 否决);`context_info` 带 `compactAt` / `compactionEnabled`。摘要调用的用量走 `phase: 'compaction'` 的 usage 事件(无 run 上下文的手动 / 惰性路径不上台账)。

## 仪器

- 单测:`src/services/compaction*.test.ts`、`contextBudget.test.ts`、`historyReplay.test.ts`(`dropCoveredCalls`)、`contextWindowStore.test.ts`(溢出判别);`test/agentLoopCompaction.test.ts`(真 SQLite + fake llm 驱动主 loop:行内切点落库与回放、溢出重试、惰性检查点、检查点没覆盖到窗口起点时的窗口前扩)。
- 真模型:`npm run live:harness -- --only compact`(手动;连带钉 `GET /usage` 压缩前实测 → 压缩后粗估 → 下个 run 后回到实测)与 `--only autocompact --window 32000`(把台架模型窗口钉小灌满:两个 run 各压一次并落库、第三个 run 从两次链式摘要里答出标记、主循环 prompt 变小)。
- 百分比旋钮的真模型三跑(缺一不可):上面那条回归;正例 `--only autocompact --window 100000 --compaction '{"thresholdPercent":25,"keepRecentTokens":500}'`(`--compaction` 把 JSON 写进隔离共享域的 config.json;场景额外断言 `context_info.compactAt === 窗口 × X%`);负对照 `--only autocompact --window 100000 --filler <正例灌的段数>`(同一份输入、不带旋钮,线在 83.6k → **必须红**,0 次压缩)。09-20 grok-4.6:正例 ②31649 → ③12722,负对照 ②31524 → ③31553。⚠️ 单条消息超 100k 字符会被 hydrate 按硬帽截成 2.5k,灌不进上下文 —— 场景对段数有上限守卫。
- 导出的时间线(`GET /agent/sessions/:id/timeline`,反馈包里那份)的 status 行带 `ctxWindow / ctxWindowSource / compactAt / compactionEnabled` 与压缩事件的 `reason / persisted / fallback / summarized / beforeTokens / afterTokens`:「引擎当时认的窗口是多少、线在哪、压没压」直接读包,不用回后台反推。
- 桌面:`npm run e2e:ctxwindow`(真 Electron + 桩引擎;T10–T14 是设置页的自动压缩滑块,截图 `ctxwindow-4-autocompact.png`);`npm run e2e:ctxlimit`(聊天框模型菜单「上下文上限」:行位置 / PUT / 环弹层封顶说明 / 开到最大后环分母当场换)。
- 窗口封顶的真模型两跑(09-22,读隔离 state.db 的 `agent_run_events` 里 context_info):`TANGU_CONTEXT_WINDOW_TOKENS=100000 npm run live:harness -- --only chat`(台架模型族表 272k 被压到 100k:`100000 / family / max 272000 / compactAt 83616`);`--only chat --window 500000`(人填的覆盖不封顶:`500000 / override`)。

## 为什么有 thresholdPercent(09-20 生产反馈)

一条 GLM-5.3 会话的反馈包:主循环 prompt 一路涨到 387k、逐轮重读,40 个 run 里**零**压缩事件,7 次 `token_quota_exceeded`。取证:后台该模型 `context_window` 留空 → 族表 1M → 触发线 950k,按设计永远够不着;而跨 run 回放「最近 50 行」**按行不按 token**(一个 80 次工具调用的 run 只算一两行),惰性检查点只盖窗口外的行 —— 「50 行」与「950k」之间没有任何 token 界,一天就从 31k 涨回 387k。该会话 92% 的点数烧在输入上(缓存命中按 0.2 计仍占 76%,未命中 16%,输出 8%)。机制本身没坏(grok live 两场景全过),缺的是一个用户够得着的线。用户拍板做成设置里的百分比,缺省不变。

没做:hydrate 窗口改 token 预算(结构修);缺省值没有下调 —— 1M 模型的用户要自己把阈值调到 20–35,或由 admin 在模型上填实际窗口。

> 修订 09-22:缺省窗口已封顶 272k(用户拍板,对标 Codex),1M 族缺省触发线回到 255.6k,上面这条病根按缺省已解;「要自己调阈值」只对手动开到 1M 的用户还成立。反过来,之前把阈值调到 25–35% 的用户,分母从 1M 变成 272k 后线会落到地板附近(~64–95k),需要的话调回 95。

## 已知边界

- 行的先后按 `chat_messages.timestamp`(ms)判、边界行按 id 认:同一毫秒的邻行只会**多回放**(重复安全),不会被吞。
- thin worker(httpStateStore,无本地库):`session_summaries` 读写与行时间戳回读都走本地 `query()` → 检查点整套不落(fail-safe,行为同改前:仍按最近 50 行窗口回放)。要在云端启用得把 summary CRUD 收进 StateStore / HTTP 接缝(未做)。
- 图片只在转写里留占位;模型无原生视觉时历史图片本就已转文字。
- 手动 `/compact` 路由没有 run 上下文,不触发 PreCompact hook。
- `historyRevision` 是进程内计数:删改与摘要在同一引擎进程里才互斥(桌面 / TUI / standalone 都是)。
