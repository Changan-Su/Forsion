import type { NoteReadingSnapshot, NoteRendererContribution } from '../plugins/noteRenderers'
import { cancelScrollToElement } from '@lcl/engine'
import { stickyTopInset, READING_GAP } from './revealScroll'

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,pre,li,table,blockquote,img'
/** Anchor ids belong only to the snapshot: never mutate the owning ProseMirror DOM. */
export function markReadingAnchors(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(BLOCKS).forEach((el, i) => { el.dataset.readingAnchor = String(i) })
}
export function readingSnapshot(root: HTMLElement, path: string, markdown: string, revision: number): NoteReadingSnapshot {
  const copy = root.cloneNode(true) as HTMLElement
  markReadingAnchors(copy)
  copy.removeAttribute('contenteditable')
  const sourceChecks = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  copy.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el, index) => {
    el.disabled = true
    el.toggleAttribute('checked', sourceChecks[index]?.checked ?? false)
  })
  copy.querySelectorAll('script,style,iframe,object,embed,button,input:not([type="checkbox"]),textarea,select,.drag-handle,.ProseMirror-separator,.amx-fold-caret,.amx-code-tools,.mk-code-tools').forEach((el) => el.remove())
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('contenteditable')
    el.removeAttribute('draggable')
    el.removeAttribute('tabindex')
    el.classList.remove('ProseMirror-focused', 'ProseMirror-selectednode', 'amx-fold-hidden', 'amx-listitem-folded', 'amx-heading-folded', 'callout-collapsed')
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || a.name === 'srcdoc' || ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name)
    }
  }
  return Object.freeze({ path, markdown, html: copy.outerHTML, revision })
}

/** The bundled official module consumes only the same immutable snapshot that external modules receive. */
export const officialNoteRenderer: NoteRendererContribution = {
  id: 'amadeus-reading', apiVersion: 1,
  mount(el, snapshot, host) {
    el.classList.add('milkdown')
    el.innerHTML = snapshot.html
    const click = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const wiki = target?.closest<HTMLElement>('[data-wiki],[data-wiki-open]')
      const link = target?.closest<HTMLAnchorElement>('a[href]')
      const href = wiki?.dataset.wiki ?? wiki?.dataset.wikiOpen ?? link?.getAttribute('href')
      if (!href) return
      event.preventDefault()
      event.stopPropagation()
      if (!host.signal.aborted) host.openLink(href, wiki ? 'wiki' : 'url')
    }
    el.addEventListener('click', click)
    return () => el.removeEventListener('click', click)
  },
}

export interface ReadingPosition { top: number; anchor?: string; text?: string; offset?: number }
function readingBlocks(root: HTMLElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>(BLOCKS) ?? [])]
}
/** Match a native document block to the static surface without touching the editor's DOM. */
export function readingCounterpart(editor: HTMLElement, reader: HTMLElement | null, node: Node | null): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null
  const block = node.matches(BLOCKS) ? node : node.closest<HTMLElement>(BLOCKS)
  const index = block ? readingBlocks(editor).indexOf(block) : -1
  return index < 0 ? null : reader?.querySelector<HTMLElement>(`[data-reading-anchor="${index}"]`) ?? null
}
export function captureReadingPosition(root: HTMLElement | null, scroll: HTMLElement): ReadingPosition {
  const y = scroll.getBoundingClientRect().top + stickyTopInset(scroll) + READING_GAP
  const blocks = readingBlocks(root)
  const i = blocks.findIndex((node) => node.getBoundingClientRect().bottom > y)
  const el = blocks[i]
  return { top: scroll.scrollTop, ...(el ? { anchor: el.dataset.readingAnchor ?? String(i), text: el.textContent?.slice(0, 80), offset: el.getBoundingClientRect().top - y } : {}) }
}
export function restoreReadingPosition(root: HTMLElement | null, scroll: HTMLElement, position: ReadingPosition): void {
  const candidates = readingBlocks(root)
  const el = candidates.find((node, i) => (node.dataset.readingAnchor ?? String(i)) === position.anchor && node.textContent?.slice(0, 80) === position.text)
  cancelScrollToElement(scroll)
  scroll.scrollTop = position.top
  const zoom = (scroll as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  if (el && position.offset != null) scroll.scrollTop += (el.getBoundingClientRect().top - (scroll.getBoundingClientRect().top + stickyTopInset(scroll) + READING_GAP) - position.offset) / zoom
}

/** Wait for the committed IME transaction before taking a synchronous editor snapshot. */
export async function prepareReadingSnapshot<T>(options: {
  waitForComposition(): Promise<void>
  active(): boolean
  capture(): void
  flush(): Promise<void>
  snapshot(): T
}): Promise<T | null> {
  await options.waitForComposition()
  if (!options.active()) return null
  options.capture()
  await options.flush()
  if (!options.active()) return null
  return options.snapshot()
}
