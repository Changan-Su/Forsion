---
title: 插件开发
description: 给 Forsion 写桌面插件与引擎插件：布局、列表源、审批、宿主零件、卡片与各类扩展点。
---
# 插件开发

面向插件作者。装插件、捆绑包和安全模型这些用户侧说明见[插件](./plugins.md)。

## 起步

插件用 JavaScript / TypeScript 编写,官方提供类型定义与模板。内置的「Forsion 扩展开发」技能可以让 Agent 照官方模板直接脚手架出插件、主题、Space 或智能体的骨架,见[技能](../agents/skills.md)。

引擎插件可通过公开的 `registerSkillProvider` 提供实时、只读的外部技能来源，无需复制进用户技能目录，见[外部技能来源契约](plugin-skill-providers.md)。

需要让插件产物与原生笔记面板联动时,使用 `ctx.app.openNote`:同一 `reuseKey` 的 Amadeus 面板会原地切换到新笔记；`activate:false` 可保持用户焦点在插件面板。配合 Space 主区条目的 `split:"right"` / `split:"down"`,插件无需在自己的 DOM 里复制文档编辑器或聊天界面。

```js
ctx.app.openNote(path, { reuseKey, activate })
```

插件视图的布局优先放进原生 Panel,别在一个视图里自造侧栏、底栏:列表进左栏工作区(`registerListSource`),主体留在主区,属性与检查器放右栏(或用 Extend View),时间线、日志、终端这类横跨全宽的内容放底部面板 —— Space 配方写 `layout.bottom`,或 `ctx.openView(id, { location: 'bottom' })`;底部横跨哪几列由配方的 `layout.bottomSpan` 定(缺省 `right` = 主区+右栏,另有 `left` / `full` 通栏 / `main` 只在主区下方)。底部面板旧宿主没有、移动端也没有,依赖它之前先查 `ctx.viewLocations?.includes('bottom')`,不满足就在视图里自绘。像 Coding Studio 那样「没打开项目时左栏是导航、打开后换成项目内容」:用 `ctx.replaceView?.('nav', 'media')` 原地换自己的视图(返回 0 别拿 `openView` 兜底,会弹出用户收起的面板),回启动台时反过来换,再 `ctx.closeView?.('timeline')` 收起底部。侧栏同理:某一页不要右栏、别的页才出详情时(像蓬洲云的概览),在那一页调 `ctx.closeView?.('info', { collapse: true })` —— 那一侧只剩这个视图就整侧收起(视图留在暂存里,用户展开或你下次 `openView` 时回来),不留空占位;侧栏里还有别的视图就照常关。旧宿主忽略这个选项、留占位(2026-10-18 起)。想让导航一直找得回来,就在配方里给它写 `"pinned": true`(固定 View:该区内始终留一个,关不掉、拖不出本区):这时同一句 `replaceView('nav', 'media')` 不再顶掉导航,而是把 `media` 作为第二个标签开在它旁边并顶到前台,反过来换时只摘掉 `media`——插件代码不用改。要让人每次进这个 Space 先看到某个视图(像内置的主页),在配方的 `layout.main` 里给那一条写 `"mainPage": true`(默认主页,至多一条):切进来、冷启动、人已在里面再点一次图标,前台都是它,别的标签留在后台;不写就照旧还原上次离开时的样子。通常和 `"pinned": true` 一起写。侧栏的标签只显示图标:会和别的视图同处一栏的视图,注册时给 `icon`(插件图标词表里的名字,如 `list-view`、`image`),否则几个标签都是同一个通用图标。进出项目的布局跳转会让宿主重挂主区视图:跨这一下要留的临时状态放模块作用域,等用户真正用掉再清(别在第一次交给界面时就清);关项目时先清掉新挂载会拿来重开项目的依据(视图参数、模块里的当前项、存盘的上次打开,存盘要 await),再拆界面、换布局。

右栏跟着主视图走(2026-10-20 起):右栏 = 本 Space 固定的视图 + 主区前台视图自带的那组 + 用户自己开进来的。给视图注册时写 `rightCompanions`(视图类型全名的数组,和 space.json 同一套写法:自己的写 `plugin:<插件id>:<视图id>`,宿主的写 `chat-panel` / `outline` / `tangu-details` / `workspace` 这些名字),它到主区前台时右栏就换成这组,第一项顶到前台;切走时收回不在下一组里的,同一类视图换文件不动,右栏收着时只换暂存、不弹出来,新建标签页不算。没写 `rightCompanions` 的视图用 Space 配方的 `layout.right`。所以你的 Space 里打开宿主的笔记、对话或 PDF(它们自带组)时,`layout.right` 会让位,回到你的视图再回来;不想让位的条目写 `"pinned": true`。组里只放能进侧栏的视图:主区的 `chat`、笔记编辑器、PDF 会被滤掉,右栏要对话写 `chat-panel`(`layout.right` 里写 `chat` 的老配方,宿主按 `chat-panel` 开);最多 4 项,建议 3 项以内。组写「这种视图通常需要什么」,点了某一行才出来的详情和表单用 Extend View。用户自己开、拖进右栏的视图规则永远不关。旧宿主忽略 `rightCompanions`,要紧的右栏视图照旧写进 `layout.right`。左栏不跟主视图走:左栏是 Space 的,第一项一般写本 Space 的工作区视图并标 `"pinned": true`。

左栏列表(`registerListSource`)可以带层级,画法和笔记树的文件夹一样。行还是一张平铺的数组:给行写 `parent`(上一级那一行的 `key`),上一级写 `kind: 'folder'`;文件夹点一下开合,不调 `open()`,开合状态由宿主记住,当前打开的那一行所在的文件夹会自动展开。搜索时不画层级,只平铺匹配的行。静态分组(`group`)的标题也可以点开合。`itemMenu(文件夹)` 里带 `primary` 的那一项会画成行尾的「+」。要让用户拖动整理:给能拖的行写 `draggable: true`,`drop.accepts` 里加 `'items'`;落下时 `onDrop({ items }, { item, position })` 告诉你拖的是哪几行、落在哪一行的前面(`before`)、后面(`after`)还是放进文件夹(`into`),`canDrop` 返回 false 可以拒绝某个落点。宿主只画提示,不替你移动:你改完自己的数据再通知订阅者。就地改名同理:行写 `renamable: true`,源上声明 `rename(item, title)`,菜单项、输入框和按键(回车提交、Esc 取消、F2 开始)都由宿主负责。这三样在旧宿主上不存在,用 `ctx.listCapabilities` 判断;探测不到时照旧输出平铺的行(否则文件夹会被画成一条普通的行)。

```js
ctx.listCapabilities?.includes('tree' | 'items' | 'rename')
```

文件夹同时也是可选中的东西时(比如父标签),给文件夹行写 `opensOnClick: true`,用 `ctx.listCapabilities?.includes('folderOpen')` 探测:点名字调 `open()` 并展开,只有行首的箭头负责开合,`activeKey` 指向它时整行高亮。旧宿主忽略这个字段,点一下只开合,所以探测不到时要在里面留一行子项。

把行按「是谁的」归组(发信人、账号、来源)时,给最上面一级的文件夹再写 `folderStyle: 'group'`:它会画成 Tangu 左栏里 Agent / 项目那种一级行,前面是头像(`iconUrl`)、方块里的图标(`icon`)或标题的首字,`hint` 是行尾的小胶囊(适合放未读数)。组里的行不再画自己的图标,只留未读的圆点,一组先列 5 条,其余在「查看更多」后面。这种组的开合只记到应用重启:写了 `defaultOpen: true` 的组自己开着(比如里面有未读),它由假变真时宿主会重新打开这一组;不写就是收着。组的先后由你的数组顺序决定。搜索时不画层级,所以带 `query` 时请返回平铺的行。手机上,只有这一层组头的列表仍然是整屏列表,组里的行照样可以左滑。用 `ctx.listCapabilities?.includes('group')` 判断宿主认不认;不认的宿主会把它画成普通文件夹。

桌面上,指针停在列表的一行上时,`itemMenu()` 里带 `icon` 的动作会在行尾排成一排图标钮,旁边仍是列出全部动作的「更多」菜单。它们和手机上左滑出来的是同一批、同一个顺序,所以把最常用的动作放在前面并配上图标;没有 `icon` 的动作只出现在菜单里。旧版宿主只有「更多」菜单。

列表行可以有第二行:给行写 `subtitle`,宿主在标题下面画一行淡字(只占一行,超出省略),适合放「谁发的 · 第一句话」或状态;不写就是原来的一行。只收纯文本,文件夹行不显示;旧版宿主会忽略这个字段。右边的 `hint` 和行首图标都对齐第一行。图标词表另外加了三枚表示来源的图标:`cloud`、`workflow`、`agent`。

手机上(安卓原生外壳),平铺的列表源(没有文件夹行、没有 `parent`)画成手机的整屏列表,和会话、笔记列表同一套:`groups()` 是一排分类胶囊;行是图标块 + 标题和 `hint` 一行 + `subtitle` 一行;搜索在顶上的搜索钮和下拉里;`itemMenu()` 的动作在左滑后面,是只有图标的圆钮;`primary` 的动作是右下角的主按钮,其余 `actions` 在它的长按菜单里。因此动作可以带 `icon`(图标词表里的名字):没有 `icon` 的行动作不进左滑(仍在长按菜单里),没有 `icon` 的主动作画成加号;成对的动作各给各的图标。词表为此加了 `mail`、`mail-open`、`archive`、`unarchive`、`trash`、`refresh`。带层级的源在手机上仍是树(只有一层组头的除外,见上)。旧版宿主忽略 `icon`。

插件自带的 Space 没出现在功能条上时,先看设置里那张插件卡片:挂着「Space 未显示」就点开详情,里面写着是哪个 Space、缺什么 —— 它引用的视图没有注册,或者需要更新的 Forsion 版本。最常见的一种是插件加载没有报错、却一个视图也没注册:`main.js` 里某个函数没收口,把后面的 `ctx.registerView` 包了进去。开发副本在 Coding Studio 的 Sandbox 面板里能看到这次加载注册了哪些视图。也可以直接让 Agent 查:「Forsion 扩展开发」技能带一份插件体检脚本(`tools/check-plugin.mjs`),照宿主的方式跑一遍 `main.js`、对账每个 Space 要的视图,并指出没跑到的注册代码在第几行到第几行。体检会执行插件代码,只对你信得过的插件用。

在沙箱里试插件(2026-10-23 起,桌面):让 Agent 写桌面插件时,它会先在**插件沙箱**里跑一遍,不直接装进你的 Forsion。沙箱是你电脑上另开的一份独立 Forsion:自己的空智库、未登录、不起 Tangu 引擎,只装这一个插件(开发副本,改完保存自动重载)。Agent 在里面看截图、读这个插件自己的控制台、跑它注册的命令;你也可以点对话里沙箱卡片上的「打开沙箱窗口」亲手试,遇到问题点窗口顶上的「报告问题」,写的话会回到发起它的那个对话的输入框。满意了点「安装到我的 Forsion」,会先问你一次,再把插件拷进你的插件文件夹(不带 `node_modules`)。沙箱里没有引擎,所以捆绑包里的引擎插件、智能体和技能要装好以后再试。同一时刻只有一个沙箱;沙箱窗口不在前台、15 分钟没人用,它会自己停。Coding Studio 的 Sandbox 面板也分这两档:「隔离沙箱」(缺省)和「我的 Forsion」——后者是原来那种把开发副本直接加载进你正在用的 Forsion,不是隔离环境。

沙箱里还有这些(2026-11-03 起):只装这个插件,内置插件也只装它在 `requiresPlugins` 里点名的那几个(比如依赖 Forsion Extend 就写上它),左侧功能条上只有这个插件自己的 Space,一开就停在它的第一个 Space 上;窗口标题写着「Forsion 沙箱 · 插件名」。Agent 能在沙箱里像人一样用插件:读出界面上有哪些按钮和输入框,点击、输入、按键、滚动、切 Space,每一步做完都看一眼截图和这期间的控制台、弹出的提示;要选文件时它先把插件目录里的测试文件备好,点「选择文件」不弹系统框。发起沙箱的那个对话,右侧摘要栏多一张沙箱卡:缩略图是 Agent 最近截的那一张(点它打开沙箱窗口),下面是视图数、Space、控制台错误数和最近一步;沙箱停了卡片变灰,点「重新启动」就再开起来。

沙箱的新变化(2026-11-15 起,需要同期的新版桌面):Agent 读界面时能看到开关是不是按下、输入框和笔记是不是只读(比如笔记处在阅读模式),点开关之前会先看清状态;通知卡挡住要点的地方时,先把通知关掉再点;插件命令弹出自己的对话框、一时没跑完时,Agent 不会重跑,而是读窗口、接着在对话框里操作;Agent 还能打开这个插件在设置里的那一页(沙箱里另开的一扇设置窗口;有设置的插件是「设置 → 插件设置」里它的设置页,没有设置的是「设置 → 插件」里的详情页),在那里填设置、点保存。

引擎插件的工具用 `capabilities.approval` 声明动手前要不要问用户。不写 = 只读,不问;`'command'` = 与跑命令同一档,「询问我批准」时每次问,用户点过「总允许」或开了完全通行就不再问;`'always'` = 每次调用都由用户本人在卡上确认 —— 完全通行、「总允许」、用户写的放行规则都跳不过,聊天会话与云端会话照样弹卡,自动化、Muse 后台和远程会话里直接被拒。花掉用户的东西、替用户对外发出内容这类动作用 `'always'`;读和写拆成两个工具名,只给写的那个声明。卡上显示的是这次调用的参数,所以一次调用只做一件事。

只给官方插件的三样(2026-10-27 起):`ctx.cloud`(以用户的 Forsion 账号请求云端,只放商店「我的条目」与提交更新两个接口)、工具的 `capabilities.approvalPreview`(插件自己写审批卡上的文案)、以及进聊天(Chat)会话的工具面。官方 = 插件在 Forsion 签名的捆绑包里(包根 `SIGNATURE` 用引擎内置的公钥验过,插件的清单和入口都签在里面)。第三方插件拿到的 `ctx.cloud` 是 `undefined`,写了 `approvalPreview` 也被忽略(卡上照旧是这次调用的参数),工具也不进聊天会话。

引擎插件的工具可以在执行时调用 `ctx.presentDesk`,把自己的视图摆上 Agent Desk,和模型调 `desk_present` 效果一样,但不依赖模型记得去调。每轮只摆一次,用 `ctx.runId` 记(没有时用 `ctx.sessionId`);视图不带 `name` 时宿主用注册时的视图标题。没有 Desk 的环境里 `presentDesk` 不存在,所以用可选链。用户关掉 Desk 后,到下一条用户消息之前不会再弹出来。

```js
ctx.presentDesk?.({ views: [{ type: 'view', view: 'plugin:<plugin id>:<view id>' }], size: 'half' })
```

宿主替插件画的零件(2026-10-26 起):插件不用再抄宿主的 CSS、自己算浮层位置、或者把文案在注册时定格。

- 对话框用 `ctx.ui.confirm`(返回 `Promise<boolean>`)和 `ctx.ui.openDialog`:居中、宿主的卡片外观、Esc / 遮罩 / 焦点由宿主管,危险操作主按钮是红的、焦点先落在「取消」,安卓上是原生确认框。

```js
ctx.ui.confirm({ title, body, danger })
ctx.ui.openDialog({ title, body, mount(el), actions })
```

- 视图头和工具栏里的分段与下拉用 `ctx.ui.mountControl`:分段和视图模式切换是同一颗,下拉是 28px 的文字钮,点开是菜单样式的列表(6 项起带搜索,安卓上是原生抽屉);设置零件是整行,别放进工具栏。

```js
ctx.ui.mountControl(el, { type: 'segmented' | 'select', value, options, onChange })
```

- `ctx.ui.contextMenu` 的行可以带 `icon` 和 `shortcut`,列表里可以放 `{ separator: true }` 和 `{ section: '小节' }`,第一个参数可以是 `{ anchor: 按钮, align: 'end' }`,安卓上同一份数据是原生底部抽屉;更早的宿主会静默丢掉这些字段。
- 按钮下方的小面板用 `ctx.ui.popover(按钮, { mount(el) })`。
- 图标只有一张词表:`space.json` 的 `icon`、列表、菜单、设置、视图标签、控件、空态都认同一份名字,自己的按钮用 `ctx.ui.icon(名字, { size })` 拿一枚 `<svg>`(某个名字第一次用时字形在微任务里补上,要多份就多调几次,别克隆),写错名字会在控制台提示一次(带最接近的名字)。
- 列表源加 `empty: { icon, title, line, action }`:在你自己的 Space 里侧栏不再写「暂无内容」,手机整屏列表直接画这份空态;主区用 `ctx.ui.mountEmptyState(el, …)` 画同一个。
- 讲网页的卡片(发布出去的链接、本地文件、在跑的服务)用 `ctx.ui.mountWebCard`(2026-10-28 起):缩略图由宿主截,和宿主自己给 HTML、本地服务画的卡是同一张。

```js
ctx.ui.mountWebCard(el, { name, status, address, note, thumbnail, actions, menu })
```

- 插件自己在本机起了带网页界面的服务(DSH 融合插件的工作台)时,用 `ctx.ui.mountWebSurface(el, { url })`(2026-11-15 起,只在桌面)把它整页放进视图:是 Forsion 管的顶层页面,服务自己的登录 cookie 能用;地址只收本机,cookie 存在插件自己的分区,页面只能在同源里跳,不给 Forsion 接口。返回的 `navigate('#…')` 只换页面当前地址的 # 那段(同一个页面里跳、不重载)。
- 给跑在外部引擎上的 Agent 加 Harness 卡上的行(运行时、更新通道……)和对话右键菜单里的项,用 `ctx.registerEngineHarness?.({ engineId, rows, sessionActions })`(2026-11-15 起,桌面);Forsion 自己只画「运行在」那一行。这些菜单项也能当引擎提示的按钮:常驻引擎(`ctx.registerResidentEngine`)在 ACP 管道上发 `_forsion/notice` 扩展通知时,Forsion 把那句话放进对话的审批托盘,`action.id` 对上的那一项就是它的按钮(DSH 融合插件的「DSH 在工作台里等你批准」+「打开工作台」)。常驻引擎还可以给 `modelSeesImages(model)`(2026-11-16 起):回这场会话此刻的模型收不收图,交过去的电脑控制只有它回 `true` 才跑,别的情况 Forsion 告诉模型「这个模型看不见屏幕」。`registerEngineHarness` 还可以带 `railView`(2026-11-16 起):你自己注册的 View 的 id;主区那场对话跑在这个引擎上时,Forsion 把它补在右栏「详情 / 文件 / 大纲」后面,不抢前台,换到别处跑的对话就关掉;View 里用 `ctx.tangu.subscribeAgentStatus` 跟着当前对话,所以主区钉住另一场的标签不补这一页(DSH 融合插件的右栏 DSH 页)。
- 视图头行用 `ctx.ui.setViewHead(el, { title })`(左标题、右按钮,不必先有视图模式)。
- 样式表用 `ctx.addStyle(css)`,停用、重载时宿主会摘掉。
- 文案用 `ctx.i18n.define({ zh, en })` 拿到 `t(key, vars)`;列表源标题、动作名、视图标题、菜单、对话框、控件、空态都收 `() => t('key')` 或 `{ zh, en }`,用户切语言时宿主画的部分自己重算(字符串照旧在注册那一刻定格)。
- 用 React / Vue 写的插件拿不到宿主的组件,用 `ctx.ui.mount(name, el, props)` 在 ref 上挂宿主零件(`menu`、`popover`、`dialog`、`segmented`、`select`、`emptyState`、`webCard`、`icon`,props 有类型),别把宿主的菜单、浮层、对话框、图标、i18n 抄一份进包。

这些接口在旧宿主上都不存在,用可选链判断。

## 商店身份与安装目录

商店给每个条目一个不会变的 ID,新上架的条目装进 `plugins/market-<ID>/`,和显示名无关,所以显示名可以重复。装在这种目录里的插件以目录名为运行身份:包里的引擎插件照常按目录名挂路由,单独上架的引擎插件 id 变成 `market-<ID>`、数据目录在 `plugin-data/market-<ID>/`,它的工具名会被宿主改写成带哈希的唯一名字(两份同 id 的插件互不顶替)。包里 Space 配方照旧用 manifest 的 `id` 写自己的视图(`plugin:<id>:<视图>`),装在 `market-<ID>` 下时宿主会换成运行身份(2.13.8 起;更早的版本上这样的 Space 不出现)。别的插件在 `requiresPlugins` 里写你 manifest 的 `id` 照样认得到,前提是只装着一份;想让用户从商店一键装上你,对方还要写 `market: "market-<ID>"`,商店只按 slug 精确匹配,不按显示名猜。这种条目要 2.13.4 之后的桌面版本才装得了,旧版本会提示先升级 Forsion。更早上架的条目保留原来由显示名推出的目录名;其中带引擎插件的包在桌面 2.13.3 及更早的版本上,目录名和 manifest `id` 不一样时页面调不到包里的引擎插件(每次调用都是 404,不报错)。

## 上架与更新

投稿时可以写标签(最多 8 个)、长描述、支持的平台(`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`)和 Forsion 版本范围:最低版本含本身,最高版本不含。包里 manifest 的 `minAppVersion`、`maxAppVersion`、`platforms` 优先于投稿表单。商店首页按这些筛选,安装前桌面和手机会再核一遍包里的 manifest,版本或平台不符的不下载、不写盘。每个条目有公开的评论区,新评论发到你(投稿账号)的收件箱,回复也通知被回复的人;你可以在评论区关掉全部或某一个插件的评论消息,评论照样公开。

发新版或改商店信息时,在「投稿」里选中你的条目:ZIP 拖进新包,GitHub / npm 先在原渠道发新版本再点「检查新版本」。版本号只从包里或上游读(技能写在 SKILL.md 的 `version` 或 `metadata.version`),要比商店当前的高。提交前会先检查一遍,列出读到的类型、版本、图标和 README,你确认后才提交。简介、标签、长描述和版本要求可以单独编辑,不用传包。已上架的条目改了都要过审,通过前商店照旧,审核结果发到你的收件箱。

用户那边(桌面 2.13.8 起):商店插件**缺省自动更新**,新版本在后台下好、下次启动时换上;用户可以在「可更新」页关掉全局开关,或在插件详情页单独关掉。换版前桌面会把旧版本留在本机(每个插件最近 2 份,放在 `~/.forsion/.plugin-versions/`),用户能一键回退;回退或从「版本」页装旧版后,这个插件会固定在那一版,不再自动更新,直到用户点「恢复自动更新」。**回退只换插件文件,你的数据(工作文件夹、`plugin-data`、设置)不跟着回退**:新版要改数据格式时,让旧版读到新格式也不至于出错(忽略不认识的字段、别把旧数据原地改写成旧版读不了的样子),或者把新格式写到新文件里。核心插件(Extend、日历、Computer Use)跟桌面版本走,不在此列。

## 商店来源（2026-11-08 起）

插件可以在商店左栏的「来源」分组里加一个条目，指向你自己维护的一份目录 `forsion-store.json`。**来源只交目录**：卡片、详情、下载、校验、安装、更新和卸载都由商店照常处理，你不画界面，也拿不到商店的页面挂载口（`registerStoreView` 仍只给 Extend）。用户也可以点「来源」旁的 + 直接贴地址，不需要插件。

在 manifest 里声明（一个插件最多 4 个）：

```json
"storeSources": [
  { "id": "main", "title": { "zh": "图片 Skills 大全", "en": "Image skills" }, "index": "github:pixel-lab/image-skills", "icon": "image" }
]
```

- `id`：插件内唯一，`^[a-z0-9][a-z0-9-]{0,31}$`。`title` 写字符串或 `{ zh, en }`；`icon` 可省，从 `image` / `sparkles` / `palette` / `wrench` / `bot` / `package` / `globe` / `crown` / `coins` 里挑，认不出的按地址类型给缺省图标。
- `index`：目录在哪。`github:owner/repo`（读默认分支根目录的 `forsion-store.json`；`https://github.com/owner/repo/tree/<ref>/<目录>` 指定分支和子目录）、`npm:<包名>`（读 `latest` 版本包根的 `forsion-store.json`，按 registry 的 sha512 校验）、或一个 `https://` 地址直接指向 JSON；`forsion-git:owner/repo`（Forsion Git 上的私有仓，读默认分支根目录的 `forsion-store.json`；`https://git.forsion.net/owner/repo/src/branch/<ref>/<目录>` 指定分支和子目录）由 Forsion 服务端按当前登录的账号去读，只有这个人有读权限的仓库才读得到——没登录时来源页给「登录 Forsion」引导，读不到时说「仓库不存在或没有读权限」（两者故意不分开），这台服务器没开 Forsion Git 时说「还没开通」。私有目录只在内存里按账号留副本，不写进磁盘缓存，换了账号会重新读。
- 插件启用时来源出现，停用或卸载时消失；用户可以在来源页右上角「⋯」里停用你的来源。来源没了，从它装的东西留着，只是不再自动更新。

`forsion-store.json`：

```json
{
  "schema": 1,
  "title": { "zh": "图片 Skills 大全", "en": "Image skills" },
  "author": "Pixel Lab",
  "description": "海报、电商图、封面……",
  "items": [
    {
      "id": "poster", "type": "skill", "version": "1.2.0",
      "name": { "zh": "海报排版", "en": "Poster layout" },
      "summary": "按尺寸与层级规则排一张活动海报。",
      "tags": ["海报", "排版"], "icon": "icons/poster.png", "readme": "# 海报排版\n…",
      "minAppVersion": "2.13.8",
      "package": { "github": "pixel-lab/image-skills", "ref": "v1.2.0", "path": "skills/poster" }
    }
  ]
}
```

- `type` 与商店投稿同一套：`skill` / `amadeus-plugin` / `plugin` / `agent` / `space` / `theme`。`id` 在目录内唯一，`^[a-z0-9][a-z0-9-]{0,47}$`，**发出去就别改**：装进本机的目录名、更新时认的都是它。
- `package` 四选一：`{ "github", "ref", "path"? }`（下这个 ref 的仓库归档，`path` 只取其中一个目录）；`{ "npm", "version", "integrity"? }`（版本必须等于条目的 `version`，没写 `integrity` 时按 registry 记录的 sha512 校验）；`{ "url", "sha256" }`（必须带 sha256）；`{ "forsionGit": "owner/repo", "ref", "path"? }`（Forsion Git 私有仓：服务端按装的人的账号下这个 ref 的整仓归档，`path` 只取其中一个目录；装的人要登录、要对这个仓库有读权限；`ref` 写分支、标签或提交号，不存在会报「没有那个分支或标签」）。
- 相对路径的 `icon` 按目录所在位置解析（npm 和 Forsion Git 私有仓没有可公开访问的位置，写完整的 `https://` 地址）。最多读 1000 条、单条 README 64 KB，坏条目跳过不影响其他条。包里 manifest 的版本与平台要求照样生效，和商店里的条目一样。
- 更新：改目录里的 `version` 和 `package`。商店按用户的自动更新设置照常更新；**包的出处变了（换了仓库、npm 包名或下载域名）自动更新会停下**，等用户自己点。
- 装进本机的身份是 `src-<来源哈希>-<条目 id>`，`requiresPlugins` 的 `market` 字段认不到来源里的条目。用户第一次从某个来源安装、以及每装一个会运行代码的条目（插件、Agent、Space）前，商店会在详情页侧栏让用户确认一次；来源里的东西标着「未经 Forsion 审核」。

## 平台账号与登录信息（桌面 2.13.8 起）

有些平台的内容要登录才取得到（B 站会员、高清、被风控的视频）。`ctx.app.platformAccounts` 让插件用**用户在内置浏览器里登录的那个账号**去取，插件自己不存登录信息：

```js
const acc = ctx.app.platformAccounts            // web / 手机 / 旧宿主没有 → 不显示任何账号入口
const st = await acc?.status('bilibili')        // { state: 'connected' | 'expired' | 'none', name? }
await acc.connect('bilibili')                   // 只在用户点击时调:弹 B 站自己的登录页（扫码），登好自动关
const cookie = await acc.cookie('bilibili')     // Cookie 请求头;没登录 / 用户不允许 → null
```

- 目前只有 `bilibili`（`platforms()` 列出当前宿主支持的）。平台名单由宿主写死，不能传任意域名。
- 登录信息只在内置浏览器里（与内置浏览器共用登录状态），不进智库、不随云同步。`pasteCookie(platform, text)` 是给高级用户的兜底，也是写进内置浏览器。`disconnect` 会让内置浏览器退出这个平台，并撤回所有插件的授权。
- 授权按「插件 × 平台」：用户在你的插件里点了连接 / 粘贴即视为同意你的插件使用；没授权过的插件调 `cookie()` 时，宿主先弹框问用户。
- **登录信息别写进智库、日志、插件数据或提示词。**要交给 Agent 跑的脚本，放进 `POST /agent/runs` 的 `secret_env`（如 `{ "BLUEBIRD_COOKIE": cookie }`）：它只在内存里、只给这次 run 的 `run_bash` 子进程，脚本打印出来也会在交给模型前被替换成 `[REDACTED:名字]`；远程来源的 run 不收。变量名须全大写（`^[A-Z][A-Z0-9_]{2,63}$`），最多 8 个，不能用 `PATH`、`TANGU_*`、`FORSION_*` 等保留名。旧引擎会忽略这个字段（等于不带登录去取）。提示词里只告诉模型「变量已经设好、不要打印」。
- 只有 `run_bash` 拿得到 `secret_env`，`run_background` 起的后台进程拿不到。Cookie 这种 `a=b; c=d` 的值会逐项打码。打码挡的是无意中打印；变量交给了模型能编程的 shell，存心编码绕得过，所以只交给你信任的脚本要用的东西。
- 插件运行在宿主渲染层里，「插件 × 平台」授权是给用户的同意框，不是插件之间的隔离边界。
- 只把登录信息交给本机引擎（`127.0.0.1` / `localhost`），配成外部引擎时别带；交给脚本前按**真实主机名**确认是这个平台的网址，脚本里也只对该平台主机带 Cookie。

## 插件设置（2026-11-18 起）

装了的插件里有设置的，都列在「设置 › 扩展 › 插件设置」下面：一个插件一项，按显示名排；超过 8 个时只列最近打开的 5 个，最后一项「另外 N 个…」打开全部插件的列表（带筛选）。关着的插件照样列着、画成灰的，点进去是一张「已停用 · 启用」卡片，存过的设置不会动。设置搜索也能按插件名和你给的别名找到它。

每个插件的设置页是一张宿主画的身份卡（图标、名字、`版本 · 内置 / 商店 / 本地`，插件有 Space 时一颗「打开插件」，右端是启用开关），下面是插件的设置，**一律用宿主的设置零件画**。卸载、自动更新留在「插件」管理页；那里的插件详情页不再画第二份设置，只给一颗「设置」直达这一页。

新写的设置页用 `ctx.registerSettingsPage` 把整页描述成数据，宿主来画：

```js
ctx.registerSettingsPage?.({ title, keywords, mount(page) { page.update({ groups }); return cleanup } })
```

- `mount` 在页面打开时调，里面调 `page.update({ groups })`（或 `{ state }`），零件和规则与 `ctx.ui.mountSettingsPage` 同一份（每组每项一个不变的 `id`，`update` 是整份替换，开关 / 下拉的回调 reject 会弹回去，清单外的内容放 `custom` 块）。返回的收尾在页面关掉、插件停用或重载时调，之后旧页面上的回调不会再调。
- `title` 可以传函数，切语言时跟着变；页面里的文字请在 `ctx.subscribeLocale` 里重新 `update`。`keywords` 是给设置搜索的中英别名。`id` 不写就是 `'main'`，同 id 再注册一次会替换掉旧的。
- 老接口照旧能用，作者不用改，画在同一页上：`ctx.registerSetting` 的行进「通用」组（开关、范围小的数字用步进器、其余是输入框；值照旧存在 localStorage `plugin.<插件 id>.<key>`）；`ctx.registerSettingsView` 的面板每个一组、排在「通用」后面，是一块自定义块。引擎插件 manifest 的 `settings.fields` 也换成零件：section 开一组，toggle 是开关，select 是下拉，number 是步进器或输入框，text 是输入框（`secret` 是密码框），textarea 和 image-list 是自定义块，note 是一行说明，link 是一颗「打开」按钮；开关、下拉即时保存，输入框失焦保存，和原来一样。
- 自绘面板里只是调了一下 `ctx.ui.mountSettingsPage` 的，换成 `registerSettingsPage`。
- **插件不许仿宿主的 `.settings-*` 样式**：零件是宿主的，按端排版、跟着宿主改；抄一份的样子在手机上会错位，也跟不上以后的变化。要宿主的样子，就在 `custom` 块里用 `ctx.ui.mountSettingsItem` 挂零件。
- 2026-11-18 之前的宿主没有 `registerSettingsPage`：先探测，没有就照旧 `registerSettingsView` + `ctx.ui.mountSettingsPage`（内置的「语音输入」插件就是这么写的）。

## 敏感设置项

引擎插件的文本设置可以声明 `secret: true`，宿主会显示密码框（`textarea` 也会转为单行密码框）。这只遮挡界面；值仍使用现有本机插件设置存储和已认证的设置接口，不新增加密。旧宿主会忽略这个可选字段。

## Mini Panel 扩展

插件内的 Space 可以声明专用 Mini 视图，只提供当前能力的快捷操作；宿主的“在主面板显示”会携带当前实体参数。未适配的 Space 不出现在 Mini 中，随插件禁用的适配会自动撤下。见 [Mini Panel 开发](./mini-panel-development.md)。

插件也可以不创建完整 Space，直接用 `ctx.openMiniPanel?.(viewId, options)` 打开已注册的紧凑视图；`mainViewId` 指定“在主面板显示”的去向。2.13.8 起桌面能同时开几扇 Mini：同一个 `viewId` 再开是叫出已开的那扇，想让不同内容各占一扇就传稳定的 `key`；满 6 扇时宿主自己提示用户，见 [Mini Panel 开发](./mini-panel-development.md)「多开」。需要宽屏独立工具页时用 `ctx.openFloatingPanel?.(viewId, options)`。宿主自动添加插件命名空间并负责窗口生命周期。见 [Floating Panel 开发](./floating-panel-development.md)。

### 统一打开入口 `ctx.workspace.open`(2.13.8 起)

上面几种打开方式(`openView` 停靠、`openMiniPanel` 小窗、`openFloatingPanel` 浮窗)现在是同一个入口的几种写法:**放在哪**(`layer`)和**长什么样**(`form`)分开写。旧的三个照旧可用,宿主内部转到这里;新代码可以直接写:

```js
const open = ctx.workspace?.open
if (open) {
  await open('board', { layer: { dock: 'right' } })                              // = openView('board', { location: 'right' })
  await open({ view: 'board', params: { id } }, { layer: { float: 'desktop' } }) // = openMiniPanel,紧凑视图按 forms 挑
  await open('board', { layer: { float: 'desktop', pin: true }, form: 'main' })  // = openFloatingPanel,并且置顶
  const r = await open('board', { layer: { float: 'space' } })                   // 一张卡浮在当前 Space 之上
  if (r.ok) r.close?.()
} else ctx.openView('board')                                                     // 旧宿主
```

| `layer` | 落到哪 |
|---|---|
| `{ dock: 'main' \| 'left' \| 'right' \| 'bottom' }` | 停靠在工作台里,同 `openView` 的 `location`;样子由位置定(左右栏都是 `side`) |
| `{ float: 'desktop', pin? }` | 系统小窗:`form: 'mini'`(缺省)是 Mini Panel(缺省置顶,`pin: false` 不置顶、拖到屏幕边也不折起来;可多开、按 `key` 复用,位置和大小按实体记、重启后还在),`'main'` 是 Floating Panel(缺省不置顶,`pin: true` 才盖在别的应用上) |
| `{ float: 'space', anchor? }` | 一张卡浮在当前 Space 的三栏之上;切到别的 Space 时藏起来,回来原样 |
| `{ float: 'window', anchor? }` | 一张卡浮在整个窗口之上,切 Space 也留着 |
| `{ float: 'view', host, anchor? }` | 一张卡浮在你视图里的某个元素(`host`)里 |

后三种和 `ctx.ui.float` 是同一套浮层(六个锚点、用户可拖到别的角),区别是里面挂的是你注册的**整个视图**,不是一块自己画的 DOM:宿主画卡头(标题、「在主面板显示」、关闭),视图的 `mount` 照常拿到 `view`(`surface` 是 `'mini'` 或 `'floating'`;`showInMainPanel()` 把当前参数带去主区打开、收掉这张卡)。插件停用或重载、视图被反注册、你调 `close()`、用户点关闭,都会收掉。同一视图 + 同一 `key` 再开 = 叫出那张、换成新参数,参数本身不算身份。

卡记在哪(2.13.8 起):
- `space`:这个 Space 开着哪些卡(视图、当前参数 —— 包括视图自己用 `view.setParams` 改的、样子、`key`、锚点)跟这个 Space 的布局一起存。重启、切回这个 Space、撤销「恢复默认布局」时开回来;你的插件晚于布局加载也没关系,视图注册上来那一刻再开。用户点「恢复默认布局」时一起收。关掉再开,回到用户上次在这个 Space 拖到的角。插件停用时收掉的卡,重新启用后不会自己回来。
- `window`:锚点按「视图 + key」记在本机;卡本身不跨重启。
- `view`:卡归你的视图管,视图每次挂上时自己再开;锚点按「视图 + key」记在本机,不写进宿主视图的参数。

**声明样子 `forms`**:`registerView` 时写 `forms`,说明这个视图能以哪几种样子出现:

```js
ctx.registerView({ id: 'board', title, mount, forms: { main: true, side: true, mini: { view: 'board-mini' } } })
```

不写 `forms` = 什么样子都行(和以前一样)。写了,没列出的就是不支持。`mini: { view }` 指一个本插件的紧凑视图(相对 id):以后凡是用 Mini 样子打开 `board`(桌面 Mini、浮层卡),里面显示的都是 `board-mini`,「在主面板显示」回到 `board`。它取代了 Space 配方 `mini` 里「哪个紧凑视图配哪个主视图」那一半;配方的 `mini` 照旧可用。

**回落规则**(要的样子不支持时):

1. 停靠:位置决定样子,传的 `form` 不看。不支持就按梯子换位置:主区 → 右栏 → 底部;左 / 右 → 主区 → 底部;底部 → 右栏 → 主区。没有底部面板的宿主(手机、卫星窗)底部当右栏。一个停靠样子都不支持(只有 `mini`)时,浮在当前 Space 之上;连 `mini` 也没有(比如 `forms: {}`)就回 `'unsupported'`。
2. 浮起来:`form` 缺省 `'mini'`,`'side'` / `'bottom'` 当 `'main'`。`mini` 不支持 → `main`;视图本身不支持 → `mini`。
3. Mini 样子里显示 `forms.mini.view`(没注册就用视图本身);没写就是视图本身。紧凑视图只认本插件的。没写 `forms` 的视图用 `openMiniPanel` 打开时和 2.13.7 一样,Mini 里就是它自己。
4. 网页没有 Mini 窗口:`{ float: 'desktop' }` 的 Mini 样子降成浮在窗口里的卡;手机上是贴底的半屏抽屉,`main` 样子停靠主区(手机上占满一屏的面板就是主区)。Space 作用域的卡在手机上贴在底栏上方。
5. Mini 窗、Floating Panel 窗这类没有工作台的窗口里,`space` / `window` / `view` 三档打不开。

返回值 `{ ok: true, layer, form, close? }` 说明回落之后实际落到哪(桌面小窗没有 `close`);打不开是 `{ ok: false, reason }`:`'unknown-view'` 不是你注册的视图,`'unsupported'` 声明的样子一个都用不上,`'unavailable'` 这扇窗开不了,`'limit'` Mini 开满了(宿主已经告诉用户,`limit` 是上限),`'disabled'` 插件已停用。参数形状不对同步抛 `TypeError`。插件只能开自己的视图。`{ float: 'desktop' }` 只是 Mini / Floating Panel 换个写法;组件浮层 `ctx.ui.float` 仍然没有桌面档。

View 内需要输入框和模型选择时，使用 `ctx.ui.mountChatBox`；它复用宿主组件，并由插件显式处理提交。不要模型选择时传 `modelPicker: false`；底排工具栏用 `toolbar`，`#` 这类补全用 `suggest`（2026-11-02 起可以传一组，例如 `#` 与 `[[` 各一份，传之前先看 `ctx.ui.chatBoxCapabilities` 里有没有 `'suggestMany'`；输入框在窗口下半部分时候选朝上开），在光标处插入文字用 `insertText`；要笔记那样的 `@` 日期 / 页面面板，传 `mentions` 并用 `onMention` 接手（2026-11-20 起，先看能力表里的 `'mentions'`）；要加粗、列表这些格式，传 `format: 'inline' | 'basic'`，值改为 Markdown，显示用 `ctx.ui.parseInlineMarkdown`（2026-11-21 起，能力表 `'format'`）。见 [可复用 UI 组件](./ui-components.md)。

设置类页面（账号、额度与积分、诊断、偏好）用 `ctx.ui.mountSettingsPage(el, { groups })` 交一份整页描述：每组有图标、标题、说明、右上角按钮和若干项（开关、数值、按钮、输入框、分段、下拉、「选了就执行」、步进器、代码 + 复制、额度条、空 / 加载 / 出错、自定义块），插件只给文字、值和回调，宿主用自己的设置零件画并按端排版——手机上开关、数值、单个按钮留在右边，输入框、步进器、两个以上的按钮换到下一行，「选了就执行」换成一枚按钮 + 半屏。清单外的内容放进 `custom` 块，块里用 `ctx.ui.mountSettingsItem` 挂单件。别再抄宿主的设置 CSS；2026-10-17 之前的宿主没有这两个接口，先探测，保留自己画的那套。见 [可复用界面组件](./ui-components.md)。

要在自己的内容上手写或圈画时（PDF 页、图片），使用 `ctx.ui.mountBoard` 把宿主白板引擎挂成一块透明层，不在手写时用 `ctx.ui.boardToSvg` 出静态图；视口与保存归插件。见 [可复用 UI 组件](./ui-components.md)。

以 `override: true` 接管了 `.pdf` 的文件类型，会接住所有「打开这份 PDF」的入口：文件树、最近使用、笔记里的 `[[x.pdf]]`，以及带页码或引语的 `[[x.pdf#page=3]]` 和聊天引用。带落点的那几种经 `mount(el, file)` 的 `file.onGoto?.(cb)` 把 `{ page, quote? }` 交给插件（2.13.2 之后的桌面版本；更早的版本把笔记链接和带落点的跳转交给内置阅读器）。回调可能在文件还没加载完、或标签刚从后台切回来时到达，先记下、能滚动了再跳。`![[x.pdf]]` 嵌入和「用内置阅读器打开」不在接管范围内。

标签被换到后台时，宿主把视图的 DOM 从文档里摘下来（不卸载，状态都在），换回来原样挂回；摘下期间量到的尺寸和滚动位置都是 0。2.13.3 之后的桌面版本在换回来时把视图里每个滚动容器的位置写回去，插件不用自己记（更早的版本一律回到顶上）。同一批版本里，⌘ / Ctrl + 点击文件树、双链、聊天引用会在新标签页打开文件类型视图，视图在主区显示时侧栏对话会自动引用这份文件。

选中一段文字要「问 Tangu」时，先调 `ctx.tangu.askInChat(text)`（2026-11-15 起）：引文挂进原生侧栏对话（和笔记划线「问 Tangu」同一个面板）的输入框上方，不发送、不动草稿；出处自己拼在末尾，库里的文件写成 `[[路径]]`（可带 `#page=N`）。返回 `false` 表示这个窗口没有侧栏对话（独立窗、Mini、浮窗），这时再退回 `file.extendView` + `mountChat` 或复制到剪贴板。旧宿主没有这个方法：`ctx.tangu?.askInChat?.(text)`。

View 内需要一个完整的常驻对话时（例如创作类 Space 的右栏），使用 `ctx.tangu.mountChat`：宿主把原生对话固定在该插件、该文件夹的一条会话上，Agent 生成的文件直接落进这个文件夹。见 [可复用 UI 组件](./ui-components.md)。

要一个「在这里打字、按发送就去 Tangu 开新对话」的输入区时（主页就是这么用的），使用 `ctx.tangu.mountComposer`：宿主把主页那一整块新对话输入区挂进来（附件、模式、项目、运行位置、语音、通话都在），用户按发送后由宿主建会话、切到 Tangu 并发出，插件只能读到草稿（`draft()`），改不了要发的内容。插件可以往空着的输入框里填一句并聚焦（`prefill(text)`，2026-11-09 起），已经写了一半的草稿原样留着，回车仍由用户按。

不需要对话、只要模型回一段文字时用 `ctx.tangu.complete`（一次性调用：没有工具、不进任何会话，用聊天当前的模型）。翻译用 `ctx.tangu.translate({ text, language })`：同一条通道，但模型取用户在「设置 → 模型 → 翻译」里选的那个；没选时账号里有机器翻译模型就用它，都没有才跟聊天模型（2.13.3 及更早的桌面版本：没选就跟聊天模型）。逐句翻译这类量大的活应当走它；它只返回译文。旧版本没有 `translate`，先探测再退回 `complete`。在划线动作的 `run` 里调用时，把 `cx.signal` 原样当 `signal` 传进去（2026-11-22 起）：结果卡头会像内置翻译那样写明是哪个模型出的（这次 run 里先调用的那个），`complete` 同理。选区周边（笔记前后的文字、页面说明）只补进宿主核心翻译插件的 `translate` 请求，别的插件不补。

边打字边给灰字建议这类按光标补中间的活用 `ctx.tangu.fim({ before, after })`（2026-10-26 起）：光标前后的正文原样交给补全模型（FIM，fill-in-the-middle），没有提示词，返回模型原文（不 trim）和实际用的 `model`。模型取用户在「设置 → 模型 → 补全」选的那个，没选就用账号里第一个补全模型；`maxTokens` 夹到 1..512（缺省 64），`stop` 最多 4 个、每个不超过 32 字符。没有补全模型、模型或引擎做不了 FIM 时 reject `Error('fim_unavailable')`：退回 `complete`，并在本次会话里记住别再试；云端目录这次没拉到时 reject `Error('fim_catalog_unreachable')`，属临时错误，下次照常试 `fim`。与 `complete` / `translate` 合计每个用户同时最多 3 个请求，每次按键先 abort 上一次。旧版本没有 `fim`，先探测。

同一份东西的几种看法（转写 / 笔记 / 纪要、文档 / 画布这类）交给宿主画：`ctx.ui?.setViewModes`，`el` 是 `mount()` 收到的元素，`modes` 是 2–4 个 `{ id, label, labelEn?, icon? }`。胶囊画在视图头行最左，⌥⌘V（Windows / Linux：Ctrl+Alt+V）切下一种、命令面板每种一条「看法：X」、视图窄于 480px 只留图标、窄于 320px 收成下拉、手机上进顶栏，这些都归宿主。句柄的 `actions` 是同一行右边的空位，把自己栏里的按钮挪进去，整个视图只留一条头行；`set(id)` 是插件自己切（不回调 `onChange`）。看到哪一种由插件按记录 / 文件自己记，宿主不存。2.13.4 及更早没有这个方法，先探测、保留自己的标签。见 [可复用界面组件](./ui-components.md)。

```js
ctx.ui?.setViewModes?.(el, { modes, value, onChange })
```

按钮和图标的悬停提示用宿主那一个：`ctx.ui?.attachTooltip`，300ms 才出、相邻接力不重播、键盘聚焦立刻出，和宿主自己的按钮一个样子；`content` 是一行或几行文字，句柄 `{ update, dispose }`，插件禁用时宿主统一收。图标按钮留 `aria-label`、去掉 `title`；旧宿主没有这个方法就照旧 `title`。见 [可复用界面组件](./ui-components.md)。

```js
ctx.ui?.attachTooltip?.(el, content, { side })
```

拖动排序、拖进去的落点提示也用宿主那一个：`ctx.ui?.dropIndicator?.()` 拿到 `{ line, zone, hide, dispose }`，传视口坐标；换落点原地淡出淡入、颜色跟主题，给 `key` 免得滚动被当成换落点，插件禁用时宿主统一收；旧宿主没有就照旧自己画。见 [可复用界面组件](./ui-components.md)。松手之后 `drop.land?.(行或找它的函数, 松手处)` 让被拖的那一行从松手处滑进新位置（2026-10-25 起，160ms，减少动态效果下直接到位）。

选中文字后浮出的那一条（划线条）对插件开放两半。一是加动作：`ctx.registerSelectionAction` 的动作列在条上的「⋯ → 插件」里，`run(cx)` 返回的 markdown 进宿主的结果卡（笔记里用户点「替换 / 插入下方」才写，别处只读）。不写 `scope` 只在笔记里出现；`scope: 'all'` 出现在所有有这一条的视图（笔记、聊天、接入了的插件视图），`'own'` 只在自己的视图，数组点名视图；`when({ view, editable, length })` 按视图和字数过滤，`output: 'none'` 表示结果由插件自己处理。二是让自己的视图用上这一条：`ctx.ui?.mountSelectionBar`，宿主给「问 Tangu」「翻译」「⋯」，插件声明自己的工具（图标钮或颜色点）；不接就不出。这两半在 2.13.3 之后的桌面版本里才有：更早的版本只在笔记里列动作（「AI ▾ → 插件」），没有 `mountSelectionBar`，先探测、保留自己的菜单。2026-11-08 起条和结果卡随滚动、缩放跟着那段字走,滚出可见区先藏起来;`watch: false` 自己报选区的视图在 `show()` 里再给 `getRect` 也能跟。2026-11-21 起动作可以常驻条上(`placement: 'bar'`,条上插件位最多 3 个,用户在 ⋯ 里钉 / 右键收进 ⋯ / 设置里改的永远优先),可以声明支持「划选后自动」(`auto: true`,开关归用户、缺省关,开了以后划选停下就出结果卡,`run` 拿到 `cx.auto`;这个开关是给用户的界面开关、不是安全边界 —— 插件和宿主跑在同一个渲染进程里,别自己去改它;笔记里不自动跑,`scope` 只认笔记的动作声明了也没用),可以让宿主在结果卡上画目标语言(`cx.language`)、原文和小喇叭(`card`);`title` 也收 `{ zh, en }`。条上多了「朗读」,插件自己念用 `ctx.tts?.speak(text)`(用用户选的朗读模型,没配时宿主提示去设置,不回落系统声音)。宿主自己的「翻译」让给 id 为 `translation` 的插件,条件是它是宿主认的核心插件(随包 / 预装,停用也算),或者它启用着并注册了划线动作;接管后沿用用户给宿主翻译设的「放在哪」。见 [可复用界面组件](./ui-components.md)。

```js
ctx.registerSelectionAction({ id, title, run, placement, auto, card })
ctx.ui?.mountSelectionBar?.(root, { tools, source, ask, watch })
await ctx.tts?.speak(text, { signal })
```

「拿着一件工具干活」的视图(PDF 批注一类)换工具用宿主的工具岛:`ctx.ui?.mountToolIsland?.(root, { tools, active, onPick, slots })` 顶部居中(窄于 520px 停底部),选中受控(`onPick` 里自己 `setActive`),句柄的 `row` 是岛下那一排、归插件画。旧宿主没有就画自己的那条。详见[可复用界面组件](./ui-components.md)「工具岛」。

要浮起来的一块(传输进度卡、导出完成的小条、录音计时胶囊)用 `ctx.ui?.float?.({ scope, anchor, role, id })`:`scope` 说浮在谁之上(`view` 自己的视图 / `space` 整个 Space、切走就藏 / `window` 整个窗口),内容放进句柄的 `el`,位置、层级、动效、拖动吸附归宿主,别自己写 `position: fixed` + z-index。旧宿主没有就照旧自己画。详见[可复用界面组件](./ui-components.md)「浮层」。

## 读写多维表与笔记任务

日历、待办、习惯这类插件需要读写你库里的多维表，以及笔记里带 `@` 时间的任务（`- [ ] 交周报 @2026-10-20`）。插件必须在说明文件里声明 `databases`（多维表）或 `noteTasks`（笔记任务）才拿得到；没声明的插件看不到这些数据。拿到之后，插件改一格、勾一项，和你在表格里、笔记里亲手改是同一条路：打开着的表格立即跟着变，笔记视图的属性写进那篇笔记。插件删经典表的一行可以撤销；笔记视图的一行是一篇笔记，插件只能把它移进回收站。插件声明了哪些，插件详情页会列成一行「这个插件可以：……」给你看（读取前台窗口的 `activeWindow` 也列在这一行）。2026-11-02 起，笔记里缩进在带 `@` 的任务下面的 `- [ ]` 会作为它的子任务交给插件（最多两层，没写 `@` 的子任务不会单独出现在待办里），每条任务也带上行里的 `#标签`；插件还能读写表格一行的记录正文（与「打开记录」同一份，改之前核对内容没被别处改过），以及给表格加一列（例如第一次用标签时加一列多选「标签」）。2026-11-04 起，插件还能一次改好整张表（改列名、加选项、调行的顺序、建视图），走的是表格界面自己的那条写口：打开着的表格立即跟着变，还没存盘的改动不会被冲掉；首列、自动编号与创建 / 修改时间仍由宿主管，不合规的改动整笔不收。2026-11-15 起，笔记里写 `- [ ] 买菜 @todo` 的任务也会交给插件：它没有日期（`due` 为空串、没有 `parentId`），意思是要进待办清单、但还没排日期；插件给它设日期时，宿主把 `@todo` 换成那个日期；反过来给任务清掉日期（`due` 传空串），日期会换回 `@todo`，它仍留在待办清单里。标注框、折叠块的标题行带日期时，交给插件的文字也不再带开头的 `[!fold]-` 这类记号。接口细节见插件开发技能「全库多维表与笔记任务」一节。

### 日历叠加源与日历设置

日历插件还需要宿主日历叠上去的那几类只读来源：Agent 日程、你加的 .ics 订阅、Local↔Cloud 另一侧库里的表，以及你的日历设置（哪些表在日历里、各用哪一列当日期和完成勾选、颜色、藏起来的来源、新建事件默认落进哪张表）。插件必须声明 `calendar` 才拿得到；没声明的插件只能用原来的「把自己的表登记进日历」。拿到之后，插件改颜色、加减日历里的表，和你在日历左栏「日历」列表里改是同一处，只对当前库生效；叠加源只能看不能改。插件订阅期间，宿主替它按时刷新这些来源（.ics 订阅要联网，和打开着的日历共用一个计时器，不会多拉）。同一项还让插件增删、改名、立刻刷新 .ics 订阅，或导入一份本地 .ics 文本，和日历设置里的「订阅」是同一份列表；插件详情页那一行会多一项「读取 Agent 日程、.ics 订阅和另一侧库里的日历，管理 .ics 订阅并改日历设置」。另外，插件可以打开笔记并直接跳到某个标题（`ctx.app.openNote(path, { heading })`）；通知上可以带一个按钮（比如「撤销」）；声明了 `databases` 的插件还能把宿主事件浮卡里那排字段（标题、时间、属性）挂进自己的卡片（`ctx.ui.mountRecord`），改动直接写回那张表。仪表盘卡片和插件自己的定时提醒还没有开放。2026-11-15 起，.ics 订阅和导入的日历里有事件写了地点、说明、链接时，这本日历多出 `location`、`description`、`url` 三列（列名按界面语言），某个事件没有这一项时那一格就是空的；老宿主只有名称和日期两列。接口细节见插件开发技能「日历叠加源与设置」一节。

### Space 与 Ribbon 收纳架

随包 Space 可以在 `spaces/<slug>/space.json` 中声明 `"autoDesktopShortcut": true`。安装版首次注册这个已启用插件的 Space 时，会在系统桌面为这个 Space 创建一个快捷方式。删除或移动快捷方式后，插件重载、升级和应用重启都不会重新生成，仍可在 Space 菜单里手动添加。该字段只在桌面安装版生效，旧版宿主会忽略它。

启动台、主页一类插件可以列出你的 Space、点一下打开、显示图标和近况（继续某会话、最近的笔记、下一条日程、未读数），并在自己的界面里调整 Ribbon 上 Space 的顺序和收纳夹。插件必须声明 `spaces` 才拿得到；它改的就是 Ribbon 那一份顺序，在插件里拖一下，Ribbon 上跟着变，反过来也一样。某个 Space 换了图标（比如它的插件更新了），插件里画的图标也跟着换。2026-11-09 起，插件里右键一个 Space 弹的是和 Ribbon、主页同一份菜单（`ctx.spaces.contextMenu`，插件可以在最后加几项自己的），能问到点它会不会开到它自己的窗口去（`opensElsewhere`），商店、成就那两格之后也会带上活动中心这类首方 Ribbon 入口。插件详情页会多一项「打开 Space，调整 Ribbon 上 Space 的顺序和收纳夹」。接口细节见插件开发技能「Space 与 Ribbon 收纳架」一节。

另外三件零碎的：插件可以拿到当前登录的名字（`ctx.app.watchAccountName`，有昵称用昵称，只给名字不给令牌）、必应每日壁纸（`ctx.wallpaper.bing`，由 Forsion 代拉），以及和 Forsion 自己一样样式的右键菜单（`ctx.ui.contextMenu`）。菜单项多、窗口矮时自己滚动；做勾选清单时可以让它点了不关，一次勾好几项。插件还能读到动效偏好（`ctx.app.motion`，2026-11-09 起）：系统减少动态效果、或在设置里选了「只淡入淡出」时别做位移和缩放，和 Forsion 自己的界面同一个判据。

接管主页的那个核心插件另有一组主页专用接口（`ctx.home`：卡里的内容由宿主画进插件的格子、主页摆放的读写、「编辑主页」命令），普通插件拿不到，也申请不到。

## 新建 Agent 与导入聊天记录（2026-11-16 起）

「从别的 AI 搬家」一类插件可以替你新建一个 Agent，再把导出文件里的旧对话写成这个 Agent 名下的会话：点开就是原来的对话，可以接着聊。插件必须在说明文件里声明 `agentImport` 才拿得到（`ctx.tangu.createAgent` / `ctx.tangu.importSessions`），插件详情页那一行会多一项「新建 Agent、导入聊天记录」。

- **写在哪台设备上**：桌面写进本机引擎，手机和网页写进云端，不跨设备同步。在桌面导入的对话不会出现在手机上，要在手机上用就在手机上再导一次。
- **只追加，不覆盖**：同一来源、同一条对话再导一次会被认成「已有」，原会话一字不动；你在里面接着聊过的内容不会被旧记录盖掉。
- **保留原样**：会话用原来的标题和时间，按原时间排在列表里，不冒到最上面，也没有未读点；导入不触发起标题、记忆整理这些后台任务。
- **会话的形状**：和「新建 Chat」一样（不挂项目），归在指定的 Agent 名下，不进它的私聊。
- 时间一律毫秒；一次可以交很多条，宿主自己分批写，每写完一批回调一次进度。出错不抛，返回 `{ ok: false, error, results }`，已经写进去的那几批列在 `results` 里。

接口细节见插件开发技能的能力表（`ctx.tangu.createAgent` / `ctx.tangu.importSessions` 那一行）。

## 插件自带的 MCP、hooks 与文件事件

插件可以随包带上自己的 MCP server(只限在本机跑的那种),装好、启用之后 Tangu 就多了这些工具,停用插件就一起停掉。设置 → MCP 里会列出它们,写着来自哪个插件;要关掉,在插件设置里停用这个插件。这些工具和用户自己接的 MCP 一样缺省按需加载:每次请求只带一行目录(工具名 + 描述第一行),AI 要用时先装上再调,所以描述第一行要能单独说清这个工具做什么;每轮都要用的 server 在声明里写 `"deferLoading": false` 就一直带着。插件也可以带 hook,在会话开始、工具跑完、一次回答结束时收到通知,用来做审计、归档这类事;这种 hook 只能看,拦不住任何操作,也不能往对话里加内容。设置 → Hooks 里同样列出它们,标着「只观察」。

插件还能收到笔记库里的文件事件:新建、删除、在 Forsion 里改名或移动、被别的程序或 Tangu 改动,以及换库。反链、自动整理这类插件靠它跟上库里的变化,不用一遍遍重新扫描。接口细节见插件开发技能的「插件自带的 MCP server 与 hooks」和「库级文件事件」两节;插件命令给 Tangu 交回查询结果的写法在「`invoke`:把一条命令开给 agent」一节。

## 库里的文件夹、文件时间、改名与移动（2026-11-16 起）

插件可以建文件夹、读文件的大小和时间、改名和移动库里的文件，做法和你在文件树里操作一样：改名或移动笔记时，库里指向它的 `[[链接]]` 跟着改，开着它的编辑器跟着走，笔记的子笔记一起挪。这几个方法都要有打开的库；旧宿主没有，用可选链判断。

```js
await ctx.app.createFolder?.('Plugins/my-plugin/Archive')
const info = await ctx.app.stat?.('Notes/Idea.md')        // { kind, size, mtime, ctime } 或 null
const moved = await ctx.app.movePath?.('Notes/Idea.md', 'Plugins/my-plugin/Archive')
const renamed = await ctx.app.renamePath?.(moved, 'Idea (done)')
```

- `stat` 给出是文件还是文件夹、字节数、修改时间和创建时间（毫秒；文件系统不记创建时间时为 `null`），路径不存在或没开库时给 `null`。网页版拿不到文件时间，那里没有这个方法。
- `renamePath` 的新名字不带文件夹，漏写的 `.md`、`.db` 这类后缀会补回去，改名改不了文件类型；`movePath` 的目标文件夹必须已经存在，空串表示库根。两者都返回新的路径。
- 插件自己的东西直接改：工作文件夹里的文件，以及这个插件本次运行里自己建出来的文件和文件夹（用 `writeFile`、`writeBytes` 写出的新文件，`createFolder` 建的文件夹）。改别的文件之前，Forsion 会先问你一次（「允许」/「取消」，焦点在「取消」上）；你点了取消，插件收到 `user_declined` 错误，什么都不会改。
- 不做的：移动多维表（`.db`）或含多维表的文件夹、改名改掉文件类型、给图片和 PDF 改名、单独挪笔记的子笔记文件夹（`.fd`）、移到不存在的文件夹。文件已经挪过去、链接却没改完时，报错里写明文件现在的位置。

## 模板与新笔记（2026-11-16 起）

Forsion 自己就有模板：库里 `templates/` 文件夹里的笔记，插入时替换 `{{date}}`、`{{date:格式}}`、`{{time}}`、`{{title}}`（格式读 `.obsidian/templates.json`）；日记的文件夹、命名和模板读设置或 `.obsidian/daily-notes.json`。做 Templater 一类插件、或者「某个文件夹里的新笔记套某个模板」的插件，接进这一套，不要另做一个模板选择器。

模板处理器在宿主替换变量之前拿到模板原文，按注册顺序一个接一个处理；返回 `null` 表示不改，抛错则这次不插、提示里写着插件名；处理到一半插件被停用或重载，就当这一个没改，后面的处理器照常接着跑。等处理器的时候换了库、换了窗格或笔记，这次就不插。`folders()` 往模板选择器里加文件夹。它管两处：在模板选择器里选模板插入（`kind` 为 `'insert'`），以及新建日记（`'daily'`）。

```js
const off = ctx.registerTemplateProcessor?.({
  id: 'tp',
  name: 'Templater',
  folders: () => ['Templates'],
  process: async (source, { templatePath, targetPath, kind }) => render(source, targetPath),
})
```

新笔记的初始内容：用户新建一篇空笔记时，Forsion 在写盘之前先问插件要内容，第一个给出非 `null` 内容的插件，内容和这次新建一起写进去，编辑器一打开就是它。会问的地方：所有「新建笔记」入口（包括插件调用 `ctx.app.createPage()`，调用的那个插件自己的提供方也会被问）、在文件夹里新建、子笔记、在快速切换器里新建、点开还不存在的 `[[链接]]`，以及没设日记模板时的新日记；不问的只有：插件自己用 `writeFile`、`writeBytes` 或文件创建器写的文件，多维表里加的行，同步下来的文件。插件可以弹框问用户，等得久了 Forsion 会显示「「插件名」正在准备这篇笔记…」并带「取消」；取消或 10 分钟没有回答，就和以前一样建一篇空笔记。

- `signal` 在 Forsion 不再等这个插件时中止：点了取消、到了 10 分钟、换了库、插件被停用或重载、笔记已经建好。它一中止，插件就该关掉自己的弹框；之后才来的回答会被忽略。
- 等的时候换了库：这篇笔记不建，并弹提示说明原因。
- 等的时候你去了别的窗格或别的笔记：笔记照样建好，但不会把你拉回去打开它 —— 「新建笔记」会弹一条「已新建「…」」并带「打开」按钮；子笔记的链接照样插进父笔记。

```js
ctx.registerNoteBirth?.({
  id: 'folder-templates',
  initial: async ({ path, folder, signal }) => (folder.startsWith('Journal') ? render(journalTemplate, path) : null),
})
```

两个方法都返回撤销函数，插件停用时也会自动撤掉。旧宿主没有这两个方法。别用「收到新建文件事件再 `writeFile` 写进去」来代替：实测打开着的编辑器看不到这次写入，用户一打字保存，模板就被挪进一份「冲突」副本。

## 往笔记里插内容（2026-11-16 起）

`ctx.app.insertMarkdownAt` 往当前笔记里插一段 Markdown，比原来的 `insertMarkdown` 多三样：`where: 'caret'` 插在光标所在的那一行里（内容只有一段时；选中了文字就像打字一样替换它）；`cursorMarker` 是你写在内容里的一串标记，插完 Forsion 把它删掉、光标落在那里；插不进去时告诉你原因。每次插入单独算一步撤销。

```js
const page = ctx.app.getPage()
const r = ctx.app.insertMarkdownAt?.(page.token, 'Hello {{cursor}}', { where: 'caret', cursorMarker: '{{cursor}}' })
// r = { ok: true } 或 { ok: false, reason: 'stale-token' | 'no-note' | 'empty' | 'read-only' | 'no-editor' }
```

- `read-only`：笔记在阅读模式或被锁定，什么也没插，可以提示用户切回编辑。`no-editor`：编辑器还没准备好，或者在源码模式。`stale-token`：用户已经换了一篇笔记，或插件被停用、重载了。
- 标记放在行首的 `#`、`-` 这类语法前面会改变 Markdown 结构，这时宿主照原文插入、不放光标。
- 旧版块笔记没有光标，`'caret'` 退成插到末尾。旧宿主没有这个方法时退回 `insertMarkdown`。

编辑器扩展（`ctx.registerEditorExtension`）拿到的是 Forsion 编辑器自己的 ProseMirror，除了拦按键、加装饰，也能改文字和移光标（LaTeX Suite 插件在占位之间跳光标就是这么做的）。但如果只是「把一段模板插到光标处、光标放到标记上」，先用上面的 `insertMarkdownAt`：解析、撤销、只读判断都由宿主处理。

## 联网与第三方库

桌面版的内容安全策略（CSP）拦的是从别的网站加载**脚本**，所以第三方库要打包进插件自己的 `main.js`（大小不限）。**联网请求不受 CSP 限制**：它允许 `https:` 和 `wss:`，对方接口返回了跨域许可头（`Access-Control-Allow-Origin`）时，插件可以直接用 `fetch`。接口不返回这个头时请求会失败（`TypeError: Failed to fetch`），原因是浏览器的跨域限制（CORS），不是 CSP。

这类接口改用 `ctx.net.request`，由 Forsion 的主进程代为请求（2026-11-16 起，只在桌面版；网页版、手机版和旧宿主上没有 `ctx.net`，先判断再用）。插件要先在 manifest 的 `network` 里写明会访问哪些主机：

```json
{ "network": ["api.example.com", "*.cdn.example.com"] }
```

```js
const res = await ctx.net.request('https://api.example.com/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(query) })
if (res.status === 200) render(res.json())
```

- 只写主机名，不带协议、端口和路径；`*.example.com` 包括任意层的子域名，但不包括 `example.com` 本身，两个都要就两个都写。每次请求时主进程都从磁盘上的 manifest 重新读这份名单。插件详情页、已装插件的商店信息和沙箱的安装确认里会列出「会访问：…」；从商店安装之前暂时还看不到。
- 只走 https 的默认端口（443）。主机写成 IP 地址，或者连接时解析到本机、内网、保留地址的，一律拒绝；重定向最多 5 次，每一跳都重新核对名单。Forsion 的 cookie 和登录信息从来不会带上，接口要鉴权就自己写 `Authorization` 头。
- 响应解压后不超过 10 MB；`timeoutMs` 缺省 30 秒、最多 60 秒；每个插件同时最多 8 个请求；插件被停用时，还没回来的请求会失败。
- 返回的 `res` 带 `status`、`headers`（小写的头名）、`bytes`、`url`（重定向后的地址）以及 `text()`、`json()`。4xx、5xx 照常返回，只有连不上之类的问题才失败；失败时错误的 `code` 是 `net_domain_not_declared`（名单里没有）、`net_blocked_address`、`net_timeout`、`net_too_large`、`net_bad_url`、`net_bad_request` 或 `net_failed`。
- 返回了跨域许可头的 https 接口，照旧可以直接 `fetch`。

网页版和手机版的 CSP 不一样，要在那两端单独试。

## 内部接口 `ctx.internals`（2026-11-16 起）

正式接口缺东西、又不想等 Forsion 发版时，可以用内部接口直接读 Forsion 自己的状态，或者拿到它的内部模块。**它不稳定**：里面的东西跟着 Forsion 内部走，任何一版都可能改名、改形状或消失，不算破坏性变更，也不会提前通知。只在桌面版有；网页版、手机版和旧宿主上 `ctx.internals` 是 `undefined`，一定先判断再用。

分两级，都要在 manifest 的 `capabilities` 里声明：

```json
{ "capabilities": ["internals"], "internalsVerified": ["2.14"] }
```

**第一级 `internals`**：只读。拿到的是冻结的数据副本，里面没有函数，改不了 Forsion。

```js
const k = ctx.internals
if (!k) return
k.stores()                                            // 能读哪些：page、app、workspace、spaces、commands、ui……
const path = k.read('page', (s) => s.activePage)      // page 指向当前活动的那个面板
const off = k.subscribe('page', (s) => s.activePage, (now, prev) => { /* … */ })
k.host.mainWindow                                      // 每扇窗口各跑一份插件；自己发起的写库动作只在主窗做
```

- 副本里函数、类实例都去掉了；`Date` 变成毫秒数，`Map` 变成 `[键, 值]` 对的数组，`Set` 变成数组。`selector` 拿到的也是副本。
- `subscribe` 在同一轮里的多次变化只算一次；选出来的数据没变就不通知。插件停用时宿主替你退订。
- 要写，用正式接口：改名、移动、建文件夹、写文件见上面「库里的文件夹、文件时间、改名与移动」，动别人的文件时会先问用户。

**第二级 `internals-raw`**：Forsion 内部模块的真对象，读写都行。要和 `internals` 一起声明。

```json
{ "capabilities": ["internals", "internals-raw"] }
```

```js
const ids = await ctx.internals.raw.modules()          // 能取哪些模块
const { usePageStore } = await ctx.internals.raw.import('host:desktop/frontend/src/amadeus/store/pageStore.ts')
```

- 只给得了 Forsion 共享模块表里登记的模块（页面状态、对话状态、布局引擎、React 等）；没登记的模块、函数内部的私有变量拿不到。
- **风险自负**：写坏了不一定报错；停用以后你拿到的对象收不回，用户会被提示保存并重载窗口。改写 Forsion 自己的动作时，自己负责在停用时还原。
- 要读写笔记文件，仍然优先用正式接口：Forsion 写文件有冲突检查、引用重写和同步记录，绕开会丢数据。

**插件页和商店怎么显示**：声明了内部接口的插件在设置 → 插件里带标注（第二级更醒目），详情页写明风险。`internalsVerified` 写你在哪几版 Forsion 上验过（只比到小版本，比如 `"2.14"`）；和用户正在用的版本对不上时，详情页会说一句「没在这一版上验过」，不拦。

**出错怎么办**：声明了内部接口的插件，没接住的错误会算到它头上；一分钟内连续 3 次，Forsion 会停用它并通知用户，用户可以在插件页重新启用。在沙箱里开发加载的副本不这样停用，错误照常进控制台。

**上架**：第一级照常审核。第二级要申请：投稿时在「内部接口申请理由」里写明要哪些模块、为什么正式接口不够；审核按版本过，每个新版本都要重新过审才会推给用户。没过审的版本，桌面版不会从官方商店安装。开发加载、手动安装和第三方商店来源不受这条限制。

检查：`node check-plugin.mjs <插件目录>` 会报出没声明就用、只声明第二级、直接摸 React 内部结构这几种问题，并列出第二级取用的模块。

## 命令的撤销与缺省快捷键

`ctx.registerCommand` 返回一个撤销函数，只撤掉这一次注册（2026-11-16 起）；同一个插件用同一个 `id` 再注册，会原地替换原来那条（标题、动作、快捷键都换成新的），被替换掉的那次注册的撤销函数不再起作用。所以插件可以在运行中增删命令（比如每个启用的模板一条），不用重载。插件停用时它的命令照旧全部撤掉。旧宿主返回 `undefined`，同 `id` 再注册会多出一条，所以写成 `off?.()`，并且在旧宿主上每个 `id` 只注册一次。

```js
const off = ctx.registerCommand({ id: 'my-plugin-insert-daily', title: 'Insert daily template', hotkey: 'Mod+Shift+Y', run: insertDaily })
off?.()
```

`hotkey` 是这条命令的缺省快捷键，只是建议：

- 必须带 `Mod`（macOS 上是 ⌘，其他系统是 Ctrl）；带 `Shift` 时只能配字母、`[`、`]` 或 `ArrowUp`、`F5`、`Enter` 这类具名键（Shift 加数字或标点打出来的是别的字符，永远对不上）；不支持 `Space`。写错的会被忽略，并在控制台提示一次。
- 只有这个键没被占用时才生效：Forsion 自己的命令、系统和编辑器的快捷键、你给别的命令设的键，以及别的插件用了同一个缺省键（这时两个插件都拿不到）。你给这条命令自己设的键永远优先。
- 没生效的缺省键会在 设置 → 快捷键 里标出来，写着「插件默认键 {key} 与「{other}」冲突，未生效」；那个键空出来以后，它会自动生效。你随时可以在那里手动给命令设键。
- 旧宿主忽略 `hotkey`。

## IM 通道

引擎插件可以接入一个新的聊天软件(比如企业微信),和内置的微信、Telegram、QQ 通道用同一套:连接即新会话、远程审批、`/new` `/model` 等命令、收件箱转发、侧栏里的通道文件夹都现成。装好之后「设置 → 通道」里多一张卡,填上插件要的凭据、点「连接」就能用;停用插件,这个通道随之停下,已绑定的会话还在。接口见插件开发技能「引擎插件」一节的 `ctx.registerChannel`;企业微信插件是现成的例子。

一个账号也可以服务多个联系人:写 `multiPeer: true`,每个联系人就有自己的绑定、会话和工作目录,对话互不相通。他们用的是同一个 Agent、同一个账号身份,所以 Agent 记忆是共用的,这些会话不用项目记忆。工作目录只是把文件分开,不是沙箱:工具走主机执行时仍然能读到别的目录,所以要自己把好谁能说话、工具怎么审批。谁能说话由驱动决定;这些联系人不是通道主人,所以只有 `/stop` 算命令,收件箱不转发,桌面也切换不了连接的会话。老引擎会静默忽略这个键,先判 `ctx.channelCapabilities?.multiPeer`。入站消息带 `agentSlug` 可以给这个联系人钉一个 Agent。

凭据直接写进配置、没有人点「连接」的无人值守部署,再加 `selfConnect: true`:账号从没连过时,驱动交上来的第一个联系人会替本机用户连上。用户断开过的账号不会被连回去。

驱动实现 `sendApproval` 后,审批不再发文字卡,而是把工具名、参数和预览交给驱动画,由 `respond` 兑现:文字消息批不了它,也作废不了它,10 分钟没人答按拒绝。实现 `settleApproval` 能知道卡是怎么结束的。界面半身可以用 `ctx.tangu.connectChannel(kind, fields, { modelId })` 替用户填好并连接自己捆绑的通道,只在桌面可用,别的插件的通道会被拒绝。`modelId` 在通道还没选过模型时当默认模型,用户选过的不动。

## 自动化触发事件

插件可以给自动化加一种自己的「当…」:用 `ctx.automation.registerTrigger` 登记,事件发生时用 `ctx.automation.emit` 发一条。登记之后它出现在自动化画布触发节点的「外部 · 插件」组,规则由用户自己写,可以加时段、星期、冷却和每天次数;用户选「直接提醒」不花额度,选「叫醒 Muse」照常过额度。

只能登记自己命名空间下的:`id` 只写 key,宿主拼成 `plugin:<插件 id>:<key>`。名字中英都要有。插件停用或卸载时触发源随之注销,相关规则不删,暂停并写明原因,装回来自动恢复。事件不落盘,引擎重启会丢掉还没被规则看到的。引擎插件用 `ctx.sdk.automation` 上的同名方法。写法见插件开发技能的 `references/tangu-host-apis.md`。

## 通知（`ctx.notify`）

`ctx.notify(message, { level, title, action, key, undo, urgent })` 在桌面上是右上角的一张卡，在手机上（窗口窄于 640）是状态栏下面的一条横幅：盖住顶上胶囊那一条，不压页面内容，一次只出一条，其余排队；来源和正文各一行，放不下在句尾省略，按钮和 × 在同一行靠右。手机上点正文等于点按钮，往上滑或点 × 收起。

- 停留：桌面上带按钮的停 8 秒、其余按级别；手机上统一 5 秒，读屏开着 10 秒，`error` 和 `sticky: true` 一直留着。
- `key`：同一个 key 的后一张顶掉前一张。手机上直接换文案和按钮，停留从第一次出现算起，不往后顺延。
- 手机上的节流：你的插件有一张卡收起后，一段时间内（到点自己走的 30 秒，用户上滑或点 × 收的 2 分钟）宿主不再出你的卡。`ctx.notify` 照常返回、不报错，所以要让用户回头还看得到，就把数字或状态留在自己的界面里（列表上的数字、页签角标）。App 在后台时的系统通知不受节流。
- `undo: true`（2026-11-15 起）：这张卡是用户刚做的事的退路（删除后的「撤销」）。手机上停 8 秒，不受节流。
- 没带 `undo`、但在处理用户点按或按键时**同步**弹出的带按钮的卡（删完马上弹的「撤销」），手机上也按撤销对待：停 8 秒，不受节流。等过文件或网络、在回调里才弹的，宿主分不出那是用户刚做的事，要自己带 `undo: true`。
- App 在后台时手机上不出横幅，只发系统通知；卡片排着，回到前台后一条条出（节流照常），但不补一整串。退到后台那一刻屏上正显示的那张（常驻的除外）也收回来，回到前台后第一个重新出（有人在等的 `urgent` 卡照样排在它前面）、从头停满，不会在后台到点消失。一律留着的：带 `undo` 的、常驻的、`error` 的、退到后台时正显示着的，以及没能发出系统通知的（比如用户关了系统通知、没给通知权限；这类卡回来后逐张出，不受同一来源的冷却）。其余的 `urgent` 卡按「插件 + key」各留最新一张、全部留着（不同的审批各自留着；回到前台时通知栏里的系统通知会被收掉，所以不丢）。不急的卡每个插件只留最新一张，补满 3 张里剩下的名额，留新的；`urgent` 已经有 3 张或更多时不急的一张不留。被省下的那些系统通知已经发过，数字留在你自己的界面里。
- 手机上从底部弹出的原生面板（菜单、输入框、确认框）开着时也不出横幅：卡片排着、不计时，屏上正显示的那张（常驻的除外）也收回去，面板收起后再出、从头停满。
- 系统通知：同一个插件只留最新一条；只有带 `urgent: true` 又带 `key` 的卡按「插件 + key」各占一条（同 key 的后一条顶掉前一条）。所以等批准这类卡给它 `urgent` 和自己的 key，就不会被你后来的普通卡顶掉。
- `urgent: true`（2026-11-15 起）：有人或 Agent 正停着等用户（比如等批准）。手机上不受节流，排在不急的卡前面；它不是常驻，停留照常。
- 两项都只认 `true`，旧宿主会忽略，所以可以直接写，不用先判断宿主版本。不受节流的卡请给它自己的 `key`（比如 `approval:<id>`），别和普通卡共用一个 key，否则会把普通卡顶掉。

## 插件数据读不出来时

2026-11-17 起，`ctx.loadData()` 把「从没存过」和「存过但读不出来」分开：从没存过（或者存的就是 `null`）时返回 `null`；存过却读不出来（读错误、文件是空的、写到一半、被手改坏）时会报错，错误的 `code` 是 `plugin-data-unreadable`。以前宿主把后一种也当成没存过，插件按默认值起来，下一次 `saveData` 就把用户原来的数据整个盖掉。

收到这个错误时，别按默认值继续再保存：先停掉要用这份数据的功能，告诉用户，等下次加载再试。宿主不会动原文件；插件接住错误后仍然保存时，桌面和手机会先把原文件另存为 `<id>.json.unreadable-<时间>`，连原文件都拷不出来就拒绝这次保存。写了 `"syncData": true` 的插件，本机文件内容坏了而云端有一份时，宿主直接用云端那份恢复，`loadData` 照常返回；读失败后插件仍然保存的数据，在和云端对上之前都不会传上云端，也不会盖掉云端那份，之后读成功了、应用重启了也一样，插件这次运行里只要读失败过一次，到重新加载之前它的保存都这样处理；下次连上云端时，云端有一份就换成云端那份，被换掉的本机数据先另存为 `<id>.json.replaced-<时间>`，云端没有才把本机这份传上去（传的时候别的设备刚好先建了一份，就让给那一份）。在 `setup` 里 `await` 它又没接住，插件会加载失败，插件列表里显示「加载失败」。旧版宿主遇到读不出来仍然返回 `null`。

2026-11-18 起，`ctx.saveData()` 遇到转成 JSON 什么都没有的值（函数、`toJSON` 返回 `undefined`）会直接报错，什么都不写。以前这种值会被写成空内容，下次读就成了读不出来。BigInt、循环引用本来就会报错。

## 插件数据跨设备同步

插件在 manifest 里写 `"syncData": true`，它用 `ctx.saveData` 存的数据就会随 Forsion 账号同步到你的其他电脑和手机。没登录或断网时照旧只存在这台设备上，联网后再补传。两台设备都改过时，保留较晚的那次。插件详情页里有「跨设备同步插件数据」开关，可以在某台设备上单独关掉。用户卸载时没勾「保留设置」，云端那份会一起清掉；从回收站恢复后本机这份会重新传上去，别的设备还装着时也会把它的那份传回来。网页版暂不同步。接口细节见插件开发技能「编辑器」一节里 `loadData/saveData` 那几条。

## 开屏与图标

设置 → 外观 →「开屏与图标」支持上传品牌图标、动态开屏素材、选择默认／呼吸／旋转／静止，以及预览和恢复默认。品牌图标在应用内立即更新；桌面端还会写进系统，退出后仍保留（macOS 的访达／Dock／启动台图标，Windows 的开始菜单、桌面和任务栏快捷方式，Linux 仅运行时）。开屏下次启动生效，安装包图标不变。默认开屏是内置的「树影」（墙上的窗光与枝影，附一句古诗）；它不跟随应用图标，只在用户选了开屏素材时让位。原来的树标动画在「开屏素材 → 内置 → 经典图标」里，经典图标仍跟随应用图标。Web 与 Mobile 共用应用内设置；Android 的桌面图标只跟随内置图标（系统只允许在安装包自带的图标之间切换，且在离开应用后才切换），上传的图片与插件图标只在应用内显示，手机系统启动屏不在此入口内。

插件通过 `ctx.registerAppearance` 提供可选的图片方案。素材嵌入插件包，选中后缓存，启动无需联网或等待插件执行；禁用或移除插件时回退默认。完整示例位于 `tangu-agent/skills/forsion-plugin/samples/forsion-sample-appearance/`。

```js
ctx.registerAppearance?.({ id, label, labelEn, icon, splash })
```

插件任务、只读外部引擎、隔离 Git 工作区、原生定时与 Desktop MCP 接缝见 [任务 SDK](./plugin-tasks.md)。

## 工具结果卡片

带引擎半身的插件,可以给自己注册的工具配一张结果卡片:Tangu 调用这个工具成功之后,对话里画的是插件的卡片,不再是一行通用的工具记录。卡片直接画在 Forsion 界面里,跟着主题、字号走。只有插件自己引擎半身注册的工具才能配卡片,内置工具和别的插件的工具都不行(唯一的例外写死在宿主里:签名的 Forsion Extend 可以给发布网页、查我的网页这两个内置工具画卡);2026-10-28 起可以用 `match` 只接这个工具的一部分调用(比如某个参数取某个值时);工具还在跑、出错、等你批准,或者插件停用、重新加载时,照旧显示通用记录。重新打开旧对话,卡片照样在。

卡片默认在对话里,右上角可以「在 Desk 打开」。插件也可以声明一出来就放进 Agent Desk(白板、看板这类要大地方的),这时对话里留一张占位卡,写着「正在 Desk 中显示」,点「收回到对话」挪回来;Desk 顶上的 ⋯ 里也有「放回对话」。来回挪的时候插件会记住缩放、滚动这类状态。手机上、关掉了 Agent Desk、或者窗口窄到放不下 Desk 时,一律显示在对话里。卡片里可以把一段内容「引用」到输入框上方,和在回答里划线引用一样,发不发由你决定;卡片不能写文件,也不能替你发消息。接口细节见插件开发技能「Tool result cards」一节。

## 过程行的句子

Tangu 把一条回答里的工具调用收成一行「过程行」,展开后每次调用一行。插件工具默认写成「插件名 · 工具名 + 第一个参数」。带引擎半身的插件可以用 `ctx.registerToolLabel?.(…)` 给自己的工具写一句人话,比如「正在 Chatter 中点击「发送」」「已在 Chatter 中输入「明天见」」,还可以带上被操作的应用的图标。认领规则和工具结果卡片一样:只有插件自己引擎半身注册的工具才认得上。

宿主在要画这一行时调用插件的 `describe`,给它这次调用的参数、结果、阶段(进行中 / 做完 / 出错)、当前界面语言,以及同一条回答里更早的本插件调用(最多 40 次,方便从前面的结果里找出应用名、按钮名)。工具还在跑时,收起的过程行滚动显示当前这一步的句子;全部做完后,收起的那行照旧显示汇总,展开的列表里每一行是「做完」那一句。Tangu 摘要栏里「正在做」那一行也用同一句。重新打开旧对话、切换界面语言时会重新生成。`describe` 出错或没给出句子时,这一行照旧显示原来的写法;插件停用、重新加载时一并撤掉。应用图标只在 macOS 桌面版上能显示,别处显示原来的工具图标。这只改给人看的这一行,模型看到的工具说明和结果不变。

宿主会记住算好的句子:只有这次调用本身、阶段、界面语言或更早的调用变了,才会再问一次。所以 `describe` 要写成只看传进来那份数据的函数,不要有副作用。句子或图标还取决于别的东西时(比如后来才知道的应用图标),再给一个 `revision()`,返回一个会跟着变的数字或字符串,宿主发现它变了就重新问。

```js
ctx.registerToolLabel?.({ tool: ['act_ui', 'observe_ui'], describe(call) { return { text, icon: { appBundleId } } } })
```

## 停止这一轮、按 run 跟状态

`ctx.tangu.agentStatus` / `subscribeAgentStatus` 原来按会话取 Agent 状态;2026-11-13 起也可以传 `{ runId }`,取的是此刻正在跑这一轮的那个会话,适合只知道 `runId`、不知道会话的视图(比如 Computer Use 的实时画面)。没有会话在跑这一轮时,状态是「空闲」、`runId` 为空。

`ctx.tangu.stop?.(…)` 停掉一轮,和输入框的停止按钮走同一条路:不传参数停主区当前会话,传会话 id 停那个会话,传 `{ runId }` 停正在跑这一轮的会话。找不到这一轮、会话没在跑时什么也不停,返回 `false`,不会去停别的会话。旧版本和没有对话功能的环境没有这个方法,这时别画停止按钮。接口细节见插件开发技能的「Agent 状态」一节。

```js
const ok = await ctx.tangu?.stop?.({ runId })
```

## 摘要栏卡片

Tangu 聊天右侧的摘要栏(2.13.8-beta.1 之后的桌面版本)是一叠卡片:进度、后台、产物、来源、工作范围和 Agent Desk。插件可以用 `ctx.summary?.registerCard` 加一张卡,和内置卡在同一个栈里;插件卡默认排在 Agent Desk 前面,用户拖动排的顺序由宿主记住。卡片的开合跟着内容走:`count` 变大就自动展开;用户手动展开或收起只管到这一轮对话结束,不会被记住;`defaultCollapsed` 决定没有新内容时收不收。车道放不下时,宿主会先收起最久没有新内容的卡,或者把最后一张的正文缩短,所以别假定正文一定有 240px。`mount` 在每个会话的摘要栏里各调用一次(换会话会卸载重挂),`host.sessionId` 是这份所在的会话;`host.update({ count, hidden })` 改卡头的计数、或者先不显示这张卡。正文最高 240px(放不下时会更矮),超出由宿主滚动。只有桌面 Tangu 有摘要栏,所以用可选链;更早的版本没有 `ctx.summary`。接口细节见插件开发技能「摘要栏插件卡」一节。

```js
ctx.summary?.registerCard({ id, title: { zh, en }, defaultCollapsed, mount(el, host) })
```

## 主页小组件（2026-11-07 起）

主页左右两栏和下排可以放小组件。插件可以出自己的卡：卡长什么样声明在 manifest，数据由插件喂、卡由宿主画，和内置的「收件箱」「最近笔记」同一套样子。用户在主页右键 →「编辑主页」→「添加组件」，插件的卡在「插件」那一组里；插件停用时卡上留一个「已停用」占位，插件卸载了卡就不画（摆放留着，装回来就回来）。

这一版只开**列表型**：一行是左边的时间或勾选框、标题、右边一小段说明，可以分组（比如「明天」），底下可以有一行小字。卡只读，点卡头或点行会打开你声明的 Space；第一版不能在卡上勾选或写回。

manifest 里列出卡的目录，每个目录一份 `manifest.json`（和 Agent 做的小组件同一种目录）：

```json
// manifest.json
"widgets": ["widgets/today"]

// widgets/today/manifest.json
{ "schemaVersion": 1, "id": "today", "title": "今天", "titleEn": "Today", "layout": "list", "icon": "date", "space": "calendar" }
```

- `id` 在插件内唯一（小写字母、数字、连字符）；主页摆放里存成 `plugin:<插件 id>/<id>`。`title` 必填，`titleEn` 给英文界面。
- `icon` 用插件图标词表里的名字（和 `registerView` 的 `icon` 同一张表），没写就用插件的 icon.png。
- `space` 是点卡头 / 点行时打开的 Space id，不写就不跳。最多 8 张；一张写坏了只丢那一张。

数据用 `ctx.widgets.provide` 给：卡挂在主页上时宿主来要，返回行的数组或 `{ rows, footer, empty }`。

```js
ctx.widgets?.provide('today', async (_params, { signal }) => ({
  rows: [{ id: 'e1', time: '10:00', title: '读书会', meta: '还有 1 小时', tone: 'accent', now: true },
         { id: 'e2', time: '10:00', title: '产品周会', group: '明天' }],
  footer: '今天 1 / 3 完成',
  empty: '今天没有日程',
}))
ctx.widgets?.invalidate('today') // 数据变了，请宿主重拿
```

- 一行可以有：`title`（必填）、`time`（左列）、`meta`（右边小字）、`tone`（`accent` / `warn` / `muted`）、`done`（有这个字段就画勾选框，`true` 划线）、`now`（实心点）、`group`（变了就在这行上面画小标题）。最多 50 行，文字按 `ctx.getLocale()` 给好，切语言时宿主会重拿。
- 宿主在卡挂上、你调 `invalidate`、窗口回到前台（离上次 30 秒以上）时来要；同一张同一时刻只有一次，新的一次会把旧的 `signal` 取消。10 秒没回或抛错，卡上写「暂时读不到」，不会当成空列表。
- 卡不在主页上宿主就不来要，所以别在 `provide` 外面一直轮询；要按时间刷新（比如「还有 1 小时」），在你被要过之后自己定时调 `invalidate`，几分钟没被要就停。
- 旧宿主不认 `widgets`，也没有 `ctx.widgets`，一律 `?.`。接口细节见插件开发技能「主页小组件」一节；范本是日历核心插件的「今天」「待办」。

## Intelligent UI 卡片

插件可以把已有的列表源开放成对话里的原生卡片：在 `registerListSource` 上加一个 `intelligent` 声明即可。列表由宿主渲染，数据与跳转仍只有 `items` / `subscribe` / `open` 这一份实现（示例见下方代码）。

- 宿主分配卡片 ID `plugin:<manifestId>:<sourceId>`；`viewId` 只在同一个插件内解析。`description` 写英文（供模型发现用），不超过 400 个字符；旧宿主忽略 `intelligent`。
- 声明了 `search: true` 的列表，卡片可以带一个可选的 `query`（最多 200 个字符）。模型传不进任意属性、HTML、CSS、回调或组件名。紧凑列表显示前六项，其余在完整视图里看。
- 卡片外框由宿主画，插件不用写样式。卡头是插件图标、「插件名 · 列表名」（英文界面用 manifest 的 `nameEn`；其中一个已经包含另一个时只显示长的那个）、一个「实时」点和打开完整视图的按钮；模型给这个块写的标题不显示。每一行显示条目的 `title` 与 `hint`，行首图标用条目自己的 `iconUrl`，取不到时退到 `icon`，再退到通用链接图标，与左栏列表一致 —— 两个都给，行才认得出来。
- Agent 用 `list_intelligent_cards` 发现当前可用的卡片，再在 `intelligent_ui` 里写 `app-card` 块引用。请求里只带元数据：显示卡片不会把记录交给模型，也不会保存生成的计划；分析与写入仍走已授权的领域工具和技能，原生的计划审批流程不变。
- 挂载时订阅，并在库可用后重读一次；数据变了要通知，返回取消订阅的函数。切换库时卡片会重新订阅。禁用插件会把这个来源撤出目录、卸下已有卡片并显示「暂不可用」；未知或已禁用的卡片不会用生成内容顶替，插件抛错只影响那一张卡。卡片是当前库的实时视图（重新打开旧对话时也是），不是历史快照，也不是跨设备的数据副本。

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

### 云端设置页分组

首方内置包的 `registerSettingsView` 可用 `parent` 指向同插件的一级页 ID；宿主只在左栏列出父页，在正文上方用页内标签切换父页与子页。父页本身是默认标签，`tabTitle` 指定它的标签文案；`title` 仍是左栏页名。两种标签均可传函数以跟随语言。`aliases` 是旧页 ID，优先认真实 ID；`keywords` 为设置搜索提供中英别名。父页缺失、跨插件或成环时保留为独立入口，不静默隐藏。挂载与卸载契约不变，切换分段仍调用现有 mount / dispose。旧宿主忽略这些可选元数据，继续显示平铺页面。

```js
registerSettingsView({ category: 'forsion', ... })
```

### 使用指南用到的接缝

2026-10-17 起，宿主给插件多了几条接缝（随 Forsion Extend 的「使用指南」Space 一起加的）：

- `ctx.app.openSpace?(id)`：切到某个 Space，布局建好后 resolve；不认识的 id 返回 `false`。2.13.8 起和 Ribbon 上点它同一个口径：本窗口是锁在某个 Space 上的 Space 窗口时，改为把那个 Space 开到它自己的窗口，本窗口不切走；锁着又开不了新窗口时返回 `false`。
- `ctx.app.openLink?(url)`：在应用内打开 `forsion://` 链接，只导航不执行。插件页、收件箱信和笔记正文里的 `forsion://` 链接，宿主本来就在应用内处理，不经过系统。
- `ctx.app.runCommand?(id)`：执行命令面板里已有的命令。**只对首方内置包生效**，其他插件调用一律返回 `false`。
- `ctx.app.spotlight?`（2026-10-19 起，**只对首方内置包生效**）：在真界面上圈住宿主标好的一处（锚点名：`ribbon-spaces`、`chat-composer`、`note-new`、`note-body`、`note-canvas`、`agent-new`），旁边一张小卡写「第几步 / 做什么」。不压暗、不拦点击，同一时刻只有一处；目标在收着的侧栏里会先展开那一栏。返回的 Promise 给出结果：`ok`（知道了 / Esc）、`mute`（不再提示，插件自己记下别再圈）、`gone`（目标消失）、`missing`（不认识的锚点、等 2 秒仍不在屏幕上，或不是首方包）、`replaced`（被下一次顶掉）；传 `null` 收起，得到 `closed`。旧宿主没有这个方法，用 `?.` 并照老做法。

```js
ctx.app.spotlight?({ anchor, title, body?, step? })
```

- `ctx.achievements.count?(event, { own? })` / `subscribe?(cb)` / `isClaimed?(id)` / `claim?(id)`：读成就计数（缺省读官方事件，只读；读不到别家插件的计数），计数或领取变了就回调，读或领取自己系列里的成就。
- `ctx.inbox`（**只给首方内置包**）：`post({ title, body })` 发一封本机系统消息，`archive(id)`，`registerCard({ sender, mount })` 在你自己的信下面挂一块自绘卡片，并设置发件人显示名。
- 列表图标词表新增 `circle`（没做完）、`circle-check`（做完）、`lock`（锁住），给进度类列表用。`todo` 是块菜单的「待办」图标，自带勾，别拿它表示没做完。

### 网盘用到的接缝

2026-10-18 起（随 Forsion Extend 蓬洲云的网盘功能一起加的）：

- `ctx.app.setSpaceProgress?(spaceId, progress)`：在 Ribbon 上你自己 Space 的图标外画一圈进度环。只认本插件随包带的 Space，别人的或内置的一律返回 `false`。`progress` 取 `0`–`1`，传 `null` 收起。宿主按整百分比画，高频上报不会让 Ribbon 跟着重画。那个 Space 有未读角标时先显示角标；插件停用时宿主替你收掉。Space 被收进 Ribbon 文件夹或「⋯」时看不到这圈环。
- 列表图标词表新增 `hard-drive`，给网盘、存储类的行用。旧宿主没有这个图标，可以用 `ctx.app.setSpaceProgress` 在不在判断新旧，旧的退回 `archive`。

### 蓬洲云的图标

2026-10-23 起：

- `space.json` 的 `icon` 图标库加了 `cloud`，全表 30 个见 forsion-plugin 技能的 `samples/forsion-sample-space/README.md`。旧宿主不认，回落方块。
- 列表图标词表加了 `penzor`：蓬洲云自己的图标（祥云），给蓬洲云的视图用，别的插件别拿它表示别的东西。旧宿主不认，退兜底图标。

### 服务器管理用到的接缝

2026-10-19 起（服务器管理插件给「反馈中心」挂提醒时加的）：

- `ctx.app.setSpaceDot?(spaceId, on)`：在 Ribbon 上你自己 Space 的图标右上角挂一个提示红点，和收件箱未读角标同一种红。`true` 挂、`false` 收。只认本插件随包带的 Space，别人的或内置的一律返回 `false`。同一个 Space 既有红点又有进度环时只画红点；有未读角标时先显示角标。插件停用时宿主替你收掉。挂着红点时，图标的读屏名会带上「有新提醒」。
- 列表行里的未读提示照旧用 `ListItem.unread`（共用的未读圆点，颜色跟着主题的指示色走，不是红色）。要从别的 Space 也看得到，就配上 `setSpaceDot`。
- `ctx.app.sync?`（2026-10-20 起，**只对首方内置包生效**，蓬洲云的「同步」页用）：读写这台电脑的三项云同步。`get()` 给一份快照（智库、Agents 与记忆、插件数据各自开没开，第一次同步的进度，第二台电脑上云端已有一份时待定的合并问题），`subscribe(fn)` 在变化时通知，`refresh()` 重读，`set(kind, on)` 开关一项（`notes` / `agents` / `plugins`），`resolveNotes('merge' | 'cloud' | 'skip')` 回答合并问题，`runNow()` 立刻同步一次。开关和同步引擎都在宿主，插件只画界面。普通插件、手机和网页上整个成员缺席。

### 弹窗排队

2026-10-19 起（Extend 的公告和宿主的协议更新提示、What's new 叠在一起时加的）：

- `ctx.app.queuePopup?()`：你的插件自己弹出来的弹窗（启动时的公告、提醒之类，不是用户点了才打开的面板）要先排队。应用里同一时间只露一个弹窗：协议更新、What's new 在前，插件的排在后面，同级按先来后到；全屏引导开着时谁都不出。
- 返回 `{ ready, done }`。`await ready` 之后再把弹窗挂出来，关掉时调 `done()` 让给下一个。决定不弹了（换了账号、数据过期）也调 `done()`，算撤销，这时 `ready` 永远不会 resolve。
- 不调 `done()` 会一直占着队列，后面的弹窗都出不来；插件停用时宿主替你收掉。旧宿主没有这个方法：直接弹，和以前一样。

```js
const turn = ctx.app.queuePopup?.()
if (turn) await turn.ready
showMyDialog({ onClose: () => turn?.done() })
```

### 上手提示（2026-11-02 起）

用户用到你插件的某个功能时，宿主替你提示一次怎么用；用过了就不再出。提示声明在 manifest，出不出由宿主定，你不用自己记「看过没有」。

```json
"guide": {
  "tips": [
    {
      "id": "drag-to-calendar",
      "at": "todo-row",
      "style": "ring",
      "platform": "desktop",
      "when": { "visible": ["calendar-grid"] },
      "done": ["todo.schedule"],
      "title": "拖到日历上排时间",
      "text": "按住这条待办拖进日历的时间格，就排成那半小时。",
      "en": { "title": "Drag onto the calendar to schedule", "text": "Drop it on a time slot to book half an hour." }
    }
  ]
}
```

- `at`：你自己 View 里某个元素的 `data-guide-anchor="<名字>"`。宿主只在你的 View 里找，名字不会和别的插件撞。这个元素在屏幕上，提示才可能出。
- `style`：`line` 在锚点上沿贴一行（适合输入框）；`ring` 圈住锚点、旁边一张小卡，要写 `title`。
- `when` 只取一种：`{ "open": "<View id>", "times": 1 }` 这个 View 打开过几次；`{ "count": "<事件>", "atLeast": 3 }` 某个计数到了；`{ "visible": ["<锚点>", …] }` 这几个锚点同时在屏幕上。不写 `when` = 只在你调 `ctx.guide.show(id)` 时出。
- `done`：任一计数 ≥ 1 就算「会了」，这条永远不再出。计数就是 `ctx.achievements.track('<事件>')`：用户真做了那件事时报一次。裸名是你自己 track 的；`app:` 开头读宿主的官方事件（如 `app:note.wikilink`）。
- `platform`：`desktop` / `mobile`，不写 = 都出。拖动、悬停、快捷键这类，手机上没有对应手势的写 `desktop`。
- 文案：中文 `title` / `text` + `en` 镜像。**英文界面缺 `en` 的那条不出**，不回落中文。标题尽量 16 个字以内，正文 40 个字以内。
- id 用小写字母、数字和 `-`，最多 12 条。坏掉的那条宿主丢掉，其余照常。

宿主管的节奏：全应用同一时刻只有一处提示（和使用指南的圈注共用）；一天最多 3 条；锚点出现 2 秒后、用户停手 1.5 秒后才出；一个 View 打开一次最多出一条；有弹窗在排或开着、首启向导开着时等着。用户点「知道了」/ × / Esc 算看过，「不再提示」关掉你这个插件的全部提示，设置 → 通知 →「上手提示」可以整体关掉或重置。看过和关掉只记在这台设备上。

**新版本加了功能**：给它加一条**新 id** 的提示。记账按「插件 id + 提示 id」算，老用户升级后用到时会看到这条，已经看过的旧提示不会再出。别改旧提示的 id（等于让所有人重看一遍）。

运行时：

```js
inputEl.dataset.guideAnchor = 'todo-input'   // 标锚点
ctx.achievements.track('todo.tag')            // 用户真做了那件事
ctx.guide?.show('tags')                        // 条件写不进 manifest 时自己叫(仍走节奏和记账)
ctx.guide?.state('tags')                       // 'waiting' | 'seen' | 'learned' | 'muted' | 'off'
```

**空着的时候给例句**：`ctx.ui.mountEmptyState` 多了 `examples`（最多 3 条），点一下通常是把这句填进你的输入框，让用户看着它被认出来、自己按发送，别直接替用户建东西：

```js
ctx.ui.mountEmptyState(el, {
  icon: 'list-todo', title: '还没有待办', line: '在下面写一句就行。',
  examples: [{ label: '明天下午3点 交周报 #工作', note: '日期、标签直接打', run: () => box.insertText('明天下午3点 交周报 #工作') }],
})
```

开发时想重看：命令面板「重置上手提示」，或设置 → 通知 →「上手提示」→ 重置；再配合 `ctx.guide.show(id)` 就能当场看到某一条。锚点 2 秒找不到、条件一直不成立时，提示就是不出，先在开发者工具里确认元素带着 `data-guide-anchor`、在你自己的 View 里。

和前置条件闸（manifest `onboarding.requires`）的分工：闸 = 不做插件就用不了；提示 = 能用，告诉用户一个窍门。旧宿主不认 `guide`，什么都不出；`ctx.guide` 一律 `?.`。

## 按需展开原生主区伴随视图

`registerView` 可声明 `mainCompanions`。支持 `amadeus-editor` / `chat-panel`，key 以插件 id 加 `-` 开头，最多三项。视图挂载上下文的 `view.setCompanionsVisible?.(true)` 按需展开，`false` 将这些原生视图收进本视图的标签组，保留正文、聊天草稿和分栏尺寸；窄窗与手机使用原生标签。不会关闭或改写其它视图，不重建整个 Space。旧宿主缺少此方法，所以重要的阅读布局仍可保留在 Space 配方中。

```js
mainCompanions: [{ type: 'amadeus-editor', key: 'my-plugin-document', split: 'right' }]
```

本机宿主还可提供 `ctx.app.writeFileScoped`：在主进程文件锁内校验活动智库，切库后拒绝旧任务的写入；`create:true` 已有文件时返回 false、不会覆盖。普通写入返回 true；方法缺席时插件需要在每次异步边界核对智库，不得宣称获得了主进程范围保护。

```js
ctx.app.writeFileScoped?.(path, text, expectedRoot, {create:true})
```

`ctx.app.migrateWorkFolder?` 是本机一次升级迁移口，迁进插件的默认 `Plugins/<插件 ID>` 目录。插件负责 schema 和路径改写，宿主负责校验、独占复制、索引比对后提交及中断恢复；原目录保留作备份。请求里给升级 `id`、事先取得的 `expectedRoot`、作为 `source` 的旧库根目录或 `Plugins/<旧名称>`、默认的 `target`，可选的 `plan`：索引改写前后的确切文本（`before`/`after`）、源文件的文本改写（`path`、`before`、`after`）和引用到的非空 `requiredFiles`。不带 plan 时只查询 / 对账每个库的迁移日志。插件校验自己的 schema，两份都有数据时拒绝；宿主校验快照、拒绝符号链接和路径穿越、不覆盖地复制、核对哈希，再在共享文本锁下发布索引。已完成的日志不会把删掉的条目再导回来。手动设置目录时拒绝自动迁移；不支持的宿主（网页、手机、云端）缺席此方法，插件须保留明确的恢复入口。

默认目录使用稳定的英文插件 ID，不随显示名称或语言变化。外部 manifest 的 ID 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，新 ID 用英文词，已发布 ID 保持稳定。商店安装以不变的 `market-<UUID>` 为生效 ID，可能不同于 manifest ID 或历史安装目录别名；请调用 `workFolder()`，不要自行拼身份目录。未接入迁移的插件继续读取已有的显示名目录；接入者先检测两项 API，再通过 `workFolder({ preferId: true })` 取得新默认目录，校验自身数据后等待迁移完成。用户手动指定的目录优先。

无 plan 的状态查询可核验上一版显示名目录的迁移日志；旧目标的写入计划仍被拒绝，手动偏好和智库 / 撤销检查照样生效。迁移前按原智库实际解析裸媒体链接，保留用户放在笔记旁边的附件的位置，而不是假定都在 `assets/` 下。

### 库外 PDF 文件视图（2026-10-29，功能分支）

文件类型写 `external: true` 并保留 `override: true`，即可在具备此接口的桌面宿主上接管系统「用 Forsion 打开」的库外 PDF；仍遵循「默认打开方式」。冷启动等插件首次装载后再分流。旧宿主和未声明 `external` 的插件继续使用内置预览。

`mount(el, file)` 的 `file.io` 仅在库外 PDF 上提供：`readBytes(path)` 读取当前 PDF 或同目录的 `.<文件名>.annot.json`，`writeBytes(path, bytes)` 只写该批注文件或 `.broken-<时间戳>` 恢复副本；源 PDF 只读。`saveCopy(name, bytes)` 打开原生另存为，返回保存名称，取消返回 `null`，拒绝覆盖原 PDF。`ctx.app` 的文件接口仍只接受库内路径；不要把绝对路径交给它们。原目录没有写权限时显示保存错误，不把失败当成已保存。

文件类型的清理函数可以返回 `Promise<void>`：普通关标签时宿主等最后一次保存完成再吊销 `file.io`；插件停用时仍立即吊销。多个标签读同一 PDF 时，不要永久保留已关闭标签的句柄。库外文件不导入库，不通过笔记写盘管线。

### 个人日历（Desktop 2.13.6+）

同时声明 `databases` 与 `calendar` 的插件，在本机引擎提供个人日历时，会收到 `human://CALENDAR.db`。日历成员把它排第一并隐藏旧智库镜像。把该不透明引用原样传给 `ctx.databases`、`ctx.ui.mountRecord` 和用于表结构/名称的 `ctx.app.mutateDb`，不要交给文件系统读写 API。成员与日期/完成列映射由宿主管理，`setMember` / `removeMember` 返回 false；隐藏用 `setHidden`。只有 `databases` 能力的插件不可访问；无此来源的远程或移动宿主不列出。写入复用宿主 CAS 与冲突重放。

订阅日历时快照里的 `myCalendar` 说明个人日历读得怎样（2026-11-10 起的宿主才有；老宿主没有这个字段，按你原来的办法判断）：`ok` 是读到了（文件还没建也算，第一次写就会建）；`absent` 是宿主确认这里没有它（老引擎、老服务端，或在设备页上看别人的设备），按没有个人日历的老办法处理；`unknown` 是这次没读到（引擎没起、网络错、服务端报错、文件坏了），`loading` 是还在读。后两种时别因为成员里没有它就另建一张表顶替：读失败不等于没有，先提示稍后再试，用户输入的内容留着，宿主读到后会推一份新快照。不认识的值按 `unknown` 处理。

### 共享账号

桌面(装载了 Forsion Extend 时)、Unit 网页账号宿主与移动端都提供 `ctx.account`,同一份插件代码三端能跑。先判断能力存在，再使用 `status()`、`login()`、`logout()`、`request(path, init)` 与 `subscribe(listener)`。`request` 只访问账号 API，不接受其他源；宿主代发凭据并保留 FormData/Blob 文件上传。账号切换会取消旧请求并使旧响应体读取失败；插件仍须取消自己的延迟任务并清空旧账号界面。可选的 `saveDownload(blob, name)` 返回 `{ ok, error? }`：Android 保存到系统下载，浏览器保存为下载文件。不要保存、导入或传递账号令牌。

桌面的 `request` 走主进程代发,有几条限制:请求体只收 JSON 字符串(FormData 和 Blob 直接报错,大文件用预签名地址),响应体只有 JSON,自定义请求头不带过去,单次最长 120 秒,DELETE 不带请求体;`abort` 立刻拒绝,但已经发出的请求会跑完,结果丢弃。桌面的 `status()` 没有 `userId`。路径一律相对 `/api`。

### 账号权益

插件要用户有某项权益才能用时,在 manifest 写 `"requires": { "entitlement": "<name>" }`,数组写法照旧。插件照常激活,自己画引导页:`ctx.account.entitlements()` 回 `{ granted }`,`true` 是有,`false` 是服务端明确说没有,`null` 是不知道(离线、没登录、老服务端),别把 `null` 当成没有。没声明时回 `true`。真正的闸在服务端。`requires.plugins` 是 Unit 的包依赖,桌面和手机的前置继续写 `requiresPlugins`。商店标签写 `entitlement:<name>`,卡片上画成一枚标记,不挡安装。

### Space 的 Ribbon 落点和手机布局

`space.json` 写 `"ribbon": { "after": "<spaceId>" }`,图标第一次出现时排在那个 Space 后面,用户已经摆过的位置不动。写 `"mobile": { "listFirst": true }`,手机上先落左栏列表,点一项进主区;只有左栏确实是这种列表才写,缺省主区是第一层、左栏是抽屉。 主视图要接管原生顶栏时用 `ctx.ui.claimHeader?.({ title, back, onBack, toList: true })`:返回时壳把列表层滑出来(边缘手势跟手,中途放弃什么都不发生),列表露出来后才调 `onBack`;不带 `toList` 时系统返回和顶栏箭头都只跑 `onBack`,适合浮层。

## View 的布局协同

LCL 统一保留并排的 View。空间不足时滚动工作区内容，Ribbon、顶栏与状态栏保持固定。侧栏开合和分屏使用同一条尺寸过渡，不对整页淡入淡出，也不缩放文字。收起侧栏保留原挂载；显式关闭 View、停用插件或切换整份布局才清理它。

`ctx.registerView({ layout: { minWidth: 360, minHeight: 200 }, ... })` 可声明逻辑 CSS 像素下的最小尺寸。未声明也自动遵守引擎规则；主区默认 320 × 180、左栏 220 × 180、右栏 240 × 180、底栏 240 × 140。同组多个标签取最大的最小尺寸，切标签不会来回挤压相邻 View。

`mount(el, view)` 的 `view.getLayout?.()` 返回 `{ width, height, visible, compact, phase }`；`view.onLayout?.(callback)` 立即回送快照，并在尺寸、可见性或阶段变化时通知，返回取消订阅函数。`phase` 为 `transition` 或 `settled`，`compact` 表示内容宽度不足 480px。PDF、画布、终端等可在过渡中只更新轻量外框，等 `settled && visible` 再做昂贵的适配；不要因窗口变窄而重新挂载内容或重置缩放。宿主在 View 卸载时自动取消残留订阅。旧宿主没有这些方法，仍可用 `ResizeObserver`。

`preferredWidth` / `preferredHeight` 可选：新建分屏时作为初始分配权重，侧栏尚未被用户调整时作为展开尺寸；用户保存的比例和侧栏尺寸优先。


### 文件视图的临时面板

`registerFileType` 的 `mount(el, file)` 可探测 `file.extendView`，按 `view.extendView` 的同一契约打开临时面板。例如 `file.extendView?.open({ id: "ask", title: "Tangu", side: "right", mount(el) { /* ctx.tangu.mountChat(el) */ } })`。主区及独立文件窗口保留原文件，侧栏内的文件视图使用带返回按钮的覆盖面板。同一个 id 再次打开保留内容；关闭文件、导航或停用插件会关闭面板并吊销旧控制器。旧宿主缺少该字段时，不要用主区跳转代替上下文提问。


## Agent 读取设置与设置页锚点

使用 [`ctx.registerAgentSettings`](plugin-agent-settings.md) 显式开放当前生效值。UI/引擎同契约，密钥只给配置状态。

云端设置页可接收 `mount(el, { anchor })` 的可选第二参数；`forsion/fx:<pluginId>:<pageId>#<anchor>` 深链传入锚点。页面加载完成后自行滚动/聚焦对应区域，普通打开不抢焦点。旧 mount(el) 不受影响。

### 笔记阅读渲染器

通过 `ctx.registerNoteRenderer` 热替换只读阅读表面，宿主继续持有文档与保存流程。完整契约、失败回退与生命周期见[笔记阅读渲染器](./note-renderers.md)。

### 笔记里公式源码的样式钩子（2026-11-15 起）

光标所在的那个公式（行内 `$…$` 与块公式 `$$…$$`，单行多行都算）露出源码时，宿主给整段源码（含 `$`）加上 `math-source` 类，
观感照 Obsidian：等宽、斜体、行内代码字号。源码再按种类加 token 类：`math-source-dollar`（`$` / `$$`）、`math-source-command`
（`\frac` 这类命令和 `\{` 这类转义符号）、`math-source-script`（`_ ^ &`）、`math-source-letter`、`math-source-number`、
`math-source-bracket`（`( ) [ ] { }`）；空格、运算符和 `%` 注释保持正文色。光标不在公式里、渲染结果和预览都不带这些类。

- **类是并在同一个 span 上的**，不是外层容器：选择器写 `.math-source.math-source-bracket`，别写 `.math-source .math-source-bracket`。
- **宿主的 token 颜色权重为 0**（选择器包在 `:where()` 里），插件给括号、`$`、占位加的类用一条普通类选择器就能盖过，不用拼权重、
  也不用管样式表先后。颜色取自宿主的 `--math-src-*` 变量，跟着明暗走；插件自己的颜色也请按明暗各给一份。
- 选区盖住的字不带 token 类（原生选区色优先），`math-source` 照样在，字体不会跳。
- `math-source-delimiter` 是旧总类（`$`、括号、`_ ^`），保留兼容，宿主不再用它上色。
- **选区落在公式里**（两头都在 `$` 之间，比如 Tab 选中一个占位）：预览照常（行内是行上方的浮层，▶ 标在选区末端；块公式在源码下方），
  格式浮条不出，挂在浮条「⋯ → 插件」里的选区动作也就不在这里出现。选区跨出公式、或连 `$` 选中整个公式，照旧出浮条、不出预览。

### 官方云端收件箱通道

首方锁定的 `forsion-extend` 可通过 `ctx.app.provideInboxChannel?.(channel)` 接入账号收件箱。
通道提供 `list(filter)`、`unreadCount()`、`patch(id, { read, archived })`、`readAll()`、`remove(id)` 与 `claim(id, client)`；
可选 `importLegacy(messages)` 仅接入有属主的桌面历史已读／归档状态，云端已有状态优先。
云端消息 ID 使用 `cloud:` 前缀；列表包含既有 `InboxMessage` 字段。未读响应可带 `revision` 和 `latestCreatedAt`，
即使未读数没变，领取、归档等变更也能触发刷新。账号凭据留在 Extend 的账号适配层。
宿主将该渠道与本地引擎的 Agent／系统消息合并，隐藏重复的旧官方广播副本。
传入 `null` 撤回自己的通道；停用／重载时宿主同样撤回，切换账号时重新提供通道。旧宿主不提供此可选方法。

旧桌面收件箱没有逐条云账号归属；升级接入先将本设备旧状态绑定到当前已验证账号，之后切账号不再重复接入。旧手机缓存不自动接入。


### 划线条分离菜单与形状边角（2026-11-12）

`mountSelectionBar` 的工具可选 `menu: { title, open(sel, anchor) }`。主体仍执行 `run(sel)`；独立箭头执行 `menu.open` 并传入真实按钮元素，可直接用于 `ctx.ui.popover(anchor, ...)`，不要搜索宿主DOM取锚点。主体上按右箭头也打开菜单，Enter/Space可操作两颗按钮；菜单先消费Esc，之后Esc才关闭划线条。`title`由插件按当前语言提供。旧宿主忽略menu，因此保留可执行的主体动作或提供自己的菜单入口。菜单消费选区时须在打开时保存该选区数据；停用/卸载时通过dispose清理菜单，不对旧选区回写。

```js
{ id: 'underline', title: t('underline'), icon: 'underline',
  run: (sel) => underline(sel),
  menu: { title: t('colors'), open: (sel, anchor) => openColors(sel, anchor) } }
```

`mountBoard` / `handle.update` 可选 `roundness: 'sharp' | 'round'`，映射引擎下一笔的 `currentItemRoundness`。省略时保留原默认；此设置不改写scene中已有元素，插件要修改已有矩形须保留完整元素信息并显式更新scene。不要在加载旧scene时统一改圆角。
