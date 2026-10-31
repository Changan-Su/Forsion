import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import { Check, ChevronDown, Copy, ExternalLink, Maximize2, Minimize2, Minus, Plus, RotateCcw, Zap } from 'lucide-react'
import { parseUIDraft, safeUIUrl, snapUIValue, UI_VERSION, validateUIDocument, type UIBlock, type UIDocument, type UIInput, type UIResource, type UISetStep } from '../../../../tangu-agent/src/contracts/intelligentUi'
import { applyUISteps, documentEnv, sameValue, truthy, UI_SLOT, uiTableRows, uiText, type DocumentEnv, type UIValue } from '../../../../tangu-agent/src/contracts/intelligentUiExpr'
import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'
import { streamingArgString } from '../views/streamingWrite'
import { registerMessages, useI18n } from '../i18n'
import { ChatWebLink } from './ChatWikiLink'
import { CodeBlock, RunContext } from './Markdown'
import { deriveChecklist, emptyUIState, formatUIQuantity, inputValues, readUIState, stateVars, uiExpansionKey, uiStateKey, visible, writeUIState, type UIUserState } from './intelligentUiState'
import './IntelligentUi.css'
import { IntelligentAppCard } from './IntelligentAppCard'

registerMessages({
  'iui.loading': { zh: '正在组织内容…', en: 'Composing…' },
  'iui.incomplete': { zh: '内容尚未完整，已保留可用部分。', en: 'This answer is incomplete. Available content is preserved.' },
  'iui.invalid': { zh: '这部分界面未能生成，请查看工具结果或重新提问。', en: 'This view could not be generated. Check the tool result or try again.' },
  'iui.copy': { zh: '复制清单', en: 'Copy list' },
  'iui.copied': { zh: '已复制', en: 'Copied' },
  'iui.copyFailed': { zh: '复制失败，请重试', en: 'Copy failed. Try again.' },
  'iui.reset': { zh: '清空勾选', en: 'Clear checks' },
  'iui.progress': { zh: '已完成 {done}/{total} 项', en: '{done} of {total} complete' },
  'iui.remaining': { zh: '还需 {quantity}', en: '{quantity} still needed' },
  'iui.expand': { zh: '展开原图', en: 'View full image' },
  'iui.collapse': { zh: '收起原图', en: 'Collapse image' },
  'iui.retry': { zh: '重新加载图片', en: 'Retry image' },
  'iui.failedImage': { zh: '图片暂时无法加载', en: 'Image unavailable' },
  'iui.current': { zh: '当前选择', en: 'Current selections' },
  'iui.modelAction': { zh: '继续提问', en: 'Ask a follow-up' },
  'iui.newer': { zh: '这张卡要新版 Forsion 才能显示。', en: 'This card needs a newer version of Forsion.' },
  'iui.setFailed': { zh: '这一步没法完成，内容保持原样。', en: "That step couldn't be done; nothing changed." },
  'iui.state': { zh: '卡片里改过的', en: 'Changed in the card' },
})

export function intelligentDocumentOf(ev: ToolEvent, live: boolean): { doc?: UIDocument; complete: boolean } {
  if (ev.name !== 'intelligent_ui' || !ev.arguments) return { complete: false }
  const successful = ev.done && !ev.isError && typeof ev.result === 'string' && !/^Error[:\s]/i.test(ev.result)
  if (successful) {
    try { return { doc: validateUIDocument(JSON.parse(JSON.parse(ev.arguments).document)), complete: true } } catch { /* preserve validated prefix below */ }
  }
  // Complete units survive cancellation too; no model actions until the whole call succeeds.
  const text = streamingArgString(ev.arguments, 'document')
  return { doc: text ? parseUIDraft(text) : undefined, complete: false }
}

export function IntelligentUi({ event, live, stateScope, onAsk }: { event: ToolEvent; live: boolean; stateScope?: string; onAsk?: (text: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  const current = useMemo(() => intelligentDocumentOf(event, live), [event.arguments, event.done, event.isError, event.result, live])
  const last = useRef<UIDocument | undefined>(undefined)
  if (current.doc) last.current = current.doc
  const doc = current.doc || last.current
  // A document from a later Forsion: show its title and opening text, and say why the rest is missing.
  const newer = useMemo(() => {
    if (doc || !event.done) return undefined
    try {
      const d = JSON.parse(JSON.parse(event.arguments || '{}').document)
      if (!(typeof d?.version === 'number' && d.version > UI_VERSION)) return undefined
      const lead = Array.isArray(d.blocks) ? d.blocks.find((b: { kind?: unknown; markdown?: unknown }) => b?.kind === 'text' && typeof b.markdown === 'string')?.markdown : undefined
      return { title: typeof d.title === 'string' ? d.title : '', lead: typeof lead === 'string' ? lead : '' }
    } catch { return undefined }
  }, [doc, event.done, event.arguments])
  if (newer) return <section className="intelligent-ui">{newer.title && <h3 className="iui-title">{newer.title}</h3>}{newer.lead && <div className="iui-prose"><RichText text={newer.lead} /></div>}<div className="iui-status" role="status">{t('iui.newer')}</div></section>
  if (!doc) return live && !event.done ? <div className="intelligent-ui"><Skeleton /></div> : <div className="iui-status" role="status">{t('iui.invalid')}</div>
  return <NativeDocument key={uiStateKey(stateScope || '', event.id, doc.id)} doc={doc} complete={current.complete} live={live && !event.done} stateKey={stateScope ? uiStateKey(stateScope, event.id, doc.id) : undefined} onAsk={onAsk} />
}

type MdNode = { type: string; value?: string; children?: MdNode[] }
/** v2: puts computed text into the parsed tree at its markers, as plain text nodes. */
const remarkSlots = (values: string[]) => () => (tree: MdNode): void => {
  const walk = (node: MdNode): void => {
    if ((node.type === 'text' || node.type === 'inlineCode') && node.value) node.value = node.value.replace(UI_SLOT, (_, i: string) => values[Number(i)] ?? '')
    node.children?.forEach(walk)
  }
  walk(tree)
}
function RichText({ text, values }: { text: string; values?: string[] }): React.JSX.Element {
  // 同聊天正文(components/Markdown.tsx):`**怎么选：**如果` 这种 CJK 标点贴闭合定界符的写法,不加这两个插件会原样露出 `**`。须排在 remarkGfm 之后。
  // 代码块用聊天正文那份(复制键 + 高亮)。不给「运行」:这里没接工作目录,也不知道会话是不是别的设备的。
  return <RunContext.Provider value={{ allowRun: false }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkCjkFriendlyStrikethrough, ...(values ? [remarkSlots(values)] : [])]} skipHtml disallowedElements={['img', 'input']} components={{
    a: ({ href, children }) => safeUIUrl(href) ? <ChatWebLink href={href}>{children}</ChatWebLink> : <span>{children}</span>,
    pre: CodeBlock,
  }}>{text}</ReactMarkdown></RunContext.Provider>
}

function Picture({ resource, sources, expanded, onExpand, flip }: { resource: Extract<UIResource, { kind: 'image' }>; sources: Map<string, UIResource>; expanded: boolean; onExpand: (expanded: boolean) => void; flip: string }): React.JSX.Element {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const source = resource.sourceId ? sources.get(resource.sourceId) : undefined
  return <figure className="iui-picture" data-expanded={expanded || undefined} data-flip={flip}>
    {failed ? <div className="iui-image-error"><span>{resource.alt}</span><small>{t('iui.failedImage')}</small><button type="button" onClick={() => { setFailed(false); setAttempt(v => v + 1) }}>{t('iui.retry')}</button></div>
      : <button type="button" className="iui-image-toggle" aria-label={t(expanded ? 'iui.collapse' : 'iui.expand')} aria-expanded={expanded} onClick={() => onExpand(!expanded)}>
        <img key={`${resource.url}:${attempt}`} src={resource.url} alt={resource.alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </button>}
    <figcaption>{resource.alt}{source?.kind === 'source' && <ChatWebLink href={source.url} quote="">{new URL(source.url).hostname}</ChatWebLink>}</figcaption>
  </figure>
}

/** These blocks draw their own heading row; an app card is named by the app, not by the model. */
const OWN_TITLE = new Set<UIBlock['kind']>(['disclosure', 'checklist', 'app-card'])
type ImageResource = Extract<UIResource, { kind: 'image' }>
type ChoiceInput = Extract<UIInput, { kind: 'choice' }>
function Skeleton(): React.JSX.Element {
  const { t } = useI18n()
  return <div className="iui-skeleton" role="status" aria-label={t('iui.loading')}><i /><i /><i /></div>
}
/** One selectable picture card. The radio owns selection and arrow keys; expanding the picture is a
 * separate corner button so looking closer never changes the choice. */
function PickCard({ name, option, resource, source, selected, onSelect, expanded, onExpand, flip }: { name: string; option: ChoiceInput['options'][number]; resource: ImageResource; source?: UIResource; selected: boolean; onSelect: () => void; expanded: boolean; onExpand: (expanded: boolean) => void; flip: string }): React.JSX.Element {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  return <div className="iui-pick-card" data-selected={selected || undefined} data-expanded={expanded || undefined} data-flip={flip}>
    <label>
      <input type="radio" name={name} value={option.id} checked={selected} onChange={onSelect} />
      {failed ? <span className="iui-image-error"><span>{resource.alt}</span><small>{t('iui.failedImage')}</small></span>
        : <img key={`${resource.url}:${attempt}`} src={resource.url} alt={resource.alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
      <span className="iui-pick-text"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
    </label>
    {failed ? <button type="button" className="iui-pick-tool" onClick={() => { setFailed(false); setAttempt(v => v + 1) }}>{t('iui.retry')}</button>
      : <button type="button" className="iui-pick-tool" aria-label={t(expanded ? 'iui.collapse' : 'iui.expand')} title={t(expanded ? 'iui.collapse' : 'iui.expand')} aria-expanded={expanded} onClick={() => onExpand(!expanded)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>}
    {source?.kind === 'source' && <ChatWebLink href={source.url} quote="">{new URL(source.url).hostname}</ChatWebLink>}
  </div>
}
/** Short, description-free options read as one segmented control. CJK glyphs count double so the
 * row still fits the 480px container where the narrow layout takes over. */
const segmented = (input: ChoiceInput): boolean => input.options.length <= 4 && input.options.every(o => !o.description)
  && input.options.reduce((n, o) => n + [...o.label].reduce((w, ch) => w + (ch > '\u2e7f' ? 2 : 1), 0), 0) <= 36

/** A change that moves things (a picture growing to full width, blocks appearing or leaving) glides
 * instead of jumping: FLIP over the document's own blocks and pictures. What only moved slides from
 * where it was; what is new or changed width fades in. Rects are viewport pixels, transforms are not,
 * hence the CSS zoom divisor (the interface zoom setting). */
const FLIP = 'iui-flip'
function reflow(root: HTMLElement | null, apply: () => void): void {
  if (!root || typeof root.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return apply()
  const parts = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-flip]')]
  // Where things are on screen now: mid-glide positions included, so a second click continues from there.
  const before = new Map(parts().map(el => [el.dataset.flip, el.getBoundingClientRect()]))
  flushSync(apply)
  const after = parts()
  // Final rects for everything before anything starts moving: a glide still running, or one just started on a
  // block, would shift what the pictures inside it measure.
  for (const el of after) for (const running of el.getAnimations()) if (running.id === FLIP) running.cancel()
  const rects = new Map(after.map(el => [el, el.getBoundingClientRect()]))
  const tokens = getComputedStyle(root), zoom = (root as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const timing = { id: FLIP, duration: parseFloat(tokens.getPropertyValue('--duration-slow')) * 1000 || 250, easing: tokens.getPropertyValue('--ease-out').trim() || 'ease-out' }
  const moved = new Map<HTMLElement, { x: number; y: number }>()
  for (const el of after) {
    const was = before.get(el.dataset.flip), now = rects.get(el)!
    if (!was || Math.abs(was.width - now.width) > 1) { el.animate([{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], timing); continue }
    // A picture inside a block that is itself sliding already travels with it.
    const host = el.parentElement?.closest<HTMLElement>('[data-flip]'), carried = host && moved.get(host)
    const shift = { x: (was.left - now.left) / zoom, y: (was.top - now.top) / zoom }
    moved.set(el, shift)
    const x = shift.x - (carried?.x ?? 0), y = shift.y - (carried?.y ?? 0)
    if (Math.abs(x) > .5 || Math.abs(y) > .5) el.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], timing)
  }
}

/** A changed state value as one short line for the follow-up message: lists by count and first five items. */
function brief(value: UIValue): string {
  const one = (v: UIValue): string => { try { return uiText(v) } catch { return JSON.stringify(v).slice(0, 120) } }
  return Array.isArray(value) ? `${value.length}: ${value.slice(0, 5).map(one).join(', ')}${value.length > 5 ? ', …' : ''}` : one(value)
}
/** Folding key of a disclosure whose text is computed: new text starts folded again. */
const contentKey = (text: string): string => { let h = 5381; for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }
/** Columns whose cells read as numbers are right-aligned. */
const numericColumns = (rows: string[][], count: number): boolean[] => Array.from({ length: count }, (_, i) => rows.some(r => /^[-+−]?\d/.test(r[i])) && rows.every(r => /^[-+−]?\d/.test(r[i]) || r[i] === '' || r[i] === '—'))
function Table({ block, env }: { block: Extract<UIBlock, { kind: 'table' }>; env: DocumentEnv }): React.JSX.Element {
  let rows: string[][] | undefined
  if (typeof block.rows !== 'string') rows = block.rows.map(row => row.map(cell => cell.includes('{{') ? env.text(cell) : cell))
  else {
    const c = env.cell(block.rows)
    try { if (c.ok) rows = uiTableRows(c.value, block.columns.length) } catch { /* shown as a dash */ }
  }
  if (!rows) return <div className="iui-status">—</div>
  const numeric = numericColumns(rows, block.columns.length)
  return <div className="iui-table-wrap"><table className="iui-table">
    <thead><tr>{block.columns.map((col, i) => <th key={i} data-num={numeric[i] || undefined}>{col}</th>)}</tr></thead>
    <tbody>{rows.map((row, j) => <tr key={j}>{row.map((cell, i) => <td key={i} data-num={numeric[i] || undefined}>{cell}</td>)}</tr>)}</tbody>
  </table></div>
}

function NativeDocument({ doc, complete, live, stateKey, onAsk }: { doc: UIDocument; complete: boolean; live: boolean; stateKey?: string; onAsk?: (text: string) => void }): React.JSX.Element {
  const { t, locale } = useI18n()
  // Hydrate before the first paint. Model defaults are never written over the user's state.
  const [state, setState] = useState<UIUserState>(() => stateKey ? readUIState(stateKey) : emptyUIState())
  const [notice, setNotice] = useState('')
  const root = useRef<HTMLElement>(null)
  // Blocks fade in only for a document that was seen arriving; replayed history stays still.
  const streamed = useRef(live).current
  const values = inputValues(doc, state)
  const vars = stateVars(doc, state)
  // v2: every derived value and expression of this render, computed lazily against one step budget.
  const env = documentEnv(doc, values, vars, locale === 'en' ? 'en' : 'zh')
  const shows = (when: UIBlock['when']): boolean => visible(when, values, env)
  const resources = new Map(doc.resources.map(r => [r.id, r]))
  // Sources a visible sources block already lists; a hidden block must not strip a picture of its attribution.
  const listed = new Set(doc.blocks.flatMap(b => b.kind === 'sources' && shows(b.when) ? b.resourceIds : []))
  // Pictures an option row already shows. Models sometimes list them again in a gallery or a comparison; each is drawn once.
  const optionImages = new Set(doc.blocks.flatMap(b => b.kind === 'controls' ? b.inputIds : []).flatMap(id => {
    const input = doc.inputs.find(i => i.id === id)
    return input?.kind === 'choice' ? input.options.flatMap(o => o.imageId ?? []) : []
  }))
  const update = (fn: (s: UIUserState) => UIUserState): void => setState(previous => {
    const next = fn(previous)
    if (stateKey) writeUIState(stateKey, next)
    return next
  })
  const copy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setNotice(t('iui.copied')) } catch { setNotice(t('iui.copyFailed')) }
  }
  const expand = (id: string, expanded: boolean): void => update(s => s.expanded[id] === expanded ? s : ({ ...s, expanded: { ...s.expanded, [id]: expanded } }))
  // A computed disclosure keeps one folding entry per block: the one for the text it shows now.
  const foldPrefix = (blockId: string): string => JSON.stringify(['disclosure', blockId]).slice(0, -1) + ','
  const fold = (blockId: string, key: string, open: boolean): void => update(s => {
    if (!!s.expanded[key] === open) return s
    return { ...s, expanded: { ...Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.startsWith(foldPrefix(blockId)))), ...(open ? { [key]: true } : {}) } }
  })
  // When a computed disclosure's text changes, the entry for the old text goes too, so coming back to
  // that text later starts folded. Filled while drawing below; read after the render commits.
  const foldKeys = new Map<string, string>()
  useEffect(() => {
    const stale = Object.keys(state.expanded).filter(k => [...foldKeys].some(([id, key]) => k !== key && k.startsWith(foldPrefix(id))))
    if (stale.length) update(s => ({ ...s, expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !stale.includes(k))) }))
  })
  // Layout moves (blocks or rows appearing, tables changing length) glide; v1 only when visibility changes.
  const moves = (nextValues: Record<string, string | number>, nextVars: Map<string, UIValue>): boolean => {
    if (live) return false
    if (doc.version === 2) return true
    const next = documentEnv(doc, nextValues, nextVars, env.locale)
    return doc.blocks.some(b => visible(b.when, values, env) !== visible(b.when, nextValues, next) || (b.kind === 'checklist' && b.items.some(i => visible(i.when, values, env) !== visible(i.when, nextValues, next))))
  }
  const runSteps = (steps: UISetStep[]): void => {
    let next: Map<string, UIValue>
    try { next = applyUISteps(doc, steps, values, vars, env.locale) } catch { setNotice(t('iui.setFailed')); return }
    const apply = (): void => update(s => ({ ...s, vars: Object.fromEntries(next) }))
    if (moves(values, next)) reflow(root.current, apply); else apply()
  }
  // A picture changing size reflows its row and everything below it. Folds animate in CSS and keep using expand().
  const zoom = (id: string, expanded: boolean): void => live ? expand(id, expanded) : reflow(root.current, () => expand(id, expanded))
  const draw = (block: UIBlock): React.ReactNode => {
    switch (block.kind) {
      case 'text': { const md = doc.version === 2 ? env.slots(block.markdown) : undefined; return <div className="iui-prose"><RichText text={md?.markdown ?? block.markdown} values={md?.values} /></div> }
      case 'stats': return <dl className="iui-stats">{block.items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd aria-live="polite">{env.text(item.value)}</dd></div>)}</dl>
      case 'table': return <Table block={block} env={env} />
      case 'controls': return <div className="iui-controls">{block.inputIds.map(id => {
        const input = doc.inputs.find(i => i.id === id)!
        const setValue = (value: string | number): void => {
          const apply = (): void => update(s => ({ ...s, values: { ...s.values, [id]: value } }))
          // Only a pick that shows or hides blocks or list rows is a reflow; a plain selection stays a plain update.
          if (moves({ ...values, [id]: value }, vars)) reflow(root.current, apply); else apply()
        }
        if (input.kind === 'number') return <div key={id} className="iui-number" role="group" aria-label={input.label}>
          <span>{input.label}</span><div className="iui-stepper">
            <button type="button" aria-label={`${input.label} −`} disabled={Number(values[id]) <= input.min} onClick={() => setValue(snapUIValue(Number(values[id]) - input.step, input))}><Minus size={16} /></button>
            <output aria-live="polite">{formatUIQuantity(Number(values[id]))}</output>
            <button type="button" aria-label={`${input.label} +`} disabled={Number(values[id]) >= input.max} onClick={() => setValue(snapUIValue(Number(values[id]) + input.step, input))}><Plus size={16} /></button>
          </div>
        </div>
        const name = `${stateKey || doc.id}:${id}`, pictured = !!input.options[0]?.imageId
        // Four pictures sit two by two: three in a row would leave the fourth alone on the next line.
        const columns = pictured && input.options.length === 4 ? 2 : Math.min(3, input.options.length)
        return <fieldset key={id} className={`iui-choice${pictured ? ' iui-pick' : segmented(input) ? ' iui-seg' : ''}`}><legend>{input.label}</legend><div className="iui-parallel" data-columns={columns}>{input.options.map(option => {
          const selected = values[id] === option.id, image = option.imageId && resources.get(option.imageId) as ImageResource
          // The source host stays on the card only when no sources block already lists that source.
          if (image) return <PickCard key={option.id} name={name} option={option} resource={image} source={image.sourceId && !listed.has(image.sourceId) ? resources.get(image.sourceId) : undefined} selected={selected} onSelect={() => setValue(option.id)}
            expanded={!!state.expanded[uiExpansionKey('image', block.id, option.imageId)]} onExpand={value => zoom(uiExpansionKey('image', block.id, option.imageId), value)} flip={`p:${block.id}:${option.imageId}`} />
          return <label key={option.id} data-selected={selected || undefined}>
            <input type="radio" name={name} value={option.id} checked={selected} onChange={() => setValue(option.id)} />
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>
        })}</div></fieldset>
      })}</div>
      case 'gallery': return <div className="iui-gallery">{block.resourceIds.filter(id => !optionImages.has(id)).map(id => <Picture key={id} resource={resources.get(id) as Extract<UIResource, { kind: 'image' }>} sources={resources} expanded={!!state.expanded[uiExpansionKey('image', block.id, id)]} onExpand={value => zoom(uiExpansionKey('image', block.id, id), value)} flip={`p:${block.id}:${id}`} />)}</div>
      case 'sources': return <div className="iui-sources">{block.resourceIds.map(id => {
        const r = resources.get(id) as Extract<UIResource, { kind: 'source' }>
        // The summary itself is the two-line preview; opening it only lifts the clamp.
        return <div key={id} className="iui-source"><ChatWebLink href={r.url} quote=""><span>{r.title}</span><small>{new URL(r.url).hostname}</small><ExternalLink size={14} /></ChatWebLink>{r.description && <details open={!!state.expanded[uiExpansionKey('source', block.id, id)]} onToggle={e => expand(uiExpansionKey('source', block.id, id), e.currentTarget.open)}><summary><span>{r.description}</span></summary></details>}</div>
      })}</div>
      case 'app-card': return complete ? <IntelligentAppCard cardId={block.cardId} query={block.query} /> : live ? <Skeleton /> : <div className="iui-status">{t('iui.incomplete')}</div>
      case 'comparison': return <div className="iui-parallel iui-comparison" data-columns={Math.min(3, block.items.length)}>{block.items.map(item => <article key={item.id}>
        {item.imageId && !optionImages.has(item.imageId) && <Picture resource={resources.get(item.imageId) as Extract<UIResource, { kind: 'image' }>} sources={resources} expanded={!!state.expanded[uiExpansionKey('image', block.id, item.imageId)]} onExpand={value => zoom(uiExpansionKey('image', block.id, item.imageId), value)} flip={`p:${block.id}:${item.imageId}`} />}
        <strong>{item.title}</strong><p>{item.description}</p><ul>{item.facts.map((fact, i) => <li key={i}>{fact}</li>)}</ul>
      </article>)}</div>
      case 'checklist': {
        const rows = deriveChecklist(block, values, state, env), done = rows.filter(r => r.checked).length
        const prose = rows.some(row => row.amount === undefined || row.label.length > 80)
        return <div className="iui-checklist"><div className="iui-list-head">{block.title && <h4>{block.title}</h4>}<span className="iui-count" aria-live="polite">{block.title ? `${done}/${rows.length}` : t('iui.progress', { done, total: rows.length })}</span><div>
          <button type="button" aria-label={t('iui.copy')} title={t('iui.copy')} onClick={() => void copy(rows.map(r => `${r.checked ? '☑' : '☐'} ${r.label}${r.amount === undefined ? '' : ` ${formatUIQuantity(r.amount)} ${r.unit}`}`).join('\n'))}><Copy size={14} /></button>
          <button type="button" aria-label={t('iui.reset')} title={t('iui.reset')} disabled={!rows.some(r => state.purchased[r.key] !== undefined)} onClick={() => update(s => ({ ...s, purchased: Object.fromEntries(Object.entries(s.purchased).filter(([key]) => !rows.some(r => r.key === key))) }))}><RotateCcw size={14} /></button>
        </div></div><progress value={done} max={Math.max(1, rows.length)} aria-label={t('iui.progress', { done, total: rows.length })} />
        <div className={prose ? 'iui-check-rows iui-prose' : 'iui-check-rows'}>{rows.map(row => <label key={row.key} data-checked={row.checked || undefined}>
          <input type="checkbox" checked={row.checked} ref={el => { if (el) el.indeterminate = !!row.shortfall }} onChange={() => update(s => {
            const purchased = { ...s.purchased }
            if (row.checked) delete purchased[row.key]; else purchased[row.key] = row.amount ?? true
            return { ...s, purchased }
          })} />
          <span>{row.label}{row.shortfall !== undefined && <small>{t('iui.remaining', { quantity: `${formatUIQuantity(row.shortfall)} ${row.unit}` })}</small>}</span>
          {row.amount !== undefined && <span className="iui-quantity">{formatUIQuantity(row.amount)} {row.unit}</span>}
        </label>)}</div></div>
      }
      case 'disclosure': {
        const md = doc.version === 2 ? env.slots(block.markdown) : undefined
        const key = uiExpansionKey('disclosure', block.id, md?.values.length ? contentKey(md.values.join('\u0000')) : undefined)
        if (md?.values.length) foldKeys.set(block.id, key)
        return <details key={key} open={!!state.expanded[key]} onToggle={e => fold(block.id, key, e.currentTarget.open)}><summary>{block.title}<ChevronDown size={16} /></summary><div className="iui-detail-content iui-prose"><RichText text={md?.markdown ?? block.markdown} values={md?.values} /></div></details>
      }
      case 'actions': return <div className="iui-actions">{block.items.map(action => action.kind === 'open'
        ? <ChatWebLink key={action.id} href={resources.get(action.resourceId)!.url} quote="">{action.label}<ExternalLink size={14} /></ChatWebLink>
        : action.kind === 'copy' ? <button type="button" key={action.id} onClick={() => void copy(action.text)}>{action.label}<Copy size={14} /></button>
        // Changes this card only: no message, no model. A condition that fails keeps the button off.
        : action.kind === 'set' ? <button type="button" key={action.id} disabled={live || (action.disabled !== undefined && (() => { const c = env.cell(action.disabled); return !c.ok || truthy(c.value) })())} onClick={() => runSteps(action.steps)}>{action.label}</button>
        // Same chip as the suggestions under an answer: it sends a visible user message.
        : <button type="button" key={action.id} className="t2-suggest-chip" disabled={!complete || !onAsk || live} title={t('iui.modelAction')} onClick={() => {
          // Inputs as set, plus state the card's buttons changed; derived values stay out (the model computes its own).
          const changed = (doc.state || []).filter(v => !sameValue(vars.get(v.id) ?? null, v.initial)).map(v => `${v.id}: ${brief(vars.get(v.id) ?? null)}`)
          onAsk?.(`${action.prompt}\n\n${t('iui.current')} (${doc.title}):\n${doc.inputs.map(i => `${i.label}: ${i.kind === 'choice' ? i.options.find(o => o.id === values[i.id])?.label : values[i.id]}`).join('\n')}${changed.length ? `\n${t('iui.state')}:\n${changed.join('\n')}` : ''}`)
        }}><Zap size={13} />{action.label}</button>)}</div>
    }
  }
  return <section ref={root} className="intelligent-ui" aria-label={doc.title} data-document-id={doc.id} data-complete={complete} data-streamed={streamed || undefined}>
    <h3 className="iui-title">{doc.title}</h3>
    {doc.blocks.filter(b => shows(b.when) && !(b.kind === 'gallery' && b.resourceIds.length && b.resourceIds.every(id => optionImages.has(id)))).map(block => <div key={block.id} className={`iui-block iui-block-${block.kind}`} data-block-id={block.id} data-flip={`b:${block.id}`}>
      {block.title && !OWN_TITLE.has(block.kind) && <h4>{block.title}</h4>}{draw(block)}
    </div>)}
    {!complete && (live ? <Skeleton /> : <div className="iui-status" role="status">{t('iui.incomplete')}</div>)}
    {notice && <div className="iui-notice" role="status"><Check size={14} />{notice}</div>}
  </section>
}
