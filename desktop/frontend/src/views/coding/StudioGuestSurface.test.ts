// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement, Fragment, StrictMode, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StudioGuestSurface } from './StudioGuestSurface'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })
let shell: HTMLDivElement, owner: HTMLDivElement, root: Root | null
let bounds: WeakMap<Element, DOMRect>
let frames: Map<number, FrameRequestCallback>, nextFrame: number
let connections = 0, disconnections = 0
class GuestProbe extends HTMLElement {
  connectedCallback() { connections++ }
  disconnectedCallback() { disconnections++ }
}
customElements.define('studio-guest-probe', GuestProbe)

function geometry(element: Element, x: number, y: number, width: number, height: number, localWidth = width, localHeight = height) {
  bounds.set(element, new DOMRect(x, y, width, height))
  for (const [key, value] of Object.entries({ offsetWidth: localWidth, offsetHeight: localHeight, clientWidth: localWidth, clientHeight: localHeight })) {
    Object.defineProperty(element, key, { configurable: true, value })
  }
}
function Project({ enabled = true, onActivate }: { enabled?: boolean; onActivate?: () => void }) {
  const anchor = useRef<HTMLDivElement | null>(null)
  return createElement(Fragment, null,
    createElement('div', { ref: (element: HTMLDivElement | null) => {
      anchor.current = element
      if (element && !bounds.has(element)) geometry(element, 100, 80, 500, 300)
    }, 'data-anchor': true }),
    createElement(StudioGuestSurface, { anchorRef: anchor, enabled, onActivate,
      children: createElement('studio-guest-probe', null, createElement('input', { defaultValue: 'draft' })) }))
}
async function render(enabled = true, strict = false, onActivate?: () => void) {
  const project = createElement(Project, { enabled, onActivate })
  await act(async () => root!.render(strict ? createElement(StrictMode, null, project) : project))
}
async function frame() {
  await act(async () => {
    const pending = [...frames.values()]; frames.clear()
    pending.forEach(callback => callback(0))
  })
}
const surface = () => document.querySelector<HTMLDivElement>('.csu-guest-surface')!

beforeEach(() => {
  bounds = new WeakMap(); frames = new Map(); nextFrame = 0
  connections = 0; disconnections = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return bounds.get(this) ?? new DOMRect(0, 0, 1000, 800)
  })
  shell = document.createElement('div'); shell.className = 'shell-work'; shell.style.position = 'relative'
  owner = document.createElement('div'); owner.className = 'dock-owner'
  shell.append(owner); document.body.append(shell)
  geometry(shell, 20, 40, 1000, 800)
  root = createRoot(owner)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.documentElement.removeAttribute('data-dv-dragging')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('StudioGuestSurface', () => {
  it('connects the guest directly under the stable shell and retains it while Dockview detaches its owner', async () => {
    await render()
    const stable = surface(), guest = stable.querySelector('studio-guest-probe')!
    expect(stable.parentElement).toBe(shell)
    expect(connections).toBe(1)
    const input = guest.querySelector('input')!; input.value = 'unsaved page memory'
    owner.remove()
    await frame()
    expect(stable.isConnected).toBe(true)
    expect(stable.style.visibility).toBe('hidden')
    expect(disconnections).toBe(0)
    shell.prepend(owner)
    window.dispatchEvent(new Event('resize'))
    await frame()
    expect(surface()).toBe(stable)
    expect(stable.querySelector('studio-guest-probe')).toBe(guest)
    expect(input.value).toBe('unsaved page memory')
    expect(stable.style.visibility).toBe('visible')
    expect(connections).toBe(1)
  })

  it('uses shell-local geometry and clips scrolling ancestors at UI zoom', async () => {
    await render()
    const anchor = owner.querySelector<HTMLElement>('[data-anchor]')!
    geometry(shell, 20, 40, 1200, 960, 1000, 800)
    geometry(anchor, 140, 160, 600, 360)
    geometry(owner, 200, 180, 400, 250)
    owner.style.overflow = 'hidden'
    await frame()
    expect(surface().style.left).toBe('100px')
    expect(surface().style.top).toBe('100px')
    expect(surface().style.width).toBe('500px')
    expect(surface().style.height).toBe('300px')
    expect(surface().style.clipPath).toBe('inset(16.667px 116.667px 75px 50px)')
  })

  it('keeps inert exit transitions painted but inaccessible until the owner becomes visually hidden', async () => {
    const activate = vi.fn()
    await render(true, false, activate)
    const stable = surface(), guest = stable.firstElementChild
    await render(false, false, activate)
    expect(stable.inert).toBe(true)
    expect(stable.getAttribute('aria-hidden')).toBe('true')
    expect(stable.style.pointerEvents).toBe('none')
    await render(true, false, activate); await frame()
    expect(stable.inert).toBe(false)
    owner.inert = true; owner.style.opacity = '0.4'; await frame()
    expect(stable.style.visibility).toBe('visible')
    expect(stable.style.opacity).toBe('0.4')
    expect(stable.style.pointerEvents).toBe('none')
    expect(stable.inert).toBe(true)
    expect(stable.getAttribute('aria-hidden')).toBe('true')
    stable.querySelector('input')!.dispatchEvent(new FocusEvent('focus'))
    expect(activate).not.toHaveBeenCalled()
    owner.inert = false; owner.setAttribute('aria-hidden', 'true'); owner.style.opacity = '0.2'
    await frame()
    expect(stable.style.visibility).toBe('visible')
    expect(stable.style.opacity).toBe('0.2')
    expect(stable.inert).toBe(true)
    owner.removeAttribute('aria-hidden'); owner.style.visibility = 'hidden'
    window.dispatchEvent(new Event('resize')); await frame()
    expect(stable.style.visibility).toBe('hidden')
    owner.style.visibility = 'visible'
    window.dispatchEvent(new Event('resize')); await frame()
    expect(stable.style.visibility).toBe('visible')
    expect(stable.firstElementChild).toBe(guest)
    expect(disconnections).toBe(0)
  })

  it('follows fades and position changes that do not resize the anchor', async () => {
    await render()
    const anchor = owner.querySelector<HTMLElement>('[data-anchor]')!
    owner.style.opacity = '0.4'
    geometry(anchor, 180, 120, 500, 300)
    await frame()
    expect(surface().style.left).toBe('160px')
    expect(surface().style.top).toBe('80px')
    expect(surface().style.opacity).toBe('0.4')
  })

  it('returns hit testing to Dockview for native panel drags and restores it without detaching the guest', async () => {
    await render()
    const stable = surface(), guest = stable.querySelector('studio-guest-probe')!
    const input = guest.querySelector('input')!; input.value = 'in-page draft'
    // No frame is advanced: observing the engine marker must itself suppress
    // hits before dragover, and removal must restore them on drop or cancel.
    await act(async () => {
      document.documentElement.setAttribute('data-dv-dragging', '1')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(stable.style.pointerEvents).toBe('none')
    expect(stable.inert).toBe(true)
    expect(stable.style.visibility).toBe('visible')
    await frame()
    expect(stable.style.pointerEvents).toBe('none')
    await act(async () => {
      document.documentElement.removeAttribute('data-dv-dragging')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(stable.style.pointerEvents).toBe('auto')
    expect(stable.inert).toBe(false)
    expect(stable.querySelector('studio-guest-probe')).toBe(guest)
    expect(input.value).toBe('in-page draft')
    expect(connections).toBe(1)
    expect(disconnections).toBe(0)
  })

  it('activates its owning panel on native focus and pointer input using the latest callback, with hidden and drag guards', async () => {
    const first = vi.fn(), next = vi.fn()
    await render(true, false, first)
    const input = surface().querySelector('input')!
    input.focus()
    expect(first).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)
    await render(true, false, next)
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(first).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(2)
    document.documentElement.setAttribute('data-dv-dragging', '1')
    input.dispatchEvent(new FocusEvent('focus'))
    expect(next).toHaveBeenCalledTimes(2)
    document.documentElement.removeAttribute('data-dv-dragging')
    await render(false, false, next)
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(next).toHaveBeenCalledTimes(2)
    await render(true, false, next); await frame()
    input.dispatchEvent(new FocusEvent('focus'))
    expect(next).toHaveBeenCalledTimes(3)
    expect(connections).toBe(1)
    expect(disconnections).toBe(0)
  })

  it('detects silent OOPIF activeElement entry once, without reactivating on every frame', async () => {
    const activate = vi.fn()
    await render(true, false, activate)
    const guest = surface().querySelector('studio-guest-probe')!
    // Electron changes activeElement when entering its internal cross-process
    // iframe, while emitting no focus/pointer event on the embedding webview.
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(guest)
    await frame()
    expect(activate).toHaveBeenCalledTimes(1)
    await frame(); await frame()
    expect(activate).toHaveBeenCalledTimes(1)
    active.mockReturnValue(owner)
    await frame()
    active.mockReturnValue(guest)
    await frame()
    expect(activate).toHaveBeenCalledTimes(2)
    expect(connections).toBe(1)
    expect(disconnections).toBe(0)
    active.mockRestore()
  })

  it('does not detach for StrictMode effect replay and disposes only its own portal on unmount', async () => {
    const other = document.createElement('div'); other.className = 'other-surface'; shell.append(other)
    await render(true, true)
    const stable = surface()
    expect(connections).toBe(1)
    expect(disconnections).toBe(0)
    await act(async () => { root!.unmount(); root = null })
    expect(stable.isConnected).toBe(false)
    expect(other.isConnected).toBe(true)
    expect(disconnections).toBe(1)
    expect(frames.size).toBe(0)
  })
})
