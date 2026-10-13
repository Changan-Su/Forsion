/** Pick the file ChatView should auto-reference from the native main area.
 *
 * A Space can keep several Dockview groups visible at once. Focus may be on a plugin or ChatView
 * panel with no file, while an Amadeus document is still visible next to it. A fileless focused
 * panel must therefore not erase the companion document from the reference chain. */
export interface MainReferenceTab {
  type: string
  active: boolean
  front: boolean
  filePath?: string
}

export function mainReferenceKey(tabs: readonly MainReferenceTab[]): string {
  const active = tabs.find((tab) => tab.active)
  const candidate = (active && refOf(active) ? active : undefined)
    ?? tabs.find((tab) => tab.front && refOf(tab))
    ?? tabs.find((tab) => tab.type === 'amadeus-editor' && refOf(tab))
    ?? tabs.find((tab) => refOf(tab))
  return candidate ? refOf(candidate) : ''
}

/** 这个标签能给出的引用:`note:<库内相对路径>` / `file:<绝对路径>` / ''(引不了)。
 *  Amadeus 的文件视图(笔记 / PDF / 图片 / 数据库 / 白板 / 仪表盘 / 媒体 / 插件接管的文件类型)记的是**库内相对路径**,
 *  走 `note:`,由调用方拼上库根变成模型读得到的绝对路径(同从文件树把它拖进对话);别的视图只认绝对路径 ——
 *  一条裸相对路径模型打不开(引擎现在按参数名收 `*Path`,插件视图里叫这种名字的参数未必是本机文件)。 */
function refOf(tab: MainReferenceTab): string {
  if (!tab.filePath) return ''
  if (isVaultRelative(tab.type, tab.filePath)) return `note:${tab.filePath}`
  return isAbsolutePath(tab.filePath) ? `file:${tab.filePath}` : ''
}

const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p)

/** 这条路径是不是 Amadeus 库内相对路径(引用时要拼库根)。先看路径再看视图:内置阅读器也开库外的 PDF
 *  (对话里引用的 `/Users/…/book.pdf`),那是一条绝对路径,拼上库根就成了一条不存在的路径。 */
export const isVaultRelative = (type: string, path: string): boolean =>
  (type.startsWith('amadeus-') || type === 'dashboard') && !isAbsolutePath(path)
