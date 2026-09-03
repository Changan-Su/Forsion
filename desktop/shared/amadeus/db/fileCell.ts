/** 附件列(type='file')的 cell 纯逻辑。**两形态并存,不迁移**:
 *    - 旧:`string`(单个附件,相对 .db 的路径或 http(s) URL)—— 历史数据原样留在盘上;
 *    - 新:`string[]`(多附件)—— 只有用户**再次编辑**这一格时才升格成数组。
 *  读端一律经 `fileRefs()` 认两种,写端只在追加/删除时产出数组。这样旧库打开即用、不触发全库改写。
 *
 *  ⚠️ 删到空写 `undefined`(**删键**),不写 `[]` 也不写 `''`:schema 的语义是「缺 key 一律视为空」,
 *     其余单元格的清空口径(setCell(..., undefined))、dropSelfRefs 的摘除也都是删键。
 *     留个空数组在盘上只会让 diff 噪音和「空但不是空」的判据分叉。
 *
 *  一旦升格成数组就**不再塌回字符串**(哪怕只剩一个):少一种形态转换 = 少一类边界 bug;
 *  读端两形态都认,所以塌回去也没有任何好处。 */
import type { CellValue } from './schema'

/** cell → 附件引用列表(两形态都认;脏值/空串一律滤掉)。与 rowLink.rowLinkIds 同款契约。 */
export const fileRefs = (v: CellValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x)
  : typeof v === 'string' && v ? [v] : []

/** 追加(上传):在既有引用**后面**接上 refs,返回新 cell 值。
 *  一次上传多个文件必须一次算完再写一次 —— 逐个 setCell 会读到同一份陈旧的 row.cells,只剩最后一个。 */
export const addFileRefs = (v: CellValue | undefined, refs: string[]): string[] =>
  [...fileRefs(v), ...refs.filter((r) => !!r)]

/** 删除某一个附件(只清引用,不删磁盘文件)。删到空 → `undefined`(删键,见文件头)。
 *  按**下标**删而不是按值:同名去重后仍可能出现两条相同 rel(手动粘贴的 URL),按值删会一次抹掉两条。 */
export const removeFileAt = (v: CellValue | undefined, index: number): string[] | undefined => {
  const cur = fileRefs(v)
  if (index < 0 || index >= cur.length) return cur.length ? cur : undefined
  const next = cur.filter((_, i) => i !== index)
  return next.length ? next : undefined
}
