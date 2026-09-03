// 多维表拖拽重排的纯逻辑(几何/DOM 全在 DatabaseEmbed 里,这里只管数组怎么动)。
// 单独成文件是为了能不开浏览器就把「拖到自己身上」「拖到末尾」这些边角钉死。
// moveRow 只要求元素有 id,**行与列共用同一份**(列就是 db.columns 这个数组的顺序)。

export interface HasId { id: string }

/**
 * 把 dragId 那一行移到 targetId 之前/之后。任一 id 不存在、或拖到自己身上 → 原样返回**同一个数组引用**
 * (调用方据此跳过写盘,不产生一次无意义的保存 + 撤销点)。
 */
export function moveRow<T extends HasId>(rows: T[], dragId: string, targetId: string, after: boolean): T[] {
  if (dragId === targetId) return rows
  const from = rows.findIndex((r) => r.id === dragId)
  const to = rows.findIndex((r) => r.id === targetId)
  if (from < 0 || to < 0) return rows
  const out = rows.slice()
  const [moved] = out.splice(from, 1)
  // 摘掉 from 之后,target 在新数组里的下标可能左移一位 —— 必须重新定位,不能拿旧的 to 算。
  const at = out.findIndex((r) => r.id === targetId)
  out.splice(after ? at + 1 : at, 0, moved)
  return out
}

/** 鼠标落在行的上半还是下半 → 插到它之前还是之后。 */
export const dropAfter = (clientY: number, rect: { top: number; height: number }): boolean =>
  clientY > rect.top + rect.height / 2

/** 鼠标落在列的左半还是右半 → 插到它之前还是之后(列拖拽用;与 dropAfter 同款,换成横轴)。 */
export const dropAfterX = (clientX: number, rect: { left: number; width: number }): boolean =>
  clientX > rect.left + rect.width / 2

/**
 * 两个数组的 id 序列是否逐字相同。
 * ⚠️ 不能只比引用:`moveRow` 只在「拖到自己身上 / id 不存在」时返回原引用;把一项摘出来又插回**原位**
 * (例:把 a 拖到紧邻的 b 之前)返回的是**内容相同的新数组**。调用方拿它判「这一手其实没动」——
 * 判不出来就会白排一个 pendingOp,而 pendingOps 会在 CAS 冲突后重放到别人刚写的新数据上,
 * 一次视觉空操作到那时就成了真改动(Codex 评审抓的)。
 */
export const sameOrder = (a: HasId[], b: HasId[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id)

/**
 * 列重排的**权威**落点计算(多维表列序 = columns 数组序)。
 *
 * ⚠️ 首列是标题列:`dbRowTitle` 恒取 `columns[0]`,看板/日历/画廊的卡片标题、以及**别的表 rowlink
 * 芯片上显示的文字**都从它来。所以它既不能被拖走、别的列也不能插到它前面 —— 否则拖一下列顺序,
 * 全库的关联芯片会集体改名。
 *
 * 闸**必须按传入的这个数组算**,不能由调用方在外面用渲染期快照先判好再传进来:dbStore 的 mutate
 * 回调会被排进 pendingOps,并在 CAS 冲突 / 外部热重载后**重放到重读出来的新数据上**;那份数据的
 * 首列可能已被外部改掉,拿旧首列判 = 闸在重放那一刻失效(Codex 评审抓的 high)。写成纯函数是为了
 * 让这条性质结构性成立 —— 谁调用它,判据都来自它当时看到的 columns。
 */
export function moveColumn<T extends HasId>(columns: T[], dragId: string, targetId: string, after: boolean): T[] {
  const id0 = columns[0]?.id
  if (!id0 || dragId === id0) return columns
  return moveRow(columns, dragId, targetId, targetId === id0 ? true : after)
}
