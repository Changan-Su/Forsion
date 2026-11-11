// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createNoteRenderSurface, registerNoteRenderer, currentNoteRenderer, beginNoteRendererReload, settleNoteRendererReload, clearNoteRendererReload, noteRendererReloadState } from './noteRenderers'
import { prepareReadingSnapshot, readingSnapshot, officialNoteRenderer } from '../unified/readingSnapshot'
import { ReadingSurface } from '../unified/ReadingSurface'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

describe('reading renderer ownership and replacement', () => {
  it('captures live input before strict flush and never commits a stale request', async () => {
    let cache = 'old'; let active = true
    const calls: string[] = []
    let release!: () => void
    const pending = prepareReadingSnapshot({
      waitForComposition: async () => { calls.push('composition') }, active: () => active,
      capture: () => { cache = 'latest committed input'; calls.push('capture') },
      flush: () => new Promise<void>((resolve) => { calls.push(cache); release = resolve }), snapshot: () => cache,
    })
    await Promise.resolve()
    expect(calls).toEqual(['composition', 'capture', 'latest committed input'])
    active = false; release()
    expect(await pending).toBeNull()
  })
  it('does not switch when saving fails', async () => {
    const snapshot = vi.fn()
    await expect(prepareReadingSnapshot({ waitForComposition: async () => {}, active: () => true, capture() {}, flush: async () => { throw new Error('offline') }, snapshot })).rejects.toThrow('offline')
    expect(snapshot).not.toHaveBeenCalled()
  })
  it('keeps the previous surface when the replacement fails, and ignores late mounts', async () => {
    const root = document.createElement('div')
    const surface = createNoteRenderSurface(root, () => {})
    const snap = { path: 'A.md', markdown: 'new text', html: '<p>new text</p>', revision: 1 }
    const dispose = vi.fn()
    let keptSignal!: AbortSignal
    await surface.render({ id: 'a', apiVersion: 1, mount(el, _snapshot, host) { keptSignal = host.signal; el.textContent = 'old renderer'; return dispose } }, snap)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await surface.render({ id: 'bad', apiVersion: 1, mount() { throw new Error('bad upgrade') } }, snap)).toBe(false)
    expect(root.textContent).toBe('old renderer'); expect(dispose).not.toHaveBeenCalled()
    expect(keptSignal.aborted).toBe(false)
    let finish!: () => void
    const staleDispose = vi.fn()
    const stale = surface.render({ id: 'slow', apiVersion: 1, async mount(el) { el.textContent = 'stale'; await new Promise<void>((r) => { finish = r }); return staleDispose } }, snap)
    await surface.render(officialNoteRenderer, snap)
    finish(); expect(await stale).toBe(false)
    expect(root.textContent).toBe('new text'); expect(staleDispose).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce()
    expect(keptSignal.aborted).toBe(true)
    surface.dispose(); log.mockRestore()
  })
  it('a late fallback cannot replace a newer document revision', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    const rootRef = { current: null as HTMLDivElement | null }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const good = registerNoteRenderer('fallback-good', { id: 'reader', apiVersion: 1, async mount(el, snapshot) {
      if (snapshot.revision === 2) await new Promise<void>((resolve) => { release = resolve })
      el.textContent = `good revision ${snapshot.revision}`
    } })
    const render = (revision: number) => root.render(createElement(ReadingSurface, { rootRef, scroll: () => host, position: null, openLink() {}, snapshot: { path: 'A.md', markdown: '', html: `<p>revision ${revision}</p>`, revision } }))
    await act(async () => { render(1) })
    let bad!: () => void
    await act(async () => { bad = registerNoteRenderer('fallback-bad', { id: 'reader', apiVersion: 1, mount() { throw new Error('expected failure') } }) })
    await act(async () => { render(2) })
    expect(release).toBeTypeOf('function')
    await act(async () => { render(3) })
    expect(rootRef.current?.textContent).toBe('good revision 3')
    await act(async () => { release() })
    const actual = rootRef.current?.textContent
    await act(async () => { root.unmount(); bad(); good() })
    host.remove(); log.mockRestore()
    expect(actual).toBe('good revision 3')
  })
  it('revokes by generation: an old disposer cannot remove the new registration', () => {
    const a = registerNoteRenderer('test', { ...officialNoteRenderer })
    const b = registerNoteRenderer('test', { ...officialNoteRenderer })
    a(); expect(currentNoteRenderer()?.pluginId).toBe('test')
    b(); expect(currentNoteRenderer()).toBeNull()
  })
  it('distinguishes a package update failure from explicit disable', () => {
    const off = registerNoteRenderer('updating', { ...officialNoteRenderer })
    beginNoteRendererReload('updating'); off()
    expect(noteRendererReloadState('updating')).toBe('pending')
    settleNoteRendererReload('updating', false)
    expect(noteRendererReloadState('updating')).toBe('failed')
    clearNoteRendererReload('updating')
    expect(noteRendererReloadState('updating')).toBeUndefined()
  })
  it('the official module preserves formatted text and wiki links without edit controls', async () => {
    const source = document.createElement('div')
    source.className = 'ProseMirror'; source.contentEditable = 'true'
    source.innerHTML = '<h2>Heading</h2><p><u>physics</u> <span data-wiki="A">A</span></p><button>delete</button><script>bad()</script><p class="amx-fold-hidden">folded text</p>'
    const snap = readingSnapshot(source, 'B.md', 'latest', 1)
    expect(snap.html).not.toMatch(/contenteditable|<script|<button|amx-fold-hidden/)
    expect(snap.html).toMatch(/<u[^>]*>physics<\/u>/); expect(source.contentEditable).toBe('true')
    expect(source.querySelector('[data-reading-anchor]')).toBeNull()
    const root = document.createElement('div'); const open = vi.fn()
    await officialNoteRenderer.mount(root, snap, { signal: new AbortController().signal, openLink: open })
    root.querySelector<HTMLElement>('[data-wiki]')!.click()
    expect(open).toHaveBeenCalledWith('A', 'wiki')
  })
})
