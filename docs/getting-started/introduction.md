---
title: Forsion 是什么
description: 产品家族总览:Tangu 引擎、Forsion Desktop、Amadeus 笔记,以及它们背后的设计理念。
---

# Forsion 是什么

Forsion(扶桑)是一个 **AI 工作台**:AI 在这里不只回答问题,还能记笔记、管日程、盯任务、跑自动化、写代码并当场预览——而这一切都发生在你自己的电脑上。

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

**本地优先。** 你的笔记是磁盘上的 Markdown 文件,Agent 的记忆是你能打开编辑的文本,配置是一个 JSON。卸载 Forsion,你的数据还在,还能用任何编辑器打开。云端能力(在线同步、共享、云端模型)全部是可选叠加,不开就不上传。详见[数据与隐私](../reference/data-and-privacy.md)。

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
