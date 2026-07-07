<div align="center">

# 🌳 Tangu Agent

**一个本地优先、隐私优先、自带多端的开源 AI Agent。**

终端 / 桌面 / 服务三种客户端共用同一引擎；LLM 任你自选（API Key 直连 · 订阅账号登录 · 本地 Ollama · 云端托管），
还能在自己的界面里直接驱动 Claude Code、Codex 等第三方 Agent。桌面端是一套 Obsidian 式可停靠工作台。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Build](https://github.com/Changan-Su/Tangu/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/Changan-Su/Tangu/actions/workflows/build-desktop.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555)

[功能特性](#-功能特性) · [快速开始](#-快速开始) · [接入 LLM](#-接入-llm三选一) · [外部引擎](#-外部-agent-引擎claude-code--codex) · [架构](#-架构一套-core--四个接缝) · [贡献](#-贡献)

</div>

---

## 这是什么

**Tangu** 是一个开源的 AI Agent 运行时与配套客户端。它的内核与「在哪运行、用谁的模型、谁来计费」彻底解耦——
同一套代码可以是你电脑上的终端 agent、一个桌面 App、一个无头 HTTP 服务，也可以作为云端微服务横向扩展。

对个人用户，它是一个**装好即用、数据留在本机**的编程/通用 Agent：

- 🔌 **用什么模型你说了算**：任意 OpenAI 兼容端点直连、用 Claude / ChatGPT / xAI **订阅账号** OAuth 登录、本地 Ollama，或连云端托管。
- 🧰 **真能干活**：在本机跑命令、读写文件（带审批闸门）、docker 沙箱执行 Python、看图、生成图、搜网页、接 MCP。
- 🪆 **还能指挥别的 Agent**：经 ACP 在 Tangu 里直接驱动 **Claude Code**、**Codex**，自动适配它们的模型与 slash 命令。
- 👥 **会协作**：多智能体群聊投票、后台讨论、子任务委派、运行中插话改方向（steering）。
- 🪟 **桌面像 IDE**：Obsidian 式可停靠工作台，面板拖拽/分屏/堆叠、布局记忆、命令面板（Cmd+K）、多套主题。
- 🔒 **本地优先**：会话、记忆、日志、技能、智能体默认落在 `~/.tangu`，零安装的嵌入式数据库；云端同步是可选项，默认手动。

---

## ✨ 功能特性

### 🪟 多端，同一引擎

- **终端 TUI**（`tangu`）：Ink 终端界面，Markdown/代码高亮、工具卡片、状态栏、slash 命令、Tab 补全、`@文件`提及。进程内跑、无端口、嵌入式 DB。
- **桌面 GUI**（Electron + React）：完整图形界面，自带托管后端，开箱即用。提供 macOS `.dmg` / Windows `.exe` / Linux `.AppImage` 安装包。
- **Standalone 服务**（`tangu-server`）：无头 HTTP/SSE 服务，供桌面、远程或脚本调用。

三端**共享同一份 `~/.tangu` 数据**（会话、记忆、技能、智能体），TUI 里开的对话桌面端能直接接着聊。

### 🧩 Obsidian 式桌面工作台

桌面端不是固定三栏，而是一套**可停靠工作区引擎**（类 Obsidian / VS Code）：

- **拖拽 / 分屏 / 堆叠**：任意视图开在任意面板，左右拖动、上下分屏、叠成标签页——把两个对话、文件树、目录并排同窗。
- **布局自动记忆**：关掉重开还原上次布局；左右侧栏可一键折叠且不丢面板。
- **命令面板**（`Cmd/Ctrl+K`）：模糊搜索所有命令、键盘直达；快捷键可自定义重绑（mac 显示 ⌘、Win/Linux 显示 Ctrl）。
- **内置视图**：会话列表、对话、工作区文件浏览+预览、正文目录（ToC）、当前 Agent 记忆、子聊天/分支——侧栏按需开关；标签栏「＋」开空白启动器选视图。
- **多套主题**：设计语言（扁平纸张 / 圆润浮卡 / 磁盘自定义主题）× 配色皮肤（奶油 / 珊瑚 / 青 / 薰衣草 / 自定义取色）× 明暗 × 毛玻璃，切换带过渡动画；主题可从 `~/.tangu/themes/` 磁盘加载。
- **贴心**：首启引导向导、环境自检（node/python/git/docker 一键装）、会话日志导出、应用内自动更新（Win/Linux 全自动；macOS 检测到新版给下载指引）。

### 🧠 接入任意 LLM

- **直连**任意 OpenAI 兼容端点（OpenAI、DeepSeek、Ollama 本地模型……），BYO-key。
- **订阅账号登录**：`tangu login claude / codex / xai`，用你的 Claude / ChatGPT / xAI 订阅额度当 LLM，**无需 API Key**（loopback + PKCE OAuth，自动刷新）。
- **云端托管**（可选）：连 Forsion 云端共享大脑，跨设备共用记忆/技能。
- 多 provider 统一注册表，直连 / 订阅 / 云端混用、按模型路由。

### 🪆 外部 Agent 引擎（ACP）

- 在新会话开始处一键切换到 **Claude Code**、**Codex** 等第三方 Agent 框架，像用 Tangu 一样在主界面对话。
- 经官方 **ACP（Agent Client Protocol）** 桥接，零适配器代码；自动接入该引擎的模型选择与 slash 命令，并把它的权限请求桥接到 Tangu 的审批系统。
- 本机检测到才出现（基于 `~/.claude` / `~/.codex` 等）；外部引擎仅本地会话可用，且与群聊互斥。

### 🧰 工具与执行

- **本机执行**：`run_bash` + 真实文件读写（read / write / edit / list / 搜索 / glob）+ **结构化补丁** `apply_patch`，**三档审批**——只读 / 自动改文件 / 全自动，会话内 `/approval` 热切。
- **文件安全闸**（fsPolicy）：硬拒敏感目录（`.git` / `~/.ssh` / `~/.aws` / 云密钥…），越出工作区的写入升级为人工确认。
- **后台进程**：`run_background` 起长任务、轮询输出、发交互输入、SIGTERM/SIGKILL 终止。
- **Docker 沙箱**：`run_python`（Python 3.12，自动同步工作区，预装 20+ 库）+ 按需 `pip_install`；无 docker 自动降级禁用。
- **看图 / 生成图**：`view_image` 识图、`generate_image` 文生图（行内缩略图）。
- **联网**：本地浏览器工具（搜索 DuckDuckGo/Bing/Google/Baidu + 读 a11y 树 + 点击/输入/滚动/执行 JS）、`web_search`、`web_fetch`（带 SSRF 防护，拦内网/元数据地址）。
- **MCP**：连接任意 MCP server（stdio / HTTP / SSE）扩展工具集。
- 还有 `todo`、`memory_log`、`get_datetime`、`calculator` 等贴身小工具。

### 👥 智能体编排

- **文件夹化智能体**：每个 Agent 是 `~/.tangu/agents/<slug>/` 下一个文件夹（`config.toml` 人格/模型/工具 + `SOUL.md` 灵魂设定 + `MEMORY.md` 长期记忆 + `LOG/` 每日日志 + `Library/` 资料库 + `skills/` 专属技能），可读可改可版本化。内置默认智能体自带长期记忆与日志。
- **全局用户画像** `USER.md`：你的背景与偏好，所有 Agent 共享可见（带引导模板）。
- **`manage_agent` 工具**：Agent 可自行新建/改/删可复用人格，把沉淀下来的角色持久化（本地）。
- **群聊模式**：多个智能体围绕同一话题轮流发言、每轮投票、可由主持人总结（纯编排，本地/桌面）。
- **讨论 & 子代理**：`@讨论` 在后台拉一个两两讨论、等结论回来不阻塞主线；`delegate` 派子任务给隔离的子 Agent，只回最终结论、不污染上下文。
- **运行中插话（steering）**：run 还在跑时继续发消息，在迭代边界注入、**不打断**当前任务。
- **计划模式**：先只读调研、提交计划，批准后再执行。
- **Special Agent**（实验性，默认关）：Historian 后台总结闲置会话写进日志；Muse 后台持续产出高价值 TODO。

> 群聊 / 讨论 / 子代理 / 计划模式 / `manage_agent` / Muse 为**本地·桌面**能力（需 host 执行）；云端多租户形态不开放。

### 📒 记忆 · 技能 · 上下文

- **本地优先记忆**（`~/.tangu/memory` + 每-Agent `MEMORY.md`/`LOG/`），可选与云端 Brain **双向同步**（记忆 LWW、日志按设备追加合并），默认手动。
- **Skills（技能）**：兼容 Claude 技能格式，内置 8 个开箱即用——`code-review` · `data-analysis-python` · `debugging-methodology` · `document-writing-cn` · `git-workflow` · `web-research` · `manage-agents-guide` · `skill-creator`（教 Agent 自己写技能）。首启自动落进 `~/.tangu/skills/`（可见可改），`use_skill` 按需懒加载、不撑爆提示词。
- **技能四级作用域**：技能按 **内置 < 用户 `~/.tangu/skills` < 当前智能体 `agents/<slug>/skills`（含该 Agent 随包自带的默认技能）< 当前项目 `<cwd>/.forsion/skills`** 叠加，越具体越优先（同 id 覆盖）——让某个 Agent 或某个项目带自己的专属技能。
- **上下文管理**：CJK 友好的 token 估算 + 输入闸门；过半自动折叠工具输出/中段消息，95% 强制压缩并留持久检查点；上下文用量条 + 一键压缩。
- **每-run 花费上限**（`TANGU_MAX_RUN_COST`）：单次运行点数硬顶，挡住工具死循环烧额度。
- **零安装数据库**：嵌入式 SQLite（WAL），落单文件 `~/.tangu/state.db`，TUI 与桌面**共享会话**。

### 🌐 其它

- 中英双语界面，一键切换。
- 微信远程（可选）：经官方 iLink bot 多账号接管，消息去重 + 输入态。
- Forsion 应用市场（可选，连云端）：桌面端浏览 / 一键安装 skills · agents · plugins 到 `~/.tangu`。

---

## 🚀 快速开始

### 方式一：下载安装包（桌面用户）

到 **[Releases](https://github.com/Changan-Su/Tangu/releases)** 下载对应平台安装包：

| 平台 | 文件 |
|---|---|
| macOS | `Tangu-*.dmg` |
| Windows | `Tangu-*.exe` |
| Linux | `Tangu-*.AppImage` |

首次启动有引导：选连接方式 → 主题 → 模型 → 工作区 → 环境自检。

> macOS 提示：本 App 暂未做 Apple 公证。若首次打开提示「已损坏 / 无法验证开发者」，请**右键 → 打开**，或在「系统设置 → 隐私与安全性」点「仍要打开」（dmg 内附有说明文件）。

### 方式二：从源码运行

需要 **Node.js ≥ 20**。

```bash
git clone https://github.com/Changan-Su/Tangu.git
cd Tangu
npm install
npm run build        # tsc → dist/
```

然后任选一个客户端：

```bash
# 终端 TUI（建议 npm link 后用 tangu，下文均以 tangu 示例）
node dist/tui/main.js --help

# 无头服务（给桌面/远程/脚本用）
node dist/standalone/main.js --help

# 桌面 GUI（自带托管后端）
npm run desktop:install
npm run desktop:dev
```

---

## 🧠 接入 LLM（三选一）

Tangu 不绑定任何一家模型。任选其一即可开聊：

**① 订阅账号登录（推荐，免 API Key）**

```bash
tangu login claude        # 用 Claude 订阅额度；codex=ChatGPT，xai=xAI Grok
tangu --model claude/<模型id>
```
> 浏览器登录、token 自动存 `~/.tangu/provider-auth.json`（带刷新），之后免登录。

**② 直连任意 OpenAI 兼容端点（BYO-key / 本地）**

```bash
# 本地 Ollama，全程不出网
tangu --provider ollama --provider-base-url http://localhost:11434/v1 --model ollama/llama3

# 任意 OpenAI 兼容服务：设置里填 Base URL / API Key 即可（桌面端可一键拉取模型列表）
```

**③ 连云端托管大脑（可选）**

```bash
tangu login --cloud-url https://api.forsion.net     # 登录后免 token
tangu --model <托管模型id>
```
> 云端模式跨设备共享记忆/技能；直连 provider（你自己的 key）则完全本地、不经云端、不产生云端计费。

> 审批档：`readonly`（写文件/跑命令都要批）· `auto-edit`（默认，改文件放行、命令需批）· `full-auto`（全放行）。会话内 `/approval <档>` 热切。

---

## 🔌 外部 Agent 引擎（Claude Code / Codex）

装了 [Claude Code](https://github.com/anthropics/claude-code) 或 [Codex](https://github.com/openai/codex) 后，Tangu 可经
**ACP（Agent Client Protocol）** 把整个对话委托给它们——零适配器代码，官方 ACP 桥即可：

- 桌面端：新会话顶部的引擎选择器切换；**设置 → Agent CLIs** 查看已检测到的引擎、设默认模型。
- 引擎自报的模型与 slash 命令自动接入主界面；它的权限请求桥接到 Tangu 审批；外部引擎仅本地会话可用，且与群聊互斥。

> 检测基于 `~/.claude` / `~/.codex` 配置目录、相关环境变量或可执行文件路径——装了/登录过即自动出现。

---

## 🏗️ 架构：一套 Core + 四个接缝

运行时本体是 `createTanguModule({ host, brain, billing, profile })`。**「运行模式」= 往这四个槽插不同实现**，
core loop 逻辑不随模式改变，差异全部收敛进注入的适配器：

| 注入点 | 是什么 |
|---|---|
| `host` | DB / 鉴权 / 日志（默认嵌入式 SQLite，零安装） |
| `brain` | LLM / 用户 / 记忆 / 技能 / 搜索 / 存储 |
| `billing` | 配额 / 计费 / 用量（开源单机形态为 noop） |
| `profile` | appId / 沙箱模式 / 能力开关（群聊·host 执行等） |

由此派生出统一 run 契约（`POST /agent/runs` + SSE `GET /agent/runs/:id/events`）下的多种形态：

| 形态 | 入口 | 用途 |
|---|---|---|
| **TUI** | `dist/tui/main.js` | 终端 agent，host 执行 + 审批，无端口 |
| **standalone** | `dist/standalone/main.js` | 无头 HTTP/SSE，供桌面/远程/脚本 |
| **desktop** | `desktop/`（Electron） | 本地 GUI（Obsidian 式工作台），内置或外接 standalone 后端 |
| **microserver / worker** | 云端 | 多租户网关 + 多机执行（不在开源核心） |

---

## 📁 项目结构

```
src/
├── index.ts        # 包入口:createTanguModule(deps)
├── seams/          # 接缝定义(host / brain / billing / profile / runtime)
├── core/           # 纯类型 + DB/HTTP 垫片 + ~/.tangu 家目录
├── agents/         # 文件夹化智能体(config.toml/SOUL.md/MEMORY.md/LOG) + 默认 Agent + USER.md
├── services/       # agentLoop / 群聊 / 讨论 / 子代理 / steering / 压缩 / 记忆同步 / 花费上限 —— 运行时本体
├── engines/        # 外部 Agent 引擎(ACP:Claude Code / Codex)
├── tools/          # 工具注册表 / hostExec(真实FS+shell) / apply_patch / fsPolicy / 浏览器 / 文件工作区
├── sandbox/        # docker 会话沙箱(run_python)
├── llm/            # 多 provider:openaiCompat 直连 + providerOAuth(订阅登录) + providerRegistry
├── routes/         # /agent/runs(+SSE) / engines / workspace / memory …
├── mcp/            # MCP 客户端管理
├── skills/         # 本地技能(内置 + ~/.tangu/skills,兼容 Claude 技能格式)
├── wechat/         # 微信 iLink 远程(可选)
├── tui/            # Ink 终端 UI(`tangu`)
├── standalone/     # standalone 入口(`tangu-server`)
└── db/             # 迁移 + schema
desktop/            # Electron + React 本地 GUI:engine/ 是 Obsidian 式工作区引擎(构建隔离,自带 electron-vite)
skills/             # 全局内置技能源(打包随安装包分发,首启 seed 进 ~/.tangu/skills)
agent-skills/       # 内置智能体的随包默认技能(agent-skills/<slug>/;该 Agent 激活时按 agent 级加载)
```

---

## ⚙️ 配置（`~/.tangu`）

本地家目录，单一事实来源（可用环境变量 `TANGU_HOME` 整体重定向）：

```
~/.tangu/
├── config.json         # 统一配置(单一真源:云端地址/模型/审批/沙箱…)
├── auth.json           # 云端凭证 { cloudUrl, token, model }
├── provider-auth.json  # 订阅账号 OAuth 凭证(claude/codex/xai)
├── providers.json      # 直连 provider 配置
├── engines.json        # 外部 Agent 引擎(ACP)配置 / 默认模型
├── mcp.json            # MCP server 配置
├── agents/             # 文件夹化智能体(每 Agent 一个目录)
├── skills/             # 技能(内置首启 seed + 你自己的)
├── themes/             # 磁盘自定义主题
├── memory/             # 本地记忆 / 日志(可选同步云端)
├── wechat/             # 微信凭证(可选)
└── state.db            # 嵌入式 SQLite 会话库(TUI/桌面共享)
```

模板见 [`example.env`](./example.env)；各客户端均支持 `--help` 查看全部参数。

---

## 🛠️ 开发

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

桌面端构建隔离，自带 `electron-vite`：`npm run desktop:dev`（dev 用系统 node 跑后端，免原生模块重建）。

> CI：仅 **推送 `v*` 版本 tag**（或在 Actions 手动触发）才会运行测试并构建三平台安装包、发布 Release——日常 push 不触发，详见 [`.github/workflows/build-desktop.yml`](./.github/workflows/build-desktop.yml)。

### 编写插件

第三方插件 = 一个含 `tangu-plugin.json`（`apiVersion` 须等于核心的 `TANGU_PLUGIN_API`，见 `src/plugins/types.ts`）+ 预构建 ESM 入口的文件夹，放进 `~/.forsion/plugins/<id>/` 即被动态加载（或经 Forsion Market 分发）。

- **类型契约**：[`plugin-api/tangu-agent.d.ts`](./plugin-api/tangu-agent.d.ts) 是稳定公开 API 的单一真源——插件用 tsconfig `paths` 把 `@forsion/tangu-agent` 映射到它的拷贝，**只允许 `import type`**（运行时能力全走 `activate(ctx)` 传入的 `ctx.sdk`，否则会复制核心单例）。改契约后跑 `npm run sync:plugin-api`；与真类型的兼容由 `src/plugins/apiContract.ts` 随 typecheck 双向断言。
- **上手模板**：独立示例仓 [tangu-sample-plugin](https://github.com/Changan-Su/tangu-sample-plugin)（工具 + 设置 schema + promptSection 全演示）；`plugins/` 下的 stickers / reply-segment 是真实案例。纯数据扩展另有各自模板仓：[tangu-sample-theme](https://github.com/Changan-Su/tangu-sample-theme)（主题包）、[tangu-sample-space](https://github.com/Changan-Su/tangu-sample-space)（Space 配方）、[tangu-sample-agent](https://github.com/Changan-Su/tangu-sample-agent)（智能体）。
- 注意：编辑器（Amadeus 笔记）插件是另一套系统——`manifest.json + main.js` 放 vault 的 `.amadeus/plugins/` 或全局 `~/.forsion/amadeus/plugins/`，见桌面端设置 → 笔记插件。

---

## 🤝 贡献

欢迎 Issue 与 PR。建议：

1. 先 `npm test && npm run typecheck` 跑绿。
2. 改动工具注册表后跑 `node scripts/dump-tooldefs.mjs` 更新快照。
3. 非平凡逻辑请附最小可运行的测试。

---

## 📄 许可证

[Apache License 2.0](./LICENSE) © Forsion / Tangu 贡献者
