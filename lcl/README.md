# LCL：Space、View 与可复用 UI 组件

Genesis 当前使用这份 LCL。`apps/Archived/Forsion-LCL` 是早期组合引擎，不能作为当前 API。

| 层 | 职责 | 公共入口 |
| --- | --- | --- |
| Space | 组织 View 的位置、默认布局与导航 | `@lcl/engine` 的 SpaceDefinition |
| View | 可在主区、侧栏、浮窗等宿主独立打开的功能面 | `@lcl/engine` 的 ViewDefinition / ViewProps |
| UI component | View 内可独立组合的输入、控制和内容表面 | `@lcl/components`；需要业务服务的组件由应用层提供公共入口 |

第三层统一称 **UI component / UI 组件**。早期 LCL 使用过 Block；Amadeus Block 现在专指文档内容与存储，Dashboard Card 是 View 的卡片宿主，都不替代这层组件契约。组件不创建 Leaf、不改变 Space，不隐式操作活动会话。

## 复用纪律

1. 写 View 前先查公共组件。已有能力缺少插槽时扩展公共组件，不复制 View 内的 JSX / CSS。
2. 无业务依赖的组件放 `lcl/components`，只从 `@lcl/components` 导出；模型目录等业务适配放应用层。LCL 不反向导入 desktop。
3. 状态与副作用归宿主：输入值、选择、禁用、提交回调明确传入。不要用活动 View / session 单例作为隐式目标。
4. 对插件开放采用现有 `ctx.ui` 的 DOM 挂载协议，返回 `update` / `focus` / `dispose`；插件拿不到宿主的 React 实例和组件，`@lcl/components` 不对外发包(走查续八 8.22 定 A):宿主零件一律经 `ctx.ui.*` / 带类型的 `ctx.ui.mount(name, el, props)` 挂进插件给的元素，插件只传数据；插件不打包宿主组件的替身(菜单、浮层、对话框、图标、i18n),自己的画面若用框架画，React 留给它自己那块，不 import 宿主内部路径。禁用、重载、setup 失败由宿主统一清理。挂载一律走 `mountHostReact`,它返回句柄 `{ render, dispose }`,所有权跟着句柄走:树挂在宿主自己加进 `el` 的一层里(`display:contents`),`dispose` 同步摘掉这一层,`el` 立刻归还插件;原地更新调句柄的 `render`;同一个 `el` 上一份没 dispose 就再挂,前一份被收掉、它的句柄此后无效。挂在树外面的资源收在 `mountHostReact` 的 `onDispose` 里;真正挂载要等动态 import 的入口,调用时先 `claimHostMount(el)`,落地时确认还归自己。
5. 公共接口变更必须同步类型、作者手册、真实消费者与生命周期测试。CSS 同源，并覆盖明暗、窄容器、输入法和菜单。

## Chat Box

- `@lcl/components`：`ChatBox`、`ChatBoxSurface`、`ChatBoxInput`、`ChatBoxToolbar`、`ChatBoxSubmit`。受控输入、伸缩、键盘提交与插槽；没有会话副作用。
- `desktop/frontend/src/components/chatbox`：接入共享 `ModelPill` 与宿主实时模型目录的 ChatBox、`useChatBoxSelection`。草稿选择局部保存，用户排序 / 隐藏偏好和模型思考档复用现有选择器。
- `Composer2`：聊天会话编排器，组合上述基础组件并接入附件、引用、命令、语音、运行状态。首页复用该编排器；Coding 项目创建使用提示表单组件，在创建成功后显式移交模型与思考档。
- 插件：`ctx.ui.mountChatBox`；详见 [公共契约](../docs/customization/ui-components.md)。

## 划线条(Selection bar)

选中文字后浮出来的那一条,全应用一份。

- `@lcl/components`:`SelectionBar`(一行 = 本视图的工具 + 动作,中间一道竖线;「⋯」展开的面板在行下方)、`SelectionBarActions`(只要动作那几枚,给自己画工具行的宿主嵌进去)。纯展示:选区怎么来、条放哪儿、每个按钮做什么都由宿主给;外壳是宿主套的 `.ui-popover.selbar`(定位用 `@lcl/engine` 的 `OverlayAt`)。
- `desktop/frontend/src/components/selectionBar/ViewSelectionBar`:应用层。看一个元素里的 DOM 选区,接上「带去对话 / 翻译 / 插件动作」和结果卡;聊天直接用。动作表(插件动作的 scope / when、排法偏好)在 `desktop/frontend/src/selectionActions.ts`。
- 笔记:`InlineToolbar` 保留自己的工具行和下拉,把 `SelectionBarActions` 嵌在行首或行尾。
- 插件:`ctx.ui.mountSelectionBar`(自己的视图用上这一条)、`ctx.registerSelectionAction`(往「⋯」里加动作);详见 [公共契约](../docs/customization/ui-components.md)。
- 不做全局选区监听:每个视图自己接,没接的视图不出。新视图接入时别再另画一条。

## 设置零件(Settings parts)

设置页、商店页那批小零件:分组面板、设置行、开关、按钮、输入框、分段、下拉、数值、额度条、步进器、代码 + 复制、半屏选择 / 确认、空 / 加载 / 出错。

- **暂在应用层**(第 2 条的例外,有意为之):`desktop/frontend/src/components/SettingsPrimitives`(面板 / 行 / 开关 / 状态)与 `components/SettingsPage`(整页描述的渲染与新零件)。它们本身不依赖业务,但 CSS 真源是 `base.css` 的 `.settings-*`,web / mobile 经 `@/` 复用同一份;搬进 `lcl/components` 要连样式一起拆,等第二批(卡片网格、表格)时再定。
- 排法归宿主:行上的 `data-fit`(`SettingsRow` 的 `fit`)声明窄屏怎么排 —— `inline` 紧凑控件留右、`wrap` 宽控件换行占满;没声明的旧行照旧一律换行。手机上「选了就执行」换成一枚按钮 + 半屏(`openNativeSheetMenu`,缺省 `mb-sheet`)。
- 宿主自己的设置页逐页换成整页描述(先换了「通知」);新写的设置类页面直接用 `SettingsPage`,不再手拼行。
- 插件:`ctx.ui.mountSettingsPage`(整页)、`ctx.ui.mountSettingsItem`(单件);详见 [公共契约](../docs/customization/ui-components.md)。

## 视图模式(View modes)

同一份东西换一种看法的胶囊,全应用一个摆法:视图头行(32px,在纸里、不随正文滚)最左。

- `@lcl/engine`:`useViewModes(leafId, spec)` 登记、`ViewModeSwitch`(给 `leafId` 画登记的那份;给 `spec` 当普通零件)、`ViewHead`(整条头行)、`installViewModeCommands()`(宿主装配期调一次:⌥⌘V 与命令面板「看法：X」)、`inSingleColumnShell()`。真身在 `engine/viewModes.tsx`,不在 components:手机顶栏(SingleColumnHost)也要画它;`@lcl/components` 只转出口。
- 窄宽按头行自己的宽度(container `lcl-viewhead`):< 480 只留图标,< 320 下拉。手机单列壳里视图不画,顶栏两颗胶囊中间画活动视图那份。
- 插件:`ctx.ui.setViewModes`;详见 [公共契约](../docs/customization/ui-components.md)。
- 标签栏不再给视图留空位(原 `useViewChromeSlot` 已删):视图的东西放视图自己的头行。

## 提示框、悬停卡与浮层退场(Motion base)

动效规矩见仓根 `DESIGN.md` §3「动效」;token 在 `desktop/frontend/src/styles/base.css :root`,LCL 样式只写同值兜底。

- `engine/hoverSurface.ts`:提示框 / 悬停卡的唯一真源(时序、接力、定位、键盘聚焦不做动画),Ribbon 浮签与侧栏行提示都走它。`@lcl/components` 出口:`tooltipProps`(React 摊 props)、`attachTooltip`(DOM)、`hideTooltip`、`useHoverCard`(React 内容的悬停卡;`longPress` 选项给手机:按住 0.5 秒出、松手收);事件委托版 `delegateTooltips` 留在引擎里给 Ribbon。插件:`ctx.ui.attachTooltip`。
- `engine/menuAnchor.tsx` 的 `useExitGhost`:条件渲染的浮层卸载时留一份 inert 替身放完退场再摘;`OverlayAt` 自带,命令面板 / ⌘P 接了。退不退由 base.css 那张名单决定(进场名单 == 退场名单,`check:motion` 钉着)。
- 方向性按压:按钮写 `data-press="back|forward|reload"`(engine.css)。
- 仪器:`npm run check:motion`(进 `npm test`;写死时长与不经 OverlayAt 的菜单走棘轮基线 `scripts/motion-baseline.json`)。
- `engine/dropIndicator.ts`:落点提示(拖动排序 / 拖入时的那根线、那圈「放进去」描边)的唯一真源。换落点 = 旧的原地淡出 90ms、新的在新位置淡入 130ms 并从近端展开;同一个落点只是坐标变了(自动滚动、重排)就直接跟。新代码用 `createDropIndicator()`(视口坐标,fixed 包含块与祖先 zoom 已补偿);已经自己画线的地方在定位前调 `dropRetarget(el, key)`、藏之前调 `dropHide(el)`(Amadeus 编辑器三根线、标签条竖线);每行自带伪元素线的列表用 `dropIndicator.css` 的 `--lcl-drop-enter` / `--lcl-drop-leave` / `--lcl-drop-fade`(写法见该文件顶注)。颜色一律 `--signal-line`。插件:`ctx.ui.dropIndicator`。入场只动 `opacity` 和独立的 `scale`,不碰 `transform`(各处靠内联 transform 定位)。方案页:仓根 `docs/ToBeImproved/落点过渡动效方案_2026-10-24/`(选 B 原地淡入)。**松手落位**(2026-10-25,借鉴 Comma 方案 2.5):`land(el, from, { with?, unclip? })` 让被拖的那一个从松手处(`releasePoint(dropEvent, dragGrab(el, dragstartEvent))`)滑进新位置,160ms(`--land-duration`,LCL 兜底 `--lcl-land`)× `--lcl-drop-ease`,阴影淡出,邻居不让位;FLIP 用内联 transform + `transition` 回 0,不写关键帧;缩放按 `currentCSSZoom` 补偿;减少动态效果直接到位。重渲要等(写盘 / 插件回调)用 `landWhenMoved(find, from)`:每次 DOM 有增删就问一次,等元素重新挂载或换了父节点 / 前一个兄弟才落。宿主调用处:Tangu 会话档项目组、插件列表行、内置待办视图换组(日历插件自带的待办视图不经这里);插件走 `ctx.ui.dropIndicator().land`。台架 `npm run check:dropland`,单测 `dropLand.test.ts`。

## English contract

Space owns layout; View owns a navigable feature; UI components compose the inside of a View. Amadeus document Blocks and Dashboard Cards have different responsibilities. Use `@lcl/components` for host-independent primitives and application adapters for services. Inputs and callbacks are explicit; a component must not implicitly target the active session. DOM plugins consume `ctx.ui` mounts, with lifecycle cleanup owned by the host. Settings parts (panels, rows, switches, buttons, inputs, meters, steppers, sheets) currently live in the application layer (`components/SettingsPrimitives`, `components/SettingsPage`) because their CSS source of truth is `base.css`; plugins reach them through `ctx.ui.mountSettingsPage` / `mountSettingsItem`. Keep types, documentation, consumers, and lifecycle coverage together when changing public APIs.

Main splits opened by file links or the split command preserve the current sidebar widths, including user-resized widths. Regression: build `desktop`, then run `npm run check:mainsplitwidth` under the repository's `devlock.cjs run --vehicle=e2e`; it clicks real Excalidraw/database links and checks geometry on every frame, saved widths, closing, and subsequent sidebar dragging in an isolated Electron profile.
