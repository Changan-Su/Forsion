# Desktop plugin contribution points: the full table

Moved out of SKILL.md (2026-11-23) verbatim. Every `ctx` registration point with its user-facing entry and notes, plus Extend View, command `invoke` for agents, and `checked` toggles.

**Where "见下 / 见上 / below" pointers in this file land** (the sections moved apart on 2026-11-23): Selection bar, View modes, Tooltips, Drop indicators, Host parts, Settings parts, dashboard, `ctx.table.mount` → `host-ui-mounts.md`; 没有活动库, 外观开关, dispose 契约, 自绘浮层, pointer math → `view-runtime-rules.md`; 只读全库查询, onVaultEvent, 二进制资源, working folder, Templates and new notes → `vault-and-assets.md`; 前置条件 / onboarding.requires, requiresPlugins, 双语与图标, 上手提示 / guide, 主页小组件 / widgets → `manifest-declarations.md`; 统一左栏列表源, Floating Panel, Startup appearance, 共享账号, Whiteboard, Chat Box, LCL layout → `more-host-apis.md`; 当前模型, Agent 状态 / 名册, 开新对话, Agent Desk, 摘要栏, 自动化 → `tangu-host-apis.md`; 日历叠加源 → `calendar-overlays.md`; 日历 / 待办其余入口 → `calendar-todo-entries.md`; Space 与 Ribbon, 主页宿主件 → `spaces-and-home.md`; 全库多维表与笔记任务 → `databases-note-tasks.md`; 编辑器 / loadData / 块表面 → `note-editor-surfaces.md`; Tool result cards, Process-row sentences → `tool-cards.md`; where a surface's data comes from → `host-data-sources.md`. All in `references/`.

## 桌面插件:贡献点全表(动手前先看这张表)

`ctx` 上的注册口就这些 —— **内置与外置拿到的是同一份**(`pluginStore.makeContext`,能力对等原则)。
细节正典 = 仓根 `docs/Function/生态内容制作指南.md`(本表每一行都能在那儿找到对应小节);
类型契约 = `Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts`。

| 贡献点 | 给用户的入口 | 备注 |
|---|---|---|
| `registerCommand` | 命令面板(+ 可选 agent 面) | `title` 可传 `() => string` 跟随界面语言(2026-10-02+,老宿主只认字符串);id 处于全局命名空间,裸名会互顶;默认只做导航,**动作性能力要么走引擎侧 agent/技能(通用纪律 5),要么给这条命令声明 `invoke`**(见下)。2026-11-16 起返回 disposer(只撤这一次注册;被替换掉的旧 disposer 什么都不做),同 id 再注册 = 原地替换(运行时增删命令不用重载插件);老宿主返回 `undefined`、重注册会多出一条 → `off?.()`、每个 id 只注册一次。`hotkey: 'Mod+Shift+Y'` 缺省键位:必须带 `Mod`;带 `Shift` 时只能配字母、`[` `]` 或具名键(ArrowUp、F5、Enter…),不支持 `Space`,写错的忽略并在控制台警告;只在没有任何别的绑定占着时生效(内置命令、系统 / 编辑器快捷键、用户给别的命令设的键、别的插件的同一缺省键 —— 两个插件撞同一个键,谁都拿不到);用户给这条命令设的键永远优先;没生效的列在 设置 → 快捷键,写「插件默认键 {key} 与「{other}」冲突，未生效」,键空出来后自动生效。老宿主忽略 `hotkey` |
| `registerSlashItem` | 笔记里的 `/` | 静态 `scaffold`,或动态 `run()`(先建文件再返回嵌入语法);`label` / `group` 传函数则跟随界面语言 |
| `registerSelectionAction` | 选中文字后浮出的那一条(划线条):缺省在「⋯ → 插件」,`placement: 'bar'` 要一个条上的位置(2026-11-21 起;条上插件位最多 3 个,用户钉 / 收进 ⋯ / 设置里改的永远优先) | `run(cx)` 返回要给人看的 markdown,**只进宿主的结果卡**:笔记里用户点「替换 / 插入下方」才写,别处只读;`scope` 决定出现在哪些视图(缺省只在笔记);`title` 收 string / 函数 / `{ zh, en }`(11-21 起,旧宿主只收字符串);`auto: true` 只声明**支持**划选后自动跑(开关归用户、缺省关);`card: { language, source, speak }` 让宿主在结果卡上画目标语言、原文、小喇叭;见下「Selection bar」。桌面 2.13.3 及更早在「AI ▾ → 插件」、只有笔记里有 |
| `registerView` | 独立标签页(`ctx.openView(id)` 打开) | `title` 2026-10-26 起收 PluginText;**DOM 挂载**(`mount(el, view?)` 返 disposer;可以是 async —— resolve 出的就是 disposer,reject 算挂载失败;`view.extendView` 可开临时扩展),外置插件的主力;加 `rightCompanions` 声明它到前台时右栏要的那组(见「右栏:主视图规则」);`workspaceSource` 只对没写 `mode` 的老配方的左栏生效。**样式不隔离**:选择器挂自家根类名,配色只用 `var(--bg)` / `--bg-card` / `--text` / `--text-muted` / `--border` / `--accent`(自造的变量名宿主没有,会落到你写死的兜底色) |
| `openFloatingPanel` | 第六种 Floating Panel | 先注册 view，再按相对 id 打开；桌面是真原生窗口，Web 是不可拖动居中面板；可选链兼容旧宿主 |
| `openMiniPanel` | Mini Panel（默认 320×420，用户可改大小；2.13.8 起可多开） | 不建 Space 也能直开紧凑 view；用 `mainViewId` 声明回主面板的目标；同一 `viewId` + `key` 复用一扇，不同 `key` 各开一扇（见 references/mini-panel.md「多开」）；仅原生桌面宿主提供 |
| `ctx.workspace.open(target, { layer, form })` | 统一打开入口(2.13.8 起) | 位置 `layer`(`{ dock }` / `{ float: 'desktop', pin? }` / `{ float: 'space' \| 'window' \| 'view' }`)和样子 `form`(`main` / `side` / `bottom` / `mini`;2026-11-26 起 `bare` = 无卡头,桌面层上是透明桌面小窗,要 manifest `desktopWindow`,见 references/desktop-window.md)分开写;上面 `openView` / `openFloatingPanel` / `openMiniPanel` 就是它的固定写法、照旧可用。浮在窗口里的三档挂的是你的**整个视图**(宿主画卡头),随停用收掉;`registerView` 写 `forms` 声明支持的样子(`mini: { view }` 配紧凑视图),不支持按回落规则换;结果告诉你实际落到哪;可选链(见 references/host-ui-mounts.md「Opening views」) |
| `registerListSource` | **统一左栏**里的一条列表(收藏/任务/订阅…) | 宿主渲染,与会话/笔记行同一套 UI;⚠️`subscribe()` 里**必须重读一次数据**,见下。`title` / 动作 `label` 2026-10-26 起收 PluginText(`() => t('…')` 或 `{ zh, en }`,切语言即变;字符串在注册那一刻定格);`empty: { icon, title, line?, action? }` 让侧栏在你的 Space 里不写「暂无内容」、手机整屏列表画这份空态 |
| `registerFileType` | 自定义 `.x.md` 文件类型;`override: true` 可接管内置的 `.pdf` | 撞内置后缀返回 **`false`** → 整体退让(判定写 `=== false`) |
| `registerFileCreator` | 文件树右键 + 新建标签页启动器 | 与文件类型配套;**四条新建路径都要注册**,少一条用户就会问「为什么这儿没有」 |
| `registerTemplateProcessor` | 宿主的模板选择器 / 日记模板 | 2026-11-16 起;`{ id, name, folders?(), process(source, { templatePath, targetPath, kind }) }`:在宿主替换 `{{date}}` / `{{title}}` **之前**处理模板原文,`null` = 不改,抛错 = 这次不插;`folders()` 给选择器加文件夹;返回 disposer。**模板类插件接这个,别另造选择器**;老宿主没有 → `?.`;见下「Templates and new notes」 |
| `registerNoteBirth` | 所有「新建笔记」入口 | 2026-11-16 起;`{ id, initial({ path, folder, signal }) }`:空的新笔记写盘前问初始内容,第一个非 null 的进同一次写入;插件写的文件、数据库行、同步来的不问;返回 disposer;老宿主没有 → `?.`,别拿 `onVaultEvent` + `writeFile` 顶替(实测被挪进冲突副本);见下「Templates and new notes」 |
| `registerEmbedRenderer` | `![[x]]` 嵌入的自绘渲染 | |
| `registerToolResultRenderer` | 对话里**你自己引擎半身注册的工具**跑完后的结果卡片(可直接进 Agent Desk) | 2026-10-19 起;别家插件的、核心的工具认领不了(唯一例外:签名的 Forsion Extend 画 `publish_web_page` / `forsion_account`);2026-10-28 起可带 `match({ tool, args })` 按参数收窄;老宿主没有 → `ctx.registerToolResultRenderer?.(…)`。见下「Tool result cards」 |
| `registerToolLabel` | 对话过程行里**你自己引擎半身的工具**每次调用那一行的整句(可带应用图标) | 2026-11-13 起;认领同 `registerToolResultRenderer`;`describe(call)` 同步且便宜,抛错 / 返回空 = 宿主照旧写法;老宿主没有 → `ctx.registerToolLabel?.(…)`。见下「Process-row sentences」 |
| `registerSetting` | 插件设置页的「通用」组(number/boolean/text;2026-11-18 起,详情页不再画) | 每键一个字符串,**没有原子性**;同 key 重注册即覆盖;宿主画成开关 / 步进器(`min`–`max` 跨度 ≤24)/ 输入框 |
| `registerSettingsPage` | 插件自己的设置页,描述成数据、宿主画(设置 › 插件设置 › 你的插件) | 2026-11-18 起;`{ id?, title, keywords?, mount(page) }`,`mount` 里 `page.update({ groups })`,返回收尾(关页 / 停用 / 重载时调);零件同 `ctx.ui.mountSettingsPage`;**不许仿宿主 `.settings-*` 样式**;老宿主没有 → `ctx.registerSettingsPage?.(…)`,退回 `registerSettingsView` + `mountSettingsPage`。见 references/host-ui-mounts.md「Plugin settings page」 |
| `ctx.ui.mountMarkdownEditor` | 视图内原生 Amadeus Markdown 编辑器 | 正文归调用方(API 草稿等),缺省**不碰笔记库**,`vault: true`(2.13.8+)接上当前库的双链补全 / 跳转;保存前 `getValue()`;`modes: false` 不画「编辑 / 源码 / 预览」那一排;老宿主没有 → 可选链 |
| `ctx.ui.mountMarkdown` | 只读 Markdown(聊天那套:公式、双链) | 2.13.8+;`update({ markdown })`;列表每行一个也行;有它就说明编辑器的 `vault` 有效 |
| `ctx.ui.mountFloatingToc` | 视图内原生悬浮目录 | 插件保有正文 DOM,宿主负责扫描 / 滚动高亮 / 跳转 / 主题;正文用 `[data-lcl-ftoc]` + `--lcl-ftoc-gutter` 让出沟(见 references);老宿主没有 → 可选链 |
| `ctx.ui.setViewModes(el, spec)` | 视图的几种「看法」(转写 / 笔记 / 纪要、文档 / 画布这类同一份东西换摆法) | 2026-10-19 起;宿主把胶囊画在视图头行最左,⌥⌘V、命令面板「看法：X」、窄宽变形、手机顶栏都归宿主;2–4 种,`icon` 用图标词表名;句柄 `actions` = 同一行右边,把自己栏里的按钮挪进去;记忆归你(按记录 / 文件记);老宿主没有 → 可选链,保留自己的标签。见下「View modes」 |
| `ctx.ui.attachTooltip(el, content, opts?)` | 按钮 / 图标的悬停提示,和宿主自己的按钮同一个 | 2026-10-23 起;300ms 才出、弹着移到相邻触发点直接接力、键盘聚焦立刻出不做动画、按下 / 滚动即收;`content` = 一行或几行(首行标题);`side` 缺省 top、放不下翻面;句柄 `{ update, dispose }`,禁用时宿主统一收;留 `aria-label`、去掉 `title`;老宿主没有 → 可选链,照旧 `title`。见下「Tooltips」 |
| `ctx.ui.dropIndicator(opts?)` | 自己视图里拖动排序 / 拖进去时的落点线、「放进去」描边,和宿主编辑器 / 侧栏 / 标签条同一个 | 2026-10-24 起;句柄 `{ line, zone, hide, dispose }`,传视口坐标(`line({x,y,w})` 横线 y=上沿、`{axis:'v'}` 竖线、`zone({x,y,w,h})` 描边);换落点原地淡出淡入、颜色 `--signal-line`;给 `key`(行 id)滚动才不算换落点;dragleave / drop 时 `hide()`,禁用时宿主统一收;老宿主没有 → 可选链,照旧自己画。2026-10-25 起句柄多一个 `land?(行或找它的函数, 松手处)`:挪完之后被拖的那一行从松手处滑进新位置(160ms,减少动态效果下直接到位),邻居不让位。见下「Drop indicators」 |
| `ctx.ui.mountSelectionBar` | 自己的视图里选中文字后浮出宿主的划线条 | 宿主给「问 Tangu / 翻译 / 朗读 / ⋯」和条上的插件动作,你声明自己的工具(图标钮 / 颜色点);不接就什么都不出;老宿主没有 → 可选链,保留自己的菜单;11-08 起跟着字走,自报选区可给 `getRect`(见 references) |
| `ctx.ui.mountToolIsland` | 「拿着工具干活」的视图(PDF 批注一类)换工具的那颗胶囊 | 2026-11-04 起;顶部居中、`root` 窄于 520px 停底部,宿主管位置 / 皮 / 滑过去的选中底块;**选中受控**(`onPick` 里自己 `setActive`),`key` 只画字母不绑键;句柄的 `row` 是岛下那一排、归插件画,`slots` 放四角;老宿主没有 → 可选链,保留自己的那条(见 references「Tool island」) |
| `ctx.ui.float(opts)` | 浮起来的一块:传输进度卡、导出完成的小条、录音计时胶囊这类 | 2026-11-07 起;`scope` 说浮在谁之上(`view` 自己的视图里 / `space` 整个 Space、切走就藏 / `window` 整个窗口),`anchor` 四角 + 上下居中,`role` `panel` 停在角上、`notice` 同角叠放并读屏;宿主管位置、层级、入场退场、拖动吸附(`data-float-drag` 把手,给 `id` 记住角);**别再自己写 fixed + z-index**;老宿主没有 → 可选链,保留自己画的(见 references「Floats」) |
| `ctx.ui.mountSettingsPage` / `ctx.ui.mountSettingsItem` | 设置类页面(账号、额度、诊断、偏好…)用宿主的设置零件画 | 只给 groups / items 数据和回调,宿主按端排版(手机上紧凑控件留右、宽控件换行、选了就执行 → 半屏);**别再抄宿主的设置 CSS**;老宿主没有 → 可选链,保留自己画的那套 |
| `ctx.ui.mountRecord` | 自己的卡片里挂宿主的「一行记录」编辑字段(标题 / 时间 / 属性,和内置日历的事件浮卡同一份) | 2026-10-17 起;⚠️**声明 `"databases"` 才有**;写口同 `ctx.databases.setCell`,外框 / 关闭 / 打开 / 删除归你;见下「日历 / 待办类插件的其余入口」 |
| `ctx.ui.haptic?.('tick')` | 移动端一次已接受操作的轻触反馈 | 2.13.7+；只有原生触感设备才存在，遵循系统设置。只在用户动作写入被接受后调用一次，撤销／同步不调用；不要拿浏览器震动模拟原生反馈 |
| `ctx.ui.claimHeader?.({ title, back, onBack, toList? })` | 移动端覆盖层临时原生顶栏 | 2.13.7+；返回 `{ dispose() }`，覆盖层关闭时释放。系统返回键与顶栏箭头都走 `onBack`。`toList: true` 表示这是手机列表下面的一页，不是浮层：返回时壳把列表层滑出来（边缘手势跟手，中途放弃什么都不发生），列表露出来后才调 `onBack`。插件停用会自动撤销顶栏和回调；没有原生栏的宿主缺省不提供 |
| `ctx.ui.contextMenu(x, y, items, opts?)` / `ctx.ui.contextMenu({ anchor, align }, items, opts?)` | 宿主样式的右键菜单(和内置主页、Ribbon 的一样) | 2026-10-26 起:行可带 `icon`(词表名)/ `shortcut`(键位提示),条目可以是 `{ separator: true }` / `{ section: '小节' }`,第一个参数可以是 `{ anchor: 按钮, align: 'end' }`(宿主量按钮、管缩放),`opts.onClose`;Android 上同一份数据走原生底部抽屉;更早的宿主把这些字段静默丢掉、只认 (x, y)。2026-10-18 起;`items` = `{ label, run(), checked?, disabled?, danger? }`,视口坐标、放不下自己翻面,限高、项多 / 窗口矮时自己滚(最多 200 项);同一时刻只开一个,点外面 / Esc / 点了某项就关;返回关闭函数;老宿主没有 → `ctx.ui?.contextMenu?.(…)`。**勾选清单连勾**:`opts.keepOpen: true` 点了不关,你改完状态调返回句柄的 `close.update(items)` 换一份行 —— ⚠️勾和 `run` 都要换成新的;连点两下可能赶在重画之前(用的还是旧那份行),所以 `run` 里读**当下**的状态(ref / store),别只靠闭包,不然第二下会把第一下吞掉;空列表 = 关。更早的宿主不认 `opts`、点了照关,也没有 `update`(拿 `typeof close.update === 'function'` 判) |
| `ctx.ui.confirm(opts)` / `ctx.ui.openDialog(opts)` | 宿主的是 / 否确认框、带挂载区的对话框 | 2026-10-26 起;`confirm` → `Promise<boolean>`(`danger` 主按钮红、焦点落「取消」;Android 原生确认框);`openDialog({ title, body?, mount?(el), actions?, width? })` 420 / 560px 居中,Esc / 遮罩 / 焦点圈 / 进出场归宿主,`run` 返回 `false` 不关。别再用 `window.confirm` 或自己画 `<dialog>`。见下「Host parts」 |
| `ctx.ui.mountControl(el, { type: 'segmented' \| 'select', … })` | 视图头 / 工具栏里的分段与下拉 | 2026-10-26 起;分段 = 看法胶囊那一份(2–5 项),下拉 = 28px 文字钮 + ▾、点开是菜单外壳的 listbox(6 项起带搜索,Android 原生抽屉)。**设置零件是 56px 的行,别放进工具栏** |
| `ctx.ui.popover(anchor, { mount(el), side?, align? })` | 按钮下方的小面板(筛选、快捷设置) | 2026-10-26 起;宿主 `.ui-popover` 外壳(同菜单材质)、锚定 / 夹边 / 缩放 / Esc / 点外面关都归宿主;别自己算 `left/top` |
| `ctx.ui.icon(name, { size })` | 自己的按钮里画词表图标 | 2026-10-26 起;返回新的 `<svg>`(currentColor);**一张词表**:Space(`space.json` 的 `icon`)、列表、菜单、设置、视图标签、控件、空态都认同一份名字(`PluginIconName`);词表外的名字回落并在控制台警告一次(带近似名);某个名字第一次用时先给尺寸已对的空壳、微任务里补字形(绘制前,11-15 起),照常 append,要多份就多调几次、别同一拍 clone。别再手抄 lucide 路径 |
| `ctx.ui.mountEmptyState(el, { icon, title, line?, action?, secondary?, examples? })` | 主区的空态 | 2026-10-26 起;`examples`(2026-11-02 起,最多 3 条 `{ label, note?, run }`)是「可以这样写」的例句,`run` 一般把这句填进你的输入框、不替用户直接建,旧宿主忽略;与内置视图、列表源 `empty` 同一个 EmptyState;别借宿主的 `.empty-state` 类名(那份 CSS 只是碰巧被别处加载过) |
| `ctx.ui.mountWebCard(el, { name, status?, address?, note?, thumbnail?, actions?, trailing?, menu?, layout? })` | 网页卡片卡身:缩略图、名字 + 状态、地址、说明、按钮 | 2026-10-28 起;和宿主自己在对话里给 HTML / 本地服务画的那张同一份;`thumbnail: { url, version }` 由宿主主进程截图(只收 http(s),换 `version` 才重拍),拿不到画占位图标;`layout: 'row'` = 列表里一行;`update` 带了键、值是 `undefined` / `[]` / `null` = 清掉 |
| `ctx.ui.mountWebSurface(el, { url, partition?, onLoadFail? })` | 把插件自己在本机起的服务的网页界面整页放进视图(DSH 融合插件的工作台) | 2026-11-15 起,**只在桌面**(web / 手机上整个成员缺席,先判 `ctx.ui?.mountWebSurface`);是 Forsion 管的顶层页面不是 iframe,服务自己的 SameSite=Strict cookie 能用;`url` 只收 127.0.0.1 / localhost / [::1] 上的 http(s);cookie 存在本插件自己的分区(`partition` 只是分区名的后缀,宿主会加上插件 id),不和内置浏览器混;页面只能在同源里跳,别的链接照对话里的链接打开;不给 Forsion 接口、不给麦克风 / 摄像头 / 定位 / 通知,只给写剪贴板;返回 `{ navigate(url), reload(), focus(), dispose() }`(`navigate('#…')` 只换页面当前地址的 # 那段,同一个页面里跳、不重载),停用 / 重载宿主收掉 |
| `ctx.ui.setViewHead(el, { title?, actions? })` | 视图的 32px 头行:左标题、右按钮 | 2026-10-26 起;不用先有看法;与 `setViewModes` 并存(胶囊在前) |
| `ctx.ui.mount(name, el, props)` | React / Vue 插件在 ref 上挂宿主零件 | 2026-10-26 起;`'menu' \| 'popover' \| 'dialog' \| 'segmented' \| 'select' \| 'emptyState' \| 'webCard' \| 'icon'`,props 有类型(`PluginUiParts`),返回 `{ update, dispose }`;**不要打包宿主组件的替身**(菜单、浮层、对话框、图标、i18n) |
| `ctx.addStyle(css)` / `ctx.i18n.define({ zh, en })` | 样式表 / 双语词表 | 2026-10-26 起;`addStyle` 停用 / 重载时宿主摘掉(别再 `document.head.append`);`define` 返回 `t(key, vars)`,回退链 当前语言 → zh → key,缺 en 的键警告一次;配合 PluginText 传 `() => t('key')` |
| `ctx.ui.mountBoard` / `ctx.ui.boardToSvg` | 盖在自己内容上的透明白板层(手写 / 圈画) | 和 `.excalidraw.md` 白板同一个引擎、同样的七支笔;**视口归调用方**(自己推 `viewport`、自己接滚轮);元素原样存取;不在手写时用 `boardToSvg` 出静态图;老宿主没有 → 不出手写入口 |
| `ctx.table.mount` | 面板里的原生多维表(只读) | 一份规格 → 真 DbTable(筛选/搜索/隐藏列/排序/统计全套),**不依赖笔记库**;老宿主没有 → 可选链 + 自己的表格降级(见下) |

#### Extend View:随主视图挂载的临时扩展(2026-09-05)

`registerView.mount(el, view?)` 在 Main View 中的第二参提供 **`view.extendView`**。用它承载新增/编辑表单、详情或临时工具;
宿主创建临时原生 View,加入现有 Left / Right / Bottom Panel 的标签组,由主视图管理生命周期。
不需要为每个插件 `registerView` 第二个常驻视图,不进永久视图目录、导航历史或布局存档。
原生标签栏保持可见,可在原有 View 与临时 View 间切换且保留草稿;宽度/高度沿用 Panel 设置。
侧栏原先收起时按需展开;关闭临时 View 后返回原有 View,仅有临时 View 的面板随之收起。
使用原生折叠按钮会收起整个 Panel 并销毁临时 View;再次展开仅还原常规 View。
内置 React 主视图从 `ViewProps.extendView` 取同一接口;侧栏 View、Dashboard 嵌卡和无侧栏的 mini 窗口没有这个接口。

```js
ctx.registerView({ id: 'items', title: 'Items', mount(el, view) {
  const button = document.createElement('button')
  button.textContent = ctx.getLocale().startsWith('zh') ? '编辑' : 'Edit'
  button.onclick = () => view?.extendView?.open({
    id: 'editor',
    title: () => ctx.getLocale().startsWith('zh') ? '编辑条目' : 'Edit item',
    side: 'right', // left / right / bottom;默认 right
    mount(body, handle) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', 'Item name')
      body.appendChild(input)
      // 保存成功可调用 handle.close();失败时保留输入并提示。
      return () => { input.remove() } // 清理订阅/监听器/计时器
    },
    onClose(reason) { /* dismiss / layout / close / replace / owner,见下 */ },
  })
  el.appendChild(button)
  return () => { button.remove() }
} })
```

`onClose(reason)` 的五种原因:

| reason | 谁关的 | 插件该怎么想 |
|---|---|---|
| `dismiss` | 用户关的就是这块面板:它的 × / 返回、Esc、系统返回、关掉它的标签 | 这是用户的意思;要记「用户不想看它」就记在这里 |
| `layout` | 宿主连同它所在的位置一起收走:那一侧被收起(移动端抽屉被关上)、恢复默认布局、切 Space 换了整份布局、别的视图的扩展占了这一侧 | **不是**用户对这块面板的决定,别当成「已关闭」记下来;需要时再 `open` 即可(宿主不会替你还原) |
| `close` | 你自己调了 `handle.close()` / `view.extendView.close()` | — |
| `replace` | 同一个主视图开了另一份扩展 | — |
| `owner` | 主视图被隐藏或卸载 | 主视图回来后按需重开 |

`layout` 是 2.12.2 之后的宿主才有的;更早的宿主把这些情况一律报成 `dismiss`。两头都要跑的插件:把 `layout` 当作
「位置没了」单独处理,`dismiss` 仍可能是收起或重置,别在它上面记不可恢复的状态。

每个主视图同时至多一份扩展,同一个 Panel 也只容纳一份临时内容(后来者替换前者)。
移动端临时 View 进入原生左右抽屉的视图选择器;请求 bottom 时回落到右抽屉。
每个主视图内,相同 `id` 再次 `open` 只聚焦,**不重新 mount、不替换参数**,保留输入;
要切对象就换 id 或先 close。不同 id 替换前一份;旧 handle 的 close 无法关掉后来者。
`handle.isOpen` 可探测是否还活着。`view.extendView.close()` 收当前扩展。
主视图关闭、切 tab/Space、换实体参数或插件禁用会卸载内容;旧 controller 的异步 open 会抛错,
调用方应取消自己的请求或处理失败。扩展里的未保存草稿由主视图自行管理,不要把凭据写入布局。

**规则/Agent 入口**调用与按钮相同的 `open` 函数即可;Agent 入口仍须在 `registerCommand` 上声明下面的
`invoke` 白名单,传显式目标和稳定 id,不做 toggle。须先确保拥有这份扩展的主视图已经挂载,
不要把过期 `view` 存成跨视图的全局控制器。旧宿主需检查 `view?.extendView`,按需保留原来的内联表单。

#### `invoke`:把一条命令开给 agent(2026-09-04)

给 `registerCommand` 的条目加一个 `invoke`,这条命令就进 Tangu 的 `list_ui_commands` 目录、
可被 `run_ui_command` 派发。**存在即白名单** —— 不声明就对模型完全不可见。

```js
ctx.registerCommand({
  id: 'myplugin-open-report',
  title: () => t('报告'),
  keywords: 'report weekly 报告 周报',   // 命令面板的模糊搜索别名(中文/拼音都可以,不进模型面)
  run: () => openReport(),
  invoke: {
    // 英文,给模型看。**不要复用 title** —— title 跟随界面语言,中文用户的目录会整份变中文。
    description: 'Open the weekly report view.',
    // 有参数就给 JSON Schema;并且**一定要接显式值,不要做 toggle**:
    // 模型看不到当前界面状态,而派发事件在重连时会重放,toggle 会被翻两次。
    params: { type: 'object', properties: { week: { type: 'string' } } },
    run: (args) => openReport(String(args.week || '')),
    state: () => currentWeek(),           // 可选:当前值探针,省得模型靠猜
  },
})
```

`invoke.run` 可以返回一个字符串,作为**这一次调用**的回执回给模型(如 `'opened week 40'`),优先于 `state()`。
回执按调用给,并发的两次调用各拿各的;`state()` 每次起 run 都会被读进目录,别在里面放一次性的结果。
回执与 `state` 一样会被截到 200 字符。

要把**查询结果**交给模型(「白板上有哪些框」「这一页有几条批注」),让 `invoke.run` 返回 `{ state?, result }`(2026-10-17 起):
`result` 是字符串或能 `JSON.stringify` 的值,渲染端截到约 8000 字,引擎把它圈成**不可信数据**交给模型(带随机标签的围栏,
模型不会把里面的话当指令)。`state` 仍是一句 200 字以内的确认。老宿主只认字符串回执:对象回执在那里等于没有回执,
所以要兼容老宿主就别只靠 `result` 传达「做成了没有」。

```js
invoke: {
  description: 'List the frames on the open whiteboard (id, title, element count).',
  run: () => { const frames = listFrames(); return { state: `${frames.length} frames`, result: frames } },
}
```

三条硬纪律:

1. **危险类不许 opt-in** —— 删除或覆盖用户数据、凭据与安全设置、对外发送/发布/购买、
   安装升级重启退出、不可逆的批量操作。理由不是洁癖:**web 与移动端的云 run 根本不经过审批闸**
   (引擎对非 host 执行档直接 approve),你这份声明就是那两端的全部安全边界。
2. **先想清楚是导航还是动作。** 模型「帮用户开一个面板」几乎没有价值;有价值的是把它刚做出来的
   东西摆到用户眼前、或者改一个用户用话说出来的设置。
3. **插件命令只在桌面存在**(web 与 mobile 的 `listPlugins` 都返回 `[]`)。声明了 `invoke` 也不会
   出现在手机的目录里 —— 这是正确行为,不是 bug,别为此写特例。

#### `checked`:开关类命令的当前状态(2026-09-25)

用户可以把任意命令钉进 Ribbon 命令区。**开关类**命令(开 / 关某个模式)声明 `checked`,钉上去的按钮
就带 `aria-pressed` 并在开着时高亮,一眼看得出现在是开是关;不声明就是普通动作钮。

```js
ctx.registerCommand({
  id: 'myplugin-focus-mode',
  title: () => t('专注模式'),
  run: () => setFocus(!isFocus()),
  checked: () => isFocus(),   // 渲染期求值:要便宜、无副作用
})
```

- **只给真开关用**。「打开报告」这种动作声明了 `checked` 会被读屏报成「未按下」。
- 宿主**不订阅**你的状态:Ribbon 在点击后、悬停进出时重读;别处(快捷键、设置页)改了状态,
  按钮要等下一次重渲才跟上。旧宿主没有这个字段 = 静默忽略,不用做特性检测。

| `registerSettingsView` | 插件设置页上自己画的一块(2026-11-18 起;以前在详情页) | 每个面板一组、组里一个自定义块,排在「通用」组之后;新页面先用 `registerSettingsPage`,这里只放零件清单外的内容;会被反复挂载卸载,状态别放模块级单例;`title` 可传函数(切语言跟上)。`category: 'forsion'`(2026-09-28 起)只对带主进程半身的首方内置包(Forsion Extend)生效:面板成为设置「Forsion 云端」的一个子页 |
| `registerStoreView` | 商店左栏里的一页(左栏多一个入口,整页正文自己画) | 2026-10-05 起;**只对带主进程半身的首方内置包(Forsion Extend)生效**,别的插件注册了不显示 —— 做普通插件用不到。旧宿主没有:`ctx.registerStoreView?.(…)`,没有就不注册,**别拿 `registerSettingsView` 顶替**(那会把页面画进插件详情页)。想在商店里列出自己的一批条目,用 manifest `storeSources`(见「商店来源」) |
| `ctx.app.openSettings?(target)` | 打开设置到某一页 / 子页(2026-09-28 起) | 口径同宿主深链,如 `'model/m-providers'`;旧宿主没有,一律 `?.` 调 |
| `ctx.app.motion?()` / `subscribeMotion?(cb)` | 动效偏好 `{ reduce, fadeOnly }`(2026-11-09 起) | `reduce` = 系统减少动态效果或设置里「只淡入淡出」任一开着:别做位移 / 缩放,只留淡入淡出;和宿主界面同一个判据。订阅返回退订,停用时宿主也会退;旧宿主没有 → 只看 `prefers-reduced-motion` |
| `ctx.app.watchAccountName?(cb)` | 当前登录的名字(有昵称用昵称,2026-10-18 起) | 先回调一次当前值,换账号 / 登出再回调,没登录 = 空串;只给名字,不给令牌和账号 id;返回退订,停用时宿主也会退 |
| `ctx.wallpaper.bing(locale?)` | 必应每日壁纸最近 8 张(2026-10-18 起) | `{ id, url, thumbnailUrl, title?, copyright?, startDate? }`;宿主代拉(桌面经主进程;必应接口不回 CORS 头,插件直接 `fetch` 会被 CORS 拦,不是 CSP);拿不到 → reject;老宿主没有 → `ctx.wallpaper?.bing(…)` |
| `ctx.app.openSpace?(id)` | 切到某个 Space(2026-10-17 起) | resolve 在新 Space 布局建好之后,接着 `ctx.openView(…, { location: 'right' })` 就落在新 Space 里;不认识的 id → `false`;旧宿主没有 → `?.`。2.13.8 起认 Space 窗口锁:锁在别的 Space 上的窗口里,开到那个 Space 自己的窗口、本窗口不切走(之后的 openView 仍落在本窗口);锁着又开不了新窗口 → `false` |
| `ctx.app.openLink?(url)` | 在应用内打开一条 `forsion://` 链接(2026-10-17 起) | 口径同系统唤起的深链,只导航不执行;插件页 / 收件箱信 / 笔记正文里的 `<a href="forsion://…">` 宿主本来就在应用内接住,这条给按钮用 |
| `ctx.app.setSpaceProgress?(spaceId, progress)` | 在 Ribbon 上自己 Space 的图标外画一圈进度环(2026-10-18 起) | 只认本插件随包带的 Space,别人的 / 内置的恒 `false`;`0–1`,`null` 收起;按整百分比画,每 0.5 秒报一次也不会重渲;那个 Space 有未读角标时让给角标;插件停用时宿主收掉;Space 收进 Ribbon 文件夹 / 「⋯」时看不到环;旧宿主没有 → `?.` |
| `ctx.app.setSpaceDot?(spaceId, on)` | 在 Ribbon 上自己 Space 的图标右上角挂提示红点(2026-10-19 起;服务器管理插件给「反馈中心」挂提醒用) | 只认本插件随包带的 Space,别人的 / 内置的恒 `false`;`true` 挂、`false` 收,没变不重渲;红点和收件箱未读角标同一种红,有角标时让给角标,和进度环同时有时只画红点;插件停用时宿主收掉;挂着时图标读屏名带「有新提醒」;列表行的未读仍用 `ListItem.unread`(指示色,不是红),要在别的 Space 也看得到就配上它;旧宿主没有 → `?.` |
| `ctx.app.queuePopup?()` | 自己弹出来的弹窗排队(2026-10-19 起;Extend 公告用) | 应用里同一时间只露一个弹窗:协议更新、What's new 在前,插件排在后面,同级先来后到;全屏引导开着时谁都不出。返回 `{ ready, done }`:`await ready` 之后再挂弹窗,关掉时 `done()`;决定不弹了(换账号、数据过期)也调 `done()` 撤销,这时 `ready` 永远不 resolve。不 `done()` 会一直堵着队列,插件停用时宿主替你收掉。用户点了才打开的面板不用排;旧宿主没有 → 直接弹 |
| `ctx.app.runCommand?(id)` | 跑一条命令面板里的现成命令(2026-10-17 起) | **只对首方内置包生效**,别的插件恒 `false`(命令里有删除 / 改设置) |
| `ctx.app.spotlight?({ anchor, title, body?, step? } \| null)` | 在真界面上圈出一处 + 一张小卡(2026-10-19 起,使用指南的「带我去」) | **只对首方内置包生效**,别的插件恒 resolve `'missing'`;锚点是宿主的一张表(`ribbon-spaces` / `chat-composer` / `note-new` / `note-body` / `note-canvas` / `agent-new`),在收着的侧栏里会先展开;不压暗、不拦点击、同一时刻一处;resolve `ok` / `mute`(用户点了不再提示,插件自己记下)/ `gone` / `missing`(等 2 秒仍不在屏幕上)/ `replaced` / `closed`(传 `null` 收起);旧宿主没有 → `?.`,没有就照老做法 |
| `ctx.guide?.show(id)` / `ctx.guide?.state(id)` | 上手提示(2026-11-02 起):请宿主出 manifest `guide.tips` 里的一条 / 读它的状态 | **所有插件可用**(和只给首方的 spotlight 不同);提示本身声明在 manifest,出不出、什么时候出由宿主定;`state` = `waiting` / `seen` / `learned` / `muted` / `off`;见下「上手提示」 |
| `ctx.app.sync?` | 读写这台电脑的三项云同步(2026-10-20 起,蓬洲云「同步」页) | **只对首方内置包生效**,别的插件整个成员缺席;手机 / 网页、没有本地库远程同步的宿主上也缺席。`get()` 给快照(智库 / Agents 与记忆 / 插件数据各自开没开、进度、第二台电脑待定的合并问题)、`subscribe(fn)`、`refresh()`、`set(kind, on)`(`notes` / `agents` / `plugins`)、`resolveNotes('merge' \| 'cloud' \| 'skip')`、`runNow()`;开关与引擎都在宿主,插件只画界面 |
| `ctx.inbox` | 往收件箱发本机系统消息 + 信下挂自己画的卡(2026-10-17 起) | **只给首方内置包**,别的插件整个成员缺席;`post` / `archive` / `registerCard({ sender, mount })`,卡只认发件人 `plugin:<你的 id>` 的本机系统消息 |
| `registerReadiness` | onboarding 检查卡上的一行 `check` | 2026-09-21 起;**必须 `ctx.registerReadiness?.(…)`**;拿不准回 `'unknown'`,见下「前置条件」 |
| `registerEngineHarness` | 跑在外部引擎上的 Agent:Harness 卡「运行在」下面的几行 + 这类对话右键菜单里的几项 | 2026-11-15 起,桌面;**必须 `ctx.registerEngineHarness?.(…)`**;`{ engineId, rows?({ agentSlug }), sessionActions? }`,`rows` 回 `{ id, label, text?, tone?, select?, hint?, actions? }[]`(最多 8 行、5 秒内),`sessionActions` 最多 4 项 `{ id, label, icon?, run({ sessionId, agentSlug? }) }`;可选 `railView`(2026-11-16 起):插件自己 `registerView` 的 View id,主区前台的对话跑在这个引擎上时宿主把它补在右栏「详情 / 文件 / 大纲」后面(不抢前台,换到别处的对话就关),View 自己用 `ctx.tangu.subscribeAgentStatus` 跟着当前对话(所以钉住另一场的主区标签不补);行变了调返回的 `refresh()`;底层只画「运行在」,其余归跑这个引擎的插件,停用就没了 |
| `registerEditorExtension` | 笔记编辑器:按键、装饰,也能改文字和选区(递进来的是宿主那份 ProseMirror) | `'high'` 档不处理**必须 `return false`**;只是在光标处插一段模板、把光标放到标记处 → 先用 `ctx.app.insertMarkdownAt` |
| `registerStatusItem` | 全局状态栏 | 返回 handle,可原位 `update({text,title})` |
| `registerTheme` | 强调色主题 | 与磁盘主题包(`~/.forsion/themes/`)是两件事 |
| `registerAppearance` | 设置 → 外观 → 开屏与图标 | 图像方案，由用户选择；可选链兼容旧宿主，返回 disposer；见下文 Startup appearance |
| `registerFont` | 设置 → 外观 → 字体 | 2026-08-28 起;**返回 disposer**(宿主在禁用/重载时也会自己撤销,返回值可以不接);旧宿主没有 → `ctx.registerFont?.(…)` |
| `registerPanel` | 右侧栏面板 | ⚠️已弃用,收 **React 组件**(拿不到宿主的 React 实例,只有自带 React 的插件能用,mindmap 有先例);新代码一律 `registerView` |
| `registerPropertyType` | 多维表自定义列类型 | ⚠️同上,`Cell` 是 React 组件;`baseType` 决定落盘形状 |
| `ctx.notify(msg, {level, action, key, undo, urgent})` | 桌面右上角的卡;手机(窄于 640)是状态栏下的一条横幅 | 自动标插件名,用户可按插件静音;`action: { label, run }` 在卡上放一个按钮(典型「撤销」,2026-10-17 起,旧宿主忽略)、`key` 同 key 的后一张顶掉前一张;`undo` / `urgent`(2026-11-15 起)和手机上的横幅见 [references/calendar-todo-entries.md](references/calendar-todo-entries.md)「带按钮的通知」「手机上的通知」 |
| `ctx.achievements` | 成就系列 + `track(event, n)`;2026-10-17 起 `count(event, { own? })` 读计数(缺省读官方事件,只读)、`subscribe(cb)`、自己系列的 `isClaimed(id)` / `claim(id)` | 宿主强制 `plugin:<id>:` 前缀,伪造不了官方成就;`count` 读不到别家插件的计数(恒 0);新成员旧宿主没有 → `?.` |
| `ctx.activity.log(event, detail)` | 写进活动日志(Muse 读得到) | 同款前缀纪律 |
| `ctx.loadData() / saveData()` | 每插件一份 JSON blob | 大块数据走这条(见下「编辑器」节);never saved → `null`, saved but unreadable → rejects `code: 'plugin-data-unreadable'` (2026-11-17+), don't save defaults over it; `saveData` rejects non-JSON values (2026-11-18+) |
| `ctx.dashboard` | 原生仪表盘(网格/卡片/排版台) | 2026-09-01 起;**两条路线**(视图内 `mount` 不依赖库 / `source` 生成 `.dashboard.md` 需要库)见下节;一律 `ctx.dashboard?.` |
| `ctx.getLocale / subscribeLocale` | 跟随宿主中英切换 | 见下「双语」 |
| `ctx.tangu` | 当前模型 / 模型目录 / 当前 Space / 会话用量 / **agent 此刻在干什么**(只读)+ `agents()` 用户的 Agent 名册 + `startChat` 用指定 Agent 开一个可见的新对话 + `mountChat` 把原生对话挂进自己的视图(2026-10-04 起)+ `mountComposer` 把「新对话」输入区整块挂进来、发送归宿主(2026-10-18 起)+ `complete` 一次性文本补全(2026-09-28 起) | ⚠️**非 Tangu 宿主上整个不存在** → 一律 `ctx.tangu?.`;`agentStatus` / `subscribeAgentStatus` / `startChat` 是 2026-09-19 起、`agents` 是 2026-09-20 起的可选方法 → `ctx.tangu?.startChat?.(…)`;2026-11-13 起有 `stop(target?)` 停掉一轮,`agentStatus` / `subscribeAgentStatus` / `stop` 的会话参数可传 `{ runId }`;见下「当前模型」「Agent 状态」「Agent 名册」「开新对话」 |
| `ctx.desk` | Tangu 聊天右侧 **Agent Desk** 里挂一块自绘区(`registerCompanion`,典型:跟着 agent 状态做反应的 3D 形象) | 2026-09-19 起;⚠️**只在桌面 Tangu 上存在**(web / 移动端 / 纯 Amadeus 壳整个没有)→ `ctx.desk?.`;两种模式 `idle` / `always`,见下「Agent Desk 伴随面」 |
| `ctx.tts` | 用用户在「设置 → 模型 → 语音」选的朗读模型念一段(`speak(text, { signal })` 念完 / 被停才兑现、`stop()` 只停自己起的、`available()`) | 2026-11-21 起;和 `ctx.tangu` 同一道门(非 Tangu 宿主 / 旧宿主没有 → `ctx.tts?.`);全应用一个播放器(和聊天朗读共用,新的顶掉旧的);没配模型 reject `tts_no_model`(宿主自己出「去设置」提示)、这个宿主没朗读(网页端)reject `tts_unavailable`;不回落系统声音;停用时宿主停掉你那段 |
| `ctx.summary` | Tangu 聊天右侧**摘要栏**加一张卡(`registerCard`,和进度 / 后台 / 产物 / Agent Desk 同一个栈,用户可折叠、拖动排序) | 2026-10-25 起;⚠️**只在桌面 Tangu 上存在**(同 `ctx.desk`)→ `ctx.summary?.`;见下「摘要栏插件卡」 |
| `ctx.widgets` | 主页小组件的数据(`provide(id, fn)` 喂行 / `invalidate(id?)` 请宿主重拿);卡声明在 manifest `widgets`,宿主画,只读 | 2026-11-07 起;**所有插件可用**,不用声明能力 → `ctx.widgets?.`;见下「主页小组件」 |
| `ctx.automation` | 播种多维表自动化规则(`ensure(rules)`);给「当…」加插件自己的事件(`registerTrigger` / `emit`,2026-10-30 起) | 2026-09-02 起;⚠️**非 Tangu 宿主上整个不存在** → `void ctx.automation?.ensure(…)`;id 宿主加 `plugin:<id>:` 前缀;见下「自动化」 |
| `ctx.calendar` | 把插件种的表登记进 Calendar Space(`ensureMember`,人人有)+ 叠加源与日历设置(`subscribe` / `setColor` / `setHidden` / `setDefault` / `setMember` / `removeMember`)+ .ics 订阅管理(`ics.add` / `importText` / `rename` / `remove` / `refresh`) | `ensureMember` 2026-09-02 起;其余 2026-10-17 起,⚠️**声明 `"calendar"` 才有**(没声明时这几个成员不存在,不是空壳)→ `ctx.calendar?.subscribe`;见下「日历叠加源与设置」 |
| `ctx.home` | 主页宿主件:卡里的内容由宿主画进插件的格子(`mount` / `mountPart`)、主页摆放读写(`layout`)、「编辑主页」命令(`onEditRequest`)、官方计数(`track`) | 2026-11-09 起;⚠️**只给接管宿主主页的那个核心插件**(`HOST_VIEW_CLAIMS.homepage`),普通插件没有、manifest 也申请不到 —— 做普通插件用不到;见下「主页宿主件」 |
| `ctx.spaces` | Space 列表 / 打开 / 图标 / 近况那一行 + 商店、成就两格 + Ribbon 上区的收纳架(顺序、收纳夹) | 2026-10-18 起;⚠️**声明 `"spaces"` 才存在**(收纳架改的是用户的 Ribbon);见下「Space 与 Ribbon 收纳架」 |
| `ctx.databases` | 全库多维表的实时聚合(`subscribe`)+ 按行按格读写(`setCell` / `addRow` / `duplicateRow` / `deleteRow`) | 2026-10-16 起;⚠️**manifest `capabilities` 声明 `"databases"` 才存在**;见下「全库多维表与笔记任务」 |
| `ctx.tangu.createAgent` / `ctx.tangu.importSessions` | 新建 Agent;把外部聊天记录(导出文件)写成这个 Agent 名下**能接着聊**的会话 | 2026-11-16 起;⚠️**声明 `"agentImport"` 才存在**;写进**本端**引擎(桌面 = 本机,手机 / 网页 = 云端,不跨端);会话追加不覆盖(同 `source` + 同对话 `id` 再导回 `exists`,原会话不动)、保留原时间、不出未读点、不触发起标题 / 记忆后台;时间一律毫秒;宿主自己切批,`onProgress` 每批一次;不抛,失败回 `{ ok: false, error, results }`(已写的那几批在 results 里) |
| `ctx.noteTasks` | 笔记正文里的 `@` 时间任务(`subscribe`)+ 就地勾选 / 改日期(`update`) | 2026-10-16 起;⚠️**声明 `"noteTasks"` 才存在**;同上节 |
| manifest `events[]` | 自动化(Automation)可订阅的事件 | 纯声明无代码;⚠️目前只有中文 `label`,英文界面下也显示中文 |
| manifest `onboarding` | 有 `requires` = **闸**(宿主实测,未满足才弹检查卡);没有 = 详情页里折叠的使用说明 | 见下「前置条件:onboarding.requires」;**别 recommends 自家已内嵌的 agent/skill**(会引导去商店重复装);⚠ `recommends` 只在闸的检查卡里渲染,没有 `requires` 就一个字都不显示 |
| manifest `widgets` | 主页小组件:每张一个目录(`manifest.json`,`layout: "list"`),用户在主页「编辑主页 → 添加组件」的「插件」组里放 | 2026-11-07 起;这一版只开列表型、只读;数据走 `ctx.widgets.provide`;见下「主页小组件」 |
| manifest `guide` | 上手提示:用户用到某个功能时宿主替你提示一次,用过就不再出 | 2026-11-02 起;不是闸;锚点只认你自己 View 里的 `data-guide-anchor`;「会了」读 `ctx.achievements.track()` 的计数;新功能配**新 id** 的提示,老用户升级后会碰到;见下「上手提示」 |

`ctx.app` 上另有三组:**整库文件读写**、**只读全库查询**、**块表面** —— 各占下面一节。
