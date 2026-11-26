---
title: 桌面小窗开发
description: 桌宠、悬浮挂件这类浮在其他应用上面、没有卡头的透明小窗：能力声明、控制器、点穿与护栏。
---
# 桌面小窗开发（2026-11-26 起）

桌面小窗是一扇**透明、没有边框和卡头、浮在其他应用上面**的小窗，里面全由你的视图来画：桌宠、悬浮挂件、计时胶囊都是这一类。它和 [Mini Panel](./mini-panel-development.md)、[Floating Panel](./floating-panel-development.md) 走同一个入口 `ctx.workspace.open`，区别是样子写 `form: 'bare'`。

## 声明与打开

manifest 里声明能力：

```json
{ "capabilities": ["desktopWindow"] }
```

视图声明支持 `bare` 样子，然后用桌面层打开：

```js
ctx.registerView({ id: 'pet', title: 'Pet', forms: { bare: true }, mount(el, view) { /* 画宠物 */ } })

if (ctx.workspace?.forms?.includes('bare')) {
  const r = await ctx.workspace.open('pet', { layer: { float: 'desktop' }, form: 'bare', key: 'cat', size: { width: 160, height: 160 } })
  if (r.ok) { /* r.layer.float 是 'desktop'(桌面小窗)或 'window'(回落成窗口里的卡) */ }
} else if (ctx.workspace?.open) {
  await ctx.workspace.open('pet', { layer: { float: 'desktop' } })   // 2.13.8–2.14.x:退成 Mini
} else ctx.openMiniPanel?.('pet')                                     // 更早的宿主
```

- `size` 是窗口的初始大小（缺省 160 × 160）；同一个 `key` 下用户挪过、你改过的位置和大小宿主会记住，下次打开回到那里。
- `pin` 缺省 `true`（盖在别的应用上面）；`pin: false` 的小窗待在普通窗口那一层。macOS 上不会盖到全屏应用上面。
- **同一视图 + 同一 `key` 再开不会另开一扇**，只把新参数交给视图（`view.onParamsChanged`）。`key` 写稳定的标识，别放时间戳。
- **每个插件最多同时 3 扇**：第 4 扇回 `{ ok: false, reason: 'limit', limit: 3 }`，宿主不替你提示用户。
- 返回值的 `close()` 关掉这扇；用户在托盘里关、插件停用 / 重载、视图反注册、主窗口重载时宿主也会关，每次关都跑 `mount` 返回的清理函数。主窗口重载后小窗不会自己回来：要常驻就在插件 `setup` 里重新开。

### 第一次用要用户同意

插件第一次开桌面小窗时，宿主弹一次框问用户「允许它在桌面上显示小窗吗」，答案记住，之后不再问。用户可以在「设置 → 插件 → 这个插件」里撤回，撤回时这个插件开着的小窗一起关掉，下次开会再问。

没声明 `desktopWindow`、用户拒绝过、或者宿主开不了系统窗口（网页、手机）时，**不报错，回落成主窗口里一张同样没有卡头的浮层卡**（`r.layer.float === 'window'`，`view.surface` 是 `'floating'`）。所以视图的画法要两边都能用。

## 视图拿到的东西

`mount(el, view)` 里：

| 成员 | 说明 |
| --- | --- |
| `view.surface` | 桌面小窗里是 `'desktop'`；回落的卡里是 `'floating'`。旧宿主不会报 `'desktop'` |
| `view.desktop` | 只在桌面小窗里有：控制器，见下表 |
| `view.getParams()` / `onParamsChanged(fn)` | 同其他样子 |
| `view.close()` | 关掉这扇 |

`view.desktop`（坐标都是屏幕坐标、逻辑像素）：

| 方法 | 说明 |
| --- | --- |
| `bounds()` | 窗口现在的位置和大小 |
| `workArea()` | 窗口所在屏幕的工作区（不含 Dock、任务栏、菜单栏）。宠物「站」在 `workArea().y + workArea().height` 上 |
| `screens()` | 所有屏幕，每块有 `bounds`（整屏）和 `workArea` |
| `moveTo(x, y)` / `moveBy(dx, dy)` / `resize(w, h)` | 挪窗、改大小。超出护栏会被夹回来，夹完的结果用 `bounds()` 读 |
| `drag(event)` | 在 `pointerdown` 里调用：窗口跟着指针走，松手为止 |
| `setClickThrough(mode)` | `'shape'`（缺省）：空白处的点击落到下面的应用上，鼠标在你画的元素上时才接住；`'none'`：整扇都接；`'all'`：都不接（只看不点） |
| `clickThrough` | 这个平台能不能点穿。Linux 上是 `false`：整扇窗总是接住点击，窗口要收紧 |
| `setHitTest(fn)` | 画在 canvas 上时自己判断：`fn(x, y)` 返回这一点（窗口内 CSS 像素）是不是在你画的东西上。`null` 回到按元素判断 |
| `requestFrame(cb)` / `cancelFrame(h)` | 这扇窗自己的动画帧。**别用全局的 `requestAnimationFrame`**：那是主窗口的，主窗口藏起来时会慢下来 |
| `onBounds(fn)` | 窗口挪了、改了大小（你调用的、拖的、换屏的）时通知，返回取消订阅 |
| `close()` | 关掉 |

关掉以后再调控制器会抛错；清理函数里停掉动画帧和订阅。

## 护栏（宿主替你守着）

- 窗口不超过所在屏幕工作区宽、高各一半，不小于 16 px。
- 至少 32 px 留在某块屏幕里：宠物可以从屏幕边探头，但不会整个丢到屏幕外；可以站在 Dock / 任务栏上。
- 换屏、拔掉副屏时宿主把窗口夹回屏内。
- 托盘菜单「桌面小窗」列出开着的每一扇，可以单独关，也可以「暂时全部藏起来」，再点「全部显示」放回来。
- macOS 上点完小窗会把前台交还给原来的应用，不会把 Forsion 主窗口顶到前面。

## 写法提醒

小窗和主窗口在同一个渲染进程里，但**是另一个文档**：

- 用 `el.ownerDocument` 和 `el.ownerDocument.defaultView` 找这扇窗的 `document` / `window`；全局的 `document`、`window` 是主窗口的。事件监听挂在 `el` 或 `el.ownerDocument` 上。
- 不要用 `instanceof HTMLElement` 这类判断：另一个文档里的元素不是主窗口的 `HTMLElement`。
- 主题的 CSS 变量（`--accent-ink` 等）和亮暗会同步过来，样式照常写语义变量；页面背景是透明的，你没画到的地方就是透明。
- `ctx.ui.mount*` 这类宿主组件是给窗口里的视图用的，别挂进桌面小窗。
- `ctx.ui.float({ scope: 'desktop' })` 仍然没有：组件浮层没有桌面档，要上桌面就走上面这个入口。

## 调试

`npm run check:desktopwindow`（`Forsion-Genesis/desktop`）是真 Electron 台架：开窗、透明、主题、挪窗夹取、点穿、同 key 复用、上限、回落、主窗口藏起来时的动画帧、停用与重载收窗。插件示例可以照着 `scripts/desktop-window.check.cjs` 里的探针插件写。
