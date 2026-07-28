// 多维表行拖拽重排的纯逻辑(几何/DOM 全在 DatabaseEmbed 里,这里只管数组怎么动)。
// 单独成文件是为了能不开浏览器就把「拖到自己身上」「拖到末尾」这些边角钉死。

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
