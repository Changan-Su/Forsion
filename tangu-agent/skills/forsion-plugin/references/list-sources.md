# Sidebar list sources: row details, phone layout, trees, drag and rename; Intelligent UI list cards

Moved out of SKILL.md (2026-11-15) to keep the skill body inside the model-visible window. Content unchanged.

The `ctx.registerListSource` signature, the two ways to put it in the left pane and the `subscribe()` re-read rule stay in SKILL.md, section 统一左栏列表源.

## 统一左栏列表源:行与动作的细则(2026-08-25 起)

- 行首图标 `iconUrl`(favicon 等)与 `icon`(词表键)**两个都给**:老宿主 / 取不到图时退 `icon`。
- 进度类列表(章节、关卡)的行状态用 `circle-check`(做完)/ `circle`(没做完)/ `lock`(锁住;2026-10-18 起,老宿主退兜底图标)。网盘 / 存储类的行用 `hard-drive`(2026-10-18 起;老宿主没有,可拿 `ctx.app.setSpaceProgress` 在不在判新旧,旧的退 `archive`)。`penzor` 是蓬洲云自己的图标(2026-10-23 起),别的插件别用。别用 `todo` 表示没做完 —— 它是块菜单的「待办」图标,自带勾。
- `actions` / `itemMenu()` 的每一项是 `{ id, label, primary?, danger?, icon?, run }`:`primary` 留在工具条外面(缺省第一项),其余收进「⋯」;
  `danger: true`(2026-09-25 起)= 不可逆动作(删除 / 移除),宿主在右键菜单和「⋯」里都用危险色画它。**只管配色,确认仍由插件自己在 `run()` 里做**
  (宿主不替你弹框);惯例把它排在最后一项。老宿主忽略该字段。
- 行可带 `unread: true`(2026-09-11 起):宿主在行首图标角上画与未读会话同一个点;老宿主忽略。
  宿主自己的收件箱就是这么接进统一左栏的(`plugin:inbox:messages`:按发信人归组的组头,筛选 = 未读 / 已归档),可当参考实现。
- 行可带 `subtitle`(2026-10-13 起):标题下面再画一行淡字,只占一行、超出省略 —— 写「谁发的 · 第一句话」「状态」这类一眼要看到的东西,
  纯文本、别放 markdown;不写就还是一行。文件夹行不认;老宿主忽略该字段、照旧画一行,不用探测。右边的 `hint` 对齐第一行。
  收件箱的行就是 `title` + `subtitle`(正文第一句;发信人在组头上,见下面「组头」)+ `hint`(时间)。词表新增三枚「谁发来的」图标:`cloud` / `workflow` / `agent`。
- **手机上的样子(2026-10-13 起)**:安卓原生外壳里,**平铺的**列表源(没有文件夹行、没有 `parent`)画成手机的整屏列表,和会话 / 笔记列表同一套 ——
  `groups()` 是一排分类胶囊(不是菜单);行是 44dp 图标块 + 标题与 `hint` 一行 + `subtitle` 一行;搜索在顶上胶囊的搜索钮和下拉里;
  `itemMenu()` 的动作藏在左滑后面,是**只有图标、不带字**的圆钮;`primary` 那个动作是右下角的主按钮,其余 `actions` 在它的长按菜单里。
  所以动作要带 `icon`(图标词表里的名字,和行的 `icon` 同一张表):**没有 `icon` 的行动作不进左滑**(仍在长按菜单里),没有 `icon` 的主动作画成加号。
  成对的动作各给各的图标(已读 `mail-open` / 未读 `mail`、归档 `archive` / 取消归档 `unarchive`);`label` 这时是读屏标签和首次提示里念的名字,照旧要写。
  动作用得上的词表名:`mail` / `mail-open` / `archive` / `unarchive` / `trash` / `refresh` / `edit` / `pin` / `bookmark` / `plus`。带层级的源在手机上仍是树;唯一的例外是只有一层「组头」的源(见下),它留在这套版式里。
  这套版式里行不能拖动(长按留给行的菜单):要让人在手机上排序 / 归类,给一个动作,别只靠 `drop`。没有 `actions`、只有 `groupActions` 的源,主按钮就是那张菜单。
  桌面 / 网页不受影响;老宿主忽略 `icon`。不用探测,照写即可。
- **桌面上行尾的图标钮(2026-10-14 起;写本条时桌面尚未发版)**:指针停在一行上(或键盘焦点走到这一行)时,`itemMenu()` 里**带 `icon` 的动作**
  在行尾排成一排图标钮,右边仍是「更多」(里面是带名字的全部动作)。和手机左滑出来的是同一批、同一个顺序 —— 所以把最常用的两三个动作
  (已读、归档、删除这一类)放在前面并配上图标;不想让它出现在行上的动作就别给 `icon`。图标钮出现时行里的 `hint` 暂时收起、标题让出位置。
  `danger` 的动作悬停时变警示色,确认仍由你在 `run()` 里做。触屏设备上没有这排按钮。不用探测:老宿主只有「更多」。
- `drop` 不声明就完全没有拖放;声明了也是宿主判形点亮、插件决定接不接。
- **层级 / 行内拖动 / 就地改名(2026-10-10 起;写本条时桌面尚未发版)**:三样都先探测
  `ctx.listCapabilities?.includes('tree' | 'items' | 'rename')`,探测不到就照旧输出平铺的行 ——
  旧宿主不认 `parent`,会把文件夹画成一条普通的行,点它还会调到你的 `open()`。
  - 层级:行仍是一张平铺数组,子行写 `parent: '<上一级的 key>'`,上一级写 `kind: 'folder'`(可以是空的)。
    数组顺序就是显示顺序。文件夹点一下开合、不调 `open()`;开合由宿主记(文件夹缺省收起,`activeKey()` 那一行
    所在的文件夹自动展开);搜索时宿主不画层级,只平铺匹配的行 —— 所以子行最好也写上 `group`。
    静态分组头(`group`)同样可以点开合,缺省展开。`itemMenu(文件夹)` 里带 `primary` 的那一项画成行尾的「+」。
  - 文件夹可选中(2026-10-31 起;探测 `ctx.listCapabilities?.includes('folderOpen')`):文件夹行写 `opensOnClick: true`,点名字调 `open()` 并展开,行首箭头开合,`activeKey` 指向它时高亮;探测不到要留一行子项。
  - 组头(2026-10-14 起;探测 `ctx.listCapabilities?.includes('group')`):最上面一级的文件夹再写 `folderStyle: 'group'`,
    就画成 Tangu 左栏里 Agent / 项目那种一级行 —— 40px 高,前面一个 30px 的前导(有 `iconUrl` 是圆头像,有 `icon` 是方块里的图标,
    都没有就画标题的首字),名字后面一个开合箭头,`hint` 画成行尾的小胶囊(放未读数这类数字)。用在「这些行是谁的」这种分法上
    (发信人、账号、来源),不是文件树。组里的行**不画自己的图标**(组头已经说了是谁的),前导槽里只留 `unread` 的圆点,
    所以 `subtitle` 里也别再重复组的名字;一组先列 5 条,其余在「查看更多 · N」后面。
    开合和普通文件夹不同:**只记这一次运行,不落盘**。写 `defaultOpen: true` 的组自己开着(例:里面有未读);这个字段由假变真时
    宿主会重新打开它(哪怕用户收起过),一直为真的期间用户收起就让它收着,变回假时不自己合上。不写就是收着。
    **顺序你自己排**:数组里谁在前谁就在上面(收件箱按各组最新的一封排,谁刚来信谁在最上面)。搜索时照旧不画层级,
    所以带 `query` 时返回平铺的行,并把组的名字放回行里(`subtitle` / `icon`)。
    手机上:只有组头这一层(组头下面直接是行)的源仍然画成整屏列表 —— 组头是同一种行放大到触屏尺寸,组里的行照样能左滑。
    探测不到 `'group'` 的宿主把它画成普通文件夹(缺省收起、行带各自的图标),能用,只是不好看;在意的话那时就别分组。
  - 行内拖动:能拖的行写 `draggable: true`,`drop.accepts` 加 `'items'`。落下时收到
    `onDrop({ items: [key] }, { item, position })`,`position` = `'before'` / `'after'`(排在那一行前 / 后)或
    `'into'`(放进文件夹)。`drop.canDrop({ items }, target)` 在指针移动时被问(同步、要快),返回 false =
    这个落点不收,宿主会改问下一个合理的落点(如「放进去」被拒就问「排在前 / 后」)。行不会被提议落在自己身上
    或自己下面。**宿主只画提示,不移动任何东西**:改完自己的数据再通知订阅者。
  - 就地改名:行写 `renamable: true`,源上声明 `rename(item, title)`。菜单里的「重命名」、输入框、按键
    (回车提交 / Esc 取消 / F2 开始 / 失焦提交)都是宿主的;你收到的是去掉首尾空格、非空且确实变了的新名字。
    行上的字要等你的 `items()` 给出新标题才变。
  - 参考实现 = server-admin 插件的「官网」Space(文件夹 = 官网侧栏的分区,拖动 = 改目录页)。
- 细节与全部字段语义见正典文档同名小节 + `amadeus/plugins/types.ts` 的 `ListSourceContribution`。

### Intelligent UI list cards (2026-10-09+)

Opt an existing `registerListSource` into chat with
`intelligent: { description: 'Live saved bookmarks; optional title search.', viewId: 'folder' }`.
Use English discovery metadata (max 400 characters); localize the source title. The host owns
rendering and assigns `plugin:<manifestId>:<sourceId>`. Reuse `items/subscribe/open`, including
reload on subscription and unsubscribe on disposal; do not build another chat UI or data store.
`search: true` permits a bounded initial query. The card displays up to six live items and a
button to the same plugin's registered full view. Disable revokes discovery and unmounts cards.
The host draws the frame, so write no card styles: the header shows the plugin icon and
`name · source title` (manifest `nameEn` in English; when one name already contains the other,
only the longer one is shown), a Live dot and the full-view button. A block title written by the
model is not shown. Rows show each item's `title` and `hint` with its `iconUrl`, falling back to
`icon` and then a generic link icon: set both, as for the sidebar list.
Agents use `list_intelligent_cards` then an `app-card` block in `intelligent_ui`. Rendering does
not read records into model context, save links, analyze videos, or create tasks. Keep those
operations in existing domain tools/skills. Old hosts ignore the optional declaration.
