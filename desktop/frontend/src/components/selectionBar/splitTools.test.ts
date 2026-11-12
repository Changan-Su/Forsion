// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectionBar } from '@lcl/components'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null })
async function mount() {
  const run = vi.fn(), open = vi.fn(), close = vi.fn()
  host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
  await act(async () => root!.render(React.createElement(SelectionBar, { tools: [{ id: 'underline', title: 'Underline', onRun: run, menu: { title: 'Underline color', onOpen: open } }], actions: [], moreLabel: 'More', onClose: close })))
  return { run, open, close, primary: host.querySelector<HTMLButtonElement>('[data-act="underline"]')!, arrow: host.querySelector<HTMLButtonElement>('[data-menu-for="underline"]')! }
}
describe('selection tools with a separate menu', () => {
  it('primary press acts once, secondary press passes its real anchor without running the primary', async () => {
    const { run, open, primary, arrow } = await mount()
    await act(async () => { primary.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); primary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(run).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled()
    await act(async () => { arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); arrow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(run).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledExactlyOnceWith(arrow)
  })
  it('ArrowRight opens a menu and keyboard click opens from the arrow; right click does neither', async () => {
    const { run, open, primary, arrow } = await mount()
    await act(async () => primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    expect(open).toHaveBeenCalledWith(primary)
    await act(async () => arrow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })))
    expect(open).toHaveBeenLastCalledWith(arrow)
    await act(async () => arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })))
    expect(open).toHaveBeenCalledTimes(2); expect(run).not.toHaveBeenCalled()
  })
  it('a child menu consumes the first Escape, leaving the selection bar open until the next Escape', async () => {
    const { close } = await mount()
    const child = (event: KeyboardEvent) => { event.preventDefault(); event.stopPropagation() }
    document.addEventListener('keydown', child, { capture: true, once: true })
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(close).not.toHaveBeenCalled()
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
