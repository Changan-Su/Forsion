/**
 * 记忆分层(11-09 第二步)的界面零件:画像页(HumanCollaborationPanel)和 Agent 记忆面板(AgentMemoryPanel)共用。
 * 常驻 = 每轮都带;详情 = 每份一行(主题、几条、说明,点开看条目),聊到时才读;归档 = 过了日期的,不再召回。
 * 行尾记号(<!--tg …-->)从不画出来:react-markdown 会把 HTML 注释原样当文字。
 */
import { useState, type ReactNode } from 'react'
import { Archive, ChevronRight, Folder, Loader2, Pin, Sparkles, Undo2 } from 'lucide-react'
import { Markdown } from './Markdown'
import { useI18n } from '../i18n'
import { formatRelative } from '../format/time'
import { entryOfLine, headingOf } from '../../../../tangu-agent/src/contracts/memoryLayers'
import { splitMark, stripMark } from '../../../../tangu-agent/src/contracts/entryMark'
import type { MemoryAuthor, MemoryOrganizeOutcome, MemoryOrganizeView } from '../services/backendService'
import './memoryLayersMessages'
import './memoryLayers.css'

export type LayerItem = { id: string; text: string; pinned?: boolean; by?: MemoryAuthor }
export type LayerTopicView = { key: string; title: string; about: string; path?: string; entries: LayerItem[] }

/** 「1 条 / N 条」 */
export function useEntryCount(): (n: number) => string {
  const { t } = useI18n()
  return (n) => (n === 1 ? t('memoryLayers.entries.one') : t('memoryLayers.entries.other', { n }))
}

/** 整理结果 → 一句人话(引擎的英文细节不上屏)。 */
export function organizeOutcomeText(t: (k: string, v?: Record<string, string | number>) => string, o: MemoryOrganizeOutcome, num: (n: number) => string = String): string {
  return o.status === 'organized'
    ? t('memoryLayers.result.organized', { moved: o.moved, archived: o.archived, before: num(o.before.chars), after: num(o.after.chars) })
    : t(`memoryLayers.result.${o.reason}`)
}

/** 一行钉子按钮:钉住的常亮,没钉的悬停 / 聚焦才出来(触屏常亮)。 */
export function PinButton({ pinned, disabled, onClick, label }: { pinned: boolean; disabled?: boolean; onClick: () => void; label?: string }) {
  const { t } = useI18n()
  const text = label ?? t(pinned ? 'memoryLayers.unpin' : 'memoryLayers.pin')
  return <button type="button" className="memory-layer-pin" aria-pressed={pinned} disabled={disabled} title={text} aria-label={text} onClick={onClick}><Pin size={13} fill={pinned ? 'currentColor' : 'none'} /></button>
}

/** 顶上那一行:常驻多少字 · 另有几份详情 · 上次整理;「整理」「整理记录」;记录里每次一行,能整次撤销。 */
export function OrganizeBar({ summary, view, busy, running, onOrganize, onUndo, extra }: {
  summary: ReactNode; view: MemoryOrganizeView | null; busy?: boolean; running?: boolean
  onOrganize?: () => void; onUndo: (id: string) => void; extra?: ReactNode
}) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const last = view?.history[0]
  return <div className="memory-layer-bar" data-memory-organize-bar>
    <p>
      <span>{summary}{last && <> · {t('memoryLayers.organizedAt', { time: formatRelative(last.at, { locale }) })}</>}</span>
      {view?.available && onOrganize && <button type="button" className="profile-text-action" disabled={busy || running} title={t('memoryLayers.organizeHint')} onClick={onOrganize} data-memory-organize>
        {running ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}{t(running ? 'memoryLayers.organizing' : 'memoryLayers.organize')}</button>}
      {!!view?.history.length && <button type="button" className="profile-text-action" aria-expanded={open} onClick={() => setOpen(!open)} data-memory-organize-records><Undo2 size={12} />{t('memoryLayers.records')}</button>}
      {extra}
    </p>
    {open && view && <ul className="memory-layer-records">
      {view.history.map((r) => <li key={r.id} data-memory-organize-record={r.id}>
        <span>{t('memoryLayers.record', { time: formatRelative(r.at, { locale }), moved: r.moved, archived: r.archived })}</span>
        {r.undoneAt ? <span className="memory-layer-muted">{t('memoryLayers.undone')}</span>
          : <button type="button" className="profile-text-action" disabled={busy || running} onClick={() => onUndo(r.id)}><Undo2 size={12} />{t('memoryLayers.undo')}</button>}
      </li>)}
    </ul>}
  </div>
}

/** 一串条目(常驻那段里连着的几条,或一份详情点开后的条目)。 */
export function LayerEntries({ items, busy, onPin, pinBack }: { items: LayerItem[]; busy?: boolean; onPin?: (item: LayerItem, pinned: boolean) => void; pinBack?: boolean }) {
  const { t } = useI18n()
  return <ul className="memory-layer-entries">
    {items.map((it) => <li key={it.id} className="memory-layer-item" data-memory-layer-entry={it.id} data-pinned={it.pinned ? 'true' : undefined}>
      <div className="md-body memory-layer-text"><Markdown content={it.text} allowRun={false} />
        {pinBack && it.by && it.by !== 'agent' && <span className="memory-layer-by">{t(`memoryLayers.by.${it.by}`)}</span>}</div>
      {onPin && (pinBack
        ? <PinButton pinned={false} disabled={busy} label={t('memoryLayers.pinBack')} onClick={() => onPin(it, true)} />
        : <PinButton pinned={!!it.pinned} disabled={busy} onClick={() => onPin(it, !it.pinned)} />)}
    </li>)}
  </ul>
}

/** 详情:每份一行,点开看条目(条目可以钉回常驻);归档单独一行。 */
export function DetailTopics({ topics, archive, busy, onPinBack }: { topics: LayerTopicView[]; archive?: LayerTopicView | null; busy?: boolean; onPinBack?: (item: LayerItem) => void }) {
  const { t } = useI18n()
  const count = useEntryCount()
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const row = (tp: LayerTopicView, isArchive: boolean) => <li key={tp.key} className="memory-layer-topic-row" data-memory-topic={tp.key}>
    <button type="button" className="memory-layer-topic" aria-expanded={open.has(tp.key)} onClick={() => toggle(tp.key)}>
      {isArchive ? <Archive size={15} /> : <Folder size={15} />}
      <span className="memory-layer-topic-main"><strong>{isArchive ? t('memoryLayers.archive') : tp.title}</strong><span className="memory-layer-muted"> · {count(tp.entries.length)}</span>
        <span className="memory-layer-about">{isArchive ? t('memoryLayers.archiveAbout') : tp.about}</span></span>
      {tp.path && <code className="memory-layer-path">{tp.path}</code>}
      <ChevronRight size={14} className="memory-layer-chevron" />
    </button>
    {open.has(tp.key) && <LayerEntries items={tp.entries} busy={busy} pinBack onPin={onPinBack ? (it) => onPinBack(it) : undefined} />}
  </li>
  if (!topics.length && !archive?.entries.length) return null
  return <section className="memory-layer-details" data-memory-details>
    <h4 className="memory-layer-head">{t('memoryLayers.details')}</h4>
    <ul className="memory-layer-topics">{topics.map((tp) => row(tp, false))}{archive && archive.entries.length > 0 && row(archive, true)}</ul>
  </section>
}

// ── 画像常驻那段:按行切成「文字块 / 条目串」,条目串一条一行带钉子;线(Agent 每轮读到这里)按去掉记号后的位置画 ──
export type ResidentBlock = { kind: 'text'; md: string; outside: boolean } | { kind: 'entries'; outside: boolean; items: LayerItem[] }
const CONTINUATION = /^(?: {2,}|\t)\S/
export function residentBlocks(resident: string, cutAt: number | null): ResidentBlock[] {
  const lines = resident.split('\n'); const out: ResidentBlock[] = []; let pos = 0
  for (let i = 0; i < lines.length;) {
    const outside = cutAt !== null && pos >= cutAt
    const last = out[out.length - 1]
    const e = entryOfLine(lines[i])
    if (e && !headingOf(lines[i])) {
      let j = i + 1; const more: string[] = []
      while (j < lines.length && CONTINUATION.test(lines[j]) && !entryOfLine(lines[j])) { more.push(lines[j].trim()); j++ }
      const { body, meta } = splitMark(e.content)
      const item: LayerItem = { id: `${i}:${body.trim()}`, text: [body.trim(), ...more].join('\n'), pinned: !!meta.pin, by: meta.by }
      if (last?.kind === 'entries' && last.outside === outside) last.items.push(item); else out.push({ kind: 'entries', outside, items: [item] })
      for (let k = i; k < j; k++) pos += stripMark(lines[k]).length + 1
      i = j; continue
    }
    const s = stripMark(lines[i])
    if (!s.trim()) { if (last?.kind === 'text') last.md += '\n' }
    else if (last?.kind === 'text' && last.outside === outside) last.md += `\n${s}`
    else out.push({ kind: 'text', md: s, outside })
    pos += s.length + 1; i++
  }
  return out.filter((b) => b.kind === 'entries' || b.md.trim())
}
/** 原句(去掉行号前缀):画像钉子按原句指。 */
export const factOf = (item: LayerItem): string => item.id.slice(item.id.indexOf(':') + 1)
