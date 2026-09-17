---
title: Forsion 是什么
description: Forsion Second Brain：知识与记忆、主动式 Agent、多 Agent 协作和可扩展工作区。
---

# Forsion 是什么

**不止记下来，还能接着做下去。**

Forsion（扶桑）是一个**本地优先的 AI 第二大脑**：在自己的 Markdown 文件上用块编辑整理知识，让可编辑的长期记忆保留背景，和不同人格的 Agent 一起思考，用 TEAM 并行推进项目，再由 Muse 在授权范围内继续跟进。

**记录与连接 → 记住背景 → 团队思考与执行 → 主动跟进 → 成果沉淀。** 插件为这条路径补充工具、技能与工作空间，前一次积累成为下一次工作的起点。

Forsion is a **local-first AI second brain**: block editing on your own Markdown files, editable long-term memory, Agents with distinct perspectives, persistent TEAMs for parallel work, and Muse for proactive follow-up. Plugins extend the tools and workspace; results return to the project and become a starting point for what comes next.

## 第二大脑如何接上你的工作 / How it connects your work

| 能力 / Capability | 使用价值 / Value |
| --- | --- |
| [块编辑与知识库](../amadeus/editor.md) / Markdown blocks | 直观组织本地文件，连接来源与产物。 / Organize local files and connect sources to outputs. |
| [长期记忆](../agents/memory.md) / Memory | 检查、修改并沿用重要背景。 / Inspect, revise, and reuse useful context. |
| [TEAM 与 Team Desk](../chat/group-chat.md) / [TEAM](../chat/group-chat.en.md) | 保存成员与职责，看见并行工作过程。 / Retain roles and follow parallel work. |
| [Muse](../agents/muse.md) / Follow-up | 在配置范围内持续跟进，将结果带回收件箱。 / Follow up within configured boundaries and report to Inbox. |
| [插件](../customization/plugins.md) / Plugins | 加入工具、Agent、技能与工作空间。 / Add tools, Agents, skills, and workspaces. |

## 产品家族

| 名字 | 是什么 |
|------|--------|
| **Tangu 引擎** | 智能体引擎,整个系统的大脑。负责跑模型、调用工具、管理 Agent 与会话。它嵌在桌面应用里开箱即用,也可以独立跑在服务器或终端里 |
| **Forsion Desktop** | 桌面应用(macOS / Windows / Linux),本文档的主角。Tangu 引擎 + 可停靠的标签页工作区 + 各种功能空间 |
| **Amadeus** | 内置笔记系统:本地 Markdown 库、双链、多维表、白板、仪表盘、PDF 批注、日历,格式与 Obsidian 兼容 |
| **Forsion Web** | 浏览器版云客户端,不装应用也能用;手机上访问会自动切成移动界面 |
| **Forsion Mobile** | Android 版,一套为触屏重做的界面:推开式侧栏、常驻标签页切换、笔记底部编辑工具栏 |
| **Tangu CLI** | 终端里的 Tangu,随桌面端一键安装,跟着桌面端一起更新 |
| **网页应用(Forsion Connect)** | 你在[编码空间](../spaces/coding.md)里做出来的网页,一键发布即得公开链接;访客用自己的 Forsion 账号付 AI 用量,页面里还能直接调用云端 Agent。填一句简介即可申请上架应用市场的「网站应用」分类 |

桌面、浏览器、手机是**同一套账号与同一批会话**:电脑上聊到一半,手机打开接着聊,Agent 的记忆和笔记也跟着走。详见[浏览器版与移动端](../reference/web-and-mobile.md)。

## 设计理念

**本地优先。** 你的笔记是磁盘上的 Markdown 文件,Agent 的记忆是你能打开编辑的文本,配置是一个 JSON。卸载 Forsion,你的数据还在,还能用任何编辑器打开。使用云端模型、账号同步或共享时，相应内容会发送到所用服务；请按实际连接与设置检查数据流向。详见[数据与隐私](../reference/data-and-privacy.md)。

**Agent 是长期伙伴,不是一次性会话。** 每个 Agent 有自己的人格设定、独立记忆、资料库和日志,越用越懂你。详见 [Agent 总览](../agents/overview.md)。

**AI 应该主动。** 除了"你问我答",Forsion 有一整套让 AI 自己动起来的机制:

- [Muse](../agents/muse.md) 按你定的规则盯着事情,该提醒时提醒;
- [自动化](../spaces/automation.md)是"触发 × 动作链"——定时、事件、笔记里的一颗按钮都能当触发器,触发后可以串起发通知、跑 Agent、直接调工具好几步;
- 结果统一落到[收件箱](../spaces/inbox.md),重要的还能转发到微信 / Telegram / QQ;
- 反过来,你也可以从[通道](../chat/channels.md)那头找 AI:在手机上给微信里的它发一句话,它在电脑这边干活;
- 干完的活不只是一段文字。[Agent Desk](../chat/agent-desk.md) 会把笔记、图片、网页、代码这类产物摆在聊天右侧,写文件的过程能实时看到。

**一切可换。** 模型服务商可换、外观主题可换、功能空间可增删、插件可装——[应用市场](../customization/market.md)里技能、代理、插件、空间、主题、网站应用六类一站式安装。

## 下一步

- [安装与更新](installation.md)
- [快速上手](quickstart.md)
- [核心概念](concepts.md)
