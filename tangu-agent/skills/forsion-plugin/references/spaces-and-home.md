# Spaces, the Ribbon shelf and the home host parts: ctx.spaces / ctx.home

Moved out of SKILL.md (2026-11-15) to keep the skill body inside the model-visible window. Content unchanged.

## Space 与 Ribbon 收纳架:ctx.spaces(2026-10-18 起)

做「启动台 / 主页」一类插件时用:列出用户的 Space、点一下打开、画出图标和近况,在自己的界面里调整 Ribbon 上区的顺序和收纳夹。
manifest 必须声明 `"spaces"`(详情页会列出「打开 Space,调整 Ribbon 上 Space 的顺序和收纳夹」),没声明时 `ctx.spaces` 不存在。

```json
{ "id": "my-launcher", "capabilities": ["spaces"] }
```

```js
const s = ctx.spaces
const draw = () => {
  grid.replaceChildren()
  for (const it of s.shelf.items()) {                 // 按用户在 Ribbon 上排的顺序
    const tile = document.createElement('button')
    if (it.kind === 'space') {
      const icon = document.createElement('span'); tile.append(icon)
      disposers.push(s.mountIcon(icon, it.spaceId, { size: 20 }))   // 图标由宿主画(Space 图标是宿主组件 / 图片)
      tile.append(it.name)
      tile.onclick = () => s.open(it.spaceId)
    } else tile.textContent = `${it.name} (${it.spaceIds.length})`
    grid.append(tile)
  }
}
const off = s.subscribe(draw)                        // Space 注册 / Ribbon 顺序变了就重画
```

- **收纳架写的就是 Ribbon 那一份**:`shelf.move(id, targetId)` 把 `id` 落到 `targetId` 那一格,Ribbon 上跟着变;`moveIntoFolder(folderId, id)` /
  `moveOutOfFolder(id)`(回到顶层末尾)/ `reorderFolder(folderId, id, targetId)` / `addFolder(name)` / `renameFolder(id, name)` / `removeFolder(id)`(成员回到原位)。
  别自己存一份顺序 —— 两份迟早对不上。`items()` 不含收纳夹里的成员(它们在 `spaceIds` 里),含你自己那个 Space(不想画就自己滤掉)。
- `mountStatus(el, id)`:宿主把这个 Space 的近况那一行(继续某会话、最近的笔记、下一条日程、未读数;`actions()` 那两格是已装插件数、可领成就)画进 `el`,
  跟着数据自己更新;拿不到就是空的。目前只有内置 Space 有近况,插件 Space 还报不了自己的。
- `actions()`:商店、成就两格 `{ id, name, run() }`,2026-11-09 起后面再接首方 Ribbon 动作(活动中心等,和内置主页的坞同一份);图标同样用 `mountIcon(el, id)`。
- `contextMenu?(event, id, extra?)`(2026-11-09 起):右键一个 Space 时弹宿主的对象菜单 —— 和 Ribbon、主页、收纳面板上同一份;`extra` 是你这一处的几项(形状同 `ctx.ui.contextMenu` 的行,最多 20 行),画在最后一节。传触发右键的事件(原生的或 React 的都行;坐标不是有限数、缺 `preventDefault` / `stopPropagation` 的直接回 false、什么都不做),弹出后宿主替你 `preventDefault` + `stopPropagation`;返回弹没弹出来。旧宿主没有 → 退回 `ctx.ui.contextMenu`。
- `opensElsewhere?(id)`(2026-11-09 起):点这个 Space 会开到它自己的窗口去(而不是本窗口里切过去)。只有在本窗口切的才值得先放离场动效;旧宿主没有 → 当 false。
- `open(id)` 口径同 Ribbon 上点它;本窗口是锁在某个 Space 上的 Space 窗口时,开到那个 Space 自己的窗口。不认识的 id → `false`。
- `mountIcon` / `mountStatus` 返回卸载函数,之后 `el` 立刻还给你;插件被停用 / 重载时宿主统一收掉,`subscribe` 也一并退订。
- `mountIcon` 画的图标跟着 Space 走:同一个 id 重新注册换了图标(插件更新了 `iconFile`)宿主原地重画;挂的时候还没注册的 id 先空着,注册上了再画 —— 不用为换图标自己重挂。

## 主页宿主件:ctx.home(2026-11-09 起,只给接管主页的核心插件)

⚠️普通插件没有这一截,也申请不到:它只注入给 `shared/corePlugins.ts` 的 `HOST_VIEW_CLAIMS.homepage` 指名、且能接管(核心插件,或开发档 `localStorage forsion.dev.coreTrial`)的那个插件(`forsion-home`)。
分工(主页插件化 B):插件管主页长什么样、东西怎么摆;卡里的内容、摆放的存储与格式校验、首启再问那张卡留在宿主。

- `widget(id)` → `{ id, kind: 'builtin' | 'plugin' | 'agent', show, title, owner, canOpen }`(非 React 读法);`library()` 列出能放的全部卡;`subscribe(cb)` 头信息可能变了。
- `mount(el, id, { part: 'head' | 'body' | 'icon', wide?, size?, editing?, onRemove?, onComposer? })`:宿主把卡头 / 卡芯 / 图标画进 `el`;返回的卸载函数带 `update(opts)`(进出编辑态不重挂)。卜算子·建议没内容时这一格改画最近对话,宿主算。
- `mountPart(el, 'computer-history-ask')`:首启跳过「电脑历史」后主页再问一次那张卡;不认识的名字什么都不画。
- `layout.read()`(从没摆过 / 读不了存储 = `null`,缺省摆法你定、别写回;每次都核对存储原文,别的窗口刚存过也读得到;给的是拷贝)/ `write(next)`(宿主校验后存、返回存进去的那份,遥测计数宿主记;⚠️你上一次 `read()` 读失败时这一下不写、回存储现状 —— 你手里那份是缺省上改的,不许盖真摆放;先再 `read()` 一次)/ `subscribe(cb)`。格式只加字段不改字段。
- `onEditRequest(cb)`:命令「编辑主页」来了;主页没挂上时宿主先记着,登记那一刻补发。`track('home.edit')`:官方计数(主页小组件那条上手提示据此算「会了」),别的名字忽略。
