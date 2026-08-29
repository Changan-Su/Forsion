// 侧栏树的「这一行接住文件后放哪」——纯判定,单测锁住(仪器 treeDrop.test.ts)。
// 用户口径:拖到准确的文件夹**或文件**里面。落到普通笔记行 = 进这篇笔记(附件 + 正文嵌入);
// 收不了正文的行(白板 / 仪表盘 / 插件文件类型 / 附件)一律归它所在的文件夹。
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isDashboardPath } from '@amadeus-shared/dashboard'

/** buildTree 把两种分隔符都当分隔并用 '/' 连接文件夹路径;父级计算必须说同一种「方言」,
 *  否则拖拽守卫/展开集合与树节点路径对不上(Windows 反斜杠路径、含 '\' 的文件名)。 */
export const parentOf = (p: string): string => { const a = p.split(/[\\/]/).filter(Boolean); a.pop(); return a.join('/') }

/** page = 进这篇笔记(打开它再导入);folder = 进这个文件夹(空串 = 库根)。 */
export type DropTarget = { page: string } | { folder: string }

/** @param mergedFd 合并笔记(.fd)的目录 —— 保持既有 Notion 语义:落进它的 .fd,不进正文。
 *  @param pluginFile 该路径归某个插件文件类型(.mindmap.md 之类):磁盘是 .md 但绝不进笔记编辑器。 */
export function rowDropTarget(path: string, o?: { mergedFd?: string; pluginFile?: boolean }): DropTarget {
  if (o?.mergedFd != null) return { folder: o.mergedFd }
  const plain = /\.md$/i.test(path) && !isDrawingPath(path) && !isDashboardPath(path) && !o?.pluginFile
  return plain ? { page: path } : { folder: parentOf(path) }
}

/** 落区高亮/离开判定用的键(page 与 folder 同处一个 dragOver 字符串态)。 */
export const dropKeyOf = (t: DropTarget): string => ('page' in t ? t.page : t.folder)

/** 这次拖拽是不是「外来的主机路径」(文件面板 / 右栏的行)。
 *  ⚠️ REF_MIME 在场 = 库里的行被拖着(树内搬笔记 / 拖去聊天区 / 拖去文件面板),它为了能落进文件面板
 *  也带了一份绝对路径 —— 但对笔记树自己来说那是**内部拖拽**,走这条外来复制分支会抢掉 dropTo。
 *  @param able 本地库且有 copyHostFiles(云侧库没有可写的本机目录)。 */
export function takesHostPaths(types: readonly string[], able: boolean, mimes: { paths: string; ref: string }): boolean {
  return able && types.includes(mimes.paths) && !types.includes(mimes.ref)
}
