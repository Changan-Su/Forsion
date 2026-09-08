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

在 macOS 上，当前会话运行中的 Computer Use 开始操作外部应用、焦点离开 Forsion 时，会自动临时打开 Mini 显示同一会话，**无需事先开启 Mini Mode**。面板不抢焦点，在光标旁沿直线匀速移动，保持在当前显示器工作区内，并让鼠标操作穿透。

临时面板在同一轮运行的工具调用间隙继续显示进度并跟随鼠标；每次目标变化都有 220–420ms 的直线匀速过渡，短距离也不会瞬间跳到位。焦点回到 Forsion 或本轮会话运行结束时自动收起。它只用于观察；需要交互时可回到主窗口，或按 `⌘+Shift+M` 把当前会话转到手动 Mini。已显示的手动 Mini 优先保留；隐藏的手动 Mini 的内容、位置和 Space 偏好也不会被覆盖。

后台 AX/PID 调用、单纯切换到其他应用，以及焦点仍在 Forsion 的调用不会触发自动弹出。手动 Mini 在真实外部前台输入期间同样跟随；当前会话正在运行时，调用间隙也持续跟随，直到本轮结束或回到 Forsion 后恢复交互。此能力需要包含前台输入信号的配套 helper；旧 helper 下仍可手动使用 Mini。

## English

Mini Panel is a compact extension of a Space. Open it with `Cmd/Ctrl+Shift+M` or the command palette. Switch between adapted Spaces in the header, and use **Show in main panel** to continue with the same conversation, note, or plugin item.

Built-in adapters cover **Tangu**, **Amadeus**, and **ToDo List** (Calendar's compact surface). Plugins must explicitly supply a dedicated Mini view. Mini's Space selection is independent of the main window.

On macOS, Computer Use automatically opens a temporary Mini for the current running conversation when physical input takes the foreground outside Forsion. No prior manual Mini is required. It shows ongoing progress without stealing focus, follows the cursor, and passes mouse input through. Each new destination gets a visible 220–420ms linear transition, including short jumps. Following continues between calls in the same run, then the temporary window closes when Forsion regains focus or the run finishes. Manual Mini follows throughout the same foreground run as well.

The temporary panel is an observer. Return to the main window or press `Cmd+Shift+M` to continue in an interactive manual Mini. An existing visible manual Mini takes priority; hidden manual windows, content, position and saved Space preferences are preserved. Background AX/PID calls and focus changes alone do not open Mini. Older helpers still support manual Mini use.
