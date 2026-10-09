import { useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, Copy, ExternalLink, Minus, Plus, RotateCcw } from 'lucide-react'
import { parseUIDraft, safeUIUrl, snapUIValue, validateUIDocument, type UIBlock, type UIDocument, type UIResource } from '../../../../tangu-agent/src/shared/intelligentUi'
import type { ToolEvent } from '../types'
import { streamingArgString } from '../views/streamingWrite'
import { registerMessages, useI18n } from '../i18n'
import { ChatWebLink } from './ChatWikiLink'
import { deriveChecklist, emptyUIState, formatUIQuantity, inputValues, readUIState, uiExpansionKey, uiStateKey, visible, writeUIState, type UIUserState } from './intelligentUiState'
import './IntelligentUi.css'

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
  'iui.summary': { zh: '摘要', en: 'Summary' },
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
  if (!doc) return <div className="iui-status" role="status">{t(live && !event.done ? 'iui.loading' : 'iui.invalid')}</div>
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

function NativeDocument({ doc, complete, live, stateKey, onAsk }: { doc: UIDocument; complete: boolean; live: boolean; stateKey?: string; onAsk?: (text: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  // Hydrate before the first paint. Model defaults are never written over the user's state.
  const [state, setState] = useState<UIUserState>(() => stateKey ? readUIState(stateKey) : emptyUIState())
  const [notice, setNotice] = useState('')
  const values = inputValues(doc, state)
  const resources = new Map(doc.resources.map(r => [r.id, r]))
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
      case 'text': return <RichText text={block.markdown} />
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
        return <fieldset key={id} className="iui-choice"><legend>{input.label}</legend><div className="iui-parallel" data-columns={Math.min(3, input.options.length)}>{input.options.map(option => <label key={option.id} data-selected={values[id] === option.id || undefined}>
          <input type="radio" name={`${stateKey || doc.id}:${id}`} value={option.id} checked={values[id] === option.id} onChange={() => setValue(option.id)} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}</div></fieldset>
      })}</div>
      case 'gallery': return <div className="iui-gallery">{block.resourceIds.map(id => <Picture key={id} resource={resources.get(id) as Extract<UIResource, { kind: 'image' }>} sources={resources} expanded={!!state.expanded[uiExpansionKey('image', block.id, id)]} onExpand={value => expand(uiExpansionKey('image', block.id, id), value)} />)}</div>
      case 'sources': return <div className="iui-sources">{block.resourceIds.map(id => {
        const r = resources.get(id) as Extract<UIResource, { kind: 'source' }>
        return <div key={id} className="iui-source"><ChatWebLink href={r.url} quote=""><span>{r.title}</span><ExternalLink size={14} /></ChatWebLink><small>{new URL(r.url).hostname}</small>{r.description && <details open={!!state.expanded[uiExpansionKey('source', block.id, id)]} onToggle={e => expand(uiExpansionKey('source', block.id, id), e.currentTarget.open)}><summary>{t('iui.summary')}<ChevronDown size={14} /></summary><p>{r.description}</p></details>}</div>
      })}</div>
      case 'comparison': return <div className="iui-parallel iui-comparison" data-columns={Math.min(3, block.items.length)}>{block.items.map(item => <article key={item.id}>
        {item.imageId && <Picture resource={resources.get(item.imageId) as Extract<UIResource, { kind: 'image' }>} sources={resources} expanded={!!state.expanded[uiExpansionKey('image', block.id, item.imageId)]} onExpand={value => expand(uiExpansionKey('image', block.id, item.imageId), value)} />}
        <strong>{item.title}</strong><p>{item.description}</p><ul>{item.facts.map((fact, i) => <li key={i}>{fact}</li>)}</ul>
      </article>)}</div>
      case 'checklist': {
        const rows = deriveChecklist(block, values, state), done = rows.filter(r => r.checked).length
        return <div className="iui-checklist"><div className="iui-list-toolbar"><span aria-live="polite">{t('iui.progress', { done, total: rows.length })}</span><div>
          <button type="button" onClick={() => void copy(rows.map(r => `${r.checked ? '☑' : '☐'} ${r.label}${r.amount === undefined ? '' : ` ${formatUIQuantity(r.amount)} ${r.unit}`}`).join('\n'))}><Copy size={14} />{t('iui.copy')}</button>
          <button type="button" aria-label={t('iui.reset')} title={t('iui.reset')} disabled={!rows.some(r => state.purchased[r.key] !== undefined)} onClick={() => update(s => ({ ...s, purchased: Object.fromEntries(Object.entries(s.purchased).filter(([key]) => !rows.some(r => r.key === key))) }))}><RotateCcw size={14} /></button>
        </div></div><progress value={done} max={Math.max(1, rows.length)} aria-label={t('iui.progress', { done, total: rows.length })} />
        <div className="iui-check-rows" data-prose={rows.some(row => row.amount === undefined || row.label.length > 80) || undefined}>{rows.map(row => <label key={row.key} data-checked={row.checked || undefined}>
          <input type="checkbox" checked={row.checked} ref={el => { if (el) el.indeterminate = !!row.shortfall }} onChange={() => update(s => {
            const purchased = { ...s.purchased }
            if (row.checked) delete purchased[row.key]; else purchased[row.key] = row.amount ?? true
            return { ...s, purchased }
          })} />
          <span>{row.label}{row.shortfall !== undefined && <small>{t('iui.remaining', { quantity: `${formatUIQuantity(row.shortfall)} ${row.unit}` })}</small>}</span>
          {row.amount !== undefined && <span className="iui-quantity">{formatUIQuantity(row.amount)} {row.unit}</span>}
        </label>)}</div></div>
      }
      case 'disclosure': return <details open={!!state.expanded[uiExpansionKey('disclosure', block.id)]} onToggle={e => expand(uiExpansionKey('disclosure', block.id), e.currentTarget.open)}><summary>{block.title}<ChevronDown size={16} /></summary><div className="iui-detail-content"><RichText text={block.markdown} /></div></details>
      case 'actions': return <div className="iui-actions">{block.items.map(action => action.kind === 'open'
        ? <ChatWebLink key={action.id} href={resources.get(action.resourceId)!.url} quote="">{action.label}<ExternalLink size={14} /></ChatWebLink>
        : <button type="button" key={action.id} disabled={action.kind === 'model' && (!complete || !onAsk || live)} title={action.kind === 'model' ? t('iui.modelAction') : undefined} onClick={() => {
          if (action.kind === 'copy') void copy(action.text)
          else onAsk?.(`${action.prompt}\n\n${t('iui.current')} (${doc.title}):\n${doc.inputs.map(i => `${i.label}: ${i.kind === 'choice' ? i.options.find(o => o.id === values[i.id])?.label : values[i.id]}`).join('\n')}`)
        }}>{action.label}{action.kind === 'copy' ? <Copy size={14} /> : <span aria-hidden="true">↗</span>}</button>)}</div>
    }
  }
  return <section className="intelligent-ui" aria-label={doc.title} data-document-id={doc.id} data-complete={complete}>
    <h3 className="iui-title">{doc.title}</h3>
    {doc.blocks.filter(b => visible(b.when, values)).map(block => <div key={block.id} className={`iui-block iui-block-${block.kind}`} data-block-id={block.id}>
      {block.title && block.kind !== 'disclosure' && <h4>{block.title}</h4>}{draw(block)}
    </div>)}
    {!complete && <div className="iui-status" role="status">{t(live ? 'iui.loading' : 'iui.incomplete')}</div>}
    {notice && <div className="iui-notice" role="status"><Check size={14} />{notice}</div>}
  </section>
}
