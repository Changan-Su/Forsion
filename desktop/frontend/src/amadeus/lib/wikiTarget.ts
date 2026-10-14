// 双链内文 → 它指向库里的哪一份文件。只回答「是哪份」,不打开、不创建 —— 给双链右键菜单用。
// ⚠️ 解析顺序与 pageStore.openWikiLink 同一条链(外链 → PDF / 媒体锚 → 白板 → 笔记锚点 → 页面 → 文件 → 复合后缀文件;外链提到最前);
//    那边改了顺序,这边跟着改(wikiTarget.test.ts 钉着两边都认的形态)。
import { resolvePageName } from '@amadeus-shared/links'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { parseMediaLinkInner, parsePdfLinkInner, splitLinkInner } from '@amadeus-shared/pdfLink'
import { isNoteMd } from './fd'
import { resolveFileName, resolveVaultPath } from './vaultFiles'

export type WikiTarget =
  /** 笔记;subpath = `#标题` / `#^块` 里 `#` 之后那段(本页锚点时 path 就是来源页)。 */
  | { kind: 'note'; path: string; subpath?: string }
  /** 库里的非笔记文件(PDF / 白板 / 多维表 / 媒体 / 图片 / 插件文件类型 / 其它附件)。 */
  | { kind: 'file'; path: string }
  /** 库里没有:name = 询问创建时用的笔记名(文件形态时是那个文件名)。 */
  | { kind: 'missing'; name: string }
  | { kind: 'external' }

export function resolveWikiTarget(inner: string, pages: string[], files: string[], src?: string): WikiTarget {
  const raw = inner.trim()
  const fileOr = (name: string, hit: string | null): WikiTarget => (hit ? { kind: 'file', path: hit } : { kind: 'missing', name })
  if (/^https?:\/\//i.test(raw)) return { kind: 'external' } // 先于 PDF / 媒体:`[[https://…/a.pdf]]` 是外链,不是库里的文件
  const pdf = parsePdfLinkInner(raw)
  if (pdf) return fileOr(pdf.target, resolveFileName(pdf.target, files, src))
  const media = parseMediaLinkInner(raw)
  if (media) return fileOr(media.target, resolveFileName(media.target, files, src))
  // 白板惯例省 .md(`[[X.excalidraw]]`),盘上是 `X.excalidraw.md` —— 以 .md 结尾的名字过不了 resolveFileName 的闸,走 resolveVaultPath。
  if (isDrawingPath(raw)) return fileOr(raw, resolveVaultPath(raw, files, src) ?? resolveVaultPath(`${raw}.md`, files, src))
  let wanted = raw
  let subpath: string | undefined
  const anchor = raw.includes('#') && !resolvePageName(raw, pages, src) ? splitLinkInner(raw) : null
  if (anchor?.subpath) {
    subpath = anchor.subpath
    if (!anchor.target) return src && isNoteMd(src) ? { kind: 'note', path: src, subpath } : { kind: 'missing', name: raw }
    wanted = anchor.target
  }
  const page = resolvePageName(wanted, pages, src)
  if (page) return { kind: 'note', path: page, ...(subpath ? { subpath } : {}) }
  return fileOr(wanted, resolveFileName(wanted, files, src) ?? resolveVaultPath(wanted, files, src) ?? resolveVaultPath(`${wanted}.md`, files, src))
}
