// 每视图列序(DbView.order)的纯逻辑:把全局 columns 按视图记的 id 序重排。渲染层 DatabaseEmbed 的 visCols
// 与公开分享页 readonlyView 共用;不在引擎 sync-db-shared 的 FILES 表里(引擎不渲染,views 对它是 unknown[])。
//
// ⚠️ 首列是**标题列**:dbRowTitle 恒取 columns[0],看板/画廊卡片标题、别的表 rowlink 芯片文案都从它来。
//    所以视图 order 也不能把它挪走 —— 不管 order 里把首列 id 写在第几位(或根本没写),输出 [0] 恒 = 输入 columns[0]。
//    这条与 rowOrder.moveColumn 的闸是同一条铁律的两个入口(拖拽 / 落盘数据),两处都得守。

/** 按视图 order 重排。规则:首列固定;order 提到的列按 order 序;没提到的按全局序补在后;order 里已不存在的 id 忽略。
 *  order 缺/空、或算完序没变 → **返回原数组引用**(调用方据此免掉一次无意义重渲/写盘)。 */
export function orderColumns<T extends { id: string }>(columns: T[], order: string[] | undefined): T[] {
  if (!order?.length || columns.length < 2) return columns
  const rank = new Map<string, number>()
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i) }) // 重复 id 取首次出现
  const [head, ...rest] = columns
  const ranked = rest.filter((c) => rank.has(c.id)).sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number))
  const out = [head, ...ranked, ...rest.filter((c) => !rank.has(c.id))]
  return out.every((c, i) => c === columns[i]) ? columns : out
}
