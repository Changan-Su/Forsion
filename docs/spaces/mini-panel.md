---
title: Mini Panel
description: 为当前任务提供快捷操作的桌面悬浮面板。
---

# Mini Panel

Mini Panel 是 Space 的扩展面板。通过 `⌘/Ctrl+Shift+M` 或命令面板打开，用顶部的 Space 按钮切换能力，点“在主面板显示”继续处理当前会话、笔记或插件中的项目。

目前提供三项内置适配：

- **Tangu**：切换会话、新建对话、发送消息。
- **Amadeus**：选择或新建笔记，就地编辑。
- **ToDo List**：日历 Space 的待办适配，勾选任务、在有可写待办表时快速添加。任务数据仍在原笔记或多维表中。

只有提供专用适配的 Space 才出现在这里。插件也可提供适配，随父插件启停。Mini 有独立的 Space 状态，不改主窗口的启动空间，也不恢复旧版 Mini 的完整工作区布局。

在 macOS 上，配套 Computer Use helper 执行真实前台输入期间，已显示的 Mini Panel 会在光标旁沿直线匀速移动，保持在当前显示器工作区内，并让鼠标操作穿透。后台 AX/PID 调用不触发跟随；操作结束后停止并恢复交互。此能力需要包含前台输入信号的新 helper，旧 helper 下 Mini 仍可正常使用。

## English

Mini Panel is a compact extension of a Space. Open it with `Cmd/Ctrl+Shift+M` or the command palette. Switch between adapted Spaces in the header, and use **Show in main panel** to continue with the same conversation, note, or plugin item.

Built-in adapters cover **Tangu**, **Amadeus**, and **ToDo List** (Calendar's compact surface). Plugins must explicitly supply a dedicated Mini view. Mini's Space selection is independent of the main window.

On macOS, the companion Computer Use helper signals actual foreground input. While active, an already visible Mini Panel follows beside the cursor at constant speed, stays within the display work area, and passes mouse input through. Background AX/PID actions do not trigger following. Interaction resumes after input completes. Older helpers support a stationary Mini Panel.
