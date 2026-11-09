// @vitest-environment happy-dom
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useStreamReveal } from './streamReveal'

vi.mock('@lcl/engine', () => ({ reducedMotion: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('reuses text nodes between animation frames and invalidates them after a child replaces its DOM', async () => {
  let frame: FrameRequestCallback | undefined
  const ranges = new Map<string, Set<Range>>()
  vi.stubGlobal('Highlight', class extends Set<Range> {})
  vi.stubGlobal('CSS', { highlights: ranges })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1 })
  const walk = vi.spyOn(document, 'createTreeWalker')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function View({ text, streaming = true }: { text: string; streaming?: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    useStreamReveal(ref, streaming)
    return React.createElement('div', { ref }, React.createElement('div', { className: 't2-content' }, text))
  }
  const tick = (at: number) => { const cb = frame; frame = undefined; cb?.(at) }
  try {
    await act(async () => root.render(React.createElement(View, { text: 'old' })))
    expect(walk).toHaveBeenCalledTimes(1)
    await act(async () => root.render(React.createElement(View, { text: 'old new' })))
    tick(performance.now())
    const afterCommit = walk.mock.calls.length
    tick(performance.now() + 10); tick(performance.now() + 20)
    expect(walk.mock.calls.length).toBe(afterCommit)
    expect([...ranges.values()].flatMap((set) => [...set]).map((r) => r.toString()).join('')).toContain('new')

    // Lazy code highlighting/embeds can replace descendants without rendering View.
    const body = host.querySelector('.t2-content')!
    body.replaceChildren(document.createTextNode('old new'))
    tick(performance.now() + 30) // takeRecords also covers mutations before MO delivery.
    expect(walk.mock.calls.length).toBe(afterCommit + 1)
    for (const range of [...ranges.values()].flatMap((set) => [...set])) expect(body.contains(range.startContainer)).toBe(true)
    await act(async () => root.render(React.createElement(View, { text: 'old new', streaming: false })))
    tick(performance.now() + 40)
    body.replaceChildren(document.createTextNode('old new'))
    tick(performance.now() + 50)
    const closing = [...ranges.values()].flatMap((set) => [...set])
    expect(closing.length).toBeGreaterThan(0)
    for (const range of closing) expect(body.contains(range.startContainer)).toBe(true)
    tick(performance.now() + 1000)
  } finally {
    await act(async () => root.unmount())
    tick(performance.now() + 2000)
    host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
