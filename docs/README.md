---
title: Forsion 文档中心
description: Forsion 桌面 AI 工作台的使用文档——对话、Agent、笔记、自动化、扩展,以及整个产品家族。
---

# Forsion 文档中心

Forsion(扶桑)是一个**本地优先的 AI 工作台**。它以 **Tangu** 智能体引擎为核心,把对话、笔记(**Amadeus**)、日历、自动化、收件箱、编码装进一个可自由布局的工作区——AI 不只回答问题,还能记笔记、管日程、盯任务、写代码并当场预览。

你可以用官方云端模型开箱即用,也可以带自己的 API Key、订阅账号甚至本地模型。笔记是磁盘上的 Markdown,记忆是你能打开编辑的文本,云端能力全部是可选叠加。

> 📌 本文档对应 **Forsion Desktop 2.7.x**。每个版本具体改了什么,看应用内的 设置 → 关于 → 更新日志,或 [GitHub Releases](https://github.com/Changan-Su/Forsion/releases)。

## 从哪儿开始

| 你想做的事 | 从这里看起 |
|---|---|
| 第一次用,先跑通 | [安装与更新](getting-started/installation.md) → [快速上手](getting-started/quickstart.md) |
| 搞清楚界面怎么用 | [工作区与界面](getting-started/workspace.md) |
| 接自己的模型 / API Key | [模型与接入方式](chat/models-and-providers.md) |
| 让 AI 动手做事,而不只是聊天 | [工具与审批](chat/tools-and-approvals.md) → [自动化](spaces/automation.md) |
| 从 Obsidian 迁过来 | [Amadeus 总览](amadeus/overview.md) → [编辑器](amadeus/editor.md) |
| 在手机 / 浏览器上用 | [浏览器版与移动端](reference/web-and-mobile.md) |
| 把工作台改造成自己的样子 | [插件](customization/plugins.md) → [应用市场](customization/market.md) |
| 出问题了 | [常见问题](reference/faq.md) |

## 入门

- [Forsion 是什么](getting-started/introduction.md) — 产品家族与设计理念
- [安装与更新](getting-started/installation.md) — macOS / Windows / Linux、更新通道、运行环境
- [快速上手](getting-started/quickstart.md) — 十分钟跑通第一次对话与第一篇笔记
- [核心概念](getting-started/concepts.md) — Agent、会话、Space、审批档位这些词各指什么
- [工作区与界面](getting-started/workspace.md) — Ribbon、标签页、状态栏、通知、内置浏览器与终端

## 对话

- [对话基础](chat/basics.md) — 流式输出、分支与编辑、斜杠命令、插话与打断
- [模型与接入方式](chat/models-and-providers.md) — 官方云端、自带 Key、订阅登录、思考档位、辅助模型
- [工具与审批](chat/tools-and-approvals.md) — 审批四档、计划模式、工作范围、MCP、项目指令文件
- [附件与图片](chat/attachments-and-vision.md) — 发图识图、文件预览、AI 生成的文件
- [Agent Desk 与任务概览](chat/agent-desk.md) — 让成果摆在聊天旁边,而不是埋进消息流
- [群聊模式](chat/group-chat.md) — 多个 Agent 同场讨论
- [通道](chat/channels.md) — 从微信 / Telegram / QQ 直接使唤你的 Agent

## Agent

- [Agent 总览](agents/overview.md) — 创建、人格(SOUL)、资料库、子任务与自我脑暴
- [记忆系统](agents/memory.md) — 每个 Agent 独立记忆,本地优先、跨端一致
- [Muse 主动助理](agents/muse.md) — 盯任务、活动感知、主动找你
- [技能(Skills)](agents/skills.md) — 给 AI 装"做事说明书"
- [外部引擎](agents/external-engines.md) — 接入 Claude Code 等第三方智能体

## Amadeus 笔记

- [Amadeus 总览](amadeus/overview.md) — 本地 Markdown 库,与 Obsidian 兼容
- [编辑器](amadeus/editor.md) — 块编辑、斜杠菜单、折叠、标注、源码开关
- [双链与属性](amadeus/links-and-properties.md) — `[[双链]]`、子笔记、页面属性、改名自动跟随
- [多维表](amadeus/databases.md) — 列类型、多视图、筛选排序统计
- [白板](amadeus/whiteboard.md) — Excalidraw 兼容的无限画布、纸张与多页
- [仪表盘](amadeus/dashboard.md) — 网格里摆卡片,把任何东西摆成一个面板
- [PDF 批注](amadeus/pdf-annotation.md) — 批注直接写进 PDF 文件
- [日历](amadeus/calendar.md) — 把表格与待办装进日历,订阅外部日历
- [在线同步与共享](amadeus/cloud-and-sharing.md) — 云端库、第三方网盘、页面分享

## 空间(Spaces)

- [Space 总览](spaces/overview.md) — 功能空间的概念与管理
- [自动化](spaces/automation.md) — 触发 × 动作链,让 Agent 自己干活
- [收件箱](spaces/inbox.md) — Agent 主动发给你的消息
- [编码空间与发布](spaces/coding.md) — 写网页立即预览,一键发布成网页应用

## 个性化

- [外观与主题](customization/themes.md) — 设计语言、配色、玻璃、字体三档
- [插件](customization/plugins.md) — 桌面插件与引擎插件、捆绑包、扩展点、安全模型
- [应用市场](customization/market.md) — 技能 / 代理 / 插件 / 空间 / 主题 / 网站应用
- [成就系统](customization/achievements.md) — 边探索边解锁

## 参考

- [账号、额度与积分](reference/account-and-quota.md) — 周额度、重置卡、积分、邀请与兑换
- [命令行(Tangu CLI)](reference/cli.md) — 在终端里使用 Tangu
- [浏览器版与移动端](reference/web-and-mobile.md) — Forsion Web 与 Android 版
- [数据与隐私](reference/data-and-privacy.md) — 数据存在哪、什么会上云
- [常见问题](reference/faq.md) — 排障速查

## 还是没找到答案

- 界面里的说法与文档不一致时,**以应用内为准**——文档按版本推进,细节可能滞后一两个版本。
- 功能类问题先翻 [常见问题](reference/faq.md);版本相关的变化看 设置 → 关于 → 更新日志。
- 官网:[forsion.net](https://forsion.net) ｜ 反馈与提问:[GitHub Issues](https://github.com/Changan-Su/Forsion/issues)
