---
title: Floating Panel 开发
description: 第六种面板表面、跨端行为与插件 API。
---

# Floating Panel 开发 / Development

Floating Panel 是工作区的第六种面板表面，适合设置、市场、成就、反馈和插件的独立工具页。它不参与 Dockview 布局，也不占用主区标签：

桌面 Floating、Mini 与从 Dockview 拖出的独立窗口都是已运行应用的卫星窗口，必须直接显示目标内容，不得重播只属于 Forsion 主窗口首次启动的品牌 Splash。

- macOS / Windows：宿主创建主窗口的原生子窗口，可拖动、缩放、最小化和关闭；相同 `id` 再次打开会聚焦并更新现有窗口。
- Web：宿主在当前页面上方显示固定居中的面板，不支持拖动；主工作台仍留在后方。
- 移动端：不模拟桌面窗口，继续使用全屏二级页面。

插件先用 `ctx.registerView()` 注册普通 DOM 视图，再用相对 view id 打开 Floating Panel。宿主负责添加 `plugin:<pluginId>:` 命名空间，插件不能打开或覆盖其他插件的视图。

```js
ctx.registerView({
  id: 'inspector',
  title: 'Inspector',
  mount(el, view) {
    el.textContent = `Surface: ${view?.surface}`
  },
})

ctx.registerCommand({
  id: 'open-inspector',
  title: 'Open Inspector',
  run() {
    ctx.openFloatingPanel?.('inspector', {
      title: 'Inspector',
      params: { source: 'command' },
      width: 880,
      height: 640,
    })
  },
})
```

`openFloatingPanel` 选项：

| 字段 | 含义 |
| --- | --- |
| `title` | 窗口/面板标题；缺省使用注册视图的标题 |
| `params` | 可序列化的实例参数 |
| `width` / `height` | 桌面原生窗口的期望尺寸 |
| `minWidth` / `minHeight` | 桌面原生窗口的最小尺寸 |

`mount(el, view)` 在该表面收到 `view.surface === 'floating'`。`getParams`、`setParams`、`onParamsChanged` 与主面板一致；`showInMainPanel()` 把当前参数交回主工作区。Floating 不提供 `extendView`。窗口关闭或插件停用时，宿主调用 `mount` 返回的清理函数；已打开的插件视图被反注册后，对应窗口/网页浮层自动关闭。

插件应 feature-detect `ctx.openFloatingPanel?.(...)` 以兼容旧宿主。当前桌面和 Web 都支持 Floating；移动端没有桌面悬浮语义，插件应继续提供正常主视图作为回退。

## 验证 / Verification

- `cd desktop && npm run typecheck`
- `cd desktop && npm run build && npm run check:floatingpanel`
- `cd desktop && npm run check:parity && npm run check:cssvar && npm run check:shadowcontract`

真机检查至少覆盖：原生窗口拖动/最小化/关闭、同 id 复用、Web 不可拖动、明暗主题、插件禁用后清理，以及参数通过“在主面板显示”完整交接。

## English contract

Register a normal plugin view first, then call `ctx.openFloatingPanel?.(viewId, options)`. The host namespaces the id, owns native-window/Web-overlay chrome, and supplies `surface: 'floating'`. Reopening the same panel id focuses and retargets it. Floating views have live params and `showInMainPanel()`, but no `extendView`. Clean up all subscriptions from the disposer returned by `mount`.
