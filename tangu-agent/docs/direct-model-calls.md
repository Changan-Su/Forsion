# 直接模型调用的思考档位

引擎里除了 agent 主循环，还有十几处「拼一份请求、调一次模型、拿结果」的直接调用（后台整理、判官、生成一句话之类）。这份文档列出每一处现在发的思考档位、为什么是这一档，以及新加一处时要注意什么。2026-10-06 逐处核对过代码，并用真模型（GPT 6 Luna）量过其中两处，数据见仓根 `harness-runs/2026-10-06/直接模型调用思考档位-核对与真模型验证汇总.md`。

## 先记住一条：不传就是关

`buildProviderPayload` 的 `thinkingLevel` 不传时，直连面（`llm/openaiCompat.ts` 的 `tuneOpenAiDirectPayload`）和托管面（server 的 `llmService`）都按 `'off'` 处理：

- 能关思考的模型，发出去的是明确的「不思考」（OpenAI 系是 `reasoning_effort: none`，Claude 是 `thinking: {type: 'disabled'}`，Qwen 是 `enable_thinking: false`）。不报错，用量里推理 token 是 0。
- 关不掉思考的模型（GPT-6 Astra、GPT-6.1 Sol、Opus 5.5、Sonnet 5.5 等，能力表里 `off: null`），落到它支持的最低一档。
- 能力表里没有登记的端点，什么字段都不发。

所以**新写一处直接调用时，要逐条判断、分类、合并、改写的，必须自己给档位**。档位一律走 `llm/modelCapabilities.ts` 的能力表夹到模型真支持的档上，调用方不用管各家的字段。

## 输出上限要跟着留

思考的 token 在多数供应方那里算在输出上限里（OpenAI 官方接口的 `max_output_tokens` / `max_completion_tokens`、Gemini、Claude 的自适应思考、DeepSeek）。开了思考而上限还按「只装正文」给，正文会被挤掉：Dream 见到截断直接判失败，判官的 JSON 解析不出来、这一轮的标题 / 摘要 / 候选全没了。

两个例外，都是今天的事实、不要当成约定：

- Codex 订阅端点不收输出上限（`llm/openaiResponses.ts` 只在非订阅账号时才发 `max_output_tokens`），所以在 `codex/*` 模型上量不出这个问题。
- Claude 的预算式思考由能力表把预算夹进上限里；上限不到 2048 时思考会被悄悄关掉（`applyThinking` 的 `anthropic-budget` 分支）。

### 这次开了思考的两处怎么留的

余量由 `llm/openaiCompat.ts` 的 `thinkingHeadroom(模型, 档位)` 统一给，调用点只写正文上限：

- 原生思考的端点（能力表里的 effort / 预算 / 开关各形态）：正文上限之外另留 4096。
- 档位只是一句系统提示的端点（`prefix`）和模型自带思考、不可调的端点（`none`）：不留。它们的推理量没有因为给了档位而变；其中的老模型输出上限往往只有 4096，多给会让原来能跑的调用直接被拒。
- 托管模型按 `model.defaultBaseUrl` 认端点（`resolveModelAndKey` 给的 `baseUrl` 是网关占位），和主循环算「实际生效档位」是同一个口径。

落到这两处：

- **Historian 独立判官**：正文上限 1600；原生思考的模型发出去是 5696。
- **Dream**：设置里的「最大输出 tokens」（缺省 4096）是两次调用的**正文**预算，提议 75%、核验 25%；原生思考的模型发出去是 7168 和 5120。

GPT 6 Luna 中档实测：判官一次调用的输出（含推理）最多 344 token，Dream 提议最多 739、核验最多 464，离上限都远。留 4096 是为推理量大得多的模型（DeepSeek 一类）准备的，没有在那些模型上量过。`thinkingHeadroom` 不认各模型自己的输出上限（能力表里没有这一项）；哪个原生思考的模型拒了这个上限，再按窗口的四分之一封顶（压缩摘要就是这么做的）。

没有原生思考的端点，档位只是系统提示里的一句「先想再答」，模型可能在 JSON 前后写几句话。判官的解析本来就只取最外层的花括号；Dream 的解析 2026-10-06 起也容得下对象前后的话，但只认**恰好一个**对象：外面还有花括号（多个对象，或者后一个被截断了）一律照旧判失败，结构仍由 `validateDreamProposal` 把关。

## 档位怎么选的（2026-10-06，GPT 6 Luna）

| | 关（改之前） | low | medium |
|---|---|---|---|
| 判官：agent 自己总结的做法有没有被提名（`refine`，每档 3 次） | 0 / 3 | 0 / 3 | 3 / 3 |
| Dream：20 条已有记忆 + 8 条候选，整理完成的轮数（`dreamseed`，每档 15 轮） | 4 / 15 | 3 / 15 | 9 / 15 |
| Dream：40 条已有记忆，同上 | 0 / 15 | 没跑 | 5 / 15 |

- low 档在这个模型上和关着没有差别：判官的 9 次调用推理 token 全是 0。本来就标着 `low` 的首帧标题也一样，60 次调用里 59 次推理 token 是 0（另两处 `low`，Muse 代批和云端判官，这次没抓）。
- 整理**完成了**的那些轮，三档的结果一样对：已有事实一条没丢，没说过的那条一次没被记进去，说过的 4 条都记了，当天进度一条没混进去。档位改变的是完成率，和提议里的格式硬错（把已有记忆放进丢弃清单、编号写重：关 5 次、low 2 次、medium 1 次）。
- medium 档剩下的没完成几乎都是同一件事：用户明说一条规矩改了（种子里「一位 reviewer 批准」改成「两位」），提议按提示把旧的原样留下、新的另记一条，核验却以「新旧矛盾」否决。这是提议和核验两份提示对「被取代的旧事实」说法不一，不是档位能解决的，另有任务卡。没完成的一轮不动记忆、候选留在收件箱，下次再来。
- 延迟：判官一次调用中位 2.7 秒 → 4.6 秒（最长 9.5 秒）；Dream 整轮中位 9 秒 → 14 秒（20 条）/ 11 秒 → 18 秒（40 条），最长 23 秒，出厂时限 60 秒。
- 行为上看得见的一处变化：开了思考的判官更常往当天日志里记一句（「写了一段 400 字的介绍」这类对话，关着时 3 次都没记，medium 连同合并前的复跑 5 次里 4 次记了）。

## 逐处清单

「实际发出」一栏是 `codex/gpt-6-luna` 上用 `TANGU_LLM_DEBUG=1` 抓到的；没抓的几处走的是同一条 `buildProviderPayload` 路径，以代码为准。

| 调用 | 位置 | 思考档位 | 输出上限 | 输出错了会怎样 |
|---|---|---|---|---|
| 主循环 | `services/agentLoop.ts` | 会话 / agent 的档位（缺省 medium） | 不设 | 参照行 |
| 子代理 | `services/subAgent.ts` | agent 定义的档 → 父 run 的档 → medium | 不设 | 同上 |
| 自我脑暴的分身 | `services/selfBrainstorm.ts` | 跟父 run 同档（缺省 medium）。档位不同前缀缓存就对不上 | 固定值 | 只是给主循环的参考意见 |
| Historian 分身判官（`fork` 模式） | `services/localHistorian.ts` `forkJudge` | 跟父 run 同档（缺省 medium），理由同上 | 1600 | 同下一行；失败时回落到独立判官 |
| **Historian 独立判官**（缺省模式；辅助模式下也由它出标题 / 摘要 / 进化记录提名） | `services/historianSession.ts` ← `localHistorian.ts` `runHistorianForSession` | **medium**（2026-10-06 起；此前没传 = 关） | 1600，原生思考的模型另加 4096 | 记忆候选进收件箱（Dream 还要对来源）；**项目级候选和进化记录提名里不带风险字眼的直接写进长期内容**；日志、摘要、标题 |
| 团队讨论的收尾总结 | 同一个函数，`task: 'team-summary'` ← `services/groupChat.ts` | 关（没传） | 1200 | 只是给用户看的一段总结，失败不影响团队那一轮 |
| 首帧标题 | `localHistorian.ts` `onUserRunStart` | low | 600 | 标题不贴切 |
| **Dream 提议** | `services/memoryDream.ts` `complete(PROPOSE)` | **medium**（2026-10-06 起；此前没传 = 关） | 3072，原生思考的模型另加 4096 | 校验不过 → 整轮失败、候选留到下次；过了校验但归并时丢了限定条件 → 靠下一行拦；该记的被当成噪音丢掉 → 这条候选就没了 |
| **Dream 核验** | `memoryDream.ts` `complete(VERIFY)` | **medium**（同上） | 1024，原生思考的模型另加 4096 | 误放 → 错的归并写进 MEMORY.md（有版本可回退）；误拒 → 这一轮白跑 |
| 项目记忆写满时的压缩 | `services/projectMemoryCompact.ts` | medium（2026-10-05 起；头两版没传，前台 19 次只对 8 次） | 12288 | 压错了会丢项目记忆里的现行规矩；去掉的原句进 `COMPACTED.json`、能逐句恢复 |
| 云端 Historian（web / 安卓的 tangu 会话，网关上跑） | `services/historian.ts` `judgeAndWrite` | low | 800 | 直接追加进长期记忆（云端没有 Dream），每趟最多 3 条 |
| 云端 Historian（AI Studio 空闲复盘） | `historian.ts` `summarizeSession` | 关（没传） | 300 | 一行日志 |
| 会话压缩的摘要 | `services/compaction.ts` `summarizeWith` | 设置项 `compaction.thinking`，缺省 `off`；`inherit` = 跟本 run | 6144，另受窗口约束 | 摘要漏了东西，之后每个 run 都从这份摘要接着跑。档位是用户可调的，见 `docs/compaction.md` |
| Muse 代批判官 | `services/pendingApprovals.ts` `judgeApproval` | low | 300 | 误批 = 后台 agent 的一个动作在用户不在时被执行；没给出裁决一律按否决（转排队等用户） |
| `/btw` 旁问 | `services/aside.ts` | 关（没传） | min(4096, 窗口 / 4) | 用户当场看到回答 |
| 正文里的生成式 AI | `services/inlineAi.ts` | 关（没传） | 同上 | 用户当场看到，自己决定用不用 |
| 提交说明 | `services/gitActions.ts` `generateCommitMessage` | 关（没传） | 400 | 用户提交前看得到、能改 |
| 图像识别（辅助视觉模型） | `services/visionService.ts` `describeImages` | 关（没传） | 1500 | 主模型拿到一段不准的图片描述 |

三处 `low` 是能力表之前定的：那时不传档位、DeepSeek 类端点按自己的缺省（high）思考，推理吃光了输出上限、只剩空正文，所以压到 low。现在不传就是关（DeepSeek V4 发的是 `thinking: {type: 'disabled'}`），这三处的 `low` 实际是「比不传多想一点」。它们的输出上限（300 / 600 / 800）都按 low 的推理量给的，要往上调档得连上限一起调。

没改的几处为什么不改：旁问、正文生成、提交说明是用户当场看着的，等待时间比多想一步要紧，结果也不落进长期内容；图像识别用的是辅助视觉模型，多数不支持调档；压缩摘要的档位本来就是用户设置；云端两处在网关上跑，改了要重新打包部署 server，而且云端判官的提示里没有「进化记录提名」那一项（这次量出差别的正是它）。这几处都没有用真模型量过开与不开的差别。

## 仪器

- `TANGU_LLM_DEBUG=1`（`adapters/standalone/multiBrain.ts`）：每次直连调用在引擎日志里记一行 `[llm-debug]`：要的档位、夹紧后的档位、实际写进请求的思考字段、输出上限、系统提示的开头（认是哪一处调用）、耗时、输入 / 输出 / 推理 token、结束原因。后台调用质量不稳时先看这一行，再去改提示词。
- 真模型场景 `--only dreamseed [--dream-rounds N] [--dream-entries 20|40]`：有体量的记忆上的整理，同一份种子连跑多轮。原来的 `dream` 场景只有两条事实，各档位都对，量不出差别。
- 判官：`--only refine`（自己总结的做法有没有被提名）、`--only signals`（出言纠正的那一轮采没采到）、`--only title`（没什么可记的对话里有没有多提）。
