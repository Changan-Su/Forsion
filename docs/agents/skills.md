---
title: 技能(Skills)
description: 给 AI 装"做事说明书":可安装、可自写、按需加载。
---

# 技能(Skills)

技能是一份**做事说明书**:教 AI 某件具体事情的正确做法——怎么写周报、怎么整理发票、怎么按你团队的规范提交代码。装上技能,AI 在遇到对应任务时就会照着做。

## 技能与人格、记忆的分工

- **人格(SOUL)**:它是谁 → 恒定的性格与原则;
- **[记忆](memory.md)(MEMORY)**:它知道你什么 → 相处中积累;
- **技能(Skill)**:它会做什么 → 具体任务的操作手册。

## 按需加载

技能不会一股脑塞进每次对话。AI 先看到的只是技能清单和一句话简介,判断当前任务需要时才展开完整内容——所以装几十个技能也不会拖慢日常对话。

## 获取技能

- **应用市场**:市场的"技能"分类里一键安装,见[应用市场](../customization/market.md);
- **随插件包**:一个[插件](../customization/plugins.md)捆绑包可以同时带引擎插件、Agent、技能和 Space,装一次全就位;
- **自己写**:一个文件夹 + 一份 `SKILL.md` 说明书就是一个技能。用 Markdown 写清楚"什么时候用、步骤是什么、注意什么"即可——你甚至可以让 AI 帮你把一段成功的操作总结成技能。

## 内置技能:Forsion 扩展开发

Forsion 自带一个「Forsion 扩展开发」技能。装着它的 Agent 可以照官方模板给你脚手架出**插件 / 主题 / Space / 智能体**——你描述想要什么,它按模板搭出可以继续改的雏形,省掉从零翻文档的那一段。

做出来的东西怎么装、怎么管,见[插件](../customization/plugins.md)与[外观与主题](../customization/themes.md)。

## 引擎插件的 npm 通道

Tangu 引擎插件除了应用市场,也可以从 npm 安装:

```
tangu install npm:<包名>
```

这条通道只拉取包内容、**不执行任何安装脚本**,校验完整性后才落位。命令行的其他用法见[命令行(Tangu CLI)](../reference/cli.md)。

## 管理

设置里的「技能」分区:查看已装技能、启用 / 停用、决定哪些 Agent 默认可用。

## 下一步

- [Agent 总览](overview.md)
- [应用市场](../customization/market.md)
- [插件](../customization/plugins.md)
- [命令行(Tangu CLI)](../reference/cli.md)
