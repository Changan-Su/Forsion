# ChatGPT Space 文档能力与 Notion Forsion 对比

调研日期：2026-10-02。本文用于后续产品讨论；没有修改产品实现。

本轮结论：ChatGPT Space 把页面内容、持久指令、请求入口、任务引用与交互产物放在同一份文档中。值得研究的是这些对象怎样协同工作。最新 Notion 也已经提供指令页、Skills、Agent mention 和后台 Custom Agents，不能把“文档里有 Agent”当作 Space 独有能力。Forsion 已有相当多对应基础，主要差距需要从页内入口和任务回写关系中寻找。

## 调研范围与证据

| 证据层 | 本轮完成 | 能支持的判断 |
| --- | --- | --- |
| OpenAI 官方说明 | 阅读 Space 总览、Pages、Agents、Collaboration、Getting started、企业管理、Visualizations、Dots | 文档公开描述的功能与边界 |
| 当前账号只读接口 | 读取内置 Your guide to pages；检查其自动更新状态 | 实际存在 instruction 块、Prompt、Visualize 引用；该页没有已配置自动维护 |
| Pages 插件内容目录与工具契约 | 检查存储类型、mention、Task、元数据、评论、自动化接口 | 编辑接口和序列化语义；不等于每个 UI 都已开放 |
| Notion 官方帮助 | 检查 Agent、Custom Agents、Skills、AI blocks、数据库、按钮、同步块、离线 | 当前官方能力；未登录 Notion 执行测试 |
| Forsion 当前工作区 | 阅读 Amadeus、自动化、Agent 文档及相关源码；HEAD 为 `7cdd15fa` | 源码存在性与接线；不代表安装版或线上验收 |

桌面 UI 读取被 Computer Use 的应用安全限制拒绝，因此没有完成逐项点击、截图和真实 Agent 任务验收。不能把本文称为“所有功能已实测”。本轮保留了既有页面、自动化和工作区代码，没有启动后台任务。

## 先分清对象

| 名称 | 含义 |
| --- | --- |
| ChatGPT workspace | 账号或组织环境，影响成员、设置与可用应用 |
| Space | 集中承载页面、文件和共享工作的产品区域 |
| 一个 space | 按主题或团队组织页面的容器，可共享 |
| Page | 可直接编辑、与 Agent 协作的文档，可有子页面 |
| Chat 或 Task | 对话与执行记录，可以在文档中引用；访问权限不能由页面链接推导 |
| dot | 可长期工作的云端 Agent；与一次页面编辑请求的生命周期不同 |
| Sheets、Slides、Sites | Space 中的其他产物类型，不应和普通 Page 混为同一种编辑器 |

来源：[Space 总览](https://learn.chatgpt.com/docs/space)、[Dots](https://learn.chatgpt.com/docs/dots)。Forsion 的 Space 则是组织 View 与布局的宿主，名称相同，抽象层级不同，见 [LCL](../../lcl/README.md)。

## Instructions Prompt Mention Task 的区别

| 对象 | 核心用途 | 执行边界 |
| --- | --- | --- |
| Agent Instructions | 保存供 Agent 使用的持续指导 | 保存不等于执行或创建日程 |
| Prompt | 保存读者可运行的一次请求 | 由读者选择 Chat about this 发起页面聊天 |
| @ChatGPT 或 @dot 加请求 | 在正文或评论中向 Agent 交办工作 | 必须区分普通文字、选中真实对象与提交请求 |
| Task | 呈现动作或关联执行对话 | 当前工具格式对 Run task 的页面类型有限制 |
| 自动化 | 在规定时间或条件下再次运行工作 | 需要真实配置、启用状态和运行证据 |

### Agent Instructions 是独立的内容类型

当前接口中，普通 Page 的持久块类型只有 `markdown` 与 `agent_instructions` 两种。标题写成“Agent Instructions”仍是普通正文。当前账号的引导页确实返回了一个 `agent_instructions` 块，正文为空：这证明类型存在，不证明非空指令在真实任务中的遵循效果。

接口进行局部搜索或按块读取时，也会返回该页面的 instruction 块。这说明 Agent 读一小段正文时，页面指导仍有机会被带入上下文。它不证明父页指令自动继承到子页，也不证明覆盖全局指令、权限或安全边界。

**产品意义，属于分析：** 文档可以同时保存“最终内容”和“以后怎样维护这份内容”。例如发布说明页可规定版本事实的来源、保留哪些人工结论、如何标注未确认项。具体示例是设计建议，不是产品默认规则。

仍待实测：多个 instruction 块的合并顺序、作用范围、父子页继承、折叠或移动后的行为、编辑指令对已在执行任务的影响，以及不同协作者发起任务时的实际读取范围。

### Mention 同时承担引用和交办

官方确认可提及人、Agent、文件及聊天；Agent 指南明确列出正文或评论中的 `@ChatGPT`、`@dot` 加请求。提及人用于协作定位；提及文件或聊天关联来源；向 Agent 提交请求会要求它采取行动。[Pages](https://learn.chatgpt.com/docs/space/pages)、[Agents](https://learn.chatgpt.com/docs/space/agents)

Pages 内容目录还区分了对象引用与已提交任务：普通 `@Name` 文本不自动成为有效对象；已提交的 ChatGPT mention 可以保存带任务身份的链接。保存、读取或重新打开这些链接不会重新启动任务，也不会开放私人任务的访问权。

**产品意义，属于分析：** 可以把一条局部审阅意见直接交给 Agent，后续仍能找到相关执行记录；需要让读者辨认“提到了谁”和“已经派了什么工作”。

### Prompt 和 Task 不应合并理解

Prompt 的接口表示是 `codex-prompt` 围栏。引导页真实包含两项此类请求。它把下一步提问做成可复用入口，读者运行时开启新的页面聊天，适合“根据本页生成我的行动清单”。

Task 存在重要边界：官方插入菜单列出 Task，但当前 Pages 内容目录限定，未启动的顶层 `codex-task` 只有在既有 `meeting_notes` 页面中展示 Run task；其他页面或嵌套位置会作为代码显示。带已返回 thread ID 的任务引用可展示 Open chat。不能据此声称任何普通页面都能手写一个 Task 并执行，也不能把聊天结束视为业务待办完成。

## 其他特别之处

| 能力 | 已确认内容 | 对产品设计的含义或限制 |
| --- | --- | --- |
| 选区 Ask for change | 针对所选文字提出修改，审阅后接受 | 局部修改入口不必经过整页任务 |
| 页内 Generate | 在编辑位置请求新内容，可继续调整 | 新内容生成与保留可复用 Prompt 是两个流程 |
| 评论中的 Agent | 评论可以成为工作请求的落点 | 讨论、执行、正文结果之间可以建立关系 |
| 页内 Image Generate | Image 块提供生成或添加已有图片入口 | 图文产物可在同一写作过程中完成 |
| 页内 Visualize | 交互图、计算器、模拟器、界面演示 | 读者可以直接操作生成结果 |
| Visualize 共享状态 | Pages 插件契约支持协作者间同步 widget state | 必须由组件正确读写；不代表任意控件默认同步 |
| 交互产物的限制 | 可视化通常基于生成时的信息 | 不能把可操作的图表自动称为实时数据看板 |
| 表格块宽度 | Normal、Flexible、Full width；可调整列宽和适配 | 宽表可突破正文阅读列，而正文仍保持合适宽度 |
| 富表格单元格 | 接口支持段落、列表、待办和代码等结构 | 普通 Page 表格仍不是数据库，也没有原生公式语义 |
| 小节折叠与移动 | 标题驱动大纲；块句柄可移动列表或标题小节 | 要区分单块拖动和整节移动 |
| 标题折叠状态 | 插件元数据支持共享默认值与读者本地覆盖 | 与 Forsion 当前本机折叠记忆的语义不同 |
| Mermaid 与 diff | 内容目录支持对应预览 | 普通代码围栏不执行程序 |
| 人类与 Agent 协作 | 实时编辑、评论、可用时显示贡献归属 | 贡献归属不等于已经验证完整版本回滚体验 |
| 子页面与链接 | 创建子页和链接已有页是不同动作 | 链接不改变父子关系或授予权限 |
| 来源与聊天引用 | 可以保留文件、页面、聊天引用 | 文档能连接讨论过程和支持材料 |
| 权限继承 | Space 与父页可向下授予访问权 | 取消直接邀请不一定取消继承的访问 |
| 多种产物统一存放 | Pages、文件、图片、Sheets、Slides、Sites | 应分别确认各产物编辑能力，不能全算成 Page 块 |

编辑与排版依据：[Pages](https://learn.chatgpt.com/docs/space/pages)。交互产物依据：[Visualizations](https://learn.chatgpt.com/docs/visualizations)。协作依据：[Collaboration](https://learn.chatgpt.com/docs/space/collaboration)。接口细节来自本地 Pages 内容目录，见文末。

## 自动维护的真实状态

三条证据要同时保留：

1. 官方 Agent 文档写明 Keep Updated 在首发时不可用；定时工作应通过聊天设置并检查保存的日程。
2. 当前账号的引导页查询返回 `can_enable: true`、`controller: null`，其关联自动化列表为空。
3. 工具契约已经包含自动维护 controller 与 worker；启用配置不等于立即执行，配置可向页面读者展示，但私人运行对话不会因此共享。

因此本轮结论是：**接口具备启用条件，该页当前未配置自动维护；没有完成启用和实际运行验证。** 官方公开说明与账号接口反映的开放阶段可能不同，不能任选一条当作全面开放或全面不可用的证据。[Agents 的 recurring work 说明](https://learn.chatgpt.com/docs/space/agents#verify-recurring-work-separately)

dot 的云端持续工作能力也应单独看待。它可以在用户电脑关闭后继续云端工作；访问用户本机则仍要求本机在线且应用打开。不能把 dot 的持续运行等同于每一份 Page 已启用自动维护。[Dots](https://learn.chatgpt.com/docs/dots)

## 与最新 Notion 对比

| 维度 | ChatGPT Space | 最新 Notion | 判断 |
| --- | --- | --- | --- |
| 持久指导 | 页内 Agent Instructions 类型 | Agent 指令页、Custom Agent 自身配置 | 都有持续指导，挂载对象不同 |
| 可复用请求 | Prompt 块启动页面聊天 | Skills 以页面承载，可共享、手动或按适用性调用 | Prompt 与 Skill 不能直接画等号 |
| Agent mention | 正文、评论向 ChatGPT 或 dot 交办 | Custom Agents 可在页面、数据库属性、评论中被提及 | mention Agent 并非 Space 独有 |
| 可重复生成内容 | Generate、可复用 Prompt | AI Block 可配置来源并重新 Generate | 两边都有页内 AI 操作，入口语义不同 |
| 页面内 Agent 对话 | 本轮确认侧边聊天与任务引用 | 可嵌入 Custom Agent 聊天 | 不应声称 Space 独占文档内 Agent 体验 |
| 自动工作 | 日程；自动维护需区分账号开放状态 | Custom Agents 支持日程和事件触发 | 本轮 Notion 的公开工作流说明更明确 |
| 结构化管理 | 普通 Page 表格与独立 Sheets | 数据库条目本身就是页面，可用属性和多视图组织 | 不要把 Page 表格等同 Notion 数据库 |
| 内容复用 | 页面、文件、聊天等对象引用 | Synced blocks 可跨位置共用内容 | 引用源与同步编辑同一内容是两种语义 |
| 离线 | 本轮未证实完整 Page 离线策略 | 支持下载页面离线使用，存在设备和子页范围 | 不能再写 Notion 完全不能离线 |

Notion 来源分别为：[Notion Agent](https://www.notion.com/help/notion-agent)、[Custom Agents](https://www.notion.com/help/custom-agents)、[Skills](https://www.notion.com/en-gb/help/create-and-manage-skills)、[AI blocks](https://www.notion.com/help/notion-ai-faqs#ai-blocks)、[数据库](https://www.notion.com/help/intro-to-databases)、[同步块](https://www.notion.com/help/synced-blocks)、[离线页面](https://www.notion.com/help/use-pages-offline)。

Notion 的权限细节也值得对照：给 Custom Agent 的 Instructions 放一个页面链接，不等于给它配置访问权；把 Agent 聊天嵌进页面，也不会自动让 Agent 读取宿主页面。个人 Notion Agent 与 Custom Agent 的行为、工具和评论权限不能混写。[Custom Agents](https://www.notion.com/help/custom-agents)

**定位分析：** Space 更突出 ChatGPT 对话、执行与产物的衔接；Notion 更突出页面与数据库构成的团队工作流。两者边界正在重叠，不能用旧版 Notion 的能力来证明 Space 领先。

## Forsion 当前对应能力

以下仅代表当前源码和仓内文档，不代表本轮跑过安装版。

| Space 对照项 | Forsion 已有基础 | 本轮识别的差距或区别 |
| --- | --- | --- |
| 页内生成与选区修改 | `/ai`、选区工具栏、流式预览，接受后替换或插入 | 已有完整基础，无需从零重建 |
| 查看 Agent 修改 | 正在修改提示、修改处数、逐处查看、全部撤回、保留 | 已有审阅入口；需要继续接具体任务来源 |
| 页面旁边聊天 | 问 Tangu、带出处选区引用、Agent Desk | 已有文档和聊天联动 |
| 持久页内 Instructions | Agent 与项目 HUMAN.md、人格、技能等分层 | 本轮未找到普通文档独立指令块及其消费链 |
| 文档 @Agent 交办 | 已有页面与日期补全，聊天与团队有 Agent 体系 | 本轮未找到正文或评论 mention 后创建并关联任务的等价链路 |
| 可运行内容 | `forsion-button` 引用手动自动化，可运行 Agent | 比 Prompt 更偏已配置动作；应区分开聊与执行 |
| 周期性维护 | 自动化、Agent 日程、Muse | 可复用现有引擎，页内展示与目标范围还需专门核对 |
| 交互内容 | 原生白板、多维表、仪表盘、插件块、网页视图 | 有广泛宿主基础；不等于已有 `/visualize` 的统一生成和共享状态流程 |
| 结构化数据 | `.db`、多视图、公式、关联、聚合、行正文、事件触发 | 普通表格层面的对比会低估 Forsion |
| 内容所有权 | 本地 Markdown 主本、附件和可选同步 | 与云端 Page 的存储及协作边界不同 |
| 团队协作 | 页面邀请、编辑或查看角色、在线状态、公开分享 | 不据此推断已有段落评论与评论派发 Agent |

关键源码依据：

- [inlineAi.ts](../../desktop/frontend/src/amadeus/unified/inlineAi.ts)：先预览，确认后写入；生成期间用户修改了目标时保护新内容。
- [AgentChangeCapsule.tsx](../../desktop/frontend/src/amadeus/unified/AgentChangeCapsule.tsx) 与 [UnifiedPage.tsx](../../desktop/frontend/src/amadeus/unified/UnifiedPage.tsx)：Agent 编辑状态与审阅接线。
- [askTangu.ts](../../desktop/frontend/src/amadeus/unified/askTangu.ts)：选区引用与笔记标题出处。
- [ButtonBlock.tsx](../../desktop/frontend/src/amadeus/blocks/button/ButtonBlock.tsx)：文档保存规则引用，手动触发已有自动化。
- [WikiSuggest.tsx](../../desktop/frontend/src/amadeus/blocks/markdown/WikiSuggest.tsx)：目前检索到的页面与日期候选，不是 Agent 派发证明。
- [humanStore.ts](../../tangu-agent/src/agents/humanStore.ts)：Agent 与项目协作说明独立作用域、版本与撤销。
- [Amadeus](../amadeus/overview.md)、[数据库](../amadeus/databases.md)、[同步共享](../amadeus/cloud-and-sharing.md)、[自动化](../spaces/automation.md)、[Agent Desk](../chat/agent-desk.md)。

HUMAN.md 不能直接拿来充当每篇文档的 Instructions。它记录人和 Agent 怎样协作；页面指令应描述该文档的来源、格式与维护方式。若未来增加页面作用域，须明确与既有 Agent、项目、技能和记忆的关系。这个区分已由当前 `humanStore.ts` 与 Agent 文档重新核实。

## 对 Forsion 的产品建议

以下是本轮分析形成的候选方向，不是已经决定或实施的改动。

1. **先定义页内指令。** 明确“这篇文档怎么维护”，可见、可编辑、有作用范围；不要悄悄变成全局人格或权限来源。
2. **把 mention 对象和执行请求分开。** `@Agent` 可以先选择对象，再明确提交任务；结果关联文档位置和执行会话，保存或重开不重复运行。
3. **区分三种可执行入口。** 提问模板负责开聊，任务入口负责一次执行，自动化按钮负责已配置动作；它们的状态文案应反映各自语义。
4. **接上现有改动审阅。** 从 Agent 请求找到运行记录，再找到它改了哪些文档位置，最后由用户保留或撤回；复用已有胶囊与改动账本。
5. **让文档展示真实维护状态。** 绑定已有自动化后再展示负责人、任务目标、启停状态、最近结果；不能把自然语言里的周期写法显示成已启用日程。
6. **给交互产物一个一致入口。** 将现有白板、图表、网页或插件能力接入文档，分别标清一次生成、共享控件状态、外部数据刷新这三件事。

一个便于比较的场景是发布计划：页内指令保存事实来源和保留规则；评论向研究 Agent 交办某个未决问题；可运行请求让读者生成个人清单；表格维护里程碑；交互图解释预算；日程根据已确认配置进行后续更新。该场景是设计组合示例，不是本轮执行过的产品演示。

## 尚不能下结论的项目

| 项目 | 为什么保留 |
| --- | --- |
| 桌面最新构建的全部菜单与快捷键 | 没有获得桌面 UI 逐项验收；官方文档也未给出本机版本号 |
| Instructions 的继承和优先级 | 块类型和读取行为已确认，执行语义没有完整证据 |
| mention 的任务模型与计费归属 | 官方说明入口，但未完成本账号真实任务提交与多人测试 |
| 普通 Page 的 Task 实际交互 | 官方菜单说明与插件格式限制需结合具体客户端验证 |
| Keep Updated 的 UI 和运行效果 | 当前接口允许启用，但该页没有 controller 或运行记录 |
| Back of page | 工具契约出现可选 scratch 流，可能禁用；未作为普遍开放功能计入 |
| 原生 Docs 与 Canvas 开放情况 | 接口能识别一些类型，不等于当前账号支持创建和全部编辑 |
| 编辑器和工具支持差异 | 官方工具栏支持 underline，插件创作目录却列为不支持；只能分别陈述 |
| 完整导入导出、版本恢复、离线、块限制 | 本轮没有覆盖全部客户端和账号差异 |

后续如做交互验收，应使用独立试验页，逐项记录入口、请求作用范围、任务引用、重开行为、并发编辑与不同权限访问。不能把这份文档中的待确认项直接列入 Forsion 的功能缺口。

## 本地接口依据

- Pages 内容目录：`/Users/suqingyuan/.codex/plugins/cache/openai-curated-remote/pages/0.1.18/skills/write-page/references/page-content.md`。
- 当前可调用接口：`read_page`、`edit_page`、`read_page_changes`、评论接口、`get_page_auto_update`、`list_page_automations`。
- 只读实证：引导页返回独立 `agent_instructions` 块、`codex-prompt` 和三个 `visualize:` 引用；自动化为空。
- 未将用户账号标识、私人页面 ID 或会话内容写入此报告。
