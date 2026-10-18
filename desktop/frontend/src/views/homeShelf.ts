/**
 * Space 收纳架 = Ribbon 上区的另一个投影(从 HomepageView 搬出,2026-10-18 主页插件化 S3):
 * 内置主页和插件(`ctx.spaces.shelf`)读写的都是这几个函数 —— 顺序、收纳夹全在 `useRibbonStore` 那一份里,不另存。
 * 下面两条不变式就是要共用这份代码的原因,改之前先读 shelfMove 的注释。
 */
import { moveTo, useRibbonStore, useSpaceStore, type RibbonFolder, type SpaceDefinition } from '@lcl/engine'
import { rankIds, reorderBase, unionOrder } from '@lcl/engine/ribbonRegistry'

/** 架上一格:一个 Space,或一个收纳夹(含它当前能解析出来的成员)。 */
export type ShelfTile =
  | { kind: 'space'; id: string; space: SpaceDefinition }
  | { kind: 'folder'; id: string; folder: RibbonFolder; members: SpaceDefinition[] }

/**
 * 架上的条目 = ribbon 上区的顶层条目(Space + 收纳夹),按用户保存的顺序排。
 *
 * ⚠️与 `Ribbon.zoneList` 同一口径:遍历**活的** spaces ∪ folders 再按 `order` 排名,
 * 绝不去遍历 `order` 本身 —— 那份持久数组里留着停用插件、已删用户 Space 的陈年 id
 * (`removeRibbonIcon` 只在真正反注册时清,插件关掉那条路会清,但历史存档不保证干净),
 * 照着它渲染就会画出点不动的幽灵格。收纳夹成员同理:解析不到的成员静默丢掉。
 *
 * 返回的 `topIds` = 顶层序:**排掉夹内成员**(同 Ribbon 的 topE),但**含 `skip` 那一格**
 * (主页自己不显示,顺序上仍然占一格)。重排写回一律以它为基准,见 shelfMove 的注释。
 */
export function shelfTiles(spaces: readonly SpaceDefinition[], order: string[], folders: readonly RibbonFolder[], skip?: string): { tiles: ShelfTile[]; topIds: string[] } {
  const topFolders = folders.filter((f) => f.zone === 'top')
  const spaceOf = (rid: string): SpaceDefinition | undefined => spaces.find((s) => `space:${s.id}` === rid)
  const inFolder = new Set(topFolders.flatMap((f) => f.items))
  // 夹内成员**不进顶层序** —— 与 Ribbon.zoneList 的 `.filter((e) => !inFolder.has(e.id))` 同一句。
  // (Codex 评审 high:不过滤的话,重排写回会把夹内成员当顶层项塞进持久 order,
  //  解散收纳夹时 removeFolder 又把 items 原样splice 回去 → 同一个 id 在 order 里出现两次。)
  const topIds = rankIds([...spaces.map((s) => `space:${s.id}`), ...topFolders.map((f) => f.id)], order)
    .filter((id) => !inFolder.has(id))
  const tiles: ShelfTile[] = []
  for (const id of topIds) {
    if (skip && id === `space:${skip}`) continue // 主页自己不进架:点了等于原地不动(但**仍在 topIds 里**)
    const f = topFolders.find((x) => x.id === id)
    if (f) { tiles.push({ kind: 'folder', id, folder: f, members: f.items.map(spaceOf).filter((s): s is SpaceDefinition => !!s) }); continue }
    const sp = spaceOf(id)
    if (sp) tiles.push({ kind: 'space', id, space: sp })
  }
  return { tiles, topIds }
}

const rb = () => useRibbonStore.getState()
/** 此刻的持久序与顶层序(每次写之前现读,不吃渲染那一拍的旧值)。 */
const now = (): { order: string[]; topIds: string[] } => {
  const { order, folders } = rb()
  return { order, topIds: shelfTiles(useSpaceStore.getState().spaces, order, folders).topIds }
}

/** 把 `moved` 落到 `targetId` 那一格上 —— 与 Ribbon 的 `dropOnBar` 逐句同构。
 *  ⚠️两条都不能省:
 *   · 基准序含**主页自己**(它在架上不显示,顺序上仍占一格)。漏了 = 它从持久数组消失 →
 *     `rankIds` 把未列出的排最后 → 主页图标第一次拖架之后就掉进 ribbon 的「…」。
 *   · 基准序**不含夹内成员**(`topIds` 已过滤)。混进去 = 夹里的 id 被当顶层项写进 order,
 *     解散夹时 `removeFolder` 再 splice 一次 → order 里同一个 id 出现两次。 */
export function shelfMove(moved: string, targetId: string): void {
  if (!moved || moved === targetId) return
  const { order, topIds } = now()
  // ctx.spaces.shelf 收的是插件给的 id:只认此刻的顶层项。夹内成员被当顶层写进序 = 解散夹时重复(Codex 评审)
  if (!topIds.includes(moved) || !topIds.includes(targetId)) return
  const full = unionOrder(order, topIds) // 保住持久序里「此刻不可见」的项(用户 Space 异步注册)
  const at = full.indexOf(targetId)
  rb().setZoneOrder('top', moveTo(full, moved, at >= 0 ? at : full.length))
}

/** 收进收纳夹 —— 同 Ribbon 的 `dropIntoFolder`:改夹成员**必须配一次区顺序写回**,
 *  把它从顶层序里摘掉,否则解散夹时会多出一个重复 id。夹套夹 ribbon 也不做。 */
export function shelfMoveIntoFolder(folderId: string, moved: string): void {
  if (!moved || moved === folderId || moved.startsWith('folder:')) return
  const { order, topIds } = now()
  // 目标夹不存在 / 不在上区、moved 不是顶层项 → 不动(否则成员资格先被摘掉、原位置丢了)
  if (!rb().folders.some((f) => f.id === folderId && f.zone === 'top') || !topIds.includes(moved)) return
  rb().moveIntoFolder(folderId, moved)
  rb().setZoneOrder('top', reorderBase(order, topIds, moved))
}

/** 移出收纳夹 —— 同 Ribbon 浮层右键的那条:去 membership + 把它写回顶层序末尾。 */
export function shelfMoveOut(itemId: string): void {
  if (!rb().folders.some((f) => f.zone === 'top' && f.items.includes(itemId))) return
  const { order, topIds } = now()
  rb().moveOutOfFolder(itemId)
  rb().setZoneOrder('top', [...reorderBase(order, topIds, itemId), itemId])
}

/** 收纳夹里调顺序:`moved` 落到 `target` 那一格(target 不在夹里 = 排到最后)。 */
export function shelfReorderFolder(folderId: string, moved: string, target: string): void {
  const folder = rb().folders.find((f) => f.id === folderId)
  if (!folder || moved === target || !folder.items.includes(moved)) return
  const at = folder.items.indexOf(target)
  rb().setFolderItems(folderId, moveTo(folder.items, moved, at < 0 ? folder.items.length : at))
}

export const shelfAddFolder = (name: string): void => rb().addFolder('top', name)
export const shelfRenameFolder = (id: string, name: string): void => rb().renameFolder(id, name)
export const shelfRemoveFolder = (id: string): void => rb().removeFolder(id)
