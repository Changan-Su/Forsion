---
title: 插件
description: 桌面插件扩展界面,引擎插件给 AI 添工具;一个捆绑包可以把两者一次装齐。
---

# 插件

Forsion 的插件分两类,设置里统一成一页管理,**内置**与**外置**分两区显示:

| 类型 | 扩展什么 | 例子 |
|------|----------|------|
| **Forsion 插件**(桌面) | 界面与笔记能力:新视图、笔记增强、数据看板 | 青鸟收藏夹(视频转笔记) |
| **Tangu 插件**(引擎) | AI 的工具箱:给 Agent 添新工具 | Computer Use(让 AI 看屏幕、操作桌面应用) |

## 插件捆绑包

一个插件包可以同时带**引擎插件、Agent、技能和 Space** —— 装一次全部就位,不必分头去四个地方装。捆绑进来的东西在父插件的卡片里级联管理:一起启停、一起卸载,看得见各自是什么。插件自带的 Space 装好即出现在 Ribbon 上。

## 插件能做什么

内置插件与外置插件的唯一区别是「内置的已经装好了」,能力完全对等。扩展点包括:

- **自定义视图** — 在工作区里开出一个属于插件的面板或标签页;
- **Floating / Mini Panel** — 把已注册视图开成独立悬浮窗口或紧凑快捷卡片;
- **块表面** — 把**真正的笔记块**渲染进插件自己的界面,编辑、双链、嵌入都照常;
- **自定义文件类型** — 认领某种扩展名,由插件负责打开与渲染;
- **命令** — 进命令面板,用户还可以把它钉到 Ribbon 命令区;开关类命令声明 `checked` 后,钉上去的按钮会显示开 / 关状态;
- **右上角通知** 与**状态栏项** — 把进度、结果推到你眼前(可点击的状态栏项能用键盘 Tab 到);
- **声明自动化事件** — 让[自动化](../spaces/automation.md)规则可以由插件的事件触发;
- **自带 Space** — 打包一整套工作场景。

每个插件自动带一个「工作文件夹」设置,指定它把产物放在哪。带设置项的插件在**详情页**提供表单,改完即生效,不用改配置文件。

## 安装渠道

- **商店**(推荐)— 一键安装,更新统一管理,桌面插件与引擎插件按真实类型自动装到正确的位置,见[商店](market.md);
- **本地目录** — 插件住在 `~/.forsion/plugins/`,一插件一文件夹,手上有插件包直接放进去;
- **npm**(引擎插件)— `tangu install npm:<包名>`,见[命令行](../reference/cli.md)。

插件如果依赖某个本机程序,详情页会列出来并给一键安装引导。

## 在 Android 上用插件

Forsion Android App 也能装 Forsion 插件,与桌面是同一套插件接口:

- **只经应用市场装** — 「⋯」菜单 → 应用市场;手机上市场只列出 Forsion 插件(技能、Agent、引擎插件、主题、Space 请在桌面端装)。装完立即启用,不用重启。
- **插件住在 App 私有目录**,不在任何笔记库里;设置 → 插件 里照常启停、看详情、卸载(卸载保留插件自己存的设置,重装后还在)。手机上没有可见的插件文件夹,所以没有「打开插件文件夹 / 创建示例插件」。
- **仅桌面的插件** — manifest 里写 `"isDesktopOnly": true` 的插件(比如依赖本机程序、Node 或引擎插件的),手机上拒装并说明原因;已经在列表里的显示「仅支持桌面端」,代码不会被执行。
- **命令在「⋯」里** — 插件注册的命令除了进命令面板,还按插件分节直接列在顶栏「⋯」菜单里(节标题 = 插件名),手机上不用先开命令面板。
- 手机暂不支持:插件的状态栏项(手机没有状态栏)、插件捆绑包里的引擎插件 / Agent / 技能 / Space。

## 安全模型

插件能力大,约束也硬:

- npm 渠道**只下载文件、绝不执行安装脚本**,杜绝装包即中招;
- 引擎插件提供的工具**纳入审批体系**,插件自己也绕不过"动手前问你",见[工具与审批](../chat/tools-and-approvals.md);
- 插件跑在受限接缝上,能力按它声明的那些授予 —— 没声明的拿不到;界面上一个插件出问题不会拖垮整个应用。

## 开发者

插件用 JavaScript / TypeScript 编写,官方提供类型定义与模板。内置的「Forsion 扩展开发」技能可以让 Agent 照官方模板直接脚手架出插件、主题、Space 或智能体的骨架,见[技能](../agents/skills.md)。

需要让插件产物与原生笔记面板联动时,使用 `ctx.app.openNote(path, { reuseKey, activate })`:同一 `reuseKey` 的 Amadeus 面板会原地切换到新笔记；`activate:false` 可保持用户焦点在插件面板。配合 Space 主区条目的 `split:"right"` / `split:"down"`,插件无需在自己的 DOM 里复制文档编辑器或聊天界面。

插件视图的布局优先放进原生 Panel,别在一个视图里自造侧栏、底栏:列表进左栏工作区(`registerListSource`),主体留在主区,属性与检查器放右栏(或用 Extend View),时间线、日志、终端这类横跨全宽的内容放底部面板 —— Space 配方写 `layout.bottom`,或 `ctx.openView(id, { location: 'bottom' })`;底部横跨哪几列由配方的 `layout.bottomSpan` 定(缺省 `right` = 主区+右栏,另有 `left` / `full` 通栏 / `main` 只在主区下方)。底部面板旧宿主没有、移动端也没有,依赖它之前先查 `ctx.viewLocations?.includes('bottom')`,不满足就在视图里自绘。像 Coding Studio 那样「没打开项目时左栏是导航、打开后换成项目内容」:用 `ctx.replaceView?.('nav', 'media')` 原地换自己的视图(返回 0 别拿 `openView` 兜底,会弹出用户收起的面板),回启动台时反过来换,再 `ctx.closeView?.('timeline')` 收起底部。想让导航一直找得回来,就在配方里给它写 `"pinned": true`(固定 View:该区内始终留一个,关不掉、拖不出本区):这时同一句 `replaceView('nav', 'media')` 不再顶掉导航,而是把 `media` 作为第二个标签开在它旁边并顶到前台,反过来换时只摘掉 `media`——插件代码不用改。侧栏的标签只显示图标:会和别的视图同处一栏的视图,注册时给 `icon`(插件图标词表里的名字,如 `list-view`、`image`),否则几个标签都是同一个通用图标。进出项目的布局跳转会让宿主重挂主区视图:跨这一下要留的临时状态放模块作用域,等用户真正用掉再清(别在第一次交给界面时就清);关项目时先清掉新挂载会拿来重开项目的依据(视图参数、模块里的当前项、存盘的上次打开,存盘要 await),再拆界面、换布局。

Lay plugin views out in native panels instead of drawing sidebars or bottom bars inside one view: lists in the left workspace, the subject in main, properties on the right, and timelines, logs or consoles in the bottom panel (`layout.bottom` in a Space recipe, or `ctx.openView(id, { location: 'bottom' })`). A recipe's `layout.bottomSpan` picks the columns the bottom panel spans: `right` (default; main and right sidebar), `left`, `full` or `main` (main only). Older hosts and mobile have no bottom panel: check `ctx.viewLocations?.includes('bottom')` first and fall back to drawing it in the view. To switch layouts the way Coding Studio does (navigation on the left until a project is open, then the project's own content), swap your own views in place with `ctx.replaceView?.('nav', 'media')`. If it returns 0, don't fall back to `openView`: that would expand a panel the person collapsed. Swap back on the way out, then call `ctx.closeView?.('timeline')` to close the bottom panel. To keep the navigation reachable at all times, mark it `"pinned": true` in the recipe (a pinned view: its panel always keeps one, it cannot be closed or dragged out of that panel). The same `replaceView('nav', 'media')` then leaves the navigation in place and opens `media` as a second tab beside it, in front; swapping back only removes `media`. The plugin code stays the same. Side-panel tabs show an icon only: give any view that shares a side panel with another an `icon` when registering it (a name from the plugin icon vocabulary, such as `list-view` or `image`), or the tabs all show the same generic icon. Jumping between the launch and project layouts makes the host remount the main view. Keep state that must survive that at module scope, and clear it only once the person has used it, not when the first mount receives it. When closing a project, first clear whatever a new mount would reopen it from (the view's params, the module's current project, the saved last project, awaiting the save), then tear down and swap the layout.

## 下一步

- [商店](market.md) — 找现成的插件
- [工具与审批](../chat/tools-and-approvals.md) — 插件工具怎么被管住
- [自动化](../spaces/automation.md) — 用插件事件触发规则

## Mini Panel 扩展

插件内的 Space 可以声明专用 Mini 视图，只提供当前能力的快捷操作；宿主的“在主面板显示”会携带当前实体参数。未适配的 Space 不出现在 Mini 中，随插件禁用的适配会自动撤下。见 [Mini Panel 开发](./mini-panel-development.md)。

Plugin Spaces can opt into Mini Panel with a dedicated compact view. The host preserves current entity parameters when opening the main panel. See [the development contract](./mini-panel-development.md).

插件也可以不创建完整 Space，直接用 `ctx.openMiniPanel?.(viewId, options)` 打开已注册的紧凑视图；`mainViewId` 指定“在主面板显示”的去向。需要宽屏独立工具页时用 `ctx.openFloatingPanel?.(viewId, options)`。宿主自动添加插件命名空间并负责窗口生命周期。见 [Floating Panel 开发](./floating-panel-development.md)。

View 内需要输入框和模型选择时，使用 `ctx.ui.mountChatBox`；它复用宿主组件，并由插件显式处理提交。见 [可复用 UI 组件 / Reusable UI components](./ui-components.md)。Plugins can embed the host Chat Box with local draft and model selection through the same contract.

View 内需要一个完整的常驻对话时（例如创作类 Space 的右栏），使用 `ctx.tangu.mountChat`：宿主把原生对话固定在该插件、该文件夹的一条会话上，Agent 生成的文件直接落进这个文件夹。Plugins that need a full, persistent chat inside a view (for example the right panel of a creative Space) use `ctx.tangu.mountChat`; the host pins the native chat to one session per plugin and folder, and files the Agent generates land in that folder. 见 [可复用 UI 组件 / Reusable UI components](./ui-components.md)。


## 开屏与图标 / Startup and icons

设置 → 外观 →「开屏与图标」支持上传品牌图标、动态开屏素材、选择默认／呼吸／旋转／静止，以及预览和恢复默认。品牌图标在应用内立即更新；桌面端还会写进系统，退出后仍保留（macOS 的访达／Dock／启动台图标，Windows 的开始菜单、桌面和任务栏快捷方式，Linux 仅运行时）。开屏下次启动生效，安装包图标不变。默认开屏是内置的「树影」（墙上的窗光与枝影，附一句古诗）；它不跟随应用图标，只在用户选了开屏素材时让位。原来的树标动画在「开屏素材 → 内置 → 经典图标」里，经典图标仍跟随应用图标。Web 与 Mobile 共用应用内设置；Android 的桌面图标只跟随内置图标（系统只允许在安装包自带的图标之间切换，且在离开应用后才切换），上传的图片与插件图标只在应用内显示，手机系统启动屏不在此入口内。

插件通过 `ctx.registerAppearance?.({ id, label, labelEn, icon, splash })` 提供可选的图片方案。素材嵌入插件包，选中后缓存，启动无需联网或等待插件执行；禁用或移除插件时回退默认。完整示例位于 `tangu-agent/skills/forsion-plugin/samples/forsion-sample-appearance/`。

Settings → Appearance → Startup and icons accepts custom brand icons and animated startup artwork, includes preview/reset, and offers built-in loading motion. Desktop also saves the static icon to the system so it stays after quitting (the Finder / Dock / Launchpad icon on macOS, the Start menu, desktop and taskbar shortcuts on Windows; on Linux only while running). Web and Mobile share the in-app appearance; on Android the home screen icon follows built-in icons only (the system switches between icons shipped in the app, and the switch happens after the app is left), uploads and plugin icons stay inside the app, and the native launch screen is separate. Plugins contribute choices through `ctx.registerAppearance`; selection stays with the user. Cached artwork works offline, and disabling or removing its plugin restores the default. The default startup screen is the built-in Tree shadow (window light and branch shadows on a wall, with one classical verse). It does not follow the app icon and yields only to selected startup artwork. The original animated logo remains under Startup artwork → Built-in → Classic logo, which still follows the app icon.

插件任务、只读外部引擎、隔离 Git 工作区、原生定时与 Desktop MCP 接缝见 [任务 SDK / Task SDK](./plugin-tasks.md)。

## Intelligent UI cards (2026-10-09, development branch)

A plugin can opt an existing list source into native chat cards. The host renders the list;
`items`, `subscribe`, and `open` remain the single data and navigation implementation.

```js
ctx.registerListSource({
  id: 'library-list',
  title: t('viewLibrary'),
  search: true,
  intelligent: {
    description: 'Live saved bookmarks. Optional title/author search. Opens existing entries; does not save or analyze links.',
    viewId: 'folder',
  },
  items: ({ query } = {}) => cachedItems.filter(item => matches(item, query)),
  subscribe: listener => subscribeAndReload(listener),
  open: item => openExistingEntry(item.key),
})
```

The host assigns `plugin:<manifestId>:<sourceId>`; `viewId` resolves only inside the same
plugin. Keep the English discovery description under 400 characters. Older hosts ignore
`intelligent`. `search: true` allows an optional `query` (up to 200 characters); no arbitrary
props, HTML, CSS, handlers or component names are accepted from the model. The first six
items appear in the compact list; the full-view button opens the existing registered view.

The host draws the card frame, so there is nothing to style: the header shows your plugin's
icon and `name · source title` (manifest `nameEn` in English), a “Live” dot, and the full-view
button; a title the model writes for the block is not shown. Each row uses the item's own
`iconUrl`, falling back to `icon` and then a generic link icon, exactly as in the sidebar list —
set both so rows stay recognisable.

Agents discover the current catalog with `list_intelligent_cards`, then use an
`intelligent_ui` block such as `{id:'bookmarks',kind:'app-card',cardId:'plugin:bluebird:library-list'}`.
The run request carries metadata only. Rendering a live card does not send its records to
the model and does not save generated plans. Analysis or writes still use authorized domain
tools and skills. Native plan approvals keep their existing tool/session lifecycle.

Subscribe on mount and reload after the vault is available; notify on data changes and return
an unsubscribe. Cards resubscribe on vault changes. Disable removes the source from discovery,
unmounts existing cards, and shows an unavailable message. Unknown/disabled cards are never
substituted with generated content. Plugin exceptions stay inside the individual card.
These are live views of the current vault, including when an old conversation is reopened;
they are not immutable historical snapshots or cross-device data replicas.
