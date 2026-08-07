---
title: 外部引擎
description: 在 Forsion 里跑 Claude Code、Codex 等第三方智能体,共用同一套会话与界面。
---

# 外部引擎

除了内置的 Tangu 引擎,Forsion 还能作为**宿主**接入第三方智能体引擎(基于 ACP,Agent Client Protocol 生态)——比如把本机的 Claude Code、Codex 挂进来,让它们在 Forsion 的界面里干活。

## 为什么要接外部引擎

- 你已经在用某个专业智能体(如专精编码的 Claude Code),想要它的能力,但更想要 Forsion 的**统一界面**:会话管理、历史记录、与笔记 / Space 的联动;
- 不同任务用不同引擎:日常对话用 Tangu,重型编码任务委托给外部引擎;
- 想用某个引擎背后的**订阅额度**(见下文「用 Claude 订阅额度」)。

## 怎么用

前提是这台机器上已经装好并登录了对应的命令行工具。

新会话开始处有一条「运行引擎」选择条,列出本机**已检测到**的引擎,选一个即可。之后与这个会话对话时,**整一轮**都委托给该引擎的子进程执行,输出照常流式显示在 Forsion 里;模型选择器和斜杠命令也自动切换成那个引擎自己的一套。

一个会话从始至终使用同一种引擎,中途不换。

## 用 Claude 订阅额度

要把 Claude 订阅额度用在 Forsion 里,走外部引擎:

1. 在本机装好 Claude Code 并用你的订阅登录它;
2. 新会话时在「运行引擎」里选它。

登录状态与用量计费全部由 Claude Code 自己管,Forsion 只负责把对话交给它、把结果显示出来。

用 Claude 的另一条路是 **Anthropic API key 直连**,按 key 计费,见[模型与接入方式](../chat/models-and-providers.md)。

ChatGPT / Codex 这一侧支持订阅登录,在账号连接里完成,不必走外部引擎。

## 反过来:把 Forsion 当 MCP 服务

设置里有一个对外 MCP 端点(默认关闭)。打开后,Claude Code 等外部客户端可以反过来调用 Forsion 桌面的能力,面板里直接复制接入命令即可。

## 边界

- 外部引擎**只在本地会话可用**,云端会话不列出;与群聊模式互斥;
- 审批与权限遵循该引擎自身的机制,不走 Forsion 的[审批档位](../chat/tools-and-approvals.md);
- 外部引擎是**可选附加**,不替换内置引擎:Muse、自动化、群聊等深度整合能力由 Tangu 引擎驱动;
- 外部引擎的会话同样会自动维护标题与日志,在侧栏里和普通会话摆在一起。

## 下一步

- [Agent 总览](overview.md)
- [模型与接入方式](../chat/models-and-providers.md)
- [工具与审批](../chat/tools-and-approvals.md)
- [命令行(Tangu CLI)](../reference/cli.md)
