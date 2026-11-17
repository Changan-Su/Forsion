# Calendar / to-do plugins: the other entry points

Moved out of SKILL.md (2026-11-15) to keep the skill body inside the model-visible window. Content unchanged.

### 日历 / 待办类插件的其余入口(2026-10-17 盘点)

- **跳到笔记里的某个标题**:`ctx.app.openNote?.(task.path, { heading: task.heading })` —— 与 `[[笔记#标题]]`、聊天引用条同一套跳转;
  找不到那个标题就只开笔记;跳标题会聚焦那篇笔记,所以带 `activate: false` 时只开不跳;旧宿主忽略 `heading`。**打开多维表视图**:`ctx.app.openFile(db.path)`(`.db` 路由到表格视图),不用另找方法。
- **迷你窗**:Space 配方的 `mini`(见上「Mini Panel 适配」)或 `ctx.openMiniPanel`,宿主日历的迷你待办也是这条路。
- **Intelligent UI**:给待办之类的列表源写 `intelligent`(见「Intelligent UI list cards」),宿主用原生列表画卡片,不画插件 DOM。
- **用户仪表盘里的卡片**:插件视图**不能**嵌进用户的 `.dashboard.md`(嵌卡是宿主白名单,插件自声明不算数)。要在自己视图里放仪表盘用 `ctx.dashboard.mount`。
- **提醒**:笔记里 `@remind:` 的到点通知由宿主发,和日历是哪个插件无关;宿主没有给插件排定时提醒的接口 —— 插件运行期间要提醒用 `ctx.notify`。
- **带按钮的通知(撤销)**:`ctx.notify(msg, { action: { label, run }, key })` —— `label` 截到 40 字,有按钮时通知留 8 秒;插件停用后点按钮什么都不做;
  `key`:同 key 的后一张顶掉前一张(宿主加 `plugin:<id>:` 前缀,和别的插件撞不上)—— 标题、文案、按钮、停留都换成新这张的,新这张没带按钮就清掉旧的;
  宿主不替你数「第几张」(不出 ×N),要显示件数自己写进文案。旧宿主同 key 时还会在卡上叠 ×N、新这张没给标题时沿用旧标题。
  窗口在后台时,顶上来的这张和新弹的一样跟发系统通知(用户关了系统通知 / 关了这个插件的通知就不发;旧宿主同 key 时不发)——
  它是新的一件事。只想悄悄刷新一个进度、不想每次都响,用 `registerStatusItem`,别反复 notify 同一个 key。
- **手机上的通知(2026-11-15 起)**:窄于 640 的手机上是状态栏下的一条横幅,一次一条、其余排队;停 5 秒(读屏开着 10 秒,`error` / `sticky` 一直留着),
  点正文 = 点按钮,上滑 / 点 × 收起。同 key 在手机上原地换文案和按钮,停留从第一次出现算、不顺延。**节流**:你的插件一张卡收起后,
  到点走的 30 秒、用户上滑 / 点 × 收的 2 分钟内宿主不出你的卡 —— `ctx.notify` 照常返回、不抛错,所以数字 / 状态要留在自己的界面里(列表、页签角标)。
  App 在后台时的系统通知不受节流。两个可选布尔项,只认 `true`,旧宿主逐项挑字段、直接忽略,不用判宿主版本:
  `undo: true` = 撤销回执(删了之后的「撤销」),手机上停 8 秒、不受节流;`urgent: true` = 有人 / Agent 正停着等用户(等批准),
  手机上不受节流、排到不急的前面,但**不是常驻**。不受节流的卡给它自己的 key(如 `approval:<id>`),别和普通卡共用 key,否则会顶掉普通卡。
  没带 `undo`、但在用户点按 / 按键的处理函数里**同步**弹出的带按钮卡,手机上也按撤销回执对待(8 秒、不受节流);等过文件 / 网络、在回调里才弹的
  宿主认不出,要自己带 `undo: true`。App 在后台时手机上不出横幅、只发系统通知,卡片排着、回到前台再一条条出(节流照常),但不补一整串:
  退到后台时屏上那张(常驻的除外)收回来、回到前台第一个重新出(有人在等的 `urgent` 卡照样排在它前面)、从头停满;带 `undo` 的、常驻的、`error` 的、退到后台时正显示着的、
  没能发出系统通知的(比如用户关了系统通知、没给通知权限;回来后逐张出、不受同一插件的冷却)一律留;其余 `urgent` 的按「插件 + key」各留最新一张
  (不同的审批各自留着)、全部留着(回到前台时通知栏里的系统通知会被收掉);不急的每个插件留最新一张,补满 3 张里剩下的名额、留新的,`urgent` 已有 3 张或更多时一张不留。手机上从底部弹出的原生面板
  (菜单 / 输入框 / 确认框)开着时也不出横幅,卡片排着、不计时,屏上那张(常驻的除外)也收回去,收起后再出、从头停满。系统通知每个插件只留最新一条,只有带 `urgent: true`
  又带 `key` 的按「插件 + key」各占一条 —— 等批准的卡给它 `urgent` 和自己的 key,就不会被后来的普通卡顶掉。
- **事件浮卡里的那排字段**:`ctx.ui?.mountRecord?.(el, { path, rowId, dateCol?, readOnly? })` 把宿主的行编辑字段(标题、时间摘要 + 展开编辑、
  其余属性)画进你的容器,返回 `{ update(patch), dispose() }`;改动直接写那张表(同 `ctx.databases.setCell`,和打开着的表格同一份),
  行被删 / 换库就什么都不画;`path` 不是库里的表或没有 `rowId` 当场抛 `TypeError`。外框、关闭、「打开 / 删除」按钮、定位归插件。
  `dateCol` 那一列当时间行、不在属性里重复(必须是日期类列,别的列类型忽略、照常列在属性里);叠加源(只读表)或 `readOnly: true` 只显示值。**声明 `"databases"` 才有。**
  2026-10-24+:`body: true` 在字段下面挂这条记录的 Markdown 正文编辑器(与表格「打开记录」同一份正文、同一条写口;只对可写经典表,笔记视图 / 叠加源 / `readOnly` 不画);
  `hideColumns: [colId…]` 不列出这些属性列(例如你已经画了勾选框的完成列)。`ctx.databases` 快照的行多了 `hasBody?: true`(正文非空),画「有备注」标记用。旧宿主忽略这三项,照常只有字段。
- **界面**:插件拿不到宿主的 React 实例,也拿不到宿主组件。要宿主零件就走 `ctx.ui.mount*` / `ctx.ui.mount(name, el, props)`(行编辑字段就是上面的 `mountRecord`;菜单、弹出层、对话框、下拉、分段、空态、图标见「Host parts」),只传数据;**不要把宿主的菜单 / 浮层 / 对话框 / 图标 / i18n 抄一份进包** —— 抄的是某一天的快照,宿主后来的退场动效、材质、夹边修复它都没有。自己的大块画面(日历网格这类)可以用自带的 React 画,边界是挂载点 DOM。

- **事件操作**（2.13.7+）：`ctx.calendar?.events` 共用宿主的完整记录剪贴板和条件撤销历史。`copy(path,rowId,dateCol,before,cut?)`、`clone(path,rowId,dateCol,before,after?)`、`paste(path?,ISO时间?)` 保留记录正文／属性／关联，笔记视图保留完整笔记。`reschedule` / `rescheduleNote` 检查旧日期；`remove` 复用原删除语义；`undo` / `redo` 不覆盖后续编辑。`clipboard()` + `subscribe(cb)` 供界面画剪切态，`scope()` 区分智库，`clearClipboard()` 清空。只在声明 `calendar` 能力后提供；旧宿主需检测，不能手写有损复制来降级。
- **从原生列表导航到筛选后的视图**（2.13.7+）：`ctx.openView('todo', { params: { view: 'today', db: 'Tasks.db' } })` 把参数交给这个视图的 leaf，挂载方通过 `view.getParams()` / `onParamsChanged(cb)` 读取，`view.setParams(patch)` 保存。仍只能打开本插件自己的视图。
