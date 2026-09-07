# Coding Studio 升级调研

调研时间：2026-09-07。范围：Google AI Studio Build、Lovable、Bolt、Replit 的官方产品文档与最佳实践。以下区分**文档证实的能力/问题**与**Forsion 的产品推断**，不把论坛个案当普遍发生率，也不把规划项当已实现能力。

## 结论

Coding Studio 的体验主线应覆盖：想法 → 明确需求 → 可观察的构建 → 实际预览 → 定向修改 → 带证据排错 → 可恢复版本。只对标旧版“聊天 + Code/Preview”的布局，已经不能覆盖现在的产品基准。

## 竞品证据

| 来源 | 文档证实的内容 | 对 Forsion 的启发（推断） |
|---|---|---|
| [Google AI Studio Build](https://ai.google.dev/gemini-api/docs/aistudio-build-mode)，文档更新于 2026-08-20 | 自然语言构建、模板 remix、GitHub 导入、实时预览与代码编辑、多文件 agent、验证执行、UI annotation；Node/npm、服务端 secrets、Firebase/Auth、双向 GitHub 同步与冲突 diff、Cloud Run 部署。也支持 Android 构建。 | 应优先补完整制作闭环；云运行基础设施和 Android 需单独规划，不能用外观控件表示已经支持。 |
| [Lovable prompting](https://docs.lovable.dev/prompting/prompting-one) | 推荐先明确产品、受众、动机、关键行动与设计方向，再以组件/小步骤迭代。 | 起步页应把“产品简报”做成轻表单与可编辑模板，降低提示词门槛。 |
| [Bolt 排错](https://support.bolt.new/troubleshooting/issues) | 大而复杂的单次请求容易遗漏功能或失去上下文；建议逐个修改、逐个检查。 | 构建计划、需求约束、已验证状态需要在工作台里可见且持续存在。 |
| [Bolt token 效率](https://support.bolt.new/best-practices/maximizing-token-efficiency) | 反复自动修错会耗费 tokens；建议诊断、加入日志、考虑 Plan。内置版本恢复无需模型调用，连接器上下文也会增加消耗。 | 给错误带上证据与已尝试方案；恢复、刷新等确定性操作用真实按钮；能力按需加入。 |
| [Lovable debugging](https://docs.lovable.dev/prompting/prompting-debugging) | 推荐解释错误、梳理尝试、寻找根因，必要时回到稳定版本，再逐步重做。 | 小白需要看懂问题和安全出口，不能只有“再试一次”。 |
| [Lovable 预览工具栏](https://docs.lovable.dev/features/preview-toolbar) | 支持元素引用、文字编辑、绘制批注、评论及修改请求排队。 | “指哪改哪”是实际基准；定位上下文应进入真实输入草稿。 |
| [Lovable 浏览器测试](https://docs.lovable.dev/features/browser-testing) | 可以点击、填表、读控制台和网络、测试不同屏幕，展示步骤/截图/结果；部分交互与细微视觉判断仍有限。 | “已生成”“预览已加载”“用户流程已验证”必须是不同状态。 |
| [Replit 检查点](https://docs.replit.com/features/version-control/checkpoints-and-rollbacks) | 检查点覆盖文件、配置、对话和 agent 上下文；开发数据库恢复可选且默认关闭；保留时间、描述与变更范围。 | 版本恢复需要明确范围；只恢复文件时不能宣称恢复所有状态。 |
| [Lovable 项目知识](https://docs.lovable.dev/features/knowledge) | 项目/工作区知识常驻，skills 按需加载；会读项目指引与集成知识。 | Forsion 的既有上下文、skills 和工具应被连到 Coding 流程，而不是再建独立系统。 |

## 建议优先级（产品推断）

1. **P0 项目起步**：自由想法、可选受众与约束、能编辑的提示词模板、真实能力选择、本地创建/打开/搜索。简报先进入草稿，由用户发起构建。
2. **P0 构建可观察**：当前动作、运行/等待/失败状态、停止入口、文件变化与耗时。状态必须来自实际执行事件。
3. **P0 预览与排错**：真实 URL、入口与设备尺寸、错误收集、带上下文诊断/修复、启动失败恢复入口。
4. **P0 恢复信心**：命名版本、时间、文件差异、恢复前说明；恢复前先保留当前工作。
5. **P1 定向修改**：元素引用与截图批注，跨源或宿主不支持时清楚降级。
6. **P1 验收与交付**：需求清单、验证证据、未验证项、打开源码、运行说明和 Connect 发布。

## 本轮实际实现与剩余差距

以下按工作树源码核对。“已实现”表示已有真实交互和底层路径；完整验证范围见下节，不能据此宣称已经全面达到或超过竞品。

| 制作环节 / 对标点 | 当前状态 | 实际能力与剩余差距 |
|---|---|---|
| 自然语言起步、模板与项目入口 | 已实现 | 需求、受众、约束、六个可编辑提示词模板、能力选择、名称校验、真实目录创建；本地导入、搜索、去重后的最近项目。模板本身不生成应用，GitHub 导入和项目 remix 尚未实现。 |
| 可持续的项目需求 | 已实现 | 创建与编辑简报会把完整技术约束保存到 `FORSION_BRIEF.md`，同时保留工作台简报；对话草稿采用简短的中英文可读说明并保留用户原文，用户发送后才调用模型。计划模式可单独选择，尚无需求到任务的自动追踪表。 |
| 多文件构建与可观察执行 | 部分实现，复用既有引擎 | 沿用已有模型、Agent、外部引擎、计划模式、技能与权限；显示真实运行/等待状态、变化文件数、流式源码与停止入口。没有新增自动任务编排面板、耗时/成本预算或付费调用质量评测。 |
| 预览、代码、并排与设备宽度 | 已实现 | 实际 Electron guest 预览、入口选择、三种工作模式、自适应/768/390 宽度、外部文件变化自动刷新、手动刷新；切换模式保留同一个 guest。通过宿主/guest 几何信息与 Electron 原生合成截图复验，避免仅凭 DOM 可见断言判断效果。 |
| Vite / Next.js 等运行环境 | 部分实现 | 内置即时预览按需转译 JS/TS/JSX/TSX；可以打开项目终端并连接本机开发服务 URL。安装依赖、启动/管理服务、Node 云沙箱和服务端 secrets 管理尚未自动化。 |
| 指定页面局部修改 | 部分实现 | 点击实际 DOM 元素，采集定位、文字与片段，再将修改要求加入真实草稿。未实现截图绘画批注、多元素队列、直接编辑页面文字；DOM 引用也不等同于精确源码映射。 |
| 带证据排错 | 部分实现 | 收集预览控制台警告/错误和加载失败，将用户描述、来源与错误加入诊断草稿。尚无完整网络请求面板、跨会话修复尝试记录或自动修复成功判定。 |
| 人工编辑与并发保护 | 已实现 | 文件版本校验、按文件串行保存、外部修改冲突暂停、未保存草稿和恢复副本，避免异步保存覆盖其他文件。此能力处理本地文本编辑，不是多人协同编辑。 |
| 版本与安全恢复 | 部分实现 | 命名源码版本、时间与文件数、恢复确认、恢复前备份、增删改恢复与并发冲突报告；确定性操作无需模型。未实现逐文件差异浏览、对话/依赖/数据库/云资源的完整环境恢复。 |
| 用户流程验收 | 部分实现 | 五项人工验收清单，项目变化后重置；可将检查要求交给既有计划模式。没有新增自动浏览器验收报告，预览加载不会标记流程通过。 |
| 发布与分发 | 复用既有能力 | 接入原有 Forsion Connect 静态发布、公开链接和市场申请流程；导入目录需要满足 `Project` 范围限制。没有新增全栈云部署、数据库/Auth 自动配置、双向 GitHub 同步、Android 构建。 |

主要实现入口：[`ProjectLaunchpad.tsx`](../../desktop/frontend/src/views/coding/ProjectLaunchpad.tsx)、[`CodeStudioView.tsx`](../../desktop/frontend/src/views/CodeStudioView.tsx)、[`StudioPreview.tsx`](../../desktop/frontend/src/views/coding/StudioPreview.tsx)、[`editorSession.ts`](../../desktop/frontend/src/views/coding/editorSession.ts)、[`codeStudioProjects.ts`](../../desktop/electron/codeStudioProjects.ts)。

## Forsion 能力映射与接入边界

本轮核查本地源 `desktop/electron/forsionConnectLocal.ts`：

| 能力选择 | 已存在的公开 SDK | 应交给模型的约束 |
|---|---|---|
| AI 对话 | `window.forsion.ai.chat` | 可流式生成，不编造模型 ID；缺省模型由平台策略确定。 |
| Agent 工作流 | `window.forsion.ai.agent` | 保留返回的 session 以延续多轮上下文；工具和模型由服务端管理。 |
| 图像生成 | `window.forsion.ai.generateImage` | 消费实际图片结果；处理未配置模型、进度和失败。 |
| Forsion 账号 | `window.forsion.user` / `window.forsion.login` | 处理空用户和授权失败；预览使用桌面登录态。 |

SDK 由本地预览的 `/forsion-connect.js` 提供。选择能力是表达开发要求，不代表账号已授权、平台模型已配置、外部资源已创建。此 API 面没有通用数据库 API，也没有任意客户端工具执行接口，因此起步页不提供这些承诺。模型简报要求复用项目规范、保护已有代码、使用真实数据与失败状态、验证预览，并报告未验证事项。

开发 Coding Studio 的 Agent 与生成应用中的 `window.forsion.ai.agent` 是两个使用场景：前者沿用桌面会话的工具、权限与外部引擎；后者调用 Connect 的云端 Agent，模型和工具由服务端策略管理。不能因桌面 Agent 能执行终端命令，就向网页应用承诺同样的本机权限。

内置静态预览的 SDK 经桌面主进程代理，使用桌面 Forsion 登录态；发布态 SDK 使用公开应用外层壳的授权通道。登录、网络、平台模型和额度仍是运行前提。自定义开发服务不会自动获得内置静态服务器的 `/forsion-connect.js` 与代理路由，现有工程需要自行按其运行环境接入。项目间静态预览使用独立本机源，但浏览器存储仍只是本机数据，不等同于跨设备账号存储。

源码版本只覆盖常见文本源码与配置，排除依赖、构建产物、密钥、媒体等二进制资源；单份限制为 512 个文件、16 MB。引擎自动检查点仅适用于受支持的 host 文件写入工具，终端和外部编辑器修改应通过手动源码版本保存。Connect 发布复用原有静态发布通道，不会将本机开发服务、后端或 secrets 一并部署。

## 验证记录与限制

- 最终 desktop 全量回归：**244 个测试文件通过，2,460 项通过、2 项跳过**。覆盖项目路径与偏好隔离、草稿投递、实际执行目录校正、编辑器并发保存、恢复副本、监听与源码恢复等链路。
- 真实 Electron 验收：**41/41 通过**。隔离临时用户目录、项目与 stub engine，经实际 UI、文件系统与 guest 验证：新建/导入项目、可编辑模板、需求文件与计划草稿、项目固定绑定、CodeMirror 编辑落盘、390 宽度、模式切换保留页面状态、点选元素、控制台问题、外部文件刷新、源码版本保存/恢复、深浅主题与英文界面。模型后端是 stub，不代表真实 AI 生成质量已验证。
- desktop、web、mobile 类型检查通过；desktop 与 tangu-agent 构建通过；内置 Agent 升级兼容测试通过。修改文件的 Hooks 检查、三端同步与 shadow contract 检查通过。
- 仓库全量 Hooks 检查仍有 3 个原有错误：`BoardToolbar.tsx:265`、`AccountCard.tsx:233`、`AutomationBuilder.tsx:172`；这些文件相对分支基线未变。CSS 变量检查仍报告 5 处既有提示，本轮未新增。
- Retina 屏幕上的 CDP 截图曾错误合成 Electron guest，造成假空白/偏移。经宿主与 guest 几何、缩放、独立截图和 `BrowserWindow.capturePage` 对照确认后，验收改用原生窗口截图；已实际检查手机、并排、定向修改、深色与英文界面。
- 未执行实时付费模型调用、真实 AI 应用端到端生成、账号/额度联调、云端发布或市场上架，也未验证所有外部引擎和真实 Vite/Next.js 工程的依赖安装与启动。SDK 描述来自源码契约核查，不能替代在线验证。
- 主进程串行写入与两次 mtime 检查可检测正常并发冲突；不合作的外部进程仍可能在最终 stat→rename 间写入，或主动保留 mtime，不能宣称跨进程原子 CAS。

可重复的 Electron 脚本：[`coding-studio.e2e.cjs`](../../desktop/scripts/coding-studio.e2e.cjs)，先在 desktop 执行 `npm run build`，再执行 `npm run e2e:coding`。诊断与原生截图写入工作树 `outputs/coding-studio-*`（不入库）；脚本不会操作现有用户项目或终止其他已运行的 Electron 进程。

## 建议验收场景

- 空项目中选模板，能继续编辑原始需求与名称；点击创建新建目录、将完整技术约束保存为 `FORSION_BRIEF.md`，并交付保留原文的可读草稿，不自动发送模型。
- 重名、路径穿越、系统保留名称、目录无权限或多次点击，不会创建到错误目录或覆盖旧项目。
- 打开已有本地文件夹不写入模板或触发构建。
- 短需求、中文和英文需求、窄分栏、深浅主题均能正常使用。
- 预览出错后仍能找到错误、带证据修改和返回已保存版本。
- 对用户展示的“完成”与真实执行结果一致。
