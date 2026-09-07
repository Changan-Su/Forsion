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

macOS helper 在真实 HID 输入收口写入与 socket 同目录的 `foreground.json`（v1）。内容只有 `active`、`updatedAt`、`expiresAt`、`helperPid`。候选前台策略、AX 成功或 PID 后台输入不产生信号。递归物理输入作用域在首次真实输入时激活，最外层退出时结束；进行中每秒续期，租约上限 2500ms，短点击结束保留 350ms 供轮询捕获。helper 消失、文件损坏或租约过期均停止跟随，不启动 helper、不截图。

Electron 每 60ms 读信号、约每 16ms 以固定速度计算直线位移；不使用原生 `animate=true`、缓动或弹簧。面板避开光标并夹紧到其所在显示器的工作区，跟随时停用贴边折叠和鼠标命中。结束时完成最后一段位移并恢复交互；隐藏或关闭后不再移动。

Genesis 与 `tangu-computer-use` 是独立仓库，交付时需要配套更新并重新构建 helper。当前信号实现针对 macOS；旧 helper 与其他平台继续保持静止面板。

## 验证 / Verification

- `desktop`: `npm run typecheck`、`npm run check:parity`、`npm run check:cssvar`、`npm run build && npm run check:minicard`。
- 单测：`miniCursorFollow.test.ts`、`lcl/spaces/miniPanel.test.ts`、Space 注册表及国际化覆盖测试。
- Computer Use 插件：`npm run check:mini-foreground`；完整 Swift 类型检查覆盖新增文件与所有原生源文件。
- Electron 测试使用临时后端、Vault、磁盘插件和前台信号，验证真实 BrowserWindow 位移及截图；不向用户应用发送物理输入。真实 HID 到信号由 native reporter 测试与收口接线检查覆盖。

## English contract

Declare distinct registered `mini.view` and `mini.mainView` targets on the Space. Mini is opt-in and never builds the full Space layout. Optional adapter availability does not invalidate the full Space. The host owns navigation chrome and forwards current entity params to the main panel.

DOM plugins receive an optional live context with `surface`, `getParams`, `setParams`, `onParamsChanged`, and (Mini only) `showInMainPanel`. Parameter updates preserve the mounted DOM; contexts are revoked on disposal. Reuse domain data, keep entity keys consistent, and clean up subscriptions.

On macOS the companion helper emits a bounded, data-only foreground lease beside its socket when it actually posts physical input. Electron reads the lease and moves the visible panel at constant speed with mouse input passing through. Missing, expired or unsupported signals leave the panel stationary. Update both repositories and rebuild the helper to enable following.
