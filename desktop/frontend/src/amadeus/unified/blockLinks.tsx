// 块菜单(⠿)的「复制标题链接 / 复制块链接 / 移动到…」(评审 B-15)。全是纯 md:
//  · 标题链接 = `[[笔记#标题]]`(Obsidian 同形,L-05 起点击能落到标题);
//  · 块链接只给**已有** `^id` 的块 —— 不为了复制链接去给用户的文件铸块 ID(评审 §3);
//  · 移动到 = 先把这几块追加到目标笔记末尾,成功了再从本篇删掉(反过来会在写失败时丢内容)。
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Fragment, Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { fuzzyRank } from '@lcl/engine/fuzzy'
import { mapOutsideFences, pageKey, resolvePageName } from '@amadeus-shared/links'
import { trailingBlockId } from '@amadeus-shared/pdfLink'
import { joinRel, toStoredMarkdown } from '@amadeus-shared/assets'
import { rewriteNoteRefs } from '@amadeus-shared/rewriteNoteRefs'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { anchorSafe } from '../blocks/markdown/wikiSubpath'
import { hrefKind } from '../blocks/markdown/linkHref'
import { amadeus } from '../api'
import { flushUnifiedPath, hasUnifiedInstance, unifiedInsertMarkdown } from './lifecycle'
import { fromDisk, toDisk } from './eol'
import { carryFolds } from './foldCarry'
import { registerMessages, translate, useI18n } from '../../i18n'

registerMessages({
  'blocklinks.copyHeading': { zh: '复制标题链接', en: 'Copy heading link' },
  'blocklinks.copyBlock': { zh: '复制块链接', en: 'Copy block link' },
  'blocklinks.moveTo': { zh: '移动到…', en: 'Move to…' },
  'blocklinks.copied': { zh: '已复制 {link}', en: 'Copied {link}' },
  'blocklinks.copyFailed': { zh: '没能写入剪贴板', en: "Couldn't write to the clipboard" },
  'blocklinks.pickTitle': { zh: '移动到哪篇笔记', en: 'Move to which note' },
  'blocklinks.pickPlaceholder': { zh: '输入笔记名…', en: 'Type a note name…' },
  'blocklinks.noMatch': { zh: '没有匹配的笔记', en: 'No matching notes' },
  'blocklinks.moved': { zh: '已移动到「{name}」末尾', en: 'Moved to the end of "{name}"' },
  'blocklinks.moveFailed': { zh: '没能移动到「{name}」，原块没动', en: 'Couldn\'t move to "{name}" — the blocks were left in place' },
  'blocklinks.moveConflict': { zh: '「{name}」刚被别处改过，没有移动，请重试', en: '"{name}" was just changed elsewhere — nothing was moved, try again' },
  'blocklinks.targetUnsaved': { zh: '已追加到「{name}」，但它还没存上，原块先保留在这里', en: 'Added to "{name}", but it hasn\'t been saved yet, so the blocks were kept here too' },
  'blocklinks.keptSource': { zh: '已追加到「{name}」，但这几块期间被改过，没有从本篇删掉', en: 'Added to "{name}", but these blocks changed meanwhile, so they were kept here too' },
})

const toast = (text: string): void => { window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text } })) }
const baseOf = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/')

/** vault 相对路径规范化(折叠 `.` / `..`;越出库根的 `..` 保留在头上)。 */
function normPath(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** 从 fromDir 指向 vaultRel 的相对路径。 */
function relPath(fromDir: string, vaultRel: string): string {
  const a = fromDir ? fromDir.split('/') : []
  const b = vaultRel.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

/** 跨目录搬块:`[文字](相对地址)` 按源 → 目标目录重算(Codex 复核 B-15 P1)。图片已由 toStoredMarkdown 按目标目录落好,
 *  外链 / 协议 / 绝对路径 / 纯锚点不动;围栏代码里的不动。
 *  ponytail: 行内代码 span 里的 `[x](y)` 也会被改 —— 罕见,真碰上再按 outsideCodeSpans 细分。
 *  「是不是页相对路径」以读的一侧为准(linkHref.hrefKind):它当成外链的(含没写协议、形似域名的 `a.com/x`)、
 *  锚点、不放行的协议都不动。新拼进地址的**源目录名**先编码(encodeDirSeg);链接里原有的段一个字节不碰,
 *  第一个 `#` 起的尾巴原样接回。结果要是会被读成别的东西(单段文件名 = 附件按文件名全库找;形似域名 = 外链)→ 前面补 `./`。
 *  读的一侧有两档:地址整段解得开就解码后读,解不开(链接自己带着落单的 `%`)就整段按字面读 —— 这里跟着分两档:
 *  解得开的,目录名编码后比、编码后写;解不开的,目录名里的 `%` 按字面比、按字面写,只有非编码不可的源目录名
 *  (带空格、括号、`#` `?` 之类)得写进结果时才整条留着不改。目录名用不着编码时,结果和原先的算法逐字相同。
 *  ponytail: 链接里解不开的那一段要是被后面的 `..` 抵掉(`50%/../x.pdf`),改完的地址换了一档,原先就这样、没管。
 *  钉子:blockLinks.move.test.ts(含与原算法的随机对拍、按读的一侧读回原文件的随机核对)。 */
export function rebaseRelativeLinks(md: string, fromDir: string, toDir: string): string {
  if (fromDir === toDir) return md
  // [解得开那一档, 按字面读那一档] 各一对 [源目录, 目标目录];目标目录只拿来比公共前缀,不会写进结果
  const dirs = [false, true].map((literal) => [markDir(fromDir, literal), markDir(toDir, literal)])
  return mapOutsideFences(md, (line) => line.replace(/(^|[^!])\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (m, pre: string, text: string, href: string, title: string) => {
    if (/^[/<]/.test(href) || !isLocal(href)) return m
    const cut = href.indexOf('#')
    const raw = cut < 0 ? href : href.slice(0, cut)
    let literal = false
    try { decodeURIComponent(raw) } catch { literal = true }
    const [from, to] = dirs[+literal]
    const marked = relPath(to, normPath(joinRel(from, raw)))
    if (literal && marked.includes(' ')) return m // 非编码不可的源目录名得写进去,而读的一侧这回不解码
    const out = marked.replace(/ /g, '')
    return `${pre}[${text}](${!out.includes('/') || !isLocal(out) ? './' : ''}${out}${cut < 0 ? '' : href.slice(cut)}${title})`
  }))
}
const isLocal = (href: string): boolean => /^(?:note|file)$/.test(hrefKind(href))
/** 目录名逐段备好:要编码才写得进地址的段,编码后前面垫一个空格当记号。链接自己的段里没有空格(正则不收),
 *  所以带记号的段只和另一个带记号的同名目录相等 —— 不会把链接里字面的 `my%20notes` 当成目录 `my notes`;
 *  算出来的结果里有没有空格 = 有没有这种目录名被写进去。literal(读的一侧按字面读):`%` 原样就是它自己,不算要编码。 */
const markDir = (dir: string, literal: boolean): string =>
  dir.split('/').map((seg) => {
    const probe = literal ? seg.replace(/%/g, '') : seg
    return encodeDirSeg(probe) === probe ? seg : ` ${encodeDirSeg(seg)}`
  }).join('/')
/** 新拼进链接地址的目录名:在 markdown 或地址里另有含义的字符(空白、括号、`%` `#` `?` `&` `|`、引号、方括号、
 *  `*` `:` `<` `>`、控制字符)一律写成 UTF-8 的 %XX —— 读的一侧(linkHref.noteLinkTarget、主进程 resolveAttachment
 *  带 `/` 的那一支)都是整段 decodeURIComponent。其余字符(中文、emoji……)原样,和图片地址的 encodeDest 同口径。 */
const encodeDirSeg = (seg: string): string =>
  seg.replace(/[\s%#?&|"'`[\]*:<>()\u0000-\u001f\u007f-\u009f]/g, (c) => Array.from(new TextEncoder().encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))

/** 目标原文末尾停在没收尾的围栏代码块 / HTML 注释里:追加的内容会被吞进去(Codex 复核 B-15 P0)。
 *  ponytail: 只认顶格(≤3 空格)的围栏,列表 / 引用里的围栏不认 —— 那种末尾没收尾的极少见。 */
export function endsInsideOpenBlock(text: string): boolean {
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    if (!fence) fence = m[1]
    else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null
  }
  return fence != null || text.lastIndexOf('<!--') > text.lastIndexOf('-->')
}

/** 追加到磁盘原文末尾:原文(含结尾空白、行尾风格)一字不动,只补必要的空行分隔(Codex 复核 B-15 P0)。 */
export function appendToNote(cur: string, md: string): string {
  const { text, eol } = fromDisk(cur)
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return toDisk(`${text}${sep}${md}\n`, eol)
}

/** 链接里写笔记的哪个名字:裸名在全库解析得回这篇就用裸名,重名时写库相对路径(去 .md)—— 与 resolvePageName 同一套规则。 */
export function linkNameFor(path: string, pages: string[]): string {
  const base = baseOf(path)
  return resolvePageName(base, pages) === path ? base : path.replace(/\.md$/i, '')
}

/** 选中的这一块能给出的链接:标题 → `[[笔记#标题]]`;行尾已有 `^id` → `[[笔记#^id]]`;都不是 → null。 */
export function blockLinkOf(node: ProseNode, notePath: string, pages: string[]): { kind: 'heading' | 'block'; link: string } | null {
  const name = linkNameFor(notePath, pages)
  if (node.type.name === 'heading') {
    const h = anchorSafe(node.textContent)
    return h ? { kind: 'heading', link: `[[${name}#${h}]]` } : null
  }
  const id = trailingBlockId(node.textContent)
  return id ? { kind: 'block', link: `[[${name}#^${id}]]` } : null
}

export function copyLink(link: string): void {
  const done = navigator.clipboard?.writeText(link)
  if (!done) { toast(translate('blocklinks.copyFailed')); return }
  done.then(() => toast(translate('blocklinks.copied', { link })), () => toast(translate('blocklinks.copyFailed')))
}

/** 这段内容能不能搬去别的笔记:画布卡 / 分栏行的锚与本篇 frontmatter 绑着,搬走就成了悬空锚。 */
export function canMove(content: Fragment): boolean {
  let ok = true
  content.descendants((n) => {
    if (/^amadeus(CanvasCard|ColumnRow|ColumnCell)$/.test(n.type.name)) ok = false
    return ok
  })
  return ok
}

/**
 * 把 [from, to) 追加到 target 末尾,成功后从本篇删掉。
 *  · target 开着(有活的 v4 实例)→ 走它的 insertMarkdown(进它的撤销栈与保存链,不和它抢写盘);
 *  · 没开 → readTextFile + writeTextFile CAS(基线指纹不符 = 期间被别处改过 → 不写、不删,提示重试)。
 *  md 按**目标**笔记的目录落成相对路径(图片 `![](…)` 跟着对)。
 *  删源之前核对这段还是原样:追加期间本篇被改过就只追加不删(内容多一份,绝不丢)。
 */
export async function moveBlocksTo(opts: {
  view: EditorView
  from: number
  to: number
  source: string
  target: string
  serialize: (content: Fragment) => string | null
  /** 全库页面表(排序):跨目录搬块时按目标位置重算裸名双链的指向。 */
  pages?: string[]
}): Promise<boolean> {
  const { view, from, to, source, target } = opts
  const name = baseOf(target)
  if (target === source) return false
  const content = view.state.doc.slice(from, to).content
  const display = opts.serialize(content)
  if (!display?.trim()) { toast(translate('blocklinks.moveFailed', { name })); return false }
  let md = rebaseRelativeLinks(toStoredMarkdown(display, dirOf(target)).trim(), dirOf(source), dirOf(target))
  if (opts.pages && dirOf(source) !== dirOf(target)) {
    // 裸名双链按「源笔记所在处」就近解析:搬到别的目录后可能指向另一篇同名笔记 → 按目标位置改写成仍指向原笔记的写法。
    md = rewriteNoteRefs(md, source, target, { pairs: new Map(), pagesBefore: opts.pages, pagesAfter: opts.pages })
  }
  try {
    if (hasUnifiedInstance(target)) {
      if (!unifiedInsertMarkdown(target, md, 'end')) throw new Error('insert refused')
      // 目标的保存还在防抖队列里:严格落盘成功才删源块 —— 否则目标没存上、源块已删,两边都丢(Codex 复核 B-15 P0)。
      try { await flushUnifiedPath(target, true) } catch { toast(translate('blocklinks.targetUnsaved', { name })); return false }
    } else {
      const cur = await amadeus.readTextFile(target)
      if (cur == null) throw new Error('missing')
      if (endsInsideOpenBlock(fromDisk(cur).text)) throw new Error('unsafe tail')
      const res = await amadeus.writeTextFile(target, appendToNote(cur, md), { base: textFingerprint(cur) })
      if (res && !res.ok) { toast(translate('blocklinks.moveConflict', { name })); return false }
    }
  } catch {
    toast(translate('blocklinks.moveFailed', { name }))
    return false
  }
  if (view.isDestroyed || to > view.state.doc.content.size || !view.state.doc.slice(from, to).content.eq(content)) {
    toast(translate('blocklinks.keptSource', { name }))
    return true
  }
  // 区间里的折叠锚随内容一起离开(B-04):交给 mapping 的话,删除点上的下一枚标题会「继承」折叠。
  const tr = view.state.tr.delete(from, to)
  carryFolds(view.state, tr, { from, to, drop: true })
  view.dispatch(tr.scrollIntoView())
  toast(translate('blocklinks.moved', { name }))
  return true
}

/** 「移动到…」的目标笔记选择器(QuickSwitcher 同款外观与键位:↑↓ 选、↵ 定、Esc 关)。
 *  ⚠️ 传送到 body、不进 .am-app:QuickSwitcher 的双行 cmd-* 外观是 engine.css + amadeus-host.css 那一套,
 *     进了 .am-app 会被 `.am-app .cmd-item`(列向 flex)叠上去,标题和路径挤成居中的两行(截图自查发现)。 */
export function NotePicker({ pages, exclude, onPick, onClose }: {
  pages: string[]
  exclude: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = fuzzyRank(query, pages.filter((p) => p !== exclude && /\.md$/i.test(p)), pageKey).slice(0, 30)
  useEffect(() => { setActive(0) }, [query])
  return createPortal(
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd-panel" role="dialog" aria-label={t('blocklinks.pickTitle')} data-testid="note-picker" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder={t('blocklinks.pickPlaceholder')}
          aria-label={t('blocklinks.pickTitle')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) onPick(results[active]) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
          }}
        />
        <div className="cmd-list" role="listbox">
          {results.map((p, i) => (
            <button key={p} className="cmd-item" role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => onPick(p)}>
              <span className="cmd-row">
                <span className="cmd-title">{baseOf(p)}</span>
                <span className="cmd-path">{p}</span>
              </span>
            </button>
          ))}
          {!results.length && <div className="cmd-empty">{t('blocklinks.noMatch')}</div>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
