# Library-wide tables and note tasks: ctx.databases / ctx.noteTasks

Moved out of SKILL.md (2026-11-15) to keep the skill body inside the model-visible window. Content unchanged.

## 全库多维表与笔记任务:ctx.databases / ctx.noteTasks(2026-10-16 起)

日历、待办、习惯这类插件要的是「库里所有带日期 / 勾选列的表」和「笔记里 `- [ ] … @2026-10-20` 那种任务」,
不是某一张固定的表。两条接缝写的是用户自己的数据,**default-deny**:manifest 里声明了才注入,没声明 `ctx.databases` /
`ctx.noteTasks` 整个不存在(旧宿主同样不存在)。

```json
{ "id": "my-planner", "capabilities": ["databases", "noteTasks"] }
```

```js
const offDb = ctx.databases?.subscribe(({ ready, databases }) => {
  if (!ready) return showLoading()          // ready:false 时的空列表 ≠ 库里没有表
  const withDates = databases.filter((db) => db.columns.some((c) => c.base === 'date' || c.type === 'calendarDate'))
  render(withDates)                          // 每次都是整份新快照,别原地改
})
// 拖动改期 / 勾选:和用户在表格里改一格是同一条路
ctx.databases?.setCell(db.path, row.id, dateColId, '2026-10-20T15:00/2026-10-20T16:00')
// 2.13.7+:经典表的条件写入;当前不匹配返回 false,CAS 重放时也检查，适合完成待办后的撤销。
ctx.databases?.setCell(db.path, row.id, doneColId, undefined, { value: true })
const id = await ctx.databases?.addRow(db.path, { [dateColId]: '2026-10-21' }, '交周报')
const undo = ctx.databases?.deleteRow(db.path, row.id)   // 经典表才有撤销;笔记视图返回 null

const offTasks = ctx.noteTasks?.subscribe(({ ready, tasks }) => {
  if (!ready) return showLoading()          // 同上:库还没恢复 / 刚换库时的空列表 ≠ 笔记里没有任务
  renderTasks(tasks.filter((t) => t.isTask))
})
ctx.noteTasks?.update(task.id, { checked: true })        // false → 让用户去笔记里改:ctx.app.openNote(task.path)

// 2026-11-02+:子任务 / 标签 / 记录正文 / 加列(旧宿主整条缺席,一律可选链)
const subs = tasks.filter((t) => t.parentId)             // 缩进在带 @ 的任务下面的 - [ ](最多两层),没写 @ 的 due 为 ''
const tags = task.tags                                    // 行里的 #标签(不含 #,口径同编辑器);text 里原样保留
const body = ctx.databases?.readBody?.(db.path, row.id)  // 经典表一行的记录正文;笔记视图 → null
ctx.databases?.setBody?.(db.path, row.id, next, { body }) // 整份替换;带 expected,正文被别处改过就 false
const col = ctx.databases?.addColumn?.(db.path, { name: '标签', type: 'multiselect' }) // 返回新列 id,马上能 setCell

// 2026-11-04+:整张表一次改,和表格界面同一条写口;fn 是纯函数,id 在外面先生成
const viewId = crypto.randomUUID()
ctx.databases?.mutate?.(db.path, (d) => {
  d.columns.find((c) => c.id === statusCol)?.options?.push('搁置')
  d.views = [...(d.views ?? []), { id: viewId, name: '看板', type: 'kanban', groupBy: statusCol }]
  return d
})
```

- **表的两种 `kind`**:`table` = 经典 .db(行在文件里);`notes` = 笔记视图(一行 = 文件夹里一篇笔记,行 id 就是笔记路径,
  属性在 frontmatter)。列给 `type`(原样,含自定义类型)和 `base`(落盘的基础类型);找日期列看 `base === 'date' || type === 'calendarDate'`,
  勾选列看 `base === 'checkbox'`。日期值:`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`,区间用 `/` 连两头。
- **与 `ctx.app.mutateDb` 的分工**:mutateDb = 单张 .db 的整文件比对交换(升级列结构、批量改);`ctx.databases` = 按行按格、
  和打开着的表格 / 编辑器实时一致,而且覆盖笔记视图。
- **写口都按「表格里改一格」的规矩**:`setCell` 返回 false = 表 / 行 / 列不存在、值不是合法单元格(字符串 / 数字 / 布尔 / 字符串数组 / null)、
  或那列是自动编号 / 创建时间(建行即定);`undefined` 清空该格。笔记视图的标题列(`type: 'page'`)= 笔记名,`setCell` 改它就是给笔记改名(只收非空字符串)。`addRow` 只收已有列,自动编号 / 创建时间由宿主盖;
  `duplicateRow` 同样重新盖章。
- **删除**:`deleteRow` 只删经典表的行,返回撤销函数(只生效一次;用户换了库再调不做事)。笔记视图的行是一篇笔记,
  这里不删(返回 null)——要删就 `ctx.app.trash(rowId)`,进回收站可恢复。
- **笔记任务**:`id` = `路径:行号`,两次加载之间稳定,笔记里行挪了会变 —— 每次以最新回调为准,别存起来。`isTask:false` 的普通行
  (`交周报 @2026-10-20`)没有勾选框,`update({checked})` 返回 false。`update` 先反映在下一次回调里,稍后写回那一行 markdown;
  那行已经对不上时宿主自己提示用户去笔记里改。网页 / 手机宿主不能回写 → false。
- **子任务与标签(2026-11-02+)**:带 `@` 的笔记任务下面缩进的 `- [ ]` 也进 `tasks`,带 `parentId`(父任务的 id;孙任务指向子任务,最多两层),
  没写 `@` 的 `due` 为 `''` —— 它不是独立待办,宿主自己的待办 / 日历不收,画在父项里;勾选照样 `update(id, { checked })`。每条任务带 `tags`
  (行里的 `#标签`)。表格行没有父子:子任务就写在那一行的记录正文里(`readBody` / `setBody`),标签存一列多选。
- **没日期的笔记待办 `@todo`(2026-11-15+)**:笔记里写 `- [ ] 买菜 @todo` 的任务也进 `tasks`:`isTask: true`、`due: ''`、**没有 `parentId`**
  = 要进待办清单、但还没排日期(放「未排期」那组;有 `parentId` 且 `due` 为 `''` 的仍是子任务)。`update(id, { due })` 设日期时宿主把 `@todo`
  换成那个日期;任务行传 `due: ''` = 清日期,日期换回 `@todo`(旧宿主拒空串、返回 false,撤销排期要能接住);`text` 里不带 `@todo`。`@todo` 只认任务行,普通行上写了不算。标注框 / 折叠块的标题行(`> [!fold]- 周会 @…`)从这天起
  `text` 不再带开头的 `[!fold]-` 记号。旧宿主不给这种任务。
- **记录正文 `readBody` / `setBody`(2026-11-02+)**:与表格「打开记录」、`mountRecord({ body })` 同一份 Markdown。`setBody` 是整份替换,
  读-改-写一律带 `expected: { body }`(当前对不上 → false,落盘重放再比一次),别盖掉用户刚在编辑器里打的字;只写可写的经典表。
- **加列 `addColumn(path, { name, type })`(2026-11-02+)**:经典表加一列基础类型(`text` / `number` / `checkbox` / `date` / `select` /
  `multiselect` / `url`),返回列 id,之后马上能 `setCell`。⚠️往一张**活表**加列别用 `ctx.app.mutateDb`:那条是磁盘比对交换,看不见还没落盘的行,
  写完一重读就把用户刚加的那一行冲掉了(2026-11-02 实拍)。
- **整表改 `mutate(path, fn)`(2026-11-04+)**:表格界面自己用的那条写口。`fn` 拿到当前表(含还没落盘的改动)的一份拷贝,返回改好的整张表
  (原地改完 `return d` 也行),返回 `null` = 不改。改列结构、批量改格、调行序、建 / 改视图都走这里;只改一格仍用 `setCell`(能带 expected)。
  ⚠️ 落盘撞上别处的新版本时,宿主重读后**在新数据上再跑一次 `fn`** —— `fn` 必须是纯函数:新行 / 新列 / 视图的 id 在外面先生成好,
  里面别调计数器、别发请求、别读外面会变的状态;按 id 找行和列,别按下标。返回 false = 没这张表 / 笔记视图 / 只读 / 叠加源、`fn` 抛错、
  返回的不是合法表结构、换掉或删掉了首列(改它的类型也算)、行或列 id 重复、改了 `source`、版本号比宿主认识的新、或者内容上没改动(不排队)。
  返回 true 之后,重放时结果才不合规(比如别处刚加了同 id 的列)这笔就整笔作废,只在控制台留一条警告 —— 用随机 id 就碰不上。盖章列(自动编号、创建时间、
  修改时间)的格子归宿主:已有行保持原值,新行由宿主盖,改过的行宿主自己刷新修改时间。删行时别的行指向它的关联格不会自动清,要清就在 `fn` 里一起改。
  旧宿主没有这个成员:一律 `?.`,缺席时退回 `addColumn` / `setCell` 那几条细写口,别退回 `ctx.app.mutateDb`(见上条)。
- 两个 `subscribe` 都**立刻回调一次**,插件停用时宿主统一退订(返回的退订函数照样可以自己调)。`ready` 两边同一个意思:库已恢复、**当前这个库**拉过了;换库那一刻翻回 `false`。(2026-10-16 早些的 seams 分支上 noteTasks 在库恢复前会先给 `ready:true` + 空列表,已修。)
- **声明的能力会写给用户看**:插件详情页在描述下面列一行「这个插件可以：读写你的多维表、读写笔记里的 @ 任务、读取前台窗口」(只列声明了的那几项,`activeWindow` / `calendar` 同理)。只声明真要用的 —— 多写一项,用户在详情页就多看到一项授权。
- 端到端台架:Genesis `desktop` 的 `npm run check:plugindata`(真 Electron × 外置探针插件 × 预置库,核对注入闸、ready 先假后真、写口落盘、详情页那一行;10-17 起含 `"calendar"` 档的闸、成员快照与 `setColor`)。
