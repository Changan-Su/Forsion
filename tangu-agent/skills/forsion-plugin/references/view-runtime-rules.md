# Desktop view runtime rules

Moved out of SKILL.md (2026-11-23) verbatim: behaviour with no open vault, following the user's appearance switches, the dispose contract of host mounts, self-drawn floats / HUDs, pointer math under host zoom.

**Where "见下 / 见上 / below" pointers in this file land** (the sections moved apart on 2026-11-23): Selection bar, View modes, Tooltips, Drop indicators, Host parts, Settings parts, dashboard, `ctx.table.mount` → `host-ui-mounts.md`; 没有活动库, 外观开关, dispose 契约, 自绘浮层, pointer math → `view-runtime-rules.md`; 只读全库查询, onVaultEvent, 二进制资源, working folder, Templates and new notes → `vault-and-assets.md`; 前置条件 / onboarding.requires, requiresPlugins, 双语与图标, 上手提示 / guide, 主页小组件 / widgets → `manifest-declarations.md`; 统一左栏列表源, Floating Panel, Startup appearance, 共享账号, Whiteboard, Chat Box, LCL layout → `more-host-apis.md`; 当前模型, Agent 状态 / 名册, 开新对话, Agent Desk, 摘要栏, 自动化 → `tangu-host-apis.md`; 日历叠加源 → `calendar-overlays.md`; 日历 / 待办其余入口 → `calendar-todo-entries.md`; Space 与 Ribbon, 主页宿主件 → `spaces-and-home.md`; 全库多维表与笔记任务 → `databases-note-tasks.md`; 编辑器 / loadData / 块表面 → `note-editor-surfaces.md`; Tool result cards, Process-row sentences → `tool-cards.md`; where a surface's data comes from → `host-data-sources.md`. All in `references/`.

### ⚠️「没有活动库」时的统一行为(2026-09-02 立规)

上面三组里**凡走库内路径**的方法(`readFile / writeFile / readBytes / writeBytes / watchFile / openFile / loadPage /
createPage / listPages / listFiles / searchVault / reveal / trash / createFolder / stat / renamePath / movePath`)都要求一个**已打开**的笔记库。
没有活动库时它们**各自失败得不一样**,而且大半是静默的:

| 方法 | 没有活动库时 |
|---|---|
| `readFile(p)` | **静默返回 `null`**(与「文件不存在」同形,try/catch 照不到) |
| `writeFile(p, t)` | **reject** —— 主进程抛 `Error('No vault is open')` |
| `readBytes(p)` / `writeBytes(p, bytes)`(2026-09-19+) | 同上两行:`readBytes` 给 `null` 不抛,`writeBytes` **reject** `'No vault is open'`。旧宿主 / 桥缺席时方法整个不存在 → `ctx.app.writeBytes?.(…)` |
| `mutateDb(p, fn)`(2026-09-02+) | `{ ok:false, error }`,**不抛**;云端/移动端桥没有 CAS 写口时同样 `{ ok:false }`。⚠️**改活表(补列属性、加视图)一律走它**:比对交换 + 冲突重读重放,`fn` 返 `null` 不写;`readFile`+`writeFile` 整文件覆盖会盖掉读写之间自动化/用户刚写的行且零报错。旧宿主没有 → `ctx.app.mutateDb?.(…)` 再走自己的回落路 |
| `listPages()` / `listFiles()` / `searchVault(q)` | 一律**给空数组、不 reject** |
| `trash(p)`(2026-10-05+) | **reject**(宿主的清单里找不到这个路径)。没有回收站的端 / 旧宿主**方法整个不存在** |
| `createFolder(p)` / `renamePath(p, name)` / `movePath(p, dest)`(2026-11-16+) | **reject**(`createFolder` 是 `'No vault is open'`)。旧宿主方法整个不存在 → `?.` |
| `stat(p)`(2026-11-16+) | **静默返回 `null`**(与「不存在」同形,同 `readFile`)。网页宿主没有这个方法 |
| `vaultRoot()` | `null` —— **唯一的可用性探针** |
| `workFolder()` | **照常返值**(它只是一条设置项的值)—— ⚠️**不是可用性探针**,拿到字符串不代表写得进去 |
| `ctx.storage`(2026-11-26+) | **不需要库**,照常读写(库外的插件数据文件夹);只有 `ctx.storage.vault()` 给 `null`、`importFromVault` reject。网页和旧宿主整个成员缺席 → `ctx.storage?.` |

- ⚠️**库是惰性恢复的**:`vaultRoot()` 为 null 只说明「当前没有**打开着的**库」,不代表用户没有库 ——
  用户这一程还没进过 Amadeus 之前它就是 null。插件在宿主**启动期**装载,setup 里那一发读写多半正撞在这上面。
  插件视图挂载时宿主会唤醒库(2026-10-02 起),但恢复是异步的:视图刚挂上那一下 `vaultRoot()` 仍可能是 null ——
  一进视图就要读库(列工程、恢复上次打开的文件)的,先等 `vaultRoot()` 有值再读,别把那一刻的空当成「用户没有内容」。
- **结论(2026-09-02 起规,起因:服务器总览面板误依赖笔记库,用户实报「太奇怪了」)**:
  **与笔记无关的功能(仪表盘 / 远程系统面板 / 工具面)不得建立在这些方法上** ——
  用 `ctx.dashboard.mount`(见下节)、`ctx.loadData` / `ctx.saveData`、`ctx.storage`(插件自己的文件,见 [references/plugin-storage.md](references/plugin-storage.md))、以及自己视图里的 DOM。
- **启动期的写一律 try/catch**;要按「库在不在」分支就读 `vaultRoot()`,别去试探 `readFile` 的 null。
- 与列表源那条纪律是同一个病根:`registerListSource` 的 `subscribe()` 必须顺手重读一次(见下)。

### 外观开关:跟着宿主走(2026-10-05 起)

用户在 设置 → 外观 有三个各自可以开、可以关的开关(哪个开着由用户定,别假设):**外围淡出**(Ribbon 图标、未选中的标签、左栏文字平时退后,指针或键盘焦点
进来恢复)、**宽松正文**(笔记与对话正文的行距、段距放宽)、**舒缓过渡**(切视图的淡入、外围恢复慢一点)。插件不用接任何 API,
守住下面几条就自动跟上;违反了不报错,只是在用户眼里「就你这个插件不一样」:

- **文字和线性图标只用宿主的文字 token**(`var(--text)` / `--text-light` / `--text-muted` / `--text-faint`),不写死颜色,也不自己叠
  `opacity` 来表示「次要」。左栏的淡出是宿主把这几个变量调淡做出来的:写死的颜色不会跟着淡,在一片退后的侧栏里独自发亮;自己再叠一层
  透明度会淡两次。状态(未读、出错、进行中)用语义色 `--accent-ink` / `--danger` —— 它们不淡,正好留给需要被看见的东西。
- **左栏列表的选中行要标出来**:`aria-selected="true"` 或 `aria-current`(类名 `.active` / `.on` / `.is-on` 也认,后两个与 Ribbon 认的
  「开着」是同一个词)。宿主让选中行保持全亮,没标的会和其它行一起退后。别把 `.on` 挂在包着整块面板的容器上——里面的东西会全都不退后。
  走 `registerListSource` 的不用管,宿主画的行自带。
- **整段阅读的正文读两个公开 token**:`line-height: var(--reading-line-height, 1.6)`,段间距 `var(--reading-paragraph-gap, 0.3em)`
  (兜底值就是开关关着时的数)。只用于文章、说明、预览这类长文;列表、表单、卡片、表格是界面文字,不用这两个 token,也不跟这个开关。
  `ctx.ui.mountMarkdownEditor` / `ctx.app.mountBlocks` / `ctx.tangu.mountChat` 挂出来的正文是宿主画的,自动跟随。
- **视图根上不加自己的入场动画**:切主视图时宿主已经做了一次淡入,再加一层会叠成两段。视图里的悬停、展开过渡用宿主的
  `--duration-fast` / `--duration-base` / `--duration-slow` / `--ease-surface`,不写死毫秒、不写 `transition: all`;`prefers-reduced-motion` 下关掉。
- **展开 / 弹出先用标准写法,宿主自动给动效**(2026-10-25 起):原生 `<details>`、`<dialog>` / `popover` 自带 Forsion 的进出场;
  「用户点了才出现」的那块写 `data-motion="enter"` 就淡入上来;能开合的一块写 `data-motion="collapse"` + `data-open`
  (里面只套一层,箭头 `data-motion="chevron"`,React 用 `@lcl/components` 的 `AnimatedCollapse`),别自己量高度补间。细则见 references/host-ui-mounts.md「Motion the host applies for you」。
- **这三个开关是用户的**:不读、不写 `forsion_calm_*` 与 `<html data-calm-*>`,不提供同类的私有开关,也不在自己的视图里用 `:hover`
  去点亮或压暗宿主的外围。iframe / webview 里的页面拿不到宿主变量、不会跟着淡,导航类内容别装进 iframe 再放到左栏。

### 宿主挂载接口的 dispose 契约(2026-10-04 起)

`ctx.app.mountBlocks` / 文件视图的 `mountNoteView` / `ctx.ui.mount*` / `ctx.table.mount` / `ctx.dashboard.mount` / `ctx.tangu.mountChat`
都把宿主的界面挂进**宿主自己加到 `el` 里的一层**(`display:contents`,不出盒子:`el` 的高度、flex 照旧作用在里面的内容上)。

- `dispose()` 同步摘掉这一层,**之后 `el` 立刻还给你**:清空它、放自己的内容、在同一个 `el` 上再挂,都不用等。
- dispose 再挂 = 一份全新的实例(输入焦点、排序筛选这些状态不带过来)。只是换数据 / 换参数就用句柄的 `update()`。
- 一个 `el` 同一时刻只有一份宿主界面:上一份没 dispose 就在同一个 `el` 上再挂,宿主先把上一份完整收掉(等同于你 dispose 了它,句柄此后不再生效),再挂新的;谁后调用谁留下,不看谁先加载完。要并排放两份,就各给一个子节点。
  `mountFloatingToc` / `mountToolIsland` 例外:它们是叠在 `shell` / `root` 上的一层,不占用它,不收掉它上面别的挂载,也不被它们收掉。
  `ctx.ui.float` 不挂在你的元素上:它自己建一块浮层、内容放进句柄的 `el`;`close()` 收掉,停用 / 重载时宿主统一收。
- 别用 `el > .x` 去选宿主渲染的节点,也别假设它是 `el.firstElementChild` —— 中间隔着那一层。
- 2.12.2 及更早的宿主没有这条保证:dispose 之后那一拍里清空 `el`,宿主的卸载会报一条页面错误,或者再挂之后一片空白。
  要兼容它们,就把宿主内容挂进你自己建的子节点(`const slot = el.appendChild(document.createElement('div'))`),换内容时连子节点一起换掉。

## 自绘浮层 / HUD:三条纪律

整页工具优先用正式 Floating Panel。只有锚定菜单、短时 HUD、画布工具等不适合注册成独立 view 的小层，才在渲染进程自行挂 DOM。此时：

1. **接鼠标的覆盖层根必须 `-webkit-app-region: no-drag`,且 append 到 body**(DOM 顺序须晚于 Shell)。mac 拖窗区按 **DOM 顺序**合成、**与 z-index 无关**;ribbon 与左侧栏是拖窗区,重叠矩形内的点击/hover/滚轮全被吞。**浏览器台架照不到,只有真 Electron 能验。**
**⚠️反向纪律:不遮挡的「HUD 层」正相反,绝不能写 no-drag。** 全屏浮层要 no-drag 是因为它盖住了拖窗区
还要能点;而一层**贴在角落、`pointer-events: none` 的装饰层**(游戏式 HUD、演出提示、角标)落在 ribbon
的拖窗区上,写了 no-drag 等于把那块**从拖窗区抠掉** —— 用户从此拖不动窗口,而且这个 bug 与浮层本身
毫无关系,极难联想。`-webkit-app-region` 是**几何合成**,与 hit-test 无关:`pointer-events: none` 挡不住它,
默认值 `none` 才是「既不加也不减」。判据一句话:**浮层要接鼠标 → no-drag;浮层纯装饰不接鼠标 → 什么都别写。**

2. **别指望 z-index 压过 Shell**(`.shell-host{isolation:isolate}` 已封箱)—— 靠 DOM 后置取胜。
3. **锚定式浮层别手写 `left/top`**:`body` 常年带 CSS zoom,`fixed` 的 `left/top` 也吃 zoom。整屏 `inset:0` 不受影响;贴元素的菜单 / 小面板走 `ctx.ui.contextMenu({ anchor })` / `ctx.ui.popover(anchor, …)`(2026-10-26 起;`@lcl/engine` 的 `OverlayAt`/`clampMenu` 是宿主内部,插件 import 不到)。更早的宿主只能原生 `popover` + 自己按「Pointer math under host zoom」那条除以 `currentCSSZoom` 并夹进视口。

**裸字母快捷键别注册成宿主热键**:`installHotkeys` 没有输入焦点闸,绑了 `f` 会在聊天框打字时触发。自挂 `keydown`,守卫必须含 `e.isComposing || e.keyCode === 229`(中文输入法选字)+ `INPUT/TEXTAREA/isContentEditable` + 「别的全屏浮层开着时让路」。顺带**也**注册一条 `registerCommand`,命令面板能搜、用户能改键。

参考实现 `Forsion-Instrumentality-Project/forsion-plugin-inspect`(检视台),`check.mjs` 把这几条做成了静态断言。

## Pointer math under host zoom (2026-10-05)

The host scales the whole interface with CSS `zoom` on `<body>` (the user changes it at any time; it is often not 1), so a view works in two pixel spaces. `clientX/clientY` and `getBoundingClientRect()` are **viewport** pixels; `style.left/top/width/height`, `translate()` offsets, `scrollLeft/scrollTop` and `clientWidth/offsetWidth` are the element's **own** pixels.

**Rule: when a pointer position or a `getBoundingClientRect()` value becomes one of your own pixel values, divide the viewport distance by that element's `currentCSSZoom`.**

```js
const cz = () => track.currentCSSZoom || 1 // read at pointer time, never cached at mount
const xIn = e => (e.clientX - track.getBoundingClientRect().left) / cz() // → style.left, scrollLeft, time = xIn / pxPerSecond
const dx = e => (e.clientX - startX) / cz() // drag distance → width, translate offset
```

- Read it when the pointer event fires, on the element whose pixels you write: zoom can change while the view is open, and `currentCSSZoom` is 1 for an element that is not rendered (`display: none`, detached).
- No division when both sides are viewport pixels: hit-testing `clientX` against a rect, or a ratio such as `(e.clientX - r.left) / r.width`.
- Skipping it puts every landing off by (zoom − 1) × the distance from the element's origin: playheads, clips, sliders, resizers, canvas pan and marquee drift further the farther the pointer is from the left/top edge. Test rigs run at 100% and stay green.
- Test once before shipping: run `document.body.style.zoom = '1.5'` in DevTools, drag far from the element's left edge, and check the thing stays under the pointer (reload to restore the user's zoom).
- Anchored overlays are the same conversion; use `ctx.ui.contextMenu({ anchor })` / `ctx.ui.popover(anchor, …)` (2026-10-26+) instead of repeating it — `OverlayAt` / `clampMenu` are host internals a plugin can't import.
