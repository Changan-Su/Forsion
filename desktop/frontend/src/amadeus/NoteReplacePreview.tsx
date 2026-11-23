import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Root, Element, ElementContent } from 'hast'
import type { Plugin } from 'unified'
import { create } from 'zustand'
import { toString } from 'mdast-util-to-string'
import { displayRanges } from './lib/noteReplaceDisplayRanges'
import { splitFm } from './unified/fm'
import type { ReplaceFile, ReplaceMatch, ReplacePlan } from '@amadeus/lib/noteBatchReplace'
import { usePageStore } from '@amadeus/store/pageStore'
import { parseMarkdown, remarkCachedParse } from '../components/markdownParse'
import { rehypeCachedKatex } from '../components/rehypeCachedKatex'
import { useI18n } from '../i18n'

export const REVIEW_VIEW = 'amadeus-replace-preview'

export interface NoteReplacePreview {
  root: string
  file: ReplaceFile
  selected: ReadonlySet<string>
  replacement: string
  activeId: string
}

export const useReplacePreview = create<{ current: NoteReplacePreview | null }>(() => ({ current: null }))

type SelectionPlan = Pick<ReplacePlan, 'scope' | 'query' | 'files'>
export interface PreviousSelection { plan: SelectionPlan; selected: ReadonlySet<string> }

/** A source offset only identifies one occurrence within a particular revision of a note. */
export function reviewSelection(plan: SelectionPlan, previous: PreviousSelection | null) {
  const selected = new Set<string>(), needsReview = new Set<string>()
  const prior = previous?.plan.query === plan.query ? previous : null
  const previousFiles = new Map(prior?.plan.files.map(file => [file.path, file]))
  for (const file of plan.files) {
    const old = previousFiles.get(file.path)
    if (prior && (prior.plan.scope !== plan.scope || !old || old.source !== file.source || old.fileId !== file.fileId)) {
      needsReview.add(file.path)
      continue
    }
    for (const match of file.matches) {
      if (prior ? prior.selected.has(match.id) : !match.quote) selected.add(match.id)
    }
  }
  return { selected, needsReview }
}

export function noteTitle(path: string): string {
  return (path.split('/').pop() || path).replace(/\.md$/i, '')
}

const plain = (value: string): ElementContent => ({ type: 'text', value })
const tag = (tagName: string, children: ElementContent[], properties: Element['properties'] = {}): Element =>
  ({ type: 'element', tagName, properties, children })

/** Mark original source ranges after Markdown parsing. User replacements only become text, even if
 * they look like HTML or Markdown. Text leaves may decode escapes or contain continuation prefixes. */
function diffMarks(view: NoteReplacePreview, body: string): Plugin<[], Root> {
  const start = view.file.source.length - body.length
  const matches = view.file.matches
  return () => (tree) => {
    let next = 0
    function markText(child: ElementContent): ElementContent[] {
      if (child.type === 'element') {
        child.children = child.children.flatMap(markText)
        return [child]
      }
      if (child.type !== 'text' || !child.position) return [child]
      const from = child.position.start.offset
      const to = child.position.end.offset
      if (from == null || to == null) return [child]
      while (next < matches.length && matches[next].to <= from + start) next++
      const first = next
      while (next < matches.length && matches[next].from >= from + start && matches[next].to <= to + start) next++
      if (first === next) return [child]
      const parts: ElementContent[] = []
      const raw = body.slice(from, to)
      const hits = matches.slice(first, next)
      const ranges = displayRanges(raw, child.value, hits, from + start)
      let cursor = 0
      for (const {hit, left, right} of ranges) {
        parts.push(plain(child.value.slice(cursor, left)))
        const original = plain(child.value.slice(left, right))
        const diff = view.selected.has(hit.id)
          ? [tag('del', [original]), ...(view.replacement ? [tag('ins', [plain(view.replacement)])] : [])]
          : [original]
        parts.push(tag('span', diff, { dataReplaceId: hit.id, dataActive: hit.id === view.activeId ? 'true' : undefined, className: ['amx-replace-mark'] }))
        cursor = right
      }
      parts.push(plain(child.value.slice(cursor)))
      return parts
    }
    tree.children.forEach((node) => {
      if (node.type === 'element') node.children = node.children.flatMap(markText)
    })
  }
}

type Snippet = [string, string, string]
const snippets = new WeakMap<ReplaceMatch, Snippet>()

/** Keep Markdown punctuation out of result rows. Parse just the short excerpt; the selected word
 * is carried by an inert placeholder, so repeated words and formatting around it stay distinct. */
export function matchContext(file: ReplaceFile, match: ReplaceMatch): Snippet {
  const cached = snippets.get(match)
  if (cached) return cached
  const { from, to } = match
  const left = Math.max(file.source.lastIndexOf('\n', from - 1) + 1, from - 48)
  const end = file.source.indexOf('\n', to)
  const right = Math.min(end < 0 ? file.source.length : end, to + 80)
  let before = file.source.slice(left, from), after = file.source.slice(to, right)
  const word = file.source.slice(from, to)
  if (/[<>*_~\x60\[\]#!\\&]/.test(before + after)) {
    let marker = '\uE000'
    while (before.includes(marker) || after.includes(marker)) marker += '\uE000'
    const cleaned = toString(parseMarkdown(before + marker + after), { includeHtml: false })
    const at = cleaned.indexOf(marker)
    if (at >= 0) { before = cleaned.slice(0, at); after = cleaned.slice(at + marker.length) }
  }
  const snippet: Snippet = [before, word, after]
  snippets.set(match, snippet)
  return snippet
}

export function NoteReplaceBody({ view }: { view: NoteReplacePreview }) {
  const { t } = useI18n()
  const body = useMemo(() => splitFm(view.file.source).body, [view.file.source])
  const marks = useMemo(() => diffMarks(view, body), [view, body])
  const paper = useRef<HTMLDivElement>(null)
  const [unmapped, setUnmapped] = useState('')
  useEffect(() => {
    const el = paper.current?.querySelector<HTMLElement>(`[data-replace-id="${CSS.escape(view.activeId)}"]`)
    setUnmapped(el ? '' : view.activeId)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [view.activeId, view.file])
  const fallback = unmapped === view.activeId ? view.file.matches.find(hit => hit.id === unmapped) : undefined
  const context = fallback && matchContext(view.file, fallback)
  return <div className="amx-replace-paper" ref={paper}>
    <article className="amx-doc">
      <p className="amx-replace-path">{view.file.path}</p>
      <h1 className="amx-title-input amx-title-static">{noteTitle(view.file.path)}</h1>
      {fallback && context && <aside className="amx-replace-source-context">
        <small>{t('noteReplace.exactContext')}</small><p>{context[0]}{view.selected.has(fallback.id)
          ? <><del>{context[1]}</del> <ins>{view.replacement}</ins></> : <mark>{context[1]}</mark>}{context[2]}</p>
      </aside>}
      <div className="amx-replace-body md-body" aria-label={t('noteReplace.preview')}>
        <ReactMarkdown remarkPlugins={[remarkCachedParse]} rehypePlugins={[marks, rehypeCachedKatex]} skipHtml
          components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>
          {body}
        </ReactMarkdown>
      </div>
    </article>
  </div>
}

export function NoteReplacePreviewView() {
  const { t } = useI18n()
  const view = useReplacePreview(s => s.current)
  const root = usePageStore(s => s.vaultRoot)
  return view && root === view.root
    ? <NoteReplaceBody view={view} />
    : <div className="amx-panel-empty">{t('noteReplace.chooseMatch')}</div>
}
