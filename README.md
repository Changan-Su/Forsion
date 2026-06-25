<div align="center">

# 🌳 Tangu Agent

**一个本地优先、隐私优先、自带多端的开源 AI Agent。**

终端 / 桌面 / 服务三种客户端共用同一引擎；自带 LLM 自选（API Key 直连 · 订阅账号登录 · 本地 Ollama · 云端托管），
还能在自己界面里直接驱动 Claude Code、Codex 等第三方 Agent。

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
- 🧰 **真能干活**：在本机跑命令、读写文件（带审批闸门）、docker 沙箱执行代码、看图、搜网页、接 MCP。
- 🪆 **还能指挥别的 Agent**：经 ACP 在 Tangu 里直接驱动 **Claude Code**、**Codex**，自动适配它们的模型与 slash 命令。
- 🔒 **本地优先**：会话、记忆、日志默认落在 `~/.tangu`，零安装的嵌入式数据库；云端同步是可选项，默认手动。

---

## ✨ 功能特性

### 多端，同一引擎
- **终端 TUI**（`tangu`）：Ink 终端界面，Markdown/代码高亮、工具卡片、状态栏、slash 命令、Tab 补全、`@文件`提及。进程内跑、无端口、嵌入式 DB。
- **桌面 GUI**（Electron + React）：完整图形界面，自带托管后端，开箱即用。提供 macOS `.dmg` / Windows `.exe` / Linux `.AppImage` 安装包。
- **Standalone 服务**（`tangu-server`）：无头 HTTP/SSE 服务，供桌面、远程或脚本调用。

### 接入任意 LLM
- **直连**任意 OpenAI 兼容端点（OpenAI、DeepSeek、Ollama 本地模型……），BYO-key。
- **订阅账号登录**：`tangu login claude / codex / xai`，用你的 Claude / ChatGPT / xAI 订阅额度当 LLM，**无需 API Key**（loopback + PKCE OAuth，带刷新）。
- **云端托管**（可选）：连 Forsion 云端共享大脑，跨设备共用记忆/技能。

### 外部 Agent 引擎（ACP）
- 在新会话开始处一键切换到 **Claude Code**、**Codex** 等第三方 Agent 框架，像用 Tangu 一样在主界面对话。
- 自动适配该引擎的模型选择与 slash 命令；本机已检测到才出现；一个会话从始至终用同一引擎。

### 工具与执行
- **本机执行**：`run_bash` + 真实文件读写（`read_file` / `write_file` / `edit_file` / `list_dir`），**三档审批**——只读 / 自动改文件 / 全自动。
- **结构化补丁** `apply_patch` + **文件越界安全闸**（路径超出工作区需确认）。
- **Docker 沙箱**：`run_python` 等隔离执行；无 docker 自动降级禁用。
- **图片识别**（`view_image`）、**本地浏览器工具**（网页搜索/交互，默认 DuckDuckGo）。
- **MCP**：连接任意 MCP server 扩展工具集。

### 智能体编排
- **群聊模式**：多个智能体围绕同一话题轮流发言、投票，可由主持人总结。
- **Normal Agent**：自定义可复用的对话人格（系统提示 + 模型 + 设置），`/agent` 一键切换。
- **Special Agent**（实验性，默认关）：Historian（自动总结标题/维护记忆）、Muse（后台产出 TODO）。
- **计划模式**：只读调研后提交计划，批准再执行。

### 记忆 · 技能 · 贴心细节
- **本地优先记忆**（`~/.tangu/memory`），可选与云端双向同步。
- **Skills**：兼容 Claude 技能格式，`/skill` 启用。
- **零安装数据库**：嵌入式 SQLite（WAL），落单文件 `~/.tangu/state.db`，TUI 与桌面**共享会话**。
- 中英双语、明暗主题、上下文用量条 + 一键压缩、微信远程（可选）。

---

## 🚀 快速开始

### 方式一：下载安装包（桌面用户）

到 **[Releases](https://github.com/Changan-Su/Tangu/releases)** 下载对应平台安装包：

| 平台 | 文件 |
|---|---|
| macOS | `Tangu-*.dmg` |
| Windows | `Tangu-*.exe` |
| Linux | `Tangu-*.AppImage` |

首次启动有引导：选连接方式 → 主题 → 模型 → 工作区。

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
tangu login --cloud-url https://api.forsion.app     # 登录后免 token
tangu --model <托管模型id>
```
> 云端模式跨设备共享记忆/技能；直连 provider（你自己的 key）则完全本地、不经云端、不产生云端计费。

> 审批档：`readonly`（写文件/跑命令都要批）· `auto-edit`（默认，改文件放行、命令需批）· `full-auto`（全放行）。会话内 `/approval <档>` 热切。

---

## 🔌 外部 Agent 引擎（Claude Code / Codex）

装了 [Claude Code](https://github.com/anthropics/claude-code) 或 [Codex](https://github.com/openai/codex) 后，Tangu 可经
**ACP（Agent Client Protocol）** 把整个对话委托给它们——零适配器代码，官方 ACP 桥即可：

- 桌面端：新会话顶部的引擎选择器切换；**设置 → Agent CLIs** 查看已检测到的引擎、设默认模型。
- 引擎自报的模型与 slash 命令自动接入主界面；外部引擎仅本地会话可用，且与群聊互斥。

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
| `profile` | appId / 沙箱模式 / 能力开关 |

由此派生出统一 run 契约（`POST /agent/runs` + SSE `GET /agent/runs/:id/events`）下的多种形态：

| 形态 | 入口 | 用途 |
|---|---|---|
| **TUI** | `dist/tui/main.js` | 终端 agent，host 执行 + 审批，无端口 |
| **standalone** | `dist/standalone/main.js` | 无头 HTTP/SSE，供桌面/远程/脚本 |
| **desktop** | `desktop/`（Electron） | 本地 GUI，内置或外接 standalone 后端 |
| **microserver / worker** | 云端 | 多租户网关 + 多机执行（不在开源核心） |

---

## 📁 项目结构

```
src/
├── index.ts        # 包入口:createTanguModule(deps)
├── seams/          # 接缝定义(host / brain / billing / profile / runtime)
├── core/           # 纯类型 + DB/HTTP 垫片
├── services/       # agentLoop / eventBus / runStore / approvals / 群聊 / 记忆同步 —— 运行时本体
├── engines/        # 外部 Agent 引擎(ACP:Claude Code / Codex)
├── tools/          # 工具注册表 / hostExec(真实FS+shell) / apply_patch / fsPolicy / 文件工作区
├── sandbox/        # docker 会话沙箱(run_python)
├── llm/            # 多 provider:openaiCompat 直连 + providerOAuth(订阅登录) + providerRegistry
├── routes/         # /agent/runs(+SSE) / engines / workspace / memory …
├── mcp/            # MCP 客户端管理
├── skills/         # 本地技能(兼容 Claude 技能格式)
├── tui/            # Ink 终端 UI(`tangu`)
├── standalone/     # standalone 入口(`tangu-server`)
└── db/             # 迁移 + schema
desktop/            # Electron + React 本地 GUI(构建隔离,自带 electron-vite)
```

---

## ⚙️ 配置（`~/.tangu`）

本地家目录，单一事实来源（可用环境变量 `TANGU_HOME` 整体重定向）：

```
~/.tangu/
├── auth.json            # 云端凭证 { cloudUrl, token, model }
├── provider-auth.json   # 订阅账号 OAuth 凭证(claude/codex/xai)
├── providers.json       # 直连 provider 配置
├── mcp.json             # MCP server 配置
├── skills/              # 本地技能
├── memory/              # 本地记忆 / 日志(可选同步云端)
├── engine-prefs.json    # 外部引擎默认模型
└── state.db             # 嵌入式 SQLite 会话库(TUI/桌面共享)
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

---

## 🤝 贡献

欢迎 Issue 与 PR。建议：

1. 先 `npm test && npm run typecheck` 跑绿。
2. 改动工具注册表后跑 `node scripts/dump-tooldefs.mjs` 更新快照。
3. 非平凡逻辑请附最小可运行的测试。

---

## 📄 许可证

[Apache License 2.0](./LICENSE) © Forsion / Tangu 贡献者
