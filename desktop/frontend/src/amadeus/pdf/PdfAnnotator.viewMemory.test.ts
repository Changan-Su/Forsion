// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { fileViewKey, flushFileViews, writeFileView } from '../lib/fileViewMemory'
import { PdfAnnotator } from './PdfAnnotator'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const probe = vi.hoisted(() => ({ bus: null as any, viewer: null as any, pageHeight: 1000 }))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
vi.mock('pdfjs-dist/legacy/web/pdf_viewer.css?inline', () => ({ default: '' }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, AnnotationEditorType: { DISABLE: -1 }, AnnotationMode: { ENABLE: 1 }, getDocument: () => ({ promise: Promise.resolve({ numPages: 50, destroy: vi.fn() }) }) }))
vi.mock('pdfjs-dist/legacy/web/pdf_viewer.mjs', () => {
  class Bus {
    listeners = new Map<string, Array<{ fn: Function; once?: boolean }>>()
    constructor() { probe.bus = this }
    on(name: string, fn: Function, opts: any = {}) { this.listeners.set(name, [...this.listeners.get(name) ?? [], { fn, once: opts.once }]) }
    off(name: string, fn: Function) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(x => x.fn !== fn)) }
    dispatch(name: string, value: unknown) { for (const l of [...this.listeners.get(name) ?? []]) { if (l.once) this.off(name, l.fn); l.fn(value) } }
  }
  class Viewer {
    container: HTMLElement; bus: Bus; pdfDocument: unknown; page = 1; scale = '1'
    constructor(o: any) { this.container = o.container; this.bus = o.eventBus; probe.viewer = this }
    setDocument(doc: unknown) { this.pdfDocument = doc }
    get currentPageNumber() { return this.page }
    set currentPageNumber(p: number) { this.page = p; this.container.scrollTop = (p - 1) * probe.pageHeight; this.bus.dispatch('pagechanging', { pageNumber: p }) }
    get currentScaleValue() { return this.scale }
    set currentScaleValue(s: string) { this.scale = s; this.bus.dispatch('scalechanging', { scale: 1, presetValue: s }) }
    scrollPageIntoView(o: any) { this.currentPageNumber = o.pageNumber; this.container.scrollTop += (792 - o.destArray[3]) * probe.pageHeight / 792 }
  }
  class Link { setViewer() {} setDocument() {} }
  class Find { setDocument() {} }
  return { EventBus: Bus, PDFViewer: Viewer, PDFLinkService: Link, PDFFindController: Find }
})
vi.mock('../api', () => ({ amadeus: { readVaultBytes: async () => new Uint8Array([1]) } }))
vi.mock('../../i18n', () => ({ registerMessages() {}, useI18n: () => ({ t: (s: string) => s }) }))
vi.mock('./hlBand', () => ({ paintHlBands: () => 0 }))
afterEach(() => { flushFileViews(); localStorage.clear() })

async function mountSaved() {
  const key = fileViewKey('pdf', '/vault', 'paper.pdf')
  writeFileView('pdf', key, { page: 4, scale: 'page-width', top: 500, left: 0 })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(PdfAnnotator, { pdfPath: 'paper.pdf', memoryKey: key, embed: true })))
  await act(async () => probe.bus.dispatch('pagesinit', {}))
  return { container: host.querySelector<HTMLElement>('.pdfa-container')!, close: async () => { await act(async () => root.unmount()); host.remove() } }
}

it('late loading completion cannot override a page jump made by the user', async () => {
  probe.pageHeight = 1000
  const mounted = await mountSaved()
  await act(async () => { probe.viewer.currentPageNumber = 20 })
  await act(async () => probe.bus.dispatch('pagesloaded', {}))
  expect(probe.viewer.currentPageNumber).toBe(20)
  expect(mounted.container.scrollTop).toBe(19000)
  await mounted.close()
})

it('restores a PDF page point using the current pane dimensions', async () => {
  probe.pageHeight = 700
  const mounted = await mountSaved()
  await act(async () => probe.bus.dispatch('pagesloaded', {}))
  expect(probe.viewer.currentPageNumber).toBe(4)
  expect(mounted.container.scrollTop).toBeCloseTo(3 * 700 + (792 - 500) * 700 / 792)
  await mounted.close()
})
