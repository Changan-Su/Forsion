# Showcase assets / 展示素材

These assets support the English and Chinese repository READMEs and GitHub repository presentation.

这些素材用于中英文 README 与 GitHub 仓库展示。

The three product screenshots were captured from a clean Forsion Desktop **v2.10.4** build at source commit [`edfd128259535ad778fdc964ddcb049cca3603f1`](https://github.com/Changan-Su/Forsion/commit/edfd128259535ad778fdc964ddcb049cca3603f1). Each capture ran the real Electron renderer against an isolated public fixture. No personal workspace data or live model call was used. The screenshots have no crop, frame, matte, or colour treatment.

三张产品截图均来自 Forsion Desktop **v2.10.4** 的干净构建，对应源码提交 [`edfd128259535ad778fdc964ddcb049cca3603f1`](https://github.com/Changan-Su/Forsion/commit/edfd128259535ad778fdc964ddcb049cca3603f1)。截图运行真实 Electron 渲染层并使用隔离的公开夹具，不含个人工作区数据，也没有调用线上模型。截图未裁边、加框、铺底或调色。

| Asset / 素材 | Source / 来源 |
| --- | --- |
| `workbench.png` | v2.10.4 Coding Studio captured through Electron's native `BrowserWindow.capturePage()`, with a public Reading room project and sample conversation. / v2.10.4 编码工作室的 Electron 原生窗口截图，使用公开的 Reading room 项目与样例对话。 |
| `notes.png` | v2.10.4 Note workspace captured in Electron with the public Product research Markdown fixture. / v2.10.4 Note 工作区的 Electron 截图，使用公开的 Product research Markdown 夹具。 |
| `calendar.png` | v2.10.4 Calendar workspace captured in Electron with an isolated public date and database fixture. / v2.10.4 日历工作区的 Electron 截图，使用隔离的公开日期与多维表夹具。 |
| `logo.svg` | Existing Forsion logo from this repository's `desktop/frontend/public/Forsion-LOGO3.svg`. / 复用本仓库已有的扶桑标志。 |
| `social-preview.png` | 1280 × 640 designed browser-canvas composition from `docs/showcase/social-preview.html`, using the v2.10.4 `notes.png` and the Second Brain positioning. / `docs/showcase/social-preview.html` 生成的 1280 × 640 设计合成图，以 Second Brain 为主旨，产品画面来自 v2.10.4 `notes.png`。 |

Machine-readable dimensions, hashes, capture methods, and source provenance are recorded in [`manifest.json`](./manifest.json).

尺寸、哈希、截图方式与源码来源记录在可机器读取的 [`manifest.json`](./manifest.json) 中。

For GitHub Social Preview, upload `social-preview.png` in the repository settings.

GitHub 的 Social Preview 可使用 `social-preview.png`。

The proposed GitHub About text is: **A local-first AI second brain: Markdown block editing, editable memory, parallel AI teams, proactive follow-ups, and plugins.** Repository settings are not changed by this branch.

建议 GitHub About 简介：**A local-first AI second brain: Markdown block editing, editable memory, parallel AI teams, proactive follow-ups, and plugins.** 本分支提供文案与素材，仓库设置未修改。

Suggested topics / 建议 Topics：`second-brain`, `local-first`, `markdown`, `block-editor`, `ai-agents`, `multi-agent`, `knowledge-management`, `automation`, `plugins`.

## Product story and evidence / 产品主线与依据

The public story follows **capture and connect → remember context → think and act as a team → follow through → keep the results**, with plugins extending the workflow. The README's project example is a suggested configuration, not a recording of model execution. Screenshots demonstrate the named workspaces with public fixtures; they do not demonstrate a live multi-agent or Muse run.

展示主线为**记录与连接 → 记住背景 → 团队思考与执行 → 主动跟进 → 成果沉淀**，插件扩展整条工作流。README 的项目案例是建议配置的使用路径，并非一次模型执行记录。截图只展示标明的工作区与公开样例，不作为多 Agent 或 Muse 真实执行的证据。

Feature copy was rechecked against **v2.11.0 / `ad3bbfba`** on 2026-09-17. Screenshot provenance remains **v2.10.4**; no new product captures or live-model demonstrations were made in this copy revision. See the [bilingual messaging guide](../../../docs/showcase/messaging.md) for reusable copy, source evidence, and the next recording brief.

功能文案于 2026-09-17 按 **v2.11.0 / `ad3bbfba`** 重新核对；截图来源仍为 **v2.10.4**，本次文案修订未新增产品截图或真实模型演示。[双语宣传主线](../../../docs/showcase/messaging.md)提供可复用文案、源码依据与下一轮录制脚本。

| Capability / 能力 | Evidence / 依据 | Presentation boundary / 展示边界 |
| --- | --- | --- |
| Knowledge / 知识库 | [Amadeus guide](../../../docs/amadeus/overview.md), [links](../../../docs/amadeus/links-and-properties.md), [databases](../../../docs/amadeus/databases.md) | Block editing on local Markdown, links, databases, whiteboards, PDF annotations and dashboards. / 本地 Markdown 块编辑、双链、多维表、白板、PDF 批注与仪表盘。 |
| Memory / 记忆 | [Memory panel](../../../desktop/frontend/src/components/AgentMemoryPanel.tsx), [repository](../../../tangu-agent/src/services/memoryRepository.ts), [Dream](../../../tangu-agent/src/services/memoryDream.ts), [recall](../../../tangu-agent/src/services/memoryRecall.ts) | Manageable per Agent; explicit shared-memory configuration exists. Automatic Dream maintenance is opt-in. Forget removes active memory, not revision history. / 按 Agent 管理，也可明确配置共享；自动 Dream 默认关；遗忘移出活跃记忆，保留版本历史。 |
| Muse / 主动跟进 | [Muse runtime](../../../tangu-agent/src/services/muse.ts), [defaults](../../../tangu-agent/src/services/specialAgentsConfig.ts), [2.10.2–2.10.4 changelog](../../../desktop/CHANGELOG.md) | Local mode, disabled by default; heartbeats, schedules, rules, budgets, approvals, Inbox tasks and its own Space. / 本地、默认关；心跳、日程、规则、预算、审批、收件箱任务与自建 Space。 |
| Collaboration / TEAM | [team registry](../../../tangu-agent/src/agents/teamRegistry.ts), [parallel orchestration](../../../tangu-agent/src/services/groupChat.ts), [Team Desk](../../../desktop/frontend/src/views/chat2/TeamDesk.tsx), [personas](../../../tangu-agent/src/agents/personaPrompts.ts) | Persistent members and roles, TEAM.md, parallel child conversations, public outputs and approvals in the main conversation; individually managed memory. / 长期成员与职责、TEAM.md、并行子会话，产物与审批汇回主会话；记忆分别管理。 |
| Extensions / 插件体系 | [plugin guide](../../../docs/customization/plugins.md), [desktop contract](../../../desktop/frontend/src/amadeus/plugins/types.ts), [bundle manifest](../../../tangu-agent/skills/forsion-plugin/samples/forsion-sample-bundle) | Bundles connect UI, engine tools, Agents, skills and Spaces; plugin events can trigger automation. / 捆绑界面、引擎工具、Agent、技能与 Space；插件事件可触发自动化。 |
| Outputs / 产出 | [Agent Desk](../../../docs/chat/agent-desk.md), [Coding Studio](../../../docs/spaces/coding.md) | Coding is one output path within the second brain. / 编码是 Second Brain 的一种产出路径。 |

README headings, both quick starts, the documentation entry, the About proposal, and the social preview should preserve this same emphasis. / 中英文 README、快速上手、文档入口、About 建议与分享封面应保持相同重点。
