---
title: Mini Panel 开发
description: Space 适配、插件上下文和前台光标跟随契约。
---

# Mini Panel 开发 / Development

Space 的 `mini` 是显式能力声明。`SpaceDefinition.mini` 与 `space.json.mini` 都包含 `view`、`mainView`；各自为 `{type, params?}`，可另设 `name`。原生名称可懒求值，JSON 名称可写 `{zh,en}`。

```json
{
  "mini": {
    "name": { "zh": "快捷记录", "en": "Quick capture" },
    "view": { "type": "plugin:my-plugin:quick", "params": { "itemId": "today" } },
    "mainView": { "type": "plugin:my-plugin:detail" }
  }
}
```

两种视图类型必须不同且均已注册。缺省不适配；缺失可选 Mini 视图时完整 Space 仍可加载。不要在 `requires.views` 强制依赖可选 Mini 类型。Mini 挂专用视图，不运行 `Space.build()`，不恢复桌面/移动布局，不提供标签页、Ribbon 全局操作或移动端抽屉。链接到其他完整视图时交给主面板。

默认窗口为 320×420。适配器复用业务数据与编辑能力，专门设计快捷交互。使用语义主题变量，提供中英文本，避免品牌欢迎页、全局设置和重复导航占据面板。宿主负责 Space 切换、主面板定位和关闭。

## 插件上下文 / Plugin context

`ctx.registerView({id, title, mount(el, view)})` 的第二个参数新增以下可选成员；旧宿主应先检测存在性。

| 成员 | 行为 |
| --- | --- |
| `surface` | `mini` 或 `main`；Mini 不提供 `extendView` |
| `getParams()` | 当前实例的实体或筛选参数 |
| `setParams(patch)` | 合并参数，更新主面板定位目标 |
| `onParamsChanged(fn)` | 参数变化通知；返回取消订阅，不重挂 DOM |
| `showInMainPanel()` | Mini 专用；使用 `mini.mainView`，当前参数覆盖其缺省参数 |

关闭、切 Space 或禁用插件后，旧 context 失效。主面板修改启停偏好后，Mini 会同步清理或重新注册本地实例与 Space，不重复发送停用自动化的动作。`mount` 的清理函数应停止异步回调和订阅。完整视图与紧凑视图使用同名实体键，不复制数据。代码示例在 `tangu-agent/skills/forsion-plugin/samples/forsion-sample-bundle/`。

## 前台跟随 / Foreground following

macOS helper 在真实 HID 输入收口写入与 socket 同目录的 `foreground.json`（v1）。内容只有 `active`、`updatedAt`、`expiresAt`、`helperPid`。候选前台策略、AX 成功或 PID 后台输入不产生信号。递归物理输入作用域在首次真实输入时激活，最外层退出时结束；进行中每秒续期，租约上限 2500ms，短点击结束保留 350ms 供轮询捕获。helper 消失、文件损坏或租约过期不产生新的前台信号，不启动 helper、不截图；已经确认的前台运行状态由 session/run 和 Forsion 焦点决定何时结束。

Electron 在应用启动后每 60ms 读信号，不依赖手动 Mini 窗口存在。主渲染器通过 `window:miniSession` 仅上报当前 `sessionId/runId`；主进程只接受主窗口顶层来源。有效前台租约、Forsion 无焦点、当前会话有运行三项同时成立才启动临时会话窗口。调用间隙保留同一轮运行的观察窗口；运行结束、换会话或焦点回到 Forsion 时收起。后台调用和普通失焦不会自行启动窗口。

临时窗口使用 `window=mini&transient=1`，定向 Tangu 会话视图，收到实际 Chat 挂载后的 `miniSessionReady` 且条件仍成立时才 `showInactive`。它不抢焦点、始终穿透鼠标，且不写手动 Mini 的 Space/布局持久化数据。手动 Mini 优先，隐藏的手动窗口也不复用或覆盖；快捷键可将临时会话接到手动 Mini。插件无需新增接口或自行监听前台信号。

约每 16ms 计算直线位移。每个新目标从窗口当前位置开始，时长为 `clamp(distance / 2400 × 1000, 220, 420)` ms，确定该段速度后保持匀速；目标变化才重新计算，不逐帧缓动，不使用原生 `animate=true` 或弹簧。同一运行第一次有效外部前台输入后，临时与手动 Mini 都在调用间隙继续跟随，避免 350ms 点击租约导致停顿。面板避开光标并夹紧到目标显示器的工作区；运行结束、换会话或 Forsion 重新获焦后退出持续跟随，手动窗口完成剩余位移并恢复交互。隐藏或关闭后不再移动。

Genesis 与 `tangu-computer-use` 是独立仓库，交付时需要配套更新并重新构建 helper。当前信号实现针对 macOS；旧 helper 与其他平台继续保持静止面板。

## 验证 / Verification

- `desktop`: `npm run typecheck`、`npm run check:parity`、`npm run check:cssvar`、`npm run build && npm run check:minicard && npm run check:miniauto`。
- 单测：`miniAutoPanel.test.ts`、`miniCursorFollow.test.ts`、`lcl/spaces/miniPanel.test.ts`、Space 注册表及国际化覆盖测试。
- Computer Use 插件：`npm run check:mini-foreground`；完整 Swift 类型检查覆盖新增文件与所有原生源文件。
- Electron 测试使用临时后端、Vault、磁盘插件和前台信号，验证真实 BrowserWindow 位移及截图；不向用户应用发送物理输入。真实 HID 到信号由 native reporter 测试与收口接线检查覆盖。
- `check:miniauto` 用另一个隔离 Electron 进程持有真实 OS 焦点，验证从未打开手动 Mini 的自动弹出、同会话 SSE 续显、调用间隙保留、结束/回焦收起，以及手动窗口与存盘数据不被覆盖。`check:minicard` 的几何段固定光标与焦点输入，真实焦点行为由前者覆盖。
- 轨迹断言固定光标采样值、记录真实窗口坐标：48px 短距离须有多帧可见过渡，输入间隙继续跟随 240px 位移。`motion-short.json` / `motion-between-calls.json` 保存逐帧证据；修复前对照为 2 帧约 19ms、间隙位移 0px。

## English contract

Declare distinct registered `mini.view` and `mini.mainView` targets on the Space. Mini is opt-in and never builds the full Space layout. Optional adapter availability does not invalidate the full Space. The host owns navigation chrome and forwards current entity params to the main panel.

DOM plugins receive an optional live context with `surface`, `getParams`, `setParams`, `onParamsChanged`, and (Mini only) `showInMainPanel`. Parameter updates preserve the mounted DOM; contexts are revoked on disposal. Reuse domain data, keep entity keys consistent, and clean up subscriptions.

On macOS the companion helper emits a bounded, data-only foreground lease beside its socket when it actually posts physical input. An app-wide monitor combines that lease with external focus and the main renderer's current run to open a temporary Tangu observer automatically. It waits for the targeted Chat to mount, shows without activation, preserves manual Mini state, and closes when Forsion regains focus or the run ends. Following continues through input gaps in that same run, for both automatic and manual Mini. Each destination uses a 220–420ms constant-speed segment from the current position. Plugins keep the existing Mini adapter contract. Missing, expired or unsupported signals never start an automatic panel. Use the compatible helper to enable following.
