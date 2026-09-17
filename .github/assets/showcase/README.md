# Showcase assets / 展示素材

Each README displays six **v2.11.0** screenshots in its own language: `README.md` uses the `-en.png` images, while `README.zh-CN.md` keeps the original Chinese images. The English set was captured at `aaccdd32`, and the Chinese set at `5e2fe953`; both desktop trees match the v2.11.0 release. They use the same isolated public research project, with localized interface labels, notes, filenames, memory, conversations, and tasks. The interface is real; conversation text, memory records, team status and Inbox tasks are seeded sample data. No model calls or personal workspace data were used.

每份 README 在对应段落展示六张 **v2.11.0** 截图：英文使用独立的 `-en.png`，中文保留原图。英文来源 `aaccdd32`，中文来源 `5e2fe953`，两者 desktop 源码树均与 v2.11.0 发布一致。使用同一公开研究项目，界面、文件名、笔记、记忆、对话和任务内容均随语言切换。界面真实，对话、记忆、团队状态和收件箱任务为预置样例，不是模型实测，不包含个人数据。

All twelve images are complete 1600 × 1000 content viewports, with no post-capture crop, frame, matte, recoloring, or UI modification. / 十二张均为完整 1600 × 1000 内容视口，未做后期裁边、边框、铺底、调色或界面修改。

| Asset / 素材 | What it shows / 展示内容 |
| --- | --- |
| `markdown-blocks.png` / `markdown-blocks-en.png` | Markdown note and actual slash-menu block insertion. / Markdown 笔记与真实斜杠菜单。 |
| `agent-memory.png` / `agent-memory-en.png` | Three editable memory entries for Arioso. / Arioso 的三条可编辑记忆。 |
| `team-desk.png` / `team-desk-en.png` | Public TEAM discussion and member status. / TEAM 公开讨论与成员状态。 |
| `team-thread.png` / `team-thread-en.png` | Recita's full child conversation beside the main discussion. / 主讨论旁的 Recita 完整子会话。 |
| `muse-inbox.png` / `muse-inbox-en.png` | Follow-up task, expanded instructions and action controls. / 跟进任务、展开的任务书与处理按钮。 |
| `project-note.png` / `project-note-en.png` | Sources, responsibilities and next steps in a local Markdown file. / 本地 Markdown 中的来源、职责与下一步。 |

The capture fixture uses the built-in portraits from `tangu-agent/src/agents/builtinAvatars.ts` and `defaultAvatar.ts`, served through the app's normal avatar endpoint. Arioso retains its canonical `xyra` identifier. Capturing fails if portraits are not requested or visible images fail to decode. / 拍摄夹具通过正常头像接口提供仓库内置原版头像；Arioso 沿用真实标识 `xyra`。头像未请求或可见图片解码失败时终止拍摄，避免再次交付占位图。

## Reproduce / 复现

Install the project's desktop dependencies, build the current source, then run from the repository root in a GUI session. Each command launches and closes its own isolated Electron instance. / 安装桌面依赖并构建后，在有图形界面的环境从仓库根执行；每次命令启动并关闭独立的隔离 Electron 实例。

```bash
npm --prefix desktop run build
node docs/showcase/capture.cjs note
node docs/showcase/capture.cjs blocks
node docs/showcase/capture.cjs memory
node docs/showcase/capture.cjs team
node docs/showcase/capture.cjs muse

# English: interface and sample content
node docs/showcase/capture.cjs note en
node docs/showcase/capture.cjs blocks en
node docs/showcase/capture.cjs memory en
node docs/showcase/capture.cjs team en
node docs/showcase/capture.cjs muse en
```

The `team` scene writes both team views. English content lives in `docs/showcase/fixture.en.cjs`; English captures abort if rendered text contains Chinese characters. The English output folder has an `-en` suffix. Output defaults to the OS temporary directory's `forsion-showcase-v211` folder; `SHOWCASE_OUT` can choose another output folder. Captures are not installed into the asset directory automatically: inspect them first, then copy and refresh the manifest. / 英文内容位于 `docs/showcase/fixture.en.cjs`；英文拍摄若检测到正文含汉字则终止，输出目录加 `-en`。`team` 场景输出两张团队图片；默认输出到系统临时目录的 `forsion-showcase-v211`，可用 `SHOWCASE_OUT` 指定路径。脚本不直接覆盖正式素材；先检查，再复制并更新清单。

[manifest.json](manifest.json) records dimensions, SHA-256 hashes, source trees and capture methods per asset. / 清单逐图记录尺寸、SHA-256、源码树与截图方式。

## Earlier assets / 旧素材

`notes.png`, `workbench.png`, and `calendar.png` remain archived v2.10.4 captures from `edfd1282`; the READMEs no longer use them. `social-preview.png` remains the existing designed 1280 × 640 composition using the old note image. Its source is recorded separately in the manifest. `logo.svg` is the repository's existing logo. / 三张旧图仍保留为 v2.10.4 历史素材，README 已全部替换。分享封面仍是旧笔记图生成的 1280 × 640 合成图，来源单独记录；标志沿用仓库原件。

Proposed GitHub About / 建议简介：**A local-first AI second brain: Markdown block editing, editable memory, parallel AI teams, proactive follow-ups, and plugins.**

Suggested topics / 建议 Topics：`second-brain`, `local-first`, `markdown`, `block-editor`, `ai-agents`, `multi-agent`, `knowledge-management`, `automation`, `plugins`.

## Product story and evidence / 产品主线与依据

The public story follows **capture and connect → remember context → think and act as a team → follow through → keep the results**, with plugins extending the workflow. The README's project example is a suggested configuration, not a recording of model execution. Screenshots demonstrate the named workspaces with public fixtures; they do not demonstrate a live multi-agent or Muse run.

展示主线为**记录与连接 → 记住背景 → 团队思考与执行 → 主动跟进 → 成果沉淀**，插件扩展整条工作流。README 的项目案例是建议配置的使用路径，并非一次模型执行记录。截图只展示标明的工作区与公开样例，不作为多 Agent 或 Muse 真实执行的证据。

Feature copy was rechecked against **v2.11.0 / `ad3bbfba`** on 2026-09-17. README screenshot provenance is **v2.11.0 / `5e2fe953` (zh), `aaccdd32` (en)**; six product captures per language accompany that copy; no live-model demonstration was run. See the [bilingual messaging guide](../../../docs/showcase/messaging.md) for reusable copy, source evidence, and the next recording brief.

功能文案于 2026-09-17 按 **v2.11.0 / `ad3bbfba`** 重新核对；README 截图来源为 **v2.11.0 / `5e2fe953`（中文）、`aaccdd32`（英文）**，每种语言各六张界面截图，未运行真实模型演示。[双语宣传主线](../../../docs/showcase/messaging.md)提供可复用文案、源码依据与下一轮录制脚本。

| Capability / 能力 | Evidence / 依据 | Presentation boundary / 展示边界 |
| --- | --- | --- |
| Knowledge / 知识库 | [Amadeus guide](../../../docs/amadeus/overview.md), [links](../../../docs/amadeus/links-and-properties.md), [databases](../../../docs/amadeus/databases.md) | Block editing on local Markdown, links, databases, whiteboards, PDF annotations and dashboards. / 本地 Markdown 块编辑、双链、多维表、白板、PDF 批注与仪表盘。 |
| Memory / 记忆 | [Memory panel](../../../desktop/frontend/src/components/AgentMemoryPanel.tsx), [repository](../../../tangu-agent/src/services/memoryRepository.ts), [Dream](../../../tangu-agent/src/services/memoryDream.ts), [recall](../../../tangu-agent/src/services/memoryRecall.ts) | Manageable per Agent; explicit shared-memory configuration exists. Automatic Dream maintenance is opt-in. Forget removes active memory, not revision history. / 按 Agent 管理，也可明确配置共享；自动 Dream 默认关；遗忘移出活跃记忆，保留版本历史。 |
| Muse / 主动跟进 | [Muse runtime](../../../tangu-agent/src/services/muse.ts), [defaults](../../../tangu-agent/src/services/specialAgentsConfig.ts), [2.10.2–2.10.4 changelog](../../../desktop/CHANGELOG.md) | Local mode, disabled by default; heartbeats, schedules, rules, budgets, approvals, Inbox tasks and its own Space. / 本地、默认关；心跳、日程、规则、预算、审批、收件箱任务与自建 Space。 |
| Collaboration / TEAM | [team registry](../../../tangu-agent/src/agents/teamRegistry.ts), [parallel orchestration](../../../tangu-agent/src/services/groupChat.ts), [Team Desk](../../../desktop/frontend/src/views/chat2/TeamDesk.tsx), [personas](../../../tangu-agent/src/agents/personaPrompts.ts) | Persistent members and roles, TEAM.md, parallel child conversations, public outputs and approvals in the main conversation; individually managed memory. / 长期成员与职责、TEAM.md、并行子会话，产物与审批汇回主会话；记忆分别管理。 |
| Extensions / 插件体系 | [plugin guide](../../../docs/customization/plugins.md), [desktop contract](../../../desktop/frontend/src/amadeus/plugins/types.ts), [bundle manifest](../../../tangu-agent/skills/forsion-plugin/samples/forsion-sample-bundle) | Bundles connect UI, engine tools, Agents, skills and Spaces; plugin events can trigger automation. / 捆绑界面、引擎工具、Agent、技能与 Space；插件事件可触发自动化。 |
| Outputs / 产出 | [Agent Desk](../../../docs/chat/agent-desk.md), [Coding Studio](../../../docs/spaces/coding.md) | Coding is one output path within the second brain. / 编码是 Second Brain 的一种产出路径。 |

README headings, both quick starts, the documentation entry, the About proposal, and the social preview should preserve this same emphasis. / 中英文 README、快速上手、文档入口、About 建议与分享封面应保持相同重点。
