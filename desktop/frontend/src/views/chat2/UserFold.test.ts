// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandUserFold, FOLD_PX, FOLD_SLACK, UserFold } from './UserFold'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('long user message folding', () => {
  it('uses delivered natural sizes without a synchronous layout read; retains expand/collapse across resizing', async () => {
    let notify!: ResizeObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) { notify = cb }
      observe() {}
      disconnect = disconnect
    })
    // A layout read during commit is the regression: it laid out the whole newly mounted chat.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => { throw new Error('forced layout') })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const host = document.createElement('div')
    const root = createRoot(host)
    const size = async (height: number, borderBox = true) => act(async () => notify([
      { borderBoxSize: borderBox ? [{ blockSize: height }] : [], contentRect: { height } } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver))
    try {
      await act(async () => root.render(React.createElement(UserFold, { lines: 90, children: React.createElement('p', null, 'Long question\n'.repeat(90)) })))
      expect((host.querySelector('.t2-user-fold') as HTMLElement).style.maxHeight).toBe(`${FOLD_PX + FOLD_SLACK}px`)
      await size(900)
      expect(host.querySelector('.t2-user-fold')?.hasAttribute('data-folded')).toBe(true)
      expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
      await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
      await size(1200)
      expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
      expect(host.querySelector('.t2-user-fold')?.hasAttribute('data-folded')).toBe(false)
      await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
      expect(host.querySelector('.t2-user-fold')?.hasAttribute('data-folded')).toBe(true)
      await size(120, false)
      expect(host.querySelector('button')).toBeNull()
      expect((host.querySelector('.t2-user-fold') as HTMLElement).style.maxHeight).toBe('')
      await size(700)
      expect(host.querySelector('.t2-user-fold')?.hasAttribute('data-folded')).toBe(true)
    } finally { await act(async () => root.unmount()) }
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('reveals a search hit before the first size arrives and keeps it open afterwards', async () => {
    let notify!: ResizeObserverCallback
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) { notify = cb }
      observe() {}
      disconnect() {}
    })
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => root.render(React.createElement(UserFold, { lines: 90, children: 'Long question\n'.repeat(90) })))
      expect(host.querySelector('button')).toBeNull()
      await act(async () => expandUserFold(host))
      expect((host.querySelector('.t2-user-fold') as HTMLElement).style.maxHeight).toBe('')
      await act(async () => notify([{ borderBoxSize: [{ blockSize: 900 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver))
      expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
      expect(host.querySelector('.t2-user-fold')?.hasAttribute('data-folded')).toBe(false)
    } finally { await act(async () => root.unmount()) }
  })
})
