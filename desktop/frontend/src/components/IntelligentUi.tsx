import { useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, Copy, ExternalLink, Maximize2, Minimize2, Minus, Plus, RotateCcw, Zap } from 'lucide-react'
import { parseUIDraft, safeUIUrl, snapUIValue, validateUIDocument, type UIBlock, type UIDocument, type UIInput, type UIResource } from '../../../../tangu-agent/src/shared/intelligentUi'
import type { ToolEvent } from '../types'
import { streamingArgString } from '../views/streamingWrite'
import { registerMessages, useI18n } from '../i18n'
import { ChatWebLink } from './ChatWikiLink'
import { deriveChecklist, emptyUIState, formatUIQuantity, inputValues, readUIState, uiExpansionKey, uiStateKey, visible, writeUIState, type UIUserState } from './intelligentUiState'
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
  if (!doc) return live && !event.done ? <div className="intelligent-ui"><Skeleton /></div> : <div className="iui-status" role="status">{t('iui.invalid')}</div>
  return <NativeDocument key={uiStateKey(stateScope || '', event.id, doc.id)} doc={doc} complete={current.complete} live={live && !event.done} stateKey={stateScope ? uiStateKey(stateScope, event.id, doc.id) : undefined} onAsk={onAsk} />
}

function RichText({ text }: { text: string }): React.JSX.Element {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img', 'input']} components={{
    a: ({ href, children }) => safeUIUrl(href) ? <ChatWebLink href={href}>{children}</ChatWebLink> : <span>{children}</span>,
  }}>{text}</ReactMarkdown>
}

function Picture({ resource, sources, expanded, onExpand }: { resource: Extract<UIResource, { kind: 'image' }>; sources: Map<string, UIResource>; expanded: boolean; onExpand: (expanded: boolean) => void }): React.JSX.Element {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const source = resource.sourceId ? sources.get(resource.sourceId) : undefined
  return <figure className="iui-picture" data-expanded={expanded || undefined}>
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
function PickCard({ name, option, resource, source, selected, onSelect, expanded, onExpand }: { name: string; option: ChoiceInput['options'][number]; resource: ImageResource; source?: UIResource; selected: boolean; onSelect: () => void; expanded: boolean; onExpand: (expanded: boolean) => void }): React.JSX.Element {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  return <div className="iui-pick-card" data-selected={selected || undefined} data-expanded={expanded || undefined}>
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

function NativeDocument({ doc, complete, live, stateKey, onAsk }: { doc: UIDocument; complete: boolean; live: boolean; stateKey?: string; onAsk?: (text: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  // Hydrate before the first paint. Model defaults are never written over the user's state.
  const [state, setState] = useState<UIUserState>(() => stateKey ? readUIState(stateKey) : emptyUIState())
  const [notice, setNotice] = useState('')
  // Blocks fade in only for a document that was seen arriving; replayed history stays still.
  const streamed = useRef(live).current
  const values = inputValues(doc, state)
  const resources = new Map(doc.resources.map(r => [r.id, r]))
  // Sources a visible sources block already lists; a hidden block must not strip a picture of its attribution.
  const listed = new Set(doc.blocks.flatMap(b => b.kind === 'sources' && visible(b.when, values) ? b.resourceIds : []))
  const update = (fn: (s: UIUserState) => UIUserState): void => setState(previous => {
    const next = fn(previous)
    if (stateKey) writeUIState(stateKey, next)
    return next
  })
  const copy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setNotice(t('iui.copied')) } catch { setNotice(t('iui.copyFailed')) }
  }
  const expand = (id: string, expanded: boolean): void => update(s => s.expanded[id] === expanded ? s : ({ ...s, expanded: { ...s.expanded, [id]: expanded } }))
  const draw = (block: UIBlock): React.ReactNode => {
    switch (block.kind) {
      case 'text': return <div className="iui-prose"><RichText text={block.markdown} /></div>
      case 'controls': return <div className="iui-controls">{block.inputIds.map(id => {
        const input = doc.inputs.find(i => i.id === id)!
        const setValue = (value: string | number): void => update(s => ({ ...s, values: { ...s.values, [id]: value } }))
        if (input.kind === 'number') return <div key={id} className="iui-number" role="group" aria-label={input.label}>
          <span>{input.label}</span><div className="iui-stepper">
            <button type="button" aria-label={`${input.label} −`} disabled={Number(values[id]) <= input.min} onClick={() => setValue(snapUIValue(Number(values[id]) - input.step, input))}><Minus size={16} /></button>
            <output aria-live="polite">{formatUIQuantity(Number(values[id]))}</output>
            <button type="button" aria-label={`${input.label} +`} disabled={Number(values[id]) >= input.max} onClick={() => setValue(snapUIValue(Number(values[id]) + input.step, input))}><Plus size={16} /></button>
          </div>
        </div>
        const name = `${stateKey || doc.id}:${id}`, pictured = !!input.options[0]?.imageId
        return <fieldset key={id} className={`iui-choice${pictured ? ' iui-pick' : segmented(input) ? ' iui-seg' : ''}`}><legend>{input.label}</legend><div className="iui-parallel" data-columns={Math.min(3, input.options.length)}>{input.options.map(option => {
          const selected = values[id] === option.id, image = option.imageId && resources.get(option.imageId) as ImageResource
          // The source host stays on the card only when no sources block already lists that source.
          if (image) return <PickCard key={option.id} name={name} option={option} resource={image} source={image.sourceId && !listed.has(image.sourceId) ? resources.get(image.sourceId) : undefined} selected={selected} onSelect={() => setValue(option.id)}
            expanded={!!state.expanded[uiExpansionKey('image', block.id, option.imageId)]} onExpand={value => expand(uiExpansionKey('image', block.id, option.imageId), value)} />
          return <label key={option.id} data-selected={selected || undefined}>
            <input type="radio" name={name} value={option.id} checked={selected} onChange={() => setValue(option.id)} />
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>
        })}</div></fieldset>
      })}</div>
      case 'gallery': return <div className="iui-gallery">{block.resourceIds.map(id => <Picture key={id} resource={resources.get(id) as Extract<UIResource, { kind: 'image' }>} sources={resources} expanded={!!state.expanded[uiExpansionKey('image', block.id, id)]} onExpand={value => expand(uiExpansionKey('image', block.id, id), value)} />)}</div>
      case 'sources': return <div className="iui-sources">{block.resourceIds.map(id => {
        const r = resources.get(id) as Extract<UIResource, { kind: 'source' }>
        // The summary itself is the two-line preview; opening it only lifts the clamp.
        return <div key={id} className="iui-source"><ChatWebLink href={r.url} quote=""><span>{r.title}</span><small>{new URL(r.url).hostname}</small><ExternalLink size={14} /></ChatWebLink>{r.description && <details open={!!state.expanded[uiExpansionKey('source', block.id, id)]} onToggle={e => expand(uiExpansionKey('source', block.id, id), e.currentTarget.open)}><summary><span>{r.description}</span></summary></details>}</div>
      })}</div>
      case 'app-card': return complete ? <IntelligentAppCard cardId={block.cardId} query={block.query} /> : live ? <Skeleton /> : <div className="iui-status">{t('iui.incomplete')}</div>
      case 'comparison': return <div className="iui-parallel iui-comparison" data-columns={Math.min(3, block.items.length)}>{block.items.map(item => <article key={item.id}>
        {item.imageId && <Picture resource={resources.get(item.imageId) as Extract<UIResource, { kind: 'image' }>} sources={resources} expanded={!!state.expanded[uiExpansionKey('image', block.id, item.imageId)]} onExpand={value => expand(uiExpansionKey('image', block.id, item.imageId), value)} />}
        <strong>{item.title}</strong><p>{item.description}</p><ul>{item.facts.map((fact, i) => <li key={i}>{fact}</li>)}</ul>
      </article>)}</div>
      case 'checklist': {
        const rows = deriveChecklist(block, values, state), done = rows.filter(r => r.checked).length
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
      case 'disclosure': return <details open={!!state.expanded[uiExpansionKey('disclosure', block.id)]} onToggle={e => expand(uiExpansionKey('disclosure', block.id), e.currentTarget.open)}><summary>{block.title}<ChevronDown size={16} /></summary><div className="iui-detail-content iui-prose"><RichText text={block.markdown} /></div></details>
      case 'actions': return <div className="iui-actions">{block.items.map(action => action.kind === 'open'
        ? <ChatWebLink key={action.id} href={resources.get(action.resourceId)!.url} quote="">{action.label}<ExternalLink size={14} /></ChatWebLink>
        : action.kind === 'copy' ? <button type="button" key={action.id} onClick={() => void copy(action.text)}>{action.label}<Copy size={14} /></button>
        // Same chip as the suggestions under an answer: it sends a visible user message.
        : <button type="button" key={action.id} className="t2-suggest-chip" disabled={!complete || !onAsk || live} title={t('iui.modelAction')} onClick={() => {
          onAsk?.(`${action.prompt}\n\n${t('iui.current')} (${doc.title}):\n${doc.inputs.map(i => `${i.label}: ${i.kind === 'choice' ? i.options.find(o => o.id === values[i.id])?.label : values[i.id]}`).join('\n')}`)
        }}><Zap size={13} />{action.label}</button>)}</div>
    }
  }
  return <section className="intelligent-ui" aria-label={doc.title} data-document-id={doc.id} data-complete={complete} data-streamed={streamed || undefined}>
    <h3 className="iui-title">{doc.title}</h3>
    {doc.blocks.filter(b => visible(b.when, values)).map(block => <div key={block.id} className={`iui-block iui-block-${block.kind}`} data-block-id={block.id}>
      {block.title && !OWN_TITLE.has(block.kind) && <h4>{block.title}</h4>}{draw(block)}
    </div>)}
    {!complete && (live ? <Skeleton /> : <div className="iui-status" role="status">{t('iui.incomplete')}</div>)}
    {notice && <div className="iui-notice" role="status"><Check size={14} />{notice}</div>}
  </section>
}
