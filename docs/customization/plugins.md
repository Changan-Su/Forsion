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

给开发者:商店给每个条目一个不会变的 ID,新上架的条目装进 `plugins/market-<ID>/`,和显示名无关,所以显示名可以重复。装在这种目录里的插件以目录名为运行身份:包里的引擎插件照常按目录名挂路由,单独上架的引擎插件 id 变成 `market-<ID>`、数据目录在 `plugin-data/market-<ID>/`,它的工具名会被宿主改写成带哈希的唯一名字(两份同 id 的插件互不顶替)。别的插件在 `requiresPlugins` 里写你 manifest 的 `id` 照样认得到,前提是只装着一份。这种条目要 2.13.4 之后的桌面版本才装得了,旧版本会提示先升级 Forsion。更早上架的条目保留原来由显示名推出的目录名;其中带引擎插件的包在桌面 2.13.3 及更早的版本上,目录名和 manifest `id` 不一样时页面调不到包里的引擎插件(每次调用都是 404,不报错)。

For developers: the Store gives every listing an ID that never changes. New listings install into `plugins/market-<ID>/`, unrelated to the display name, so display names may repeat. A plugin in such a folder runs under the folder name: engine plugins inside a bundle still mount their routes under it, a standalone engine plugin's id becomes `market-<ID>` with its data under `plugin-data/market-<ID>/`, and the host renames its tools to unique hashed names (two plugins sharing an id never replace each other). Other plugins can still list your manifest `id` in `requiresPlugins` as long as only one copy is installed. These listings need a desktop version after 2.13.4; older ones ask the person to update Forsion first. Older listings keep the folder name derived from their display name; for those, a bundle with an engine plugin whose folder name differs from its manifest `id` cannot reach that engine plugin on desktop 2.13.3 and earlier (every call returns 404, with no error shown).

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

每个插件自动带一个「工作文件夹」设置,指定它把产物放在哪。缺省是笔记库里的 `Plugins/<英文插件 ID>`:所有插件的产物都收在 `Plugins` 这一个文件夹下,库根目录留给你自己的笔记。带设置项的插件在**详情页**提供表单,改完即生效,不用改配置文件。

Every plugin gets a *Working folder* setting that decides where its output goes. By default it is `Plugins/<plugin ID>` inside your vault, so all plugin output sits under one `Plugins` folder and the vault root stays yours. Plugins with settings show a form on their **detail page**; changes apply immediately.

Engine plugin text settings can set `secret: true` to render a password input (including when the field type is `textarea`). This masks the UI only: values still use the existing local plugin settings store and authenticated settings API; it does not add encryption. Older hosts ignore this optional field.

引擎插件的文本设置可以声明 `secret: true`，宿主会显示密码框（`textarea` 也会转为单行密码框）。这只遮挡界面；值仍使用现有本机插件设置存储和已认证的设置接口，不新增加密。旧宿主会忽略这个可选字段。

## 安装渠道

- **商店**(推荐)— 一键安装,更新统一管理,桌面插件与引擎插件按真实类型自动装到正确的位置,见[商店](market.md);
- **本地目录** — 插件住在 `~/.forsion/plugins/`,一插件一文件夹,手上有插件包直接放进去;
- **npm**(引擎插件)— `tangu install npm:<包名>`,见[命令行](../reference/cli.md)。

插件如果依赖某个本机程序,详情页会列出来并给一键安装引导。

投稿时可以写标签(最多 8 个)、长描述、支持的平台(`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`)和 Forsion 版本范围:最低版本含本身,最高版本不含。包里 manifest 的 `minAppVersion`、`maxAppVersion`、`platforms` 优先于投稿表单。商店首页按这些筛选,安装前桌面和手机会再核一遍包里的 manifest,版本或平台不符的不下载、不写盘。每个条目有公开的评论区,新评论发到你(投稿账号)的收件箱,回复也通知被回复的人;你可以在评论区关掉全部或某一个插件的评论消息,评论照样公开。

When you submit, you can add tags (up to 8), a long description, supported platforms (`desktop`, `macos`, `windows`, `linux`, `android`, `ios`, `web`) and a Forsion version range: the minimum is inclusive, the maximum exclusive. `minAppVersion`, `maxAppVersion` and `platforms` in the package manifest take precedence over the form. The Store home filters on them, and desktop and phone check the package manifest again before installing: a version or platform that does not fit is never downloaded or written to disk. Every listing has a public comment section. New comments reach your inbox (the submitting account) and replies also notify the person replied to; you can turn off comment messages for all your plugins or for one, and the comments stay public.

发新版或改商店信息时,在「投稿」里选中你的条目:ZIP 拖进新包,GitHub / npm 先在原渠道发新版本再点「检查新版本」。版本号只从包里或上游读(技能写在 SKILL.md 的 `version` 或 `metadata.version`),要比商店当前的高。提交前会先检查一遍,列出读到的类型、版本、图标和 README,你确认后才提交。简介、标签、长描述和版本要求可以单独编辑,不用传包。已上架的条目改了都要过审,通过前商店照旧,审核结果发到你的收件箱。

To ship a new version or change the Store details, select your item under Submissions: drop a new ZIP, or for GitHub and npm publish the new version there first and choose “Check for a new version”. The version is always read from the package or upstream (for skills, `version` or `metadata.version` in SKILL.md) and must be newer than the Store’s. The package is checked before anything is submitted: you see the type, version, icon and README that were read, then confirm. Summary, tags, description and version requirements can be edited on their own, without a package. Changes to a published item are reviewed; until then the Store keeps the current version and details, and the review result goes to your inbox.

## 在 Android 上用插件

Forsion Android App 也能装 Forsion 插件,与桌面是同一套插件接口:

- **只经应用市场装** — 「⋯」菜单 → 应用市场;手机上市场只列出 Forsion 插件(技能、Agent、引擎插件、主题、Space 请在桌面端装)。装完立即启用,不用重启。
- **插件住在 App 私有目录**,不在任何笔记库里;设置 → 插件 里照常启停、看详情、卸载(卸载保留插件自己存的设置,重装后还在)。手机上没有可见的插件文件夹,所以没有「打开插件文件夹 / 创建示例插件」。
- **仅桌面的插件** — manifest 里写 `"isDesktopOnly": true` 的插件(比如依赖本机程序、Node 或引擎插件的),手机上拒装并说明原因;已经在列表里的显示「仅支持桌面端」,代码不会被执行。
- **命令在「⋯」里** — 插件注册的命令除了进命令面板,还按插件分节直接列在顶栏「⋯」菜单里(节标题 = 插件名),手机上不用先开命令面板。
- **主页只有一页** — 在主页里运行插件命令打开的视图,会带你到这个插件自己的 Space 里打开;插件没有带 Space 的,视图先盖在主页上,下次回到主页时自动收起。
- 手机暂不支持:插件的状态栏项(手机没有状态栏)、插件捆绑包里的引擎插件 / Agent / 技能 / Space。

## 安全模型

插件能力大,约束也硬:

- npm 渠道**只下载文件、绝不执行安装脚本**,杜绝装包即中招;
- 引擎插件提供的工具**纳入审批体系**,插件自己也绕不过"动手前问你",见[工具与审批](../chat/tools-and-approvals.md);
- 插件跑在受限接缝上,能力按它声明的那些授予 —— 没声明的拿不到;界面上一个插件出问题不会拖垮整个应用;
- 插件自带的 MCP 工具同样过审批,它带的 hook 只能看、不能拦也不能往对话里加内容(见下「插件自带的 MCP、hooks 与文件事件」)。

## 开发者

插件用 JavaScript / TypeScript 编写,官方提供类型定义与模板。内置的「Forsion 扩展开发」技能可以让 Agent 照官方模板直接脚手架出插件、主题、Space 或智能体的骨架,见[技能](../agents/skills.md)。

需要让插件产物与原生笔记面板联动时,使用 `ctx.app.openNote(path, { reuseKey, activate })`:同一 `reuseKey` 的 Amadeus 面板会原地切换到新笔记；`activate:false` 可保持用户焦点在插件面板。配合 Space 主区条目的 `split:"right"` / `split:"down"`,插件无需在自己的 DOM 里复制文档编辑器或聊天界面。

插件视图的布局优先放进原生 Panel,别在一个视图里自造侧栏、底栏:列表进左栏工作区(`registerListSource`),主体留在主区,属性与检查器放右栏(或用 Extend View),时间线、日志、终端这类横跨全宽的内容放底部面板 —— Space 配方写 `layout.bottom`,或 `ctx.openView(id, { location: 'bottom' })`;底部横跨哪几列由配方的 `layout.bottomSpan` 定(缺省 `right` = 主区+右栏,另有 `left` / `full` 通栏 / `main` 只在主区下方)。底部面板旧宿主没有、移动端也没有,依赖它之前先查 `ctx.viewLocations?.includes('bottom')`,不满足就在视图里自绘。像 Coding Studio 那样「没打开项目时左栏是导航、打开后换成项目内容」:用 `ctx.replaceView?.('nav', 'media')` 原地换自己的视图(返回 0 别拿 `openView` 兜底,会弹出用户收起的面板),回启动台时反过来换,再 `ctx.closeView?.('timeline')` 收起底部。侧栏同理:某一页不要右栏、别的页才出详情时(像蓬洲云的概览),在那一页调 `ctx.closeView?.('info', { collapse: true })` —— 那一侧只剩这个视图就整侧收起(视图留在暂存里,用户展开或你下次 `openView` 时回来),不留空占位;侧栏里还有别的视图就照常关。旧宿主忽略这个选项、留占位(2026-10-18 起)。想让导航一直找得回来,就在配方里给它写 `"pinned": true`(固定 View:该区内始终留一个,关不掉、拖不出本区):这时同一句 `replaceView('nav', 'media')` 不再顶掉导航,而是把 `media` 作为第二个标签开在它旁边并顶到前台,反过来换时只摘掉 `media`——插件代码不用改。要让人每次进这个 Space 先看到某个视图(像内置的主页),在配方的 `layout.main` 里给那一条写 `"mainPage": true`(默认主页,至多一条):切进来、冷启动、人已在里面再点一次图标,前台都是它,别的标签留在后台;不写就照旧还原上次离开时的样子。通常和 `"pinned": true` 一起写。侧栏的标签只显示图标:会和别的视图同处一栏的视图,注册时给 `icon`(插件图标词表里的名字,如 `list-view`、`image`),否则几个标签都是同一个通用图标。进出项目的布局跳转会让宿主重挂主区视图:跨这一下要留的临时状态放模块作用域,等用户真正用掉再清(别在第一次交给界面时就清);关项目时先清掉新挂载会拿来重开项目的依据(视图参数、模块里的当前项、存盘的上次打开,存盘要 await),再拆界面、换布局。

Lay plugin views out in native panels instead of drawing sidebars or bottom bars inside one view: lists in the left workspace, the subject in main, properties on the right, and timelines, logs or consoles in the bottom panel (`layout.bottom` in a Space recipe, or `ctx.openView(id, { location: 'bottom' })`). A recipe's `layout.bottomSpan` picks the columns the bottom panel spans: `right` (default; main and right sidebar), `left`, `full` or `main` (main only). Older hosts and mobile have no bottom panel: check `ctx.viewLocations?.includes('bottom')` first and fall back to drawing it in the view. To switch layouts the way Coding Studio does (navigation on the left until a project is open, then the project's own content), swap your own views in place with `ctx.replaceView?.('nav', 'media')`. If it returns 0, don't fall back to `openView`: that would expand a panel the person collapsed. Swap back on the way out, then call `ctx.closeView?.('timeline')` to close the bottom panel. Side panels work the same way: when one page doesn't need the right panel (an overview, say) and the others show details there, call `ctx.closeView?.('info', { collapse: true })` on that page. If the panel holds nothing but that view, it folds away (the view waits in the stash and comes back when the person reopens the panel or on your next `openView`) instead of showing the empty placeholder; with other views in the panel it closes as usual. Older hosts ignore the option and leave the placeholder (2026-10-18+). To keep the navigation reachable at all times, mark it `"pinned": true` in the recipe (a pinned view: its panel always keeps one, it cannot be closed or dragged out of that panel). The same `replaceView('nav', 'media')` then leaves the navigation in place and opens `media` as a second tab beside it, in front; swapping back only removes `media`. The plugin code stays the same. To have people land on one view every time they enter the Space (like the built-in Home), set `"mainPage": true` on that item in the recipe's `layout.main` (at most one). Switching to the Space, launching into it, or clicking its icon again then brings that view to the front, with other tabs kept behind it. Without it, the Space reopens the way it was left. Usually pair it with `"pinned": true`. Side-panel tabs show an icon only: give any view that shares a side panel with another an `icon` when registering it (a name from the plugin icon vocabulary, such as `list-view` or `image`), or the tabs all show the same generic icon. Jumping between the launch and project layouts makes the host remount the main view. Keep state that must survive that at module scope, and clear it only once the person has used it, not when the first mount receives it. When closing a project, first clear whatever a new mount would reopen it from (the view's params, the module's current project, the saved last project, awaiting the save), then tear down and swap the layout.

右栏跟着主视图走(2026-10-20 起):右栏 = 本 Space 固定的视图 + 主区前台视图自带的那组 + 用户自己开进来的。给视图注册时写 `rightCompanions`(视图类型全名的数组,和 space.json 同一套写法:自己的写 `plugin:<插件id>:<视图id>`,宿主的写 `chat-panel` / `outline` / `tangu-details` / `workspace` 这些名字),它到主区前台时右栏就换成这组,第一项顶到前台;切走时收回不在下一组里的,同一类视图换文件不动,右栏收着时只换暂存、不弹出来,新建标签页不算。没写 `rightCompanions` 的视图用 Space 配方的 `layout.right`。所以你的 Space 里打开宿主的笔记、对话或 PDF(它们自带组)时,`layout.right` 会让位,回到你的视图再回来;不想让位的条目写 `"pinned": true`。组里只放能进侧栏的视图:主区的 `chat`、笔记编辑器、PDF 会被滤掉,右栏要对话写 `chat-panel`(`layout.right` 里写 `chat` 的老配方,宿主按 `chat-panel` 开);最多 4 项,建议 3 项以内。组写「这种视图通常需要什么」,点了某一行才出来的详情和表单用 Extend View。用户自己开、拖进右栏的视图规则永远不关。旧宿主忽略 `rightCompanions`,要紧的右栏视图照旧写进 `layout.right`。左栏不跟主视图走:左栏是 Space 的,第一项一般写本 Space 的工作区视图并标 `"pinned": true`。

The right panel follows the main view (2026-10-20+): it holds the Space's pinned views, the group the front main view brings along, and whatever the person opened there themselves. Give a view `rightCompanions` when you register it (full view types, the same way space.json writes them: your own as `plugin:<plugin id>:<view id>`, host views by name such as `chat-panel`, `outline`, `tangu-details` or `workspace`). When that view comes to the front of the main area, the right panel switches to that group and its first entry comes to the front; switching away retires the entries the next group does not have. Opening another file in the same kind of view changes nothing, a collapsed right panel only has its stash updated and stays collapsed, and a new tab does not count. A view without `rightCompanions` uses the recipe's `layout.right`, so when your Space opens a host note, chat or PDF (they bring their own groups), `layout.right` steps aside and comes back with your view; mark an entry `"pinned": true` to keep it. Only side views belong in a group: the main-area `chat`, the note editor and PDF are dropped, so ask for `chat-panel` to get a chat on the right (older recipes with `chat` in `layout.right` open as `chat-panel`). At most 4 entries are used; keep it to 3 or fewer. A group says what this kind of view usually needs; details or forms that open from one row belong in an Extend View. Views the person opens or drags into the right panel themselves are never closed by the host. Older hosts ignore `rightCompanions`, so keep what matters in `layout.right` too. The left panel does not follow the main view: it belongs to the Space, and its first entry is usually the Space's workspace view, marked `"pinned": true`.

左栏列表(`registerListSource`)可以带层级,画法和笔记树的文件夹一样。行还是一张平铺的数组:给行写 `parent`(上一级那一行的 `key`),上一级写 `kind: 'folder'`;文件夹点一下开合,不调 `open()`,开合状态由宿主记住,当前打开的那一行所在的文件夹会自动展开。搜索时不画层级,只平铺匹配的行。静态分组(`group`)的标题也可以点开合。`itemMenu(文件夹)` 里带 `primary` 的那一项会画成行尾的「+」。要让用户拖动整理:给能拖的行写 `draggable: true`,`drop.accepts` 里加 `'items'`;落下时 `onDrop({ items }, { item, position })` 告诉你拖的是哪几行、落在哪一行的前面(`before`)、后面(`after`)还是放进文件夹(`into`),`canDrop` 返回 false 可以拒绝某个落点。宿主只画提示,不替你移动:你改完自己的数据再通知订阅者。就地改名同理:行写 `renamable: true`,源上声明 `rename(item, title)`,菜单项、输入框和按键(回车提交、Esc 取消、F2 开始)都由宿主负责。这三样在旧宿主上不存在,用 `ctx.listCapabilities?.includes('tree' | 'items' | 'rename')` 判断;探测不到时照旧输出平铺的行(否则文件夹会被画成一条普通的行)。

把行按「是谁的」归组(发信人、账号、来源)时,给最上面一级的文件夹再写 `folderStyle: 'group'`:它会画成 Tangu 左栏里 Agent / 项目那种一级行,前面是头像(`iconUrl`)、方块里的图标(`icon`)或标题的首字,`hint` 是行尾的小胶囊(适合放未读数)。组里的行不再画自己的图标,只留未读的圆点,一组先列 5 条,其余在「查看更多」后面。这种组的开合只记到应用重启:写了 `defaultOpen: true` 的组自己开着(比如里面有未读),它由假变真时宿主会重新打开这一组;不写就是收着。组的先后由你的数组顺序决定。搜索时不画层级,所以带 `query` 时请返回平铺的行。手机上,只有这一层组头的列表仍然是整屏列表,组里的行照样可以左滑。用 `ctx.listCapabilities?.includes('group')` 判断宿主认不认;不认的宿主会把它画成普通文件夹。

To group rows by whose they are (senders, accounts, sources), also set `folderStyle: 'group'` on the top-level folders: each is drawn like the first-level rows for agents and projects in the Tangu sidebar, led by an avatar (`iconUrl`), an icon in a tile (`icon`) or the first letter of the title, with `hint` as a small pill at the end (good for an unread count). Rows inside a group give up their own icon and keep only the unread dot; a group lists five rows and puts the rest behind "View more". These groups remember their fold state only until the app restarts: a group with `defaultOpen: true` is open (say, while it holds something unread) and the host reopens it each time the flag turns on; without the flag it starts folded. Groups appear in the order of your array. Search shows no hierarchy, so return flat rows when `query` is set. On a phone a list whose only folders are these group heads keeps the full-screen list, and rows inside a group can still be swiped. Check `ctx.listCapabilities?.includes('group')`; hosts without it draw a plain folder.

桌面上,指针停在列表的一行上时,`itemMenu()` 里带 `icon` 的动作会在行尾排成一排图标钮,旁边仍是列出全部动作的「更多」菜单。它们和手机上左滑出来的是同一批、同一个顺序,所以把最常用的动作放在前面并配上图标;没有 `icon` 的动作只出现在菜单里。旧版宿主只有「更多」菜单。

On a desktop, while the pointer is over a list row, the actions from `itemMenu()` that carry an `icon` line up as icon buttons at the end of the row, next to the "more" menu that lists every action. They are the same actions, in the same order, as the ones behind the left swipe on a phone, so put the most used ones first and give them icons; an action without an `icon` appears only in the menu. Older hosts show the "more" menu alone.

列表行可以有第二行:给行写 `subtitle`,宿主在标题下面画一行淡字(只占一行,超出省略),适合放「谁发的 · 第一句话」或状态;不写就是原来的一行。只收纯文本,文件夹行不显示;旧版宿主会忽略这个字段。右边的 `hint` 和行首图标都对齐第一行。图标词表另外加了三枚表示来源的图标:`cloud`、`workflow`、`agent`。

A list row can have a second line: set `subtitle` and the host draws one dim line under the title, cut with an ellipsis — good for "who sent it · first sentence" or a status. Rows without it stay one line high. It is plain text only, folder rows do not show it, and older hosts ignore the field. The `hint` on the right and the leading icon stay aligned with the first line. The icon vocabulary also gains three source icons: `cloud`, `workflow` and `agent`.

手机上(安卓原生外壳),平铺的列表源(没有文件夹行、没有 `parent`)画成手机的整屏列表,和会话、笔记列表同一套:`groups()` 是一排分类胶囊;行是图标块 + 标题和 `hint` 一行 + `subtitle` 一行;搜索在顶上的搜索钮和下拉里;`itemMenu()` 的动作在左滑后面,是只有图标的圆钮;`primary` 的动作是右下角的主按钮,其余 `actions` 在它的长按菜单里。因此动作可以带 `icon`(图标词表里的名字):没有 `icon` 的行动作不进左滑(仍在长按菜单里),没有 `icon` 的主动作画成加号;成对的动作各给各的图标。词表为此加了 `mail`、`mail-open`、`archive`、`unarchive`、`trash`、`refresh`。带层级的源在手机上仍是树(只有一层组头的除外,见上)。旧版宿主忽略 `icon`。

On a phone (the Android native shell) a flat list source — no folder rows, no `parent` — is drawn as the phone's full-screen list, the same parts the session and notes lists use: `groups()` become a row of chips; a row is an icon block, the title and `hint` on one line, `subtitle` on the next; search sits behind the search button at the top and a pull-down; the actions from `itemMenu()` sit behind a left swipe as round, icon-only buttons; the `primary` action is the main button at the bottom right, with the other `actions` in its long-press menu. So an action may carry an `icon` (a name from the icon vocabulary): a row action without one is left out of the swipe tray (it stays in the long-press menu), and a primary action without one is drawn as a plus sign; give paired actions each their own icon. The vocabulary gained `mail`, `mail-open`, `archive`, `unarchive`, `trash` and `refresh` for this. Sources with a hierarchy stay a tree on a phone (except a list whose only folders are group heads, see above). Older hosts ignore `icon`.

The left-sidebar list (`registerListSource`) can be hierarchical, drawn like the folders of the notes tree. Rows stay one flat array: give a row `parent` (the `key` of the row above it) and mark that row `kind: 'folder'`. Clicking a folder folds or unfolds it instead of calling `open()`; the host remembers which folders are open and unfolds the one holding the active row. Search shows matching rows flat, without folders. Static section headings (`group`) fold too. An action marked `primary` in `itemMenu(folder)` becomes the `+` button at the end of the row. To let people rearrange by dragging, mark rows `draggable: true` and add `'items'` to `drop.accepts`; `onDrop({ items }, { item, position })` then tells you which rows moved and whether they landed `before` or `after` a row or `into` a folder, and `canDrop` can refuse a spot by returning false. The host only draws the hint and never moves anything: update your own data, then notify the subscriber. Renaming in place works the same way: mark rows `renamable: true` and declare `rename(item, title)` on the source; the host owns the menu entry, the input and the keys (Enter commits, Escape cancels, F2 starts). Older hosts have none of this. Check `ctx.listCapabilities?.includes('tree' | 'items' | 'rename')` and keep emitting flat rows when it is missing, otherwise a folder shows up as an ordinary row.

插件自带的 Space 没出现在功能条上时,先看设置里那张插件卡片:挂着「Space 未显示」就点开详情,里面写着是哪个 Space、缺什么 —— 它引用的视图没有注册,或者需要更新的 Forsion 版本。最常见的一种是插件加载没有报错、却一个视图也没注册:`main.js` 里某个函数没收口,把后面的 `ctx.registerView` 包了进去。开发副本在 Coding Studio 的 Sandbox 面板里能看到这次加载注册了哪些视图。也可以直接让 Agent 查:「Forsion 扩展开发」技能带一份插件体检脚本(`tools/check-plugin.mjs`),照宿主的方式跑一遍 `main.js`、对账每个 Space 要的视图,并指出没跑到的注册代码在第几行到第几行。体检会执行插件代码,只对你信得过的插件用。

When a plugin's bundled Space is missing from the ribbon, check the plugin's card in Settings first: a **Space hidden** badge opens to the Space's name and what it is waiting for — a view that was never registered, or a newer Forsion version. The most common cause is a plugin that loads without an error yet registers no views: an unclosed function in `main.js` swallowed the `ctx.registerView` calls after it. For a development copy, the Sandbox panel in Coding Studio lists the views the current load registered. You can also ask the agent: the built-in Forsion extension development skill ships a plugin checker (`tools/check-plugin.mjs`) that runs `main.js` the way the host does, reconciles the views each Space needs, and points to the lines of registration code that never ran. The checker executes the plugin's code, so use it only on plugins you trust.

在沙箱里试插件(2026-10-23 起,桌面):让 Agent 写桌面插件时,它会先在**插件沙箱**里跑一遍,不直接装进你的 Forsion。沙箱是你电脑上另开的一份独立 Forsion:自己的空智库、未登录、不起 Tangu 引擎,只装这一个插件(开发副本,改完保存自动重载)。Agent 在里面看截图、读这个插件自己的控制台、跑它注册的命令;你也可以点对话里沙箱卡片上的「打开沙箱窗口」亲手试,遇到问题点窗口顶上的「报告问题」,写的话会回到发起它的那个对话的输入框。满意了点「安装到我的 Forsion」,会先问你一次,再把插件拷进你的插件文件夹(不带 `node_modules`)。沙箱里没有引擎,所以捆绑包里的引擎插件、智能体和技能要装好以后再试。同一时刻只有一个沙箱;沙箱窗口不在前台、15 分钟没人用,它会自己停。Coding Studio 的 Sandbox 面板也分这两档:「隔离沙箱」(缺省)和「我的 Forsion」——后者是原来那种把开发副本直接加载进你正在用的 Forsion,不是隔离环境。

Trying a plugin in the sandbox (2026-10-23+, desktop): when you ask the agent to write a desktop plugin, it runs it in the **plugin sandbox** first instead of installing it into your Forsion. The sandbox is a separate Forsion on your computer with its own empty vault, signed out and without the Tangu engine, where only this plugin is loaded (as a development copy that reloads when its files are saved). The agent looks at screenshots, reads the plugin's own console and runs the commands it registered. You can try it yourself with **Open sandbox window** on the sandbox card in the chat; if something is off, use **Report a problem** at the top of that window and what you write lands in the input box of the chat that started it. When you are happy with it, **Install in my Forsion** asks you once, then copies the plugin into your plugins folder (without `node_modules`). The sandbox has no engine, so a bundle's engine plugins, agents and skills are tried after installing. Only one sandbox runs at a time, and it stops by itself after 15 minutes without use while its window is in the background. The Sandbox panel in Coding Studio has the same two tiers: **Isolated sandbox** (the default) and **My Forsion**, the earlier loader that puts the development copy straight into the Forsion you are using and is not isolated.

引擎插件的工具用 `capabilities.approval` 声明动手前要不要问用户。不写 = 只读,不问;`'command'` = 与跑命令同一档,「询问我批准」时每次问,用户点过「总允许」或开了完全通行就不再问;`'always'` = 每次调用都由用户本人在卡上确认 —— 完全通行、「总允许」、用户写的放行规则都跳不过,聊天会话与云端会话照样弹卡,自动化、Muse 后台和远程会话里直接被拒。花掉用户的东西、替用户对外发出内容这类动作用 `'always'`;读和写拆成两个工具名,只给写的那个声明。卡上显示的是这次调用的参数,所以一次调用只做一件事。

An engine plugin tool declares whether the user is asked first with `capabilities.approval`. Leave it out for read-only tools (never asked). `'command'` puts the tool in the same class as running a command: asked every time in "ask me" mode, and no longer asked once the user picks "always allow" or turns on full access. `'always'` means the user confirms every single call on the approval card: full access, "always allow" and the user's own allow rules do not skip it, chat and cloud sessions ask as well, and automations, Muse background runs and remote sessions are refused outright. Use `'always'` for actions that spend something the user owns or send something out on their behalf. Split reading and writing into two tool names and declare it only on the writing one. The card shows the arguments of that call, so keep one call to one action.

引擎插件的工具可以在执行时调用 `ctx.presentDesk?.({ views: [{ type: 'view', view: 'plugin:<插件 id>:<视图 id>' }], size: 'half' })`,把自己的视图摆上 Agent Desk,和模型调 `desk_present` 效果一样,但不依赖模型记得去调。每轮只摆一次,用 `ctx.runId` 记(没有时用 `ctx.sessionId`);视图不带 `name` 时宿主用注册时的视图标题。没有 Desk 的环境里 `presentDesk` 不存在,所以用可选链。用户关掉 Desk 后,到下一条用户消息之前不会再弹出来。

An engine plugin tool can call `ctx.presentDesk?.({ views: [{ type: 'view', view: 'plugin:<plugin id>:<view id>' }], size: 'half' })` while it runs to put one of its views on the Agent Desk. It does the same as the model calling `desk_present`, without relying on the model to remember. Present once per run and track it with `ctx.runId` (fall back to `ctx.sessionId`). A view without a `name` gets the title it was registered with. `presentDesk` is missing where there is no Desk, so call it with optional chaining. After the user closes the Desk it stays closed until their next message.

宿主替插件画的零件(2026-10-26 起):插件不用再抄宿主的 CSS、自己算浮层位置、或者把文案在注册时定格。对话框用 `ctx.ui.confirm({ title, body, danger })`(返回 `Promise<boolean>`)和 `ctx.ui.openDialog({ title, body, mount(el), actions })`:居中、宿主的卡片外观、Esc / 遮罩 / 焦点由宿主管,危险操作主按钮是红的、焦点先落在「取消」,安卓上是原生确认框。视图头和工具栏里的分段与下拉用 `ctx.ui.mountControl(el, { type: 'segmented' | 'select', value, options, onChange })`:分段和视图模式切换是同一颗,下拉是 28px 的文字钮,点开是菜单样式的列表(6 项起带搜索,安卓上是原生抽屉);设置零件是整行,别放进工具栏。`ctx.ui.contextMenu` 的行可以带 `icon` 和 `shortcut`,列表里可以放 `{ separator: true }` 和 `{ section: '小节' }`,第一个参数可以是 `{ anchor: 按钮, align: 'end' }`,安卓上同一份数据是原生底部抽屉;更早的宿主会静默丢掉这些字段。按钮下方的小面板用 `ctx.ui.popover(按钮, { mount(el) })`。图标只有一张词表:`space.json` 的 `icon`、列表、菜单、设置、视图标签、控件、空态都认同一份名字,自己的按钮用 `ctx.ui.icon(名字, { size })` 拿一枚 `<svg>`,写错名字会在控制台提示一次(带最接近的名字)。列表源加 `empty: { icon, title, line, action }`:在你自己的 Space 里侧栏不再写「暂无内容」,手机整屏列表直接画这份空态;主区用 `ctx.ui.mountEmptyState(el, …)` 画同一个。视图头行用 `ctx.ui.setViewHead(el, { title })`(左标题、右按钮,不必先有视图模式)。样式表用 `ctx.addStyle(css)`,停用、重载时宿主会摘掉。文案用 `ctx.i18n.define({ zh, en })` 拿到 `t(key, vars)`;列表源标题、动作名、视图标题、菜单、对话框、控件、空态都收 `() => t('key')` 或 `{ zh, en }`,用户切语言时宿主画的部分自己重算(字符串照旧在注册那一刻定格)。用 React / Vue 写的插件拿不到宿主的组件,用 `ctx.ui.mount(name, el, props)` 在 ref 上挂宿主零件(`menu`、`popover`、`dialog`、`segmented`、`select`、`emptyState`、`icon`,props 有类型),别把宿主的菜单、浮层、对话框、图标、i18n 抄一份进包。这些接口在旧宿主上都不存在,用可选链判断。

Parts the host draws for plugins (2026-10-26+): no more copying host CSS, positioning overlays by hand, or strings frozen at registration. Dialogs: `ctx.ui.confirm({ title, body, danger })` returns `Promise<boolean>`, and `ctx.ui.openDialog({ title, body, mount(el), actions })` gives you the host's frame — centered, the host's card look, Escape / backdrop / focus handled; a dangerous action gets a red main button with focus starting on Cancel, and Android shows the native confirm sheet. For a segmented switch or a select in a view head or toolbar, use `ctx.ui.mountControl(el, { type: 'segmented' | 'select', value, options, onChange })`: the segmented switch is the same one view modes use, and the select is a 28px text button that opens a list in the menu style (with a search field from six options on; the native sheet on Android). Settings parts are full rows and don't belong in a toolbar. Rows of `ctx.ui.contextMenu` take an `icon` and a `shortcut`, the list takes `{ separator: true }` and `{ section: 'Heading' }`, the first argument can be `{ anchor: button, align: 'end' }`, and on Android the same entries open as the native bottom sheet; older hosts silently drop these fields. For a small panel under a button use `ctx.ui.popover(button, { mount(el) })`. Icons come from one vocabulary: `space.json`'s `icon`, lists, menus, settings, view tabs, controls and empty states all take the same names, and `ctx.ui.icon(name, { size })` gives your own buttons an `<svg>`; a wrong name is reported once in the console with the closest match. A list source can declare `empty: { icon, title, line, action }`: inside your own Space the sidebar then stops saying "Nothing here yet", and on a phone the full-screen list draws that empty state; draw the same one in your main view with `ctx.ui.mountEmptyState(el, …)`. `ctx.ui.setViewHead(el, { title })` gives a view its head row (title on the left, your buttons on the right) without needing view modes. Add stylesheets with `ctx.addStyle(css)`; the host removes them on disable and reload. `ctx.i18n.define({ zh, en })` returns `t(key, vars)`, and list-source titles, action names, view titles, menus, dialogs, controls and empty states take `() => t('key')` or `{ zh, en }`, so what the host draws for you follows a language switch by itself (a plain string is still frozen when you pass it). Plugins written with React or Vue never get the host's components: mount host parts on a ref with `ctx.ui.mount(name, el, props)` (`menu`, `popover`, `dialog`, `segmented`, `select`, `emptyState`, `icon`, with typed props) rather than bundling copies of the host's menus, overlays, dialogs, icons or i18n. None of these exist on older hosts, so call them with optional chaining.

## 下一步

- [商店](market.md) — 找现成的插件
- [工具与审批](../chat/tools-and-approvals.md) — 插件工具怎么被管住
- [自动化](../spaces/automation.md) — 用插件事件触发规则

## Mini Panel 扩展

插件内的 Space 可以声明专用 Mini 视图，只提供当前能力的快捷操作；宿主的“在主面板显示”会携带当前实体参数。未适配的 Space 不出现在 Mini 中，随插件禁用的适配会自动撤下。见 [Mini Panel 开发](./mini-panel-development.md)。

Plugin Spaces can opt into Mini Panel with a dedicated compact view. The host preserves current entity parameters when opening the main panel. See [the development contract](./mini-panel-development.md).

插件也可以不创建完整 Space，直接用 `ctx.openMiniPanel?.(viewId, options)` 打开已注册的紧凑视图；`mainViewId` 指定“在主面板显示”的去向。需要宽屏独立工具页时用 `ctx.openFloatingPanel?.(viewId, options)`。宿主自动添加插件命名空间并负责窗口生命周期。见 [Floating Panel 开发](./floating-panel-development.md)。

View 内需要输入框和模型选择时，使用 `ctx.ui.mountChatBox`；它复用宿主组件，并由插件显式处理提交。见 [可复用 UI 组件 / Reusable UI components](./ui-components.md)。Plugins can embed the host Chat Box with local draft and model selection through the same contract.

设置类页面（账号、额度与积分、诊断、偏好）用 `ctx.ui.mountSettingsPage(el, { groups })` 交一份整页描述：每组有图标、标题、说明、右上角按钮和若干项（开关、数值、按钮、输入框、分段、下拉、「选了就执行」、步进器、代码 + 复制、额度条、空 / 加载 / 出错、自定义块），插件只给文字、值和回调，宿主用自己的设置零件画并按端排版——手机上开关、数值、单个按钮留在右边，输入框、步进器、两个以上的按钮换到下一行，「选了就执行」换成一枚按钮 + 半屏。清单外的内容放进 `custom` 块，块里用 `ctx.ui.mountSettingsItem` 挂单件。别再抄宿主的设置 CSS；2026-10-17 之前的宿主没有这两个接口，先探测，保留自己画的那套。见 [可复用界面组件](./ui-components.md)。Settings-like pages (account, quota and credits, diagnostics, preferences) hand the host a page description through `ctx.ui.mountSettingsPage(el, { groups })`: each group has an icon, title, description, top-right buttons and items (switch, value, buttons, input, segmented, select, pick-to-run choice, stepper, code with copy, usage meters, empty / loading / error, custom block). The plugin supplies the text, values and callbacks; the host draws them with its own settings parts and lays them out per device — on phones switches, values and single buttons stay at the right, inputs, steppers and two or more buttons move under the title, and a pick-to-run choice becomes one button and a half sheet. Put anything else in a `custom` block and mount single parts there with `ctx.ui.mountSettingsItem`. Do not copy the host's settings CSS. Hosts before 2026-10-17 lack both methods: feature-detect and keep your own page there. See [Reusable UI components](./ui-components.md).

要在自己的内容上手写或圈画时（PDF 页、图片），使用 `ctx.ui.mountBoard` 把宿主白板引擎挂成一块透明层，不在手写时用 `ctx.ui.boardToSvg` 出静态图；视口与保存归插件。见 [可复用 UI 组件 / Reusable UI components](./ui-components.md)。Plugins can overlay the host whiteboard engine on their own content with `ctx.ui.mountBoard` and render stored ink with `ctx.ui.boardToSvg`; the plugin owns the viewport and persistence.

以 `override: true` 接管了 `.pdf` 的文件类型，会接住所有「打开这份 PDF」的入口：文件树、最近使用、笔记里的 `[[x.pdf]]`，以及带页码或引语的 `[[x.pdf#page=3]]` 和聊天引用。带落点的那几种经 `mount(el, file)` 的 `file.onGoto?.(cb)` 把 `{ page, quote? }` 交给插件（2.13.2 之后的桌面版本；更早的版本把笔记链接和带落点的跳转交给内置阅读器）。回调可能在文件还没加载完、或标签刚从后台切回来时到达，先记下、能滚动了再跳。`![[x.pdf]]` 嵌入和「用内置阅读器打开」不在接管范围内。A file type that takes over `.pdf` with `override: true` receives every "open this PDF" entry: the file tree, recent items, `[[x.pdf]]` note links, and jumps that carry a page or a quote (`[[x.pdf#page=3]]`, chat citations). Those jumps reach the plugin through `file.onGoto?.(cb)` on `mount(el, file)` as `{ page, quote? }` (desktop versions after 2.13.2; earlier versions send note links and such jumps to the built-in reader). The callback can arrive while the file is still loading or just as a background tab comes back to the front, so hold the target until you can scroll. `![[x.pdf]]` embeds and "Open with the built-in reader" are not taken over.

标签被换到后台时，宿主把视图的 DOM 从文档里摘下来（不卸载，状态都在），换回来原样挂回；摘下期间量到的尺寸和滚动位置都是 0。2.13.3 之后的桌面版本在换回来时把视图里每个滚动容器的位置写回去，插件不用自己记（更早的版本一律回到顶上）。同一批版本里，⌘ / Ctrl + 点击文件树、双链、聊天引用会在新标签页打开文件类型视图，视图在主区显示时侧栏对话会自动引用这份文件。When a tab goes to the background the host detaches the view's DOM from the document (the view is not unmounted and keeps its state) and re-attaches it when the tab comes back; sizes and scroll positions read as 0 while detached. Desktop versions after 2.13.3 write every scroll container's position back on return, so a plugin does not need to remember it (earlier versions always come back at the top). In the same versions, Cmd / Ctrl + click on the file tree, wikilinks and chat citations opens a file-type view in a new tab, and the side chat automatically references the file shown in the main area.

View 内需要一个完整的常驻对话时（例如创作类 Space 的右栏），使用 `ctx.tangu.mountChat`：宿主把原生对话固定在该插件、该文件夹的一条会话上，Agent 生成的文件直接落进这个文件夹。Plugins that need a full, persistent chat inside a view (for example the right panel of a creative Space) use `ctx.tangu.mountChat`; the host pins the native chat to one session per plugin and folder, and files the Agent generates land in that folder. 见 [可复用 UI 组件 / Reusable UI components](./ui-components.md)。

要一个「在这里打字、按发送就去 Tangu 开新对话」的输入区时（主页就是这么用的），使用 `ctx.tangu.mountComposer`：宿主把主页那一整块新对话输入区挂进来（附件、模式、项目、运行位置、语音、通话都在），用户按发送后由宿主建会话、切到 Tangu 并发出，插件只能读到草稿（`draft()`），改不了要发的内容。A plugin that wants a "type here, send to a new Tangu chat" box, as Home has, uses `ctx.tangu.mountComposer`: the host mounts the full new-chat composer from Home (attachments, modes, projects, run location, voice and calls included), and when the user presses Send the host creates the session, switches to Tangu and sends it; the plugin can read the draft (`draft()`) but cannot change what is sent.

不需要对话、只要模型回一段文字时用 `ctx.tangu.complete`（一次性调用：没有工具、不进任何会话，用聊天当前的模型）。翻译用 `ctx.tangu.translate({ text, language })`：同一条通道，但模型取用户在「设置 → 模型 → 翻译」里选的那个；没选时账号里有机器翻译模型就用它，都没有才跟聊天模型（2.13.3 及更早的桌面版本：没选就跟聊天模型）。逐句翻译这类量大的活应当走它；它只返回译文。旧版本没有 `translate`，先探测再退回 `complete`。When a plugin only needs the model to return a piece of text, use `ctx.tangu.complete` (a one-shot call: no tools, no session, on the current chat model). For translation use `ctx.tangu.translate({ text, language })`: the same channel, but on the model the user picked under Settings → Models → Translation. When none is picked, a machine translation model is used if the account has one, and the chat model otherwise (desktop versions up to 2.13.3 go straight to the chat model). High-volume work such as sentence-by-sentence translation belongs here; it returns the translation only. Older versions have no `translate`, so feature-detect and fall back to `complete`.

同一份东西的几种看法（转写 / 笔记 / 纪要、文档 / 画布这类）交给宿主画：`ctx.ui?.setViewModes?.(el, { modes, value, onChange })`，`el` 是 `mount()` 收到的元素，`modes` 是 2–4 个 `{ id, label, labelEn?, icon? }`。胶囊画在视图头行最左，⌥⌘V（Windows / Linux：Ctrl+Alt+V）切下一种、命令面板每种一条「看法：X」、视图窄于 480px 只留图标、窄于 320px 收成下拉、手机上进顶栏，这些都归宿主。句柄的 `actions` 是同一行右边的空位，把自己栏里的按钮挪进去，整个视图只留一条头行；`set(id)` 是插件自己切（不回调 `onChange`）。看到哪一种由插件按记录 / 文件自己记，宿主不存。2.13.4 及更早没有这个方法，先探测、保留自己的标签。见 [可复用界面组件](./ui-components.md)。Views of the same thing (Transcript / Notes / Summary, Document / Canvas) are drawn by the host: `ctx.ui?.setViewModes?.(el, { modes, value, onChange })` with the element `mount()` received and 2–4 `{ id, label, labelEn?, icon? }` modes. The host draws the switch at the left end of the view's head row and owns ⌥⌘V (Ctrl+Alt+V) to the next mode, one "View: X" command per mode, icons only under 480px of view width, a menu under 320px and the phone top bar. Move your toolbar buttons into `handle.actions` (the right end of the same row) so the view keeps one head row; `set(id)` switches without calling `onChange`. Remember the mode per record or file yourself; the host stores nothing. Desktop 2.13.4 and earlier lack the method, so feature-detect and keep your own tabs there.

按钮和图标的悬停提示用宿主那一个：`ctx.ui?.attachTooltip?.(el, content, { side })`，300ms 才出、相邻接力不重播、键盘聚焦立刻出，和宿主自己的按钮一个样子；`content` 是一行或几行文字，句柄 `{ update, dispose }`，插件禁用时宿主统一收。图标按钮留 `aria-label`、去掉 `title`；旧宿主没有这个方法就照旧 `title`。见 [可复用界面组件](./ui-components.md)。Hover hints on buttons and icons use the host tooltip: `ctx.ui?.attachTooltip?.(el, content, { side })` — 300ms delay, neighbours hand the open tooltip over without replaying it, keyboard focus shows it at once, the same look as the host's own buttons. `content` is one or several lines; the handle has `update` and `dispose`, and the host disposes it on disable. Keep `aria-label` on icon buttons and drop their `title`; older hosts lack the method, so fall back to `title` there.

拖动排序、拖进去的落点提示也用宿主那一个：`ctx.ui?.dropIndicator?.()` 拿到 `{ line, zone, hide, dispose }`，传视口坐标；换落点原地淡出淡入、颜色跟主题，给 `key` 免得滚动被当成换落点，插件禁用时宿主统一收；旧宿主没有就照旧自己画。见 [可复用界面组件](./ui-components.md)。Drag-to-reorder and drag-into indicators use the host's too: `ctx.ui?.dropIndicator?.()` returns `{ line, zone, hide, dispose }` taking viewport coordinates; it fades between drop points in the theme's colour, a `key` keeps a scroll from counting as a new drop point, and the host disposes it on disable. Older hosts lack it, so draw your own there. 松手之后 `drop.land?.(行或找它的函数, 松手处)` 让被拖的那一行从松手处滑进新位置（2026-10-25 起，160ms，减少动态效果下直接到位）。After a drop, `drop.land?.(row or a function that finds it, from)` glides the moved row from where it was let go into its new place (2026-10-25+, 160ms; instant with reduced motion).

选中文字后浮出的那一条（划线条）对插件开放两半。一是加动作：`ctx.registerSelectionAction({ id, title, run })` 的动作列在条上的「⋯ → 插件」里，`run(cx)` 返回的 markdown 进宿主的结果卡（笔记里用户点「替换 / 插入下方」才写，别处只读）。不写 `scope` 只在笔记里出现；`scope: 'all'` 出现在所有有这一条的视图（笔记、聊天、接入了的插件视图），`'own'` 只在自己的视图，数组点名视图；`when({ view, editable, length })` 按视图和字数过滤，`output: 'none'` 表示结果由插件自己处理。二是让自己的视图用上这一条：`ctx.ui?.mountSelectionBar?.(root, { tools, source, ask, watch })`，宿主给「问 Tangu」「翻译」「⋯」，插件声明自己的工具（图标钮或颜色点）；不接就不出。这两半在 2.13.3 之后的桌面版本里才有：更早的版本只在笔记里列动作（「AI ▾ → 插件」），没有 `mountSelectionBar`，先探测、保留自己的菜单。见 [可复用界面组件](./ui-components.md)。The selection bar — the strip that appears over selected text — is open to plugins in two ways. Adding actions: entries from `ctx.registerSelectionAction({ id, title, run })` are listed behind "⋯" under "Plugins", and the markdown `run(cx)` returns goes to the host's result card (in a note nothing is written until the user picks Replace or Insert below; elsewhere the card is read-only). Without `scope` an action appears in notes only; `scope: 'all'` lists it in every view that shows the bar (notes, chat, plugin views that opted in), `'own'` only in the plugin's own views, and an array names views. `when({ view, editable, length })` filters by view and length, and `output: 'none'` means the plugin handles the result itself. Using the bar in your own view: `ctx.ui?.mountSelectionBar?.(root, { tools, source, ask, watch })` gives the view Ask Tangu, Translate and "⋯" from the host next to the tools the plugin declares (icon buttons or colour swatches); a view that does not call it gets no bar. Both exist in desktop versions after 2.13.3. Earlier versions list actions in notes only (under "AI ▾ → Plugins") and have no `mountSelectionBar`, so feature-detect and keep your own menu there. See [Reusable UI components](./ui-components.md).


## 读写多维表与笔记任务 / Tables and note tasks

日历、待办、习惯这类插件需要读写你库里的多维表，以及笔记里带 `@` 时间的任务（`- [ ] 交周报 @2026-10-20`）。插件必须在说明文件里声明 `databases`（多维表）或 `noteTasks`（笔记任务）才拿得到；没声明的插件看不到这些数据。拿到之后，插件改一格、勾一项，和你在表格里、笔记里亲手改是同一条路：打开着的表格立即跟着变，笔记视图的属性写进那篇笔记。插件删经典表的一行可以撤销；笔记视图的一行是一篇笔记，插件只能把它移进回收站。插件声明了哪些，插件详情页会列成一行「这个插件可以：……」给你看（读取前台窗口的 `activeWindow` 也列在这一行）。接口细节见插件开发技能「全库多维表与笔记任务」一节。

Calendar, to-do and habit plugins need to read and edit the tables in your vault and the dated tasks in your notes (`- [ ] Send report @2026-10-20`). A plugin gets them only if its manifest declares `databases` (tables) or `noteTasks` (note tasks); plugins that do not declare them cannot see this data. Once granted, a plugin changing a cell or ticking a task goes the same way as your own edit: open tables update at once, and note-view properties are written into that note. A plugin can undo deleting a row from a regular table; a note-view row is a note, so a plugin can only move it to the recycle bin. The plugin's detail page lists what it declared in one line, "This plugin can: …" (the `activeWindow` capability for reading the front window is listed there too). API details are in the plugin development skill, section "全库多维表与笔记任务".

### 日历叠加源与日历设置 / Calendar overlays and calendar settings

日历插件还需要宿主日历叠上去的那几类只读来源：Agent 日程、你加的 .ics 订阅、Local↔Cloud 另一侧库里的表，以及你的日历设置（哪些表在日历里、各用哪一列当日期和完成勾选、颜色、藏起来的来源、新建事件默认落进哪张表）。插件必须声明 `calendar` 才拿得到；没声明的插件只能用原来的「把自己的表登记进日历」。拿到之后，插件改颜色、加减日历里的表，和你在日历左栏「日历」列表里改是同一处，只对当前库生效；叠加源只能看不能改。插件订阅期间，宿主替它按时刷新这些来源（.ics 订阅要联网，和打开着的日历共用一个计时器，不会多拉）。同一项还让插件增删、改名、立刻刷新 .ics 订阅，或导入一份本地 .ics 文本，和日历设置里的「订阅」是同一份列表；插件详情页那一行会多一项「读取 Agent 日程、.ics 订阅和另一侧库里的日历，管理 .ics 订阅并改日历设置」。另外，插件可以打开笔记并直接跳到某个标题（`ctx.app.openNote(path, { heading })`）；通知上可以带一个按钮（比如「撤销」）；声明了 `databases` 的插件还能把宿主事件浮卡里那排字段（标题、时间、属性）挂进自己的卡片（`ctx.ui.mountRecord`），改动直接写回那张表。仪表盘卡片和插件自己的定时提醒还没有开放。接口细节见插件开发技能「日历叠加源与设置」一节。

A calendar plugin also needs the read-only sources the host calendar layers in: Agent schedules, the .ics subscriptions you added, and tables in the vault on the other side (Local↔Cloud), plus your calendar settings (which tables are in the calendar and which columns they use for the date and the done checkbox, colours, hidden sources, and the table new events go into). A plugin gets them only if its manifest declares `calendar`; plugins that do not declare it can still only add their own table to the calendar. Once granted, a plugin changing a colour or adding a table to the calendar changes the same settings as the "Calendars" list in the calendar's left panel, for the current vault only; overlays can be read but not changed. While a plugin is subscribed, the host refreshes these sources on schedule (.ics subscriptions go online; the timer is shared with an open calendar, so nothing is fetched twice). The same capability lets a plugin add, rename, remove and refresh .ics subscriptions or import a local .ics text; it is the same list as "Subscriptions" in the calendar settings. The detail page line gains "read Agent schedules, .ics subscriptions and calendars in your other vault, manage .ics subscriptions and change calendar settings". Plugins can also open a note at a heading (`ctx.app.openNote(path, { heading })`), put one button (such as Undo) on a notification, and, if they declare `databases`, mount the field list from the host's event card (title, time, properties) into their own card with `ctx.ui.mountRecord`; edits go straight back to the table. Dashboard cards and a plugin's own scheduled reminders are not open yet. API details are in the plugin development skill, section "日历叠加源与设置".

### Space 与 Ribbon 收纳架 / Spaces and the Ribbon shelf

启动台、主页一类插件可以列出你的 Space、点一下打开、显示图标和近况（继续某会话、最近的笔记、下一条日程、未读数），并在自己的界面里调整 Ribbon 上 Space 的顺序和收纳夹。插件必须声明 `spaces` 才拿得到；它改的就是 Ribbon 那一份顺序，在插件里拖一下，Ribbon 上跟着变，反过来也一样。某个 Space 换了图标（比如它的插件更新了），插件里画的图标也跟着换。插件详情页会多一项「打开 Space，调整 Ribbon 上 Space 的顺序和收纳夹」。接口细节见插件开发技能「Space 与 Ribbon 收纳架」一节。

Launcher and home-style plugins can list your Spaces, open them, show their icons and a status line (continue a chat, the latest note, the next event, unread count), and rearrange Spaces and folders on the Ribbon from their own view. A plugin gets this only if it declares `spaces`; it changes the Ribbon's own order, so a drag in the plugin moves the Ribbon too, and the other way round. When a Space's icon changes (say its plugin updates), the icon in the plugin changes with it. The detail page lists "open Spaces and rearrange Spaces and folders on the Ribbon". API details are in the plugin development skill, section "Space 与 Ribbon 收纳架".

另外三件零碎的：插件可以拿到当前登录的名字（`ctx.app.watchAccountName`，有昵称用昵称，只给名字不给令牌）、必应每日壁纸（`ctx.wallpaper.bing`，由 Forsion 代拉），以及和 Forsion 自己一样样式的右键菜单（`ctx.ui.contextMenu`）。菜单项多、窗口矮时自己滚动；做勾选清单时可以让它点了不关，一次勾好几项。Three smaller pieces: plugins can read the signed-in name (`ctx.app.watchAccountName`, the nickname if there is one; the name only, never a token), get Bing's daily wallpapers (`ctx.wallpaper.bing`, fetched by Forsion), and open a right-click menu styled like Forsion's own (`ctx.ui.contextMenu`). Long menus scroll when the window is short, and a checklist menu can stay open so you can tick several items in one go.

## 插件自带的 MCP、hooks 与文件事件 / Bundled MCP servers, hooks and file events

插件可以随包带上自己的 MCP server(只限在本机跑的那种),装好、启用之后 Tangu 就多了这些工具,停用插件就一起停掉。设置 → MCP 里会列出它们,写着来自哪个插件;要关掉,在插件设置里停用这个插件。插件也可以带 hook,在会话开始、工具跑完、一次回答结束时收到通知,用来做审计、归档这类事;这种 hook 只能看,拦不住任何操作,也不能往对话里加内容。设置 → Hooks 里同样列出它们,标着「只观察」。

插件还能收到笔记库里的文件事件:新建、删除、在 Forsion 里改名或移动、被别的程序或 Tangu 改动,以及换库。反链、自动整理这类插件靠它跟上库里的变化,不用一遍遍重新扫描。接口细节见插件开发技能的「插件自带的 MCP server 与 hooks」和「库级文件事件」两节;插件命令给 Tangu 交回查询结果的写法在「`invoke`:把一条命令开给 agent」一节。

A plugin can ship its own MCP servers (only ones that run on this computer). Once it is installed and enabled, Tangu gains those tools; disabling the plugin stops them. Settings → MCP lists them with the plugin they come from; to turn them off, disable the plugin in plugin settings. A plugin can also ship hooks that are told when a session starts, when a tool has run and when an answer ends, for auditing or archiving. These hooks only watch: they cannot block anything or add to the conversation. Settings → Hooks lists them too, marked "Observe only".

Plugins can also follow file events in your vault: files created, deleted, renamed or moved in Forsion, changed by another program or by Tangu, and switching vaults. Backlink and tidy-up plugins use this to keep up without rescanning the vault. For the API, see the plugin development skill, sections "插件自带的 MCP server 与 hooks" and "库级文件事件"; how a plugin command hands query results to Tangu is in the "`invoke`" section.

## IM 通道 / IM channels

引擎插件可以接入一个新的聊天软件(比如企业微信),和内置的微信、Telegram、QQ 通道用同一套:连接即新会话、远程审批、`/new` `/model` 等命令、收件箱转发、侧栏里的通道文件夹都现成。装好之后「设置 → 通道」里多一张卡,填上插件要的凭据、点「连接」就能用;停用插件,这个通道随之停下,已绑定的会话还在。接口见插件开发技能「引擎插件」一节的 `ctx.registerChannel`;企业微信插件是现成的例子。

An engine plugin can bring in another chat app (WeCom, for example) and reuse everything the built-in WeChat, Telegram and QQ channels have: a fresh session on connect, remote approvals, commands such as `/new` and `/model`, inbox forwarding, and the channel folder in the sidebar. Once installed, Settings → Channels shows a card for it; fill in the credentials the plugin asks for and click Connect. Disabling the plugin stops the channel and keeps the sessions it was bound to. For the API, see `ctx.registerChannel` in the "引擎插件" section of the plugin development skill; the WeCom plugin is a working example.

## 插件数据跨设备同步 / Plugin data sync across devices

插件在 manifest 里写 `"syncData": true`，它用 `ctx.saveData` 存的数据就会随 Forsion 账号同步到你的其他电脑和手机。没登录或断网时照旧只存在这台设备上，联网后再补传。两台设备都改过时，保留较晚的那次。插件详情页里有「跨设备同步插件数据」开关，可以在某台设备上单独关掉。网页版暂不同步。接口细节见插件开发技能「编辑器」一节里 `loadData/saveData` 那几条。

A plugin that sets `"syncData": true` in its manifest has the data it saves with `ctx.saveData` synced to your other computers and phones through your Forsion account. When you are signed out or offline, the data stays on this device and is uploaded later. If two devices both changed it, the later change wins. The plugin's detail page has a "Sync plugin data across devices" switch to turn it off on one device. The web version does not sync yet. For the API, see the `loadData/saveData` notes in the "编辑器" section of the plugin development skill.

## 开屏与图标 / Startup and icons

设置 → 外观 →「开屏与图标」支持上传品牌图标、动态开屏素材、选择默认／呼吸／旋转／静止，以及预览和恢复默认。品牌图标在应用内立即更新；桌面端还会写进系统，退出后仍保留（macOS 的访达／Dock／启动台图标，Windows 的开始菜单、桌面和任务栏快捷方式，Linux 仅运行时）。开屏下次启动生效，安装包图标不变。默认开屏是内置的「树影」（墙上的窗光与枝影，附一句古诗）；它不跟随应用图标，只在用户选了开屏素材时让位。原来的树标动画在「开屏素材 → 内置 → 经典图标」里，经典图标仍跟随应用图标。Web 与 Mobile 共用应用内设置；Android 的桌面图标只跟随内置图标（系统只允许在安装包自带的图标之间切换，且在离开应用后才切换），上传的图片与插件图标只在应用内显示，手机系统启动屏不在此入口内。

插件通过 `ctx.registerAppearance?.({ id, label, labelEn, icon, splash })` 提供可选的图片方案。素材嵌入插件包，选中后缓存，启动无需联网或等待插件执行；禁用或移除插件时回退默认。完整示例位于 `tangu-agent/skills/forsion-plugin/samples/forsion-sample-appearance/`。

Settings → Appearance → Startup and icons accepts custom brand icons and animated startup artwork, includes preview/reset, and offers built-in loading motion. Desktop also saves the static icon to the system so it stays after quitting (the Finder / Dock / Launchpad icon on macOS, the Start menu, desktop and taskbar shortcuts on Windows; on Linux only while running). Web and Mobile share the in-app appearance; on Android the home screen icon follows built-in icons only (the system switches between icons shipped in the app, and the switch happens after the app is left), uploads and plugin icons stay inside the app, and the native launch screen is separate. Plugins contribute choices through `ctx.registerAppearance`; selection stays with the user. Cached artwork works offline, and disabling or removing its plugin restores the default. The default startup screen is the built-in Tree shadow (window light and branch shadows on a wall, with one classical verse). It does not follow the app icon and yields only to selected startup artwork. The original animated logo remains under Startup artwork → Built-in → Classic logo, which still follows the app icon.

插件任务、只读外部引擎、隔离 Git 工作区、原生定时与 Desktop MCP 接缝见 [任务 SDK / Task SDK](./plugin-tasks.md)。

## 工具结果卡片 / Tool result cards

带引擎半身的插件,可以给自己注册的工具配一张结果卡片:Tangu 调用这个工具成功之后,对话里画的是插件的卡片,不再是一行通用的工具记录。卡片直接画在 Forsion 界面里,跟着主题、字号走。只有插件自己引擎半身注册的工具才能配卡片,内置工具和别的插件的工具都不行;工具还在跑、出错、等你批准,或者插件停用、重新加载时,照旧显示通用记录。重新打开旧对话,卡片照样在。

卡片默认在对话里,右上角可以「在 Desk 打开」。插件也可以声明一出来就放进 Agent Desk(白板、看板这类要大地方的),这时对话里留一张占位卡,写着「正在 Desk 中显示」,点「收回到对话」挪回来;Desk 顶上的 ⋯ 里也有「放回对话」。来回挪的时候插件会记住缩放、滚动这类状态。手机上、关掉了 Agent Desk、或者窗口窄到放不下 Desk 时,一律显示在对话里。卡片里可以把一段内容「引用」到输入框上方,和在回答里划线引用一样,发不发由你决定;卡片不能写文件,也不能替你发消息。接口细节见插件开发技能「Tool result cards」一节。

A plugin with an engine half can give the tools it registers a result card: after Tangu calls such a tool successfully, the chat shows the plugin's card instead of the generic one-line tool record. The card is drawn right in the Forsion interface and follows the theme and text size. Only tools the plugin's own engine half registered can get a card; built-in tools and other plugins' tools cannot. While the tool is still running, when it failed or is waiting for your approval, and while the plugin is disabled or reloading, the generic record shows. Cards come back when you reopen an old conversation.

A card sits in the chat by default, with "Open in Desk" at its top right. A plugin can also ask for a card to go straight into the Agent Desk (for whiteboards and boards that need room); the chat then keeps a placeholder that says "Showing in Desk", and "Back to chat" moves it back. The ⋯ menu at the top of the Desk has "Move back to chat" too. The plugin keeps state such as zoom and scroll position across moves. On phones, with the Agent Desk turned off, or when the window is too narrow for the Desk, cards always show in the chat. A card can quote part of its content above the chat input, the same as selecting text in a reply and quoting it, and you decide whether to send it; cards cannot write files or send messages for you. For the API, see the "Tool result cards" section of the plugin development skill.

## 摘要栏卡片 / Summary panel cards

Tangu 聊天右侧的摘要栏(2.13.8-beta.1 之后的桌面版本)是一叠卡片:进度、后台、产物、来源、工作范围和 Agent Desk。插件可以用 `ctx.summary?.registerCard({ id, title: { zh, en }, defaultCollapsed, mount(el, host) })` 加一张卡,和内置卡在同一个栈里:用户能折叠、拖动排序,收起状态和顺序由宿主记住;插件卡默认排在 Agent Desk 前面。`mount` 在每个会话的摘要栏里各调用一次(换会话会卸载重挂),`host.sessionId` 是这份所在的会话;`host.update({ count, hidden })` 改卡头的计数、或者先不显示这张卡。正文最高 240px,超出由宿主滚动。只有桌面 Tangu 有摘要栏,所以用可选链;更早的版本没有 `ctx.summary`。接口细节见插件开发技能「摘要栏插件卡」一节。

The summary panel on the right of a Tangu chat (desktop versions after 2.13.8-beta.1) is a stack of cards: Progress, Background, Outputs, Sources, Scope and the Agent Desk. A plugin adds a card with `ctx.summary?.registerCard({ id, title: { zh, en }, defaultCollapsed, mount(el, host) })`. It sits in the same stack as the built-in cards: people can collapse it and drag it to a new place, and the host remembers both; plugin cards start out above the Agent Desk. `mount` runs once per chat's summary panel (switching chats unmounts and mounts again), and `host.sessionId` is the chat it belongs to. `host.update({ count, hidden })` sets the count in the card header or hides the card for now. The body is at most 240px tall and the host scrolls anything longer. Only desktop Tangu has the summary panel, so use optional chaining; earlier versions have no `ctx.summary`. For the API, see the "摘要栏插件卡" section of the plugin development skill.

## Intelligent UI 卡片 / Intelligent UI cards

插件可以把已有的列表源开放成对话里的原生卡片：在 `registerListSource` 上加一个 `intelligent` 声明即可。列表由宿主渲染，数据与跳转仍只有 `items` / `subscribe` / `open` 这一份实现（示例见下方代码）。

- 宿主分配卡片 ID `plugin:<manifestId>:<sourceId>`；`viewId` 只在同一个插件内解析。`description` 写英文（供模型发现用），不超过 400 个字符；旧宿主忽略 `intelligent`。
- 声明了 `search: true` 的列表，卡片可以带一个可选的 `query`（最多 200 个字符）。模型传不进任意属性、HTML、CSS、回调或组件名。紧凑列表显示前六项，其余在完整视图里看。
- 卡片外框由宿主画，插件不用写样式。卡头是插件图标、「插件名 · 列表名」（英文界面用 manifest 的 `nameEn`；其中一个已经包含另一个时只显示长的那个）、一个「实时」点和打开完整视图的按钮；模型给这个块写的标题不显示。每一行显示条目的 `title` 与 `hint`，行首图标用条目自己的 `iconUrl`，取不到时退到 `icon`，再退到通用链接图标，与左栏列表一致 —— 两个都给，行才认得出来。
- Agent 用 `list_intelligent_cards` 发现当前可用的卡片，再在 `intelligent_ui` 里写 `app-card` 块引用。请求里只带元数据：显示卡片不会把记录交给模型，也不会保存生成的计划；分析与写入仍走已授权的领域工具和技能，原生的计划审批流程不变。
- 挂载时订阅，并在库可用后重读一次；数据变了要通知，返回取消订阅的函数。切换库时卡片会重新订阅。禁用插件会把这个来源撤出目录、卸下已有卡片并显示「暂不可用」；未知或已禁用的卡片不会用生成内容顶替，插件抛错只影响那一张卡。卡片是当前库的实时视图（重新打开旧对话时也是），不是历史快照，也不是跨设备的数据副本。

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
icon and `name · source title` (manifest `nameEn` in English; when one name already contains the
other, only the longer one is shown), a “Live” dot, and the full-view button; a title the model
writes for the block is not shown. Each row shows the item's `title` and `hint` and uses its own
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


### 云端设置页分组 / Cloud settings groups

首方内置包的 `registerSettingsView({ category: 'forsion', ... })` 可用 `parent` 指向同插件的一级页 ID；宿主只在左栏列出父页，在正文上方用页内标签切换父页与子页。父页本身是默认标签，`tabTitle` 指定它的标签文案；`title` 仍是左栏页名。两种标签均可传函数以跟随语言。`aliases` 是旧页 ID，优先认真实 ID；`keywords` 为设置搜索提供中英别名。父页缺失、跨插件或成环时保留为独立入口，不静默隐藏。挂载与卸载契约不变，切换分段仍调用现有 mount / dispose。旧宿主忽略这些可选元数据，继续显示平铺页面。

First-party `registerSettingsView({ category: 'forsion', ... })` pages may set `parent` to a top-level page ID in the same plugin. The sidebar lists the parent; section tabs select the parent page or one of its children. The parent is the default tab, and `tabTitle` supplies its section label while `title` remains the sidebar label. Both labels may be functions evaluated after locale changes. `aliases` maps old page IDs, with real IDs taking priority; `keywords` supplies search aliases. Missing, cross-plugin or cyclic parents remain standalone. The existing mount/dispose lifecycle applies to every section switch. Older hosts ignore these optional fields and retain flat navigation.

### 使用指南用到的接缝 / Seams used by the Guide

2026-10-17 起，宿主给插件多了几条接缝（随 Forsion Extend 的「使用指南」Space 一起加的）：

- `ctx.app.openSpace?(id)`：切到某个 Space，布局建好后 resolve；不认识的 id 返回 `false`。
- `ctx.app.openLink?(url)`：在应用内打开 `forsion://` 链接，只导航不执行。插件页、收件箱信和笔记正文里的 `forsion://` 链接，宿主本来就在应用内处理，不经过系统。
- `ctx.app.runCommand?(id)`：执行命令面板里已有的命令。**只对首方内置包生效**，其他插件调用一律返回 `false`。
- `ctx.app.spotlight?({ anchor, title, body?, step? })`（2026-10-19 起，**只对首方内置包生效**）：在真界面上圈住宿主标好的一处（锚点名：`ribbon-spaces`、`chat-composer`、`note-new`、`note-body`、`note-canvas`、`agent-new`），旁边一张小卡写「第几步 / 做什么」。不压暗、不拦点击，同一时刻只有一处；目标在收着的侧栏里会先展开那一栏。返回的 Promise 给出结果：`ok`（知道了 / Esc）、`mute`（不再提示，插件自己记下别再圈）、`gone`（目标消失）、`missing`（不认识的锚点、等 2 秒仍不在屏幕上，或不是首方包）、`replaced`（被下一次顶掉）；传 `null` 收起，得到 `closed`。旧宿主没有这个方法，用 `?.` 并照老做法。
- `ctx.achievements.count?(event, { own? })` / `subscribe?(cb)` / `isClaimed?(id)` / `claim?(id)`：读成就计数（缺省读官方事件，只读；读不到别家插件的计数），计数或领取变了就回调，读或领取自己系列里的成就。
- `ctx.inbox`（**只给首方内置包**）：`post({ title, body })` 发一封本机系统消息，`archive(id)`，`registerCard({ sender, mount })` 在你自己的信下面挂一块自绘卡片，并设置发件人显示名。
- 列表图标词表新增 `circle`（没做完）、`circle-check`（做完）、`lock`（锁住），给进度类列表用。`todo` 是块菜单的「待办」图标，自带勾，别拿它表示没做完。

Since 2026-10-17 the host offers a few more seams (added with the Guide Space in Forsion Extend):

- `ctx.app.openSpace?(id)` switches to a Space and resolves once its layout is built; an unknown id returns `false`.
- `ctx.app.openLink?(url)` opens a `forsion://` link inside the app. It only navigates, never runs anything. `forsion://` links in plugin pages, inbox letters and note text are already routed inside the app without going through the system.
- `ctx.app.runCommand?(id)` runs an existing command-palette command. **First-party built-in bundles only**; for any other plugin it returns `false`.
- `ctx.app.spotlight?({ anchor, title, body?, step? })` (since 2026-10-19, **first-party built-in bundles only**) rings one spot the host has marked in the real interface (anchors: `ribbon-spaces`, `chat-composer`, `note-new`, `note-body`, `note-canvas`, `agent-new`) and shows a small card beside it with the step and what to do. It doesn't dim the screen or block clicks, and only one spot shows at a time; if the target sits in a collapsed sidebar, the host opens that sidebar first. The promise resolves to `ok` (Got it / Esc), `mute` (Don't show again; the plugin should remember it), `gone` (the target disappeared), `missing` (unknown anchor, still not on screen after 2 seconds, or not a first-party bundle) or `replaced` (a newer spotlight took over); pass `null` to close it, which resolves to `closed`. Older hosts don't have the method, so call it with `?.` and fall back to the old behaviour.
- `ctx.achievements.count?(event, { own? })` / `subscribe?(cb)` / `isClaimed?(id)` / `claim?(id)` read achievement counters (official events by default, read-only; other plugins' counters always read 0), call back when counters or claims change, and read or claim achievements in your own series.
- `ctx.inbox` (**first-party built-in bundles only**): `post({ title, body })` sends a local system message, `archive(id)` archives one, and `registerCard({ sender, mount })` draws your own card under your letters and sets the sender name.
- The list icon vocabulary gains `circle` (not done), `circle-check` (done) and `lock` (locked) for progress lists. `todo` is the block menu's to-do icon and already shows a tick, so don't use it for "not done".

### 网盘用到的接缝 / Seams used by the cloud drive

2026-10-18 起（随 Forsion Extend 蓬洲云的网盘功能一起加的）：

- `ctx.app.setSpaceProgress?(spaceId, progress)`：在 Ribbon 上你自己 Space 的图标外画一圈进度环。只认本插件随包带的 Space，别人的或内置的一律返回 `false`。`progress` 取 `0`–`1`，传 `null` 收起。宿主按整百分比画，高频上报不会让 Ribbon 跟着重画。那个 Space 有未读角标时先显示角标；插件停用时宿主替你收掉。Space 被收进 Ribbon 文件夹或「⋯」时看不到这圈环。
- 列表图标词表新增 `hard-drive`，给网盘、存储类的行用。旧宿主没有这个图标，可以用 `ctx.app.setSpaceProgress` 在不在判断新旧，旧的退回 `archive`。

Since 2026-10-18 (added with the cloud drive in Forsion Extend's Penzor Cloud):

- `ctx.app.setSpaceProgress?(spaceId, progress)` draws a progress ring around your own Space's icon in the Ribbon. It only accepts a Space bundled with your plugin; for anyone else's or a built-in Space it returns `false`. `progress` is `0`–`1`; pass `null` to remove it. The host draws whole percents, so frequent updates don't re-render the Ribbon. An unread badge on that Space takes precedence, and the host clears the ring when your plugin is disabled. A Space tucked into a Ribbon folder or the "⋯" overflow shows no ring.
- The list icon vocabulary gains `hard-drive` for drive and storage rows. Older hosts lack it: use whether `ctx.app.setSpaceProgress` exists to tell, and fall back to `archive`.

### 蓬洲云的图标 / Penzor Cloud's icon

2026-10-23 起：

- `space.json` 的 `icon` 图标库加了 `cloud`，全表 30 个见 forsion-plugin 技能的 `samples/forsion-sample-space/README.md`。旧宿主不认，回落方块。
- 列表图标词表加了 `penzor`：蓬洲云自己的图标（祥云），给蓬洲云的视图用，别的插件别拿它表示别的东西。旧宿主不认，退兜底图标。

Since 2026-10-23:

- The `icon` library for `space.json` gains `cloud`; the full list of 30 is in the forsion-plugin skill's `samples/forsion-sample-space/README.md`. Older hosts don't know it and fall back to the boxes icon.
- The list icon vocabulary gains `penzor`, Penzor Cloud's own icon (a ruyi cloud), for Penzor Cloud's views. Don't use it to mean anything else. Older hosts fall back to the default icon.

### 服务器管理用到的接缝 / Seams used by Server Admin

2026-10-19 起（服务器管理插件给「反馈中心」挂提醒时加的）：

- `ctx.app.setSpaceDot?(spaceId, on)`：在 Ribbon 上你自己 Space 的图标右上角挂一个提示红点，和收件箱未读角标同一种红。`true` 挂、`false` 收。只认本插件随包带的 Space，别人的或内置的一律返回 `false`。同一个 Space 既有红点又有进度环时只画红点；有未读角标时先显示角标。插件停用时宿主替你收掉。挂着红点时，图标的读屏名会带上「有新提醒」。
- 列表行里的未读提示照旧用 `ListItem.unread`（共用的未读圆点，颜色跟着主题的指示色走，不是红色）。要从别的 Space 也看得到，就配上 `setSpaceDot`。
- `ctx.app.sync?`（2026-10-20 起，**只对首方内置包生效**，蓬洲云的「同步」页用）：读写这台电脑的三项云同步。`get()` 给一份快照（智库、Agents 与记忆、插件数据各自开没开，第一次同步的进度，第二台电脑上云端已有一份时待定的合并问题），`subscribe(fn)` 在变化时通知，`refresh()` 重读，`set(kind, on)` 开关一项（`notes` / `agents` / `plugins`），`resolveNotes('merge' | 'cloud' | 'skip')` 回答合并问题，`runNow()` 立刻同步一次。开关和同步引擎都在宿主，插件只画界面。普通插件、手机和网页上整个成员缺席。

Since 2026-10-19 (added when Server Admin started flagging the feedback center):

- `ctx.app.setSpaceDot?(spaceId, on)` puts an attention dot on the top-right of your own Space's icon in the Ribbon, in the same red as the inbox unread badge. Pass `true` to show it and `false` to remove it. It only accepts a Space bundled with your plugin; for anyone else's or a built-in Space it returns `false`. If the Space has both a dot and a progress ring, only the dot is drawn; an unread badge takes precedence over both. The host clears the dot when your plugin is disabled. While the dot is shown, the icon's accessible name says it has new activity.
- Unread rows in a list still use `ListItem.unread`: the shared unread dot, drawn in the theme's indicator colour rather than red. Pair it with `setSpaceDot` so it can be noticed from other Spaces.
- `ctx.app.sync?` (since 2026-10-20, **first-party built-in bundles only**; used by Penzor Cloud's Sync page) reads and changes this computer's three cloud sync switches. `get()` returns a snapshot (whether the notes vault, agents & memory, and plugin data are each on, first-sync progress, and the pending question when the cloud already holds a vault on a second computer); `subscribe(fn)` notifies on change; `refresh()` re-reads; `set(kind, on)` turns one on or off (`notes`, `agents` or `plugins`); `resolveNotes('merge' | 'cloud' | 'skip')` answers the pending question; `runNow()` syncs once now. The host owns the switches and the sync engines; the plugin only draws the page. Other plugins, phones and the web don't get the member at all.

### 弹窗排队 / Popup queue

2026-10-19 起（Extend 的公告和宿主的协议更新提示、What's new 叠在一起时加的）：

- `ctx.app.queuePopup?()`：你的插件自己弹出来的弹窗（启动时的公告、提醒之类，不是用户点了才打开的面板）要先排队。应用里同一时间只露一个弹窗：协议更新、What's new 在前，插件的排在后面，同级按先来后到；全屏引导开着时谁都不出。
- 返回 `{ ready, done }`。`await ready` 之后再把弹窗挂出来，关掉时调 `done()` 让给下一个。决定不弹了（换了账号、数据过期）也调 `done()`，算撤销，这时 `ready` 永远不会 resolve。
- 不调 `done()` 会一直占着队列，后面的弹窗都出不来；插件停用时宿主替你收掉。旧宿主没有这个方法：直接弹，和以前一样。

```js
const turn = ctx.app.queuePopup?.()
if (turn) await turn.ready
showMyDialog({ onClose: () => turn?.done() })
```

Since 2026-10-19 (added when Extend's announcement, the host's terms update notice and What's new could pile up):

- `ctx.app.queuePopup?()` queues a popup your plugin opens on its own (a startup announcement or reminder, not a panel the user just clicked open). Only one popup shows at a time: the terms update notice and What's new go first, plugin popups come after them, and popups at the same level show in arrival order. Nothing shows while the full-screen onboarding is open.
- It returns `{ ready, done }`. Wait for `ready`, then show your popup, and call `done()` when it closes so the next one can show. If you decide not to show it after all (the account changed, the data is stale), call `done()` too: that withdraws it, and `ready` never resolves.
- Until you call `done()` your popup holds the queue and nothing after it can show. The host clears it for you when your plugin is disabled. Older hosts don't have this method; show the popup straight away as before.


## 按需展开原生主区伴随视图 / On-demand native main companions

`registerView` 可声明 `mainCompanions: [{ type: 'amadeus-editor', key: 'my-plugin-document', split: 'right' }]`。支持 `amadeus-editor` / `chat-panel`，key 以插件 id 加 `-` 开头，最多三项。视图挂载上下文的 `view.setCompanionsVisible?.(true)` 按需展开，`false` 将这些原生视图收进本视图的标签组，保留正文、聊天草稿和分栏尺寸；窄窗与手机使用原生标签。不会关闭或改写其它视图，不重建整个 Space。旧宿主缺少此方法，所以重要的阅读布局仍可保留在 Space 配方中。

Declare up to three `mainCompanions` on a plugin view, using native `amadeus-editor` or `chat-panel` types and keys prefixed with the plugin id plus `-`. `view.setCompanionsVisible?.(true)` expands them on demand; `false` folds them into the source tab group without destroying native content or chat drafts. Split sizes are restored, narrow hosts use tabs, and unrelated views are retained. Feature-detect on older hosts and keep essential fallback views in the Space recipe.

本机宿主还可提供 `ctx.app.writeFileScoped?.(path, text, expectedRoot, {create:true})`：在主进程文件锁内校验活动智库，切库后拒绝旧任务的写入；`create:true` 已有文件时返回 false、不会覆盖。普通写入返回 true；方法缺席时插件需要在每次异步边界核对智库，不得宣称获得了主进程范围保护。

Local hosts may expose `ctx.app.writeFileScoped(path, text, expectedRoot, { create: true })`. The main process validates the active vault under the file lock. Stale writes reject; create-only writes return false for an existing file. Feature-detect this API; a renderer-only scope check on an older host does not provide the same guarantee.


`ctx.app.migrateWorkFolder?(request)` performs a one-time **local** upgrade into the plugin's default `Plugins/<plugin ID>` folder. Feature-detect it. A manual work-folder preference rejects automatic migration. Supply an upgrade `id`, captured `expectedRoot`, legacy root-level or `Plugins/<previous name>` `source`, default `target`, and optionally a `plan`: exact index `before`/`after` text, source text edits (`path`, `before`, `after`) and referenced nonempty `requiredFiles`. Without a plan it queries/reconciles the per-vault journal. The plugin validates its schema and refuses two populated data sets; the host validates snapshots, rejects symlinks/traversal, copies without overwriting, verifies hashes, then publishes the index under the shared text lock. Original files remain the backup. A completed journal never reimports deleted entries. Unsupported web/mobile/cloud hosts omit this API; retain an explicit recovery flow.

`ctx.app.migrateWorkFolder?` 是本机一次升级迁移口。插件负责 schema 和路径改写，宿主负责校验、独占复制、索引比对后提交及中断恢复；原目录保留作备份。手动设置目录时拒绝自动迁移；不支持的宿主缺席此方法，插件须保留恢复入口。

Default work-folder paths use the effective plugin ID, never the localized display name. External manifest IDs must match `^[a-z0-9][a-z0-9-]{0,63}$`; choose English words for new IDs and preserve published IDs. Store installs use the immutable `market-<UUID>` effective ID, which may differ from the manifest ID or a historical install-folder alias. Obtain the path from `workFolder()` rather than deriving it yourself. Existing display-name folders remain readable for plugins without migration support. To migrate one, feature-detect both APIs, call `workFolder({ preferId: true })`, validate your schema and await `migrateWorkFolder` before using that target. Manual preferences always take precedence.

默认目录使用稳定的英文插件 ID，不随显示名称或语言变化。外部 manifest 的 ID 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，新 ID 用英文词，已发布 ID 保持稳定。商店安装以不变的 `market-<UUID>` 为生效 ID，可能不同于 manifest ID 或历史安装目录别名；请调用 `workFolder()`，不要自行拼身份目录。未接入迁移的插件继续读取已有的显示名目录；接入者先检测两项 API，再通过 `workFolder({ preferId: true })` 取得新默认目录，校验自身数据后等待迁移完成。用户手动指定的目录优先。

A status-only request may target the plugin's previous display-name default to reconcile an interrupted predecessor journal. Old-target plans remain rejected; manual preferences and vault/revocation checks still apply. Bare media wikilinks are resolved against the original vault before copying, preserving user-added attachments beside notes instead of assuming an `assets/` location.

无 plan 的状态查询可核验上一版显示名目录的迁移日志；旧目标的写入计划仍被拒绝。迁移前按原智库实际解析裸媒体链接，保留用户自加附件的位置。

### 个人日历（Desktop 2.13.6+）

同时声明 `databases` 与 `calendar` 的插件，在本机引擎提供个人日历时，会收到 `human://CALENDAR.db`。日历成员把它排第一并隐藏旧智库镜像。把该不透明引用原样传给 `ctx.databases`、`ctx.ui.mountRecord` 和用于表结构/名称的 `ctx.app.mutateDb`，不要交给文件系统读写 API。成员与日期/完成列映射由宿主管理，`setMember` / `removeMember` 返回 false；隐藏用 `setHidden`。只有 `databases` 能力的插件不可访问；无此来源的远程或移动宿主不列出。写入复用宿主 CAS 与冲突重放。

Plugins with both `databases` and `calendar` capabilities receive the exact `human://CALENDAR.db` reference when the local engine provides it. Calendar members put it first and hide its old vault mirror. Pass this opaque reference unchanged to `ctx.databases`, `ctx.ui.mountRecord`, and `ctx.app.mutateDb` for schema/name changes, never filesystem read/write APIs. Database-only plugins cannot access it; hosts without this source omit it. Writes retain host CAS and replay.

### 共享账号 / Shared account

Unit 网页账号宿主与移动端可提供 `ctx.account`。先判断能力存在，再使用 `status()`、`login()`、`logout()`、`request(path, init)` 与 `subscribe(listener)`。`request` 只访问账号 API，不接受其他源；宿主代发凭据并保留 FormData/Blob 文件上传。账号切换会取消旧请求并使旧响应体读取失败；插件仍须取消自己的延迟任务并清空旧账号界面。可选的 `saveDownload(blob, name)` 返回 `{ ok, error? }`：Android 保存到系统下载，浏览器保存为下载文件。不要保存、导入或传递账号令牌。

Unit account hosts and the mobile app may provide `ctx.account`. Feature-detect it before using `status()`, `login()`, `logout()`, `request(path, init)` and `subscribe(listener)`. Requests stay within the account API; the host supplies credentials and preserves FormData/Blob uploads. Account changes cancel old requests and reject reads from old response bodies. Plugins must also cancel their deferred tasks and clear the previous account's UI. Optional `saveDownload(blob, name)` returns `{ ok, error? }`: Android saves through system Downloads, while browsers save a download. Never store, import or forward account tokens.
