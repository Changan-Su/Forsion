# 日历叠加源与设置:ctx.calendar 的 `"calendar"` 档(2026-10-17 起)

Desktop 2.13.6+: plugins declaring both `databases` and `calendar` also receive the local personal calendar as the exact opaque path `human://CALENDAR.db`. Use `ctx.databases` writes, `ctx.ui.mountRecord`, and `ctx.app.mutateDb` (schema/name changes) with that path unchanged; never pass it to filesystem APIs. It is first in calendar members and the fallback default; the host hides the old vault mirror. Hosts without a local human calendar omit it. Database-only plugins do not receive this source. Its intrinsic date/done mapping and membership are managed: `setMember` and `removeMember` return false; use `setHidden` to hide it. Subscriptions own loading, focus refresh and teardown; writes retain the host CAS/replay protocol.

做一个完整的日历插件,光有库里的表(`ctx.databases`)和笔记任务(`ctx.noteTasks`)不够:宿主日历还叠着三类**只读源**
(Agent 日程、用户加的 .ics 订阅、Local↔Cloud 另一侧库里的表),以及用户的**日历设置**(哪些表在日历里、各用哪一列、颜色、
藏起来的源、新建默认落哪张表)。这一档把它们给插件,**default-deny**:

```json
{ "id": "my-calendar", "capabilities": ["calendar", "databases", "noteTasks"] }
```

```js
if (ctx.calendar?.subscribe) {                  // 没声明 "calendar" → ctx.calendar 只有 ensureMember
  const off = ctx.calendar.subscribe(({ ready, members, overlays, colors, hidden, defaultPath }) => {
    // members:[{ path, dateCol, checkboxCol? }] —— 已按宿主规则解析好的成员,行去 ctx.databases 的快照里按 path 找
    // overlays:只读表,形状同 ctx.databases 的表 + origin('agent' | 'ics' | 'otherVault')+ otherVault 的 vaultLabel
    // colors:每个成员 / 叠加源的 '#rrggbb',和宿主图例一致;hidden:用户藏起来的路径
    render({ members, overlays, colors, hidden, defaultPath })
  })
}
ctx.calendar?.setColor?.(path, '#5aa98b')       // null = 回到调色板色
ctx.calendar?.setHidden?.(path, true)
ctx.calendar?.setMember?.(db.path, dateColId, doneColId)   // 加进日历 / 改映射(会覆盖用户改过的)
ctx.calendar?.setDefault?.(db.path)
ctx.calendar?.removeMember?.(db.path)           // 只撤成员,不删表
```

- **订阅会让宿主替你刷新叠加源**:Agent 日程每分钟拉、.ics 订阅每半小时联网拉、换库时重读另一侧 —— 和打开着的宿主日历共用一个计时器,
  最后一个订阅者退订就停。只用设置不用叠加源也得订阅(设置在同一份快照里),用完退订;插件停用时宿主统一退订。
- `ready` waits for vault tables and the initial local personal-calendar read to settle (missing/unavailable also settles);叠加源各自尽力而为,Agent 引擎不在、.ics 拉不下来都只是少几个源,不报错。
- **写口都返回 boolean**,false = 宿主不收:颜色只收 `#rrggbb`;`setColor` / `setHidden` 的路径只认库里的表或当前的叠加源;
  `setMember` 只认库里可写的表,日期列必须是日期类列(`base === 'date'` 或 `calendarDate`)、勾选列必须是勾选类列;
  `setDefault` 只认可写的成员;`removeMember` 只认显式登记过的成员,而且日历做过首次整理才收(从没打开过日历的库里,订阅会在 `ready` 后替你做这一步,成员不变 —— 先订阅、等 ready 再撤)。叠加源不能当成员、不能设默认,拿它的 path 调 `ctx.databases` 的写口也是 false。
- 设置按**当前库**生效,和宿主日历左栏「日历」列表改的是同一处(存在本机,不进库文件、不同步)。
- **`myCalendar`(2026-11-10 起的宿主;老宿主没有这个字段)= 个人日历 `human://CALENDAR.db` 读得怎样**:`'ok'` 读到了(文件还没建也算,第一次写会建;有日期列就在 `members` 里);
  `'absent'` 宿主确认没有它(老引擎 / 老 server、设备页的远端访客)→ 按没有个人日历的老规矩走;`'unknown'` 没读到(引擎没起、网络、5xx、文件坏了)、`'loading'` 还在读 →
  **读失败 ≠ 没有**:别因为成员里没它就新建别的表顶替,提示稍后再试、留住用户的输入,读到后宿主会再推一份快照。不认识的值当 `'unknown'`;字段缺失(老宿主)才退回自己的历史证据。
- **.ics 日历的地点 / 说明 / 链接(2026-11-15+)**:只读的 `ics://` 成员在这本日历里有事件带这一项时,多出 `location`(text)/ `description`(text)/
  `url`(url)三列,列名已按界面语言翻好;某个事件没有这一项时那一格不存在。老宿主只有 `name` / `date` 两列。`url` 是 ICS 原样,打开前自己判 http(s)。
- 详情页那一行会多一项「读取 Agent 日程、.ics 订阅和另一侧库里的日历，管理 .ics 订阅并改日历设置」。

**.ics 订阅管理**(同一档,2026-10-17 起):和宿主日历设置里的「订阅」是同一份列表(存在本机,不进库),改了宿主那边立刻看到。

```js
const id = ctx.calendar?.ics?.add('webcal://example.com/holidays.ics')   // 只收 http(s) / webcal,≤2048 字;同一 URL 已在 → 返回原来那条的 id
const id2 = ctx.calendar?.ics?.importText('课表', icsText)               // 本地 .ics 文本导入(不联网),≤ 宿主的导入上限;解析不出来 → null
ctx.calendar?.ics?.rename(id, '节假日')
const ok = await ctx.calendar?.ics?.refresh(id)  // 立刻联网拉一次;拉成功才 true,导入的(没有 URL)恒 false
ctx.calendar?.ics?.remove(id)
// 快照里:icsSubscriptions: [{ id, path: 'ics://<id>', name, url, error? }];事件本身在 overlays(origin 'ics')里
```

- 不收的一律返回 `null` / `false`,不抛;插件停用后全部不做。删订阅不会删任何库文件(它本来就不在库里)。
