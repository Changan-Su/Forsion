/**
 * 引用芯片的**唯一**外观 + 「消息开头那行引用 token」的反解析(UIUX 评审 U-11)。
 *
 * 输入框的「已选择」条(Composer2)与用户气泡(EditorialMessage)共用 RefChipView:此前输入框里
 * 是芯片,发出去之后气泡里却是一串带引号的原始路径(`"/Users/x/Screen Shot 1.png"`)—— macOS 截图
 * 文件名都带空格,所以一定会中。
 *
 * 发送契约不变(见 Composer2 的 RefChip):芯片 token 用单个空格连成**正文第一行**,后接 `\n`。
 * splitLeadingRefs 是它的逆运算,只认 refChipOf / fileChip / folderChip / viewChip 能产出的形态;
 * 第一行里但凡有一段认不出来,就整行不拆(宁可照旧显示原文,也不把用户自己写的话吃成芯片)。
 * 复制 / 编辑仍用原始 msg.content —— 这里只改「怎么显示」,不改「发的是什么」。
 */
import type { ReactNode } from 'react'
import { FileText, Folder, MessageSquare, PanelsTopLeft, X } from 'lucide-react'
import { sessionIdOfTarget } from './chatDragRef'
import type { RefChip } from './Composer2'

const ICON = { color: 'var(--accent-ink)', flexShrink: 0 } as const

export function RefChipView({ chip, onRemove, removeTitle, children }: {
  chip: RefChip
  /** 给了才出 × 按钮(输入框);气泡里只读。 */
  onRemove?: () => void
  removeTitle?: string
  /** 替换名字那一格(气泡里的 [[…]] 引用用 ChatWikiLink,点开笔记 / 会话)。 */
  children?: ReactNode
}) {
  return (
    <span className="attach-chip" title={chip.token} data-ref-kind={chip.kind}>
      {chip.kind === 'session'
        ? <MessageSquare size={13} style={ICON} />
        : chip.kind === 'folder'
        ? <Folder size={13} style={ICON} />
        : chip.kind === 'view'
        ? <PanelsTopLeft size={13} style={ICON} />
        : <FileText size={13} style={ICON} />}
      <span>{children ?? chip.name}</span>
      {onRemove && <button type="button" title={removeTitle} aria-label={removeTitle} onClick={onRemove}><X size={12} /></button>}
    </span>
  )
}

/** 从正文开头拆出来的一条引用;wiki = `[[…]]` 的内层(笔记 / 会话),气泡据此交给 ChatWikiLink。 */
export type LeadingRef = RefChip & { wiki?: string }

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const unescapeAttr = (v: string): string =>
  v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** 不带引号的路径 token 要「长得确实像路径」才认:绝对路径至少两段(`/refine` 这种斜杠命令不算),
 *  相对路径得带分隔符且末段有扩展名(`and/or` 不算);URL 一律不算。 */
function barePathLike(tok: string): boolean {
  if (/[\s"<>[\]]/.test(tok) || tok.includes('://')) return false
  const abs = /^(~?\/|[A-Za-z]:[\\/])/.test(tok)
  const segs = tok.split(/[\\/]/).filter(Boolean)
  if (abs) return segs.length >= (/^[A-Za-z]:/.test(tok) ? 3 : 2)
  return segs.length >= 2 && /\.[A-Za-z0-9]{1,10}$/.test(segs[segs.length - 1])
}

const WIKI_RE = /^\[\[([^[\]\n]+)\]\]/
const QUOTED_RE = /^"([^"\n]+)"/
const VIEW_RE = /^<forsion-view type="([^"\n]*)" title="([^"\n]*)" \/>/
const BARE_RE = /^[^\s]+/

/** 从 line 的 pos 处读一条引用 token;读不出 → null。 */
function readRef(line: string, pos: number): { ref: LeadingRef; end: number; strong: boolean } | null {
  const rest = line.slice(pos)
  let m = WIKI_RE.exec(rest)
  if (m) {
    const inner = m[1]
    const bar = inner.indexOf('|')
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim()
    const label = (bar === -1 ? '' : inner.slice(bar + 1)).trim()
    if (!target) return null
    const session = sessionIdOfTarget(target)
    const ref: LeadingRef = session
      ? { token: m[0], name: label || 'Chat', kind: 'session', wiki: inner }
      : { token: m[0], name: label || baseName(target).replace(/\.md$/i, ''), kind: 'note', wiki: inner }
    return { ref, end: pos + m[0].length, strong: true }
  }
  m = VIEW_RE.exec(rest)
  if (m) return { ref: { token: m[0], name: unescapeAttr(m[2]), kind: 'view' }, end: pos + m[0].length, strong: true }
  m = QUOTED_RE.exec(rest)
  if (m) {
    // fileChip 只给**含空白**的路径加引号;引号里得是路径(带分隔符),`"hello world"` 这种句子不认
    const p = m[1]
    if (!/\s/.test(p) || !/[\\/]/.test(p)) return null
    return { ref: { token: m[0], name: baseName(p), kind: 'file' }, end: pos + m[0].length, strong: true }
  }
  m = BARE_RE.exec(rest)
  if (m && barePathLike(m[0])) return { ref: { token: m[0], name: baseName(m[0]), kind: 'file' }, end: pos + m[0].length, strong: false }
  return null
}

/**
 * 正文开头的引用行 → 芯片 + 剩下的正文。认不全 / 没有引用 → null(调用方照旧渲染原文)。
 * 没有换行的整条消息(只发了芯片、没写字)也拆,但只接受 [[…]] / 引号路径 / View 这类
 * 不会和普通文字撞形的 token —— 单独一个裸路径的消息多半是用户自己打的,原样显示。
 */
export function splitLeadingRefs(content: string): { refs: LeadingRef[]; body: string } | null {
  if (!content) return null
  const nl = content.indexOf('\n')
  const line = nl === -1 ? content : content.slice(0, nl)
  const refs: LeadingRef[] = []
  let allStrong = true
  let pos = 0
  while (pos < line.length) {
    const hit = readRef(line, pos)
    if (!hit) return null
    refs.push(hit.ref)
    allStrong = allStrong && hit.strong
    pos = hit.end
    if (pos === line.length) break
    if (line[pos] !== ' ') return null // token 之间恰好一个空格(Composer 用 join(' '))
    pos += 1
    if (pos === line.length) return null
  }
  if (!refs.length) return null
  if (nl === -1 && !allStrong) return null
  return { refs, body: nl === -1 ? '' : content.slice(nl + 1) }
}
