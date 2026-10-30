---
title: 插件开发
description: 给 Forsion 写桌面插件与引擎插件：布局、列表源、审批、宿主零件、卡片与各类扩展点。
---
# 插件开发

面向插件作者。装插件、捆绑包和安全模型这些用户侧说明见[插件](./plugins.md)。

## 起步

插件用 JavaScript / TypeScript 编写,官方提供类型定义与模板。内置的「Forsion 扩展开发」技能可以让 Agent 照官方模板直接脚手架出插件、主题、Space 或智能体的骨架,见[技能](../agents/skills.md)。

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

把行按「是谁的」归组(发信人、账号、来源)时,给最上面一级的文件夹再写 `folderStyle: 'group'`:它会画成 Tangu 左栏里 Agent / 项目那种一级行,前面是头像(`iconUrl`)、方块里的图标(`icon`)或标题的首字,`hint` 是行尾的小胶囊(适合放未读数)。组里的行不再画自己的图标,只留未读的圆点,一组先列 5 条,其余在「查看更多」后面。这种组的开合只记到应用重启:写了 `defaultOpen: true` 的组自己开着(比如里面有未读),它由假变真时宿主会重新打开这一组;不写就是收着。组的先后由你的数组顺序决定。搜索时不画层级,所以带 `query` 时请返回平铺的行。手机上,只有这一层组头的列表仍然是整屏列表,组里的行照样可以左滑。用 `ctx.listCapabilities?.includes('group')` 判断宿主认不认;不认的宿主会把它画成普通文件夹。

桌面上,指针停在列表的一行上时,`itemMenu()` 里带 `icon` 的动作会在行尾排成一排图标钮,旁边仍是列出全部动作的「更多」菜单。它们和手机上左滑出来的是同一批、同一个顺序,所以把最常用的动作放在前面并配上图标;没有 `icon` 的动作只出现在菜单里。旧版宿主只有「更多」菜单。

列表行可以有第二行:给行写 `subtitle`,宿主在标题下面画一行淡字(只占一行,超出省略),适合放「谁发的 · 第一句话」或状态;不写就是原来的一行。只收纯文本,文件夹行不显示;旧版宿主会忽略这个字段。右边的 `hint` 和行首图标都对齐第一行。图标词表另外加了三枚表示来源的图标:`cloud`、`workflow`、`agent`。

手机上(安卓原生外壳),平铺的列表源(没有文件夹行、没有 `parent`)画成手机的整屏列表,和会话、笔记列表同一套:`groups()` 是一排分类胶囊;行是图标块 + 标题和 `hint` 一行 + `subtitle` 一行;搜索在顶上的搜索钮和下拉里;`itemMenu()` 的动作在左滑后面,是只有图标的圆钮;`primary` 的动作是右下角的主按钮,其余 `actions` 在它的长按菜单里。因此动作可以带 `icon`(图标词表里的名字):没有 `icon` 的行动作不进左滑(仍在长按菜单里),没有 `icon` 的主动作画成加号;成对的动作各给各的图标。词表为此加了 `mail`、`mail-open`、`archive`、`unarchive`、`trash`、`refresh`。带层级的源在手机上仍是树(只有一层组头的除外,见上)。旧版宿主忽略 `icon`。

插件自带的 Space 没出现在功能条上时,先看设置里那张插件卡片:挂着「Space 未显示」就点开详情,里面写着是哪个 Space、缺什么 —— 它引用的视图没有注册,或者需要更新的 Forsion 版本。最常见的一种是插件加载没有报错、却一个视图也没注册:`main.js` 里某个函数没收口,把后面的 `ctx.registerView` 包了进去。开发副本在 Coding Studio 的 Sandbox 面板里能看到这次加载注册了哪些视图。也可以直接让 Agent 查:「Forsion 扩展开发」技能带一份插件体检脚本(`tools/check-plugin.mjs`),照宿主的方式跑一遍 `main.js`、对账每个 Space 要的视图,并指出没跑到的注册代码在第几行到第几行。体检会执行插件代码,只对你信得过的插件用。

在沙箱里试插件(2026-10-23 起,桌面):让 Agent 写桌面插件时,它会先在**插件沙箱**里跑一遍,不直接装进你的 Forsion。沙箱是你电脑上另开的一份独立 Forsion:自己的空智库、未登录、不起 Tangu 引擎,只装这一个插件(开发副本,改完保存自动重载)。Agent 在里面看截图、读这个插件自己的控制台、跑它注册的命令;你也可以点对话里沙箱卡片上的「打开沙箱窗口」亲手试,遇到问题点窗口顶上的「报告问题」,写的话会回到发起它的那个对话的输入框。满意了点「安装到我的 Forsion」,会先问你一次,再把插件拷进你的插件文件夹(不带 `node_modules`)。沙箱里没有引擎,所以捆绑包里的引擎插件、智能体和技能要装好以后再试。同一时刻只有一个沙箱;沙箱窗口不在前台、15 分钟没人用,它会自己停。Coding Studio 的 Sandbox 面板也分这两档:「隔离沙箱」(缺省)和「我的 Forsion」——后者是原来那种把开发副本直接加载进你正在用的 Forsion,不是隔离环境。

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
- 图标只有一张词表:`space.json` 的 `icon`、列表、菜单、设置、视图标签、控件、空态都认同一份名字,自己的按钮用 `ctx.ui.icon(名字, { size })` 拿一枚 `<svg>`,写错名字会在控制台提示一次(带最接近的名字)。
- 列表源加 `empty: { icon, title, line, action }`:在你自己的 Space 里侧栏不再写「暂无内容」,手机整屏列表直接画这份空态;主区用 `ctx.ui.mountEmptyState(el, …)` 画同一个。
- 讲网页的卡片(发布出去的链接、本地文件、在跑的服务)用 `ctx.ui.mountWebCard`(2026-10-28 起):缩略图由宿主截,和宿主自己给 HTML、本地服务画的卡是同一张。

```js
ctx.ui.mountWebCard(el, { name, status, address, note, thumbnail, actions, menu })
```

- 视图头行用 `ctx.ui.setViewHead(el, { title })`(左标题、右按钮,不必先有视图模式)。
- 样式表用 `ctx.addStyle(css)`,停用、重载时宿主会摘掉。
- 文案用 `ctx.i18n.define({ zh, en })` 拿到 `t(key, vars)`;列表源标题、动作名、视图标题、菜单、对话框、控件、空态都收 `() => t('key')` 或 `{ zh, en }`,用户切语言时宿主画的部分自己重算(字符串照旧在注册那一刻定格)。
- 用 React / Vue 写的插件拿不到宿主的组件,用 `ctx.ui.mount(name, el, props)` 在 ref 上挂宿主零件(`menu`、`popover`、`dialog`、`segmented`、`select`、`emptyState`、`webCard`、`icon`,props 有类型),别把宿主的菜单、浮层、对话框、图标、i18n 抄一份进包。

这些接口在旧宿主上都不存在,用可选链判断。

## 商店身份与安装目录

商店给每个条目一个不会变的 ID,新上架的条目装进 `plugins/market-<ID>/`,和显示名无关,所以显示名可以重复。装在这种目录里的插件以目录名为运行身份:包里的引擎插件照常按目录名挂路由,单独上架的引擎插件 id 变成 `market-<ID>`、数据目录在 `plugin-data/market-<ID>/`,它的工具名会被宿主改写成带哈希的唯一名字(两份同 id 的插件互不顶替)。别的插件在 `requiresPlugins` 里写你 manifest 的 `id` 照样认得到,前提是只装着一份。这种条目要 2.13.4 之后的桌面版本才装得了,旧版本会提示先升级 Forsion。更早上架的条目保留原来由显示名推出的目录名;其中带引擎插件的包在桌面 2.13.3 及更早的版本上,目录名和 manifest `id` 不一样时页面调不到包里的引擎插件(每次调用都是 404,不报错)。

## 上架与更新

投稿时可以写标签(最多 8 个)、长描述、支持的平台(`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`)和 Forsion 版本范围:最低版本含本身,最高版本不含。包里 manifest 的 `minAppVersion`、`maxAppVersion`、`platforms` 优先于投稿表单。商店首页按这些筛选,安装前桌面和手机会再核一遍包里的 manifest,版本或平台不符的不下载、不写盘。每个条目有公开的评论区,新评论发到你(投稿账号)的收件箱,回复也通知被回复的人;你可以在评论区关掉全部或某一个插件的评论消息,评论照样公开。

发新版或改商店信息时,在「投稿」里选中你的条目:ZIP 拖进新包,GitHub / npm 先在原渠道发新版本再点「检查新版本」。版本号只从包里或上游读(技能写在 SKILL.md 的 `version` 或 `metadata.version`),要比商店当前的高。提交前会先检查一遍,列出读到的类型、版本、图标和 README,你确认后才提交。简介、标签、长描述和版本要求可以单独编辑,不用传包。已上架的条目改了都要过审,通过前商店照旧,审核结果发到你的收件箱。

## 敏感设置项

引擎插件的文本设置可以声明 `secret: true`，宿主会显示密码框（`textarea` 也会转为单行密码框）。这只遮挡界面；值仍使用现有本机插件设置存储和已认证的设置接口，不新增加密。旧宿主会忽略这个可选字段。

## Mini Panel 扩展

插件内的 Space 可以声明专用 Mini 视图，只提供当前能力的快捷操作；宿主的“在主面板显示”会携带当前实体参数。未适配的 Space 不出现在 Mini 中，随插件禁用的适配会自动撤下。见 [Mini Panel 开发](./mini-panel-development.md)。

插件也可以不创建完整 Space，直接用 `ctx.openMiniPanel?.(viewId, options)` 打开已注册的紧凑视图；`mainViewId` 指定“在主面板显示”的去向。需要宽屏独立工具页时用 `ctx.openFloatingPanel?.(viewId, options)`。宿主自动添加插件命名空间并负责窗口生命周期。见 [Floating Panel 开发](./floating-panel-development.md)。

View 内需要输入框和模型选择时，使用 `ctx.ui.mountChatBox`；它复用宿主组件，并由插件显式处理提交。见 [可复用 UI 组件](./ui-components.md)。

设置类页面（账号、额度与积分、诊断、偏好）用 `ctx.ui.mountSettingsPage(el, { groups })` 交一份整页描述：每组有图标、标题、说明、右上角按钮和若干项（开关、数值、按钮、输入框、分段、下拉、「选了就执行」、步进器、代码 + 复制、额度条、空 / 加载 / 出错、自定义块），插件只给文字、值和回调，宿主用自己的设置零件画并按端排版——手机上开关、数值、单个按钮留在右边，输入框、步进器、两个以上的按钮换到下一行，「选了就执行」换成一枚按钮 + 半屏。清单外的内容放进 `custom` 块，块里用 `ctx.ui.mountSettingsItem` 挂单件。别再抄宿主的设置 CSS；2026-10-17 之前的宿主没有这两个接口，先探测，保留自己画的那套。见 [可复用界面组件](./ui-components.md)。

要在自己的内容上手写或圈画时（PDF 页、图片），使用 `ctx.ui.mountBoard` 把宿主白板引擎挂成一块透明层，不在手写时用 `ctx.ui.boardToSvg` 出静态图；视口与保存归插件。见 [可复用 UI 组件](./ui-components.md)。

以 `override: true` 接管了 `.pdf` 的文件类型，会接住所有「打开这份 PDF」的入口：文件树、最近使用、笔记里的 `[[x.pdf]]`，以及带页码或引语的 `[[x.pdf#page=3]]` 和聊天引用。带落点的那几种经 `mount(el, file)` 的 `file.onGoto?.(cb)` 把 `{ page, quote? }` 交给插件（2.13.2 之后的桌面版本；更早的版本把笔记链接和带落点的跳转交给内置阅读器）。回调可能在文件还没加载完、或标签刚从后台切回来时到达，先记下、能滚动了再跳。`![[x.pdf]]` 嵌入和「用内置阅读器打开」不在接管范围内。

标签被换到后台时，宿主把视图的 DOM 从文档里摘下来（不卸载，状态都在），换回来原样挂回；摘下期间量到的尺寸和滚动位置都是 0。2.13.3 之后的桌面版本在换回来时把视图里每个滚动容器的位置写回去，插件不用自己记（更早的版本一律回到顶上）。同一批版本里，⌘ / Ctrl + 点击文件树、双链、聊天引用会在新标签页打开文件类型视图，视图在主区显示时侧栏对话会自动引用这份文件。

View 内需要一个完整的常驻对话时（例如创作类 Space 的右栏），使用 `ctx.tangu.mountChat`：宿主把原生对话固定在该插件、该文件夹的一条会话上，Agent 生成的文件直接落进这个文件夹。见 [可复用 UI 组件](./ui-components.md)。

要一个「在这里打字、按发送就去 Tangu 开新对话」的输入区时（主页就是这么用的），使用 `ctx.tangu.mountComposer`：宿主把主页那一整块新对话输入区挂进来（附件、模式、项目、运行位置、语音、通话都在），用户按发送后由宿主建会话、切到 Tangu 并发出，插件只能读到草稿（`draft()`），改不了要发的内容。

不需要对话、只要模型回一段文字时用 `ctx.tangu.complete`（一次性调用：没有工具、不进任何会话，用聊天当前的模型）。翻译用 `ctx.tangu.translate({ text, language })`：同一条通道，但模型取用户在「设置 → 模型 → 翻译」里选的那个；没选时账号里有机器翻译模型就用它，都没有才跟聊天模型（2.13.3 及更早的桌面版本：没选就跟聊天模型）。逐句翻译这类量大的活应当走它；它只返回译文。旧版本没有 `translate`，先探测再退回 `complete`。

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

选中文字后浮出的那一条（划线条）对插件开放两半。一是加动作：`ctx.registerSelectionAction` 的动作列在条上的「⋯ → 插件」里，`run(cx)` 返回的 markdown 进宿主的结果卡（笔记里用户点「替换 / 插入下方」才写，别处只读）。不写 `scope` 只在笔记里出现；`scope: 'all'` 出现在所有有这一条的视图（笔记、聊天、接入了的插件视图），`'own'` 只在自己的视图，数组点名视图；`when({ view, editable, length })` 按视图和字数过滤，`output: 'none'` 表示结果由插件自己处理。二是让自己的视图用上这一条：`ctx.ui?.mountSelectionBar`，宿主给「问 Tangu」「翻译」「⋯」，插件声明自己的工具（图标钮或颜色点）；不接就不出。这两半在 2.13.3 之后的桌面版本里才有：更早的版本只在笔记里列动作（「AI ▾ → 插件」），没有 `mountSelectionBar`，先探测、保留自己的菜单。见 [可复用界面组件](./ui-components.md)。

```js
ctx.registerSelectionAction({ id, title, run })
ctx.ui?.mountSelectionBar?.(root, { tools, source, ask, watch })
```

## 读写多维表与笔记任务

日历、待办、习惯这类插件需要读写你库里的多维表，以及笔记里带 `@` 时间的任务（`- [ ] 交周报 @2026-10-20`）。插件必须在说明文件里声明 `databases`（多维表）或 `noteTasks`（笔记任务）才拿得到；没声明的插件看不到这些数据。拿到之后，插件改一格、勾一项，和你在表格里、笔记里亲手改是同一条路：打开着的表格立即跟着变，笔记视图的属性写进那篇笔记。插件删经典表的一行可以撤销；笔记视图的一行是一篇笔记，插件只能把它移进回收站。插件声明了哪些，插件详情页会列成一行「这个插件可以：……」给你看（读取前台窗口的 `activeWindow` 也列在这一行）。接口细节见插件开发技能「全库多维表与笔记任务」一节。

### 日历叠加源与日历设置

日历插件还需要宿主日历叠上去的那几类只读来源：Agent 日程、你加的 .ics 订阅、Local↔Cloud 另一侧库里的表，以及你的日历设置（哪些表在日历里、各用哪一列当日期和完成勾选、颜色、藏起来的来源、新建事件默认落进哪张表）。插件必须声明 `calendar` 才拿得到；没声明的插件只能用原来的「把自己的表登记进日历」。拿到之后，插件改颜色、加减日历里的表，和你在日历左栏「日历」列表里改是同一处，只对当前库生效；叠加源只能看不能改。插件订阅期间，宿主替它按时刷新这些来源（.ics 订阅要联网，和打开着的日历共用一个计时器，不会多拉）。同一项还让插件增删、改名、立刻刷新 .ics 订阅，或导入一份本地 .ics 文本，和日历设置里的「订阅」是同一份列表；插件详情页那一行会多一项「读取 Agent 日程、.ics 订阅和另一侧库里的日历，管理 .ics 订阅并改日历设置」。另外，插件可以打开笔记并直接跳到某个标题（`ctx.app.openNote(path, { heading })`）；通知上可以带一个按钮（比如「撤销」）；声明了 `databases` 的插件还能把宿主事件浮卡里那排字段（标题、时间、属性）挂进自己的卡片（`ctx.ui.mountRecord`），改动直接写回那张表。仪表盘卡片和插件自己的定时提醒还没有开放。接口细节见插件开发技能「日历叠加源与设置」一节。

### Space 与 Ribbon 收纳架

启动台、主页一类插件可以列出你的 Space、点一下打开、显示图标和近况（继续某会话、最近的笔记、下一条日程、未读数），并在自己的界面里调整 Ribbon 上 Space 的顺序和收纳夹。插件必须声明 `spaces` 才拿得到；它改的就是 Ribbon 那一份顺序，在插件里拖一下，Ribbon 上跟着变，反过来也一样。某个 Space 换了图标（比如它的插件更新了），插件里画的图标也跟着换。插件详情页会多一项「打开 Space，调整 Ribbon 上 Space 的顺序和收纳夹」。接口细节见插件开发技能「Space 与 Ribbon 收纳架」一节。

另外三件零碎的：插件可以拿到当前登录的名字（`ctx.app.watchAccountName`，有昵称用昵称，只给名字不给令牌）、必应每日壁纸（`ctx.wallpaper.bing`，由 Forsion 代拉），以及和 Forsion 自己一样样式的右键菜单（`ctx.ui.contextMenu`）。菜单项多、窗口矮时自己滚动；做勾选清单时可以让它点了不关，一次勾好几项。

## 插件自带的 MCP、hooks 与文件事件

插件可以随包带上自己的 MCP server(只限在本机跑的那种),装好、启用之后 Tangu 就多了这些工具,停用插件就一起停掉。设置 → MCP 里会列出它们,写着来自哪个插件;要关掉,在插件设置里停用这个插件。插件也可以带 hook,在会话开始、工具跑完、一次回答结束时收到通知,用来做审计、归档这类事;这种 hook 只能看,拦不住任何操作,也不能往对话里加内容。设置 → Hooks 里同样列出它们,标着「只观察」。

插件还能收到笔记库里的文件事件:新建、删除、在 Forsion 里改名或移动、被别的程序或 Tangu 改动,以及换库。反链、自动整理这类插件靠它跟上库里的变化,不用一遍遍重新扫描。接口细节见插件开发技能的「插件自带的 MCP server 与 hooks」和「库级文件事件」两节;插件命令给 Tangu 交回查询结果的写法在「`invoke`:把一条命令开给 agent」一节。

## IM 通道

引擎插件可以接入一个新的聊天软件(比如企业微信),和内置的微信、Telegram、QQ 通道用同一套:连接即新会话、远程审批、`/new` `/model` 等命令、收件箱转发、侧栏里的通道文件夹都现成。装好之后「设置 → 通道」里多一张卡,填上插件要的凭据、点「连接」就能用;停用插件,这个通道随之停下,已绑定的会话还在。接口见插件开发技能「引擎插件」一节的 `ctx.registerChannel`;企业微信插件是现成的例子。

## 自动化触发事件

插件可以给自动化加一种自己的「当…」:用 `ctx.automation.registerTrigger` 登记,事件发生时用 `ctx.automation.emit` 发一条。登记之后它出现在自动化画布触发节点的「外部 · 插件」组,规则由用户自己写,可以加时段、星期、冷却和每天次数;用户选「直接提醒」不花额度,选「叫醒 Muse」照常过额度。

只能登记自己命名空间下的:`id` 只写 key,宿主拼成 `plugin:<插件 id>:<key>`。名字中英都要有。插件停用或卸载时触发源随之注销,相关规则不删,暂停并写明原因,装回来自动恢复。事件不落盘,引擎重启会丢掉还没被规则看到的。引擎插件用 `ctx.sdk.automation` 上的同名方法。写法见插件开发技能的 `references/tangu-host-apis.md`。

## 插件数据跨设备同步

插件在 manifest 里写 `"syncData": true`，它用 `ctx.saveData` 存的数据就会随 Forsion 账号同步到你的其他电脑和手机。没登录或断网时照旧只存在这台设备上，联网后再补传。两台设备都改过时，保留较晚的那次。插件详情页里有「跨设备同步插件数据」开关，可以在某台设备上单独关掉。网页版暂不同步。接口细节见插件开发技能「编辑器」一节里 `loadData/saveData` 那几条。

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

## 摘要栏卡片

Tangu 聊天右侧的摘要栏(2.13.8-beta.1 之后的桌面版本)是一叠卡片:进度、后台、产物、来源、工作范围和 Agent Desk。插件可以用 `ctx.summary?.registerCard` 加一张卡,和内置卡在同一个栈里;插件卡默认排在 Agent Desk 前面,用户拖动排的顺序由宿主记住。卡片的开合跟着内容走:`count` 变大就自动展开;用户手动展开或收起只管到这一轮对话结束,不会被记住;`defaultCollapsed` 决定没有新内容时收不收。车道放不下时,宿主会先收起最久没有新内容的卡,或者把最后一张的正文缩短,所以别假定正文一定有 240px。`mount` 在每个会话的摘要栏里各调用一次(换会话会卸载重挂),`host.sessionId` 是这份所在的会话;`host.update({ count, hidden })` 改卡头的计数、或者先不显示这张卡。正文最高 240px(放不下时会更矮),超出由宿主滚动。只有桌面 Tangu 有摘要栏,所以用可选链;更早的版本没有 `ctx.summary`。接口细节见插件开发技能「摘要栏插件卡」一节。

```js
ctx.summary?.registerCard({ id, title: { zh, en }, defaultCollapsed, mount(el, host) })
```

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

- `ctx.app.openSpace?(id)`：切到某个 Space，布局建好后 resolve；不认识的 id 返回 `false`。
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

### 共享账号

Unit 网页账号宿主与移动端可提供 `ctx.account`。先判断能力存在，再使用 `status()`、`login()`、`logout()`、`request(path, init)` 与 `subscribe(listener)`。`request` 只访问账号 API，不接受其他源；宿主代发凭据并保留 FormData/Blob 文件上传。账号切换会取消旧请求并使旧响应体读取失败；插件仍须取消自己的延迟任务并清空旧账号界面。可选的 `saveDownload(blob, name)` 返回 `{ ok, error? }`：Android 保存到系统下载，浏览器保存为下载文件。不要保存、导入或传递账号令牌。
