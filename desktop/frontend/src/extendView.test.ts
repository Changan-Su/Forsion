// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createExtendViewController, type ExtendViewController, type ExtendViewOptions } from '@lcl/engine/extendView'
import { ExtendViewHost } from '@lcl/engine/ExtendViewHost'
import { allViews } from '@lcl/engine/viewRegistry'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const spec = (id: string, extra: Partial<ExtendViewOptions> = {}): ExtendViewOptions => ({ id, title: id, mount: () => {}, ...extra })

describe('owner-scoped extend views', () => {
  it('deduplicates repeated rule/agent opens without replacing the draft', () => {
    const store = createExtendViewController()
    const first = store.controller.open(spec('edit'))
    const options = store.getSnapshot()!.options
    expect(store.controller.open(spec('edit'))).toBe(first)
    expect(store.getSnapshot()!.options).toBe(options)
  })

  it('replaces content; a stale handle cannot close the new extension', () => {
    const store = createExtendViewController()
    const onClose = vi.fn()
    const old = store.controller.open(spec('a', { onClose }))
    const next = store.controller.open(spec('b'))
    old.close()
    expect(old.isOpen).toBe(false)
    expect(next.isOpen).toBe(true)
    expect(onClose).toHaveBeenCalledExactlyOnceWith('replace')
    next.close()
    next.close()
    expect(store.getSnapshot()).toBeNull()
  })

  it('isolates owners and revokes late callbacks after navigation', () => {
    const a = createExtendViewController(), b = createExtendViewController()
    const onClose = vi.fn()
    a.controller.open(spec('edit', { onClose }))
    const second = b.controller.open(spec('edit'))
    a.dispose()
    expect(onClose).toHaveBeenCalledExactlyOnceWith('owner')
    expect(() => a.controller.open(spec('late'))).toThrow('no longer mounted')
    expect(second.isOpen).toBe(true)
  })

  it('uses no view registry entries and accepts all workbench sides', () => {
    const before = allViews()
    const store = createExtendViewController()
    for (const side of ['left', 'right', 'bottom'] as const) {
      store.controller.open(spec(side, { side }))
      expect(store.getSnapshot()!.options.side).toBe(side)
    }
    expect(allViews()).toEqual(before)
  })

  it('a hidden main tab closes its extension and rejects rules until visible again', () => {
    const store = createExtendViewController(), onClose = vi.fn()
    store.controller.open(spec('edit', { onClose }))
    store.setVisible(false)
    expect(onClose).toHaveBeenCalledExactlyOnceWith('owner')
    expect(() => store.controller.open(spec('late'))).toThrow('not visible')
    store.setVisible(true)
    expect(store.controller.open(spec('next')).isOpen).toBe(true)
  })

  it('notifies dismiss once even when callbacks call close again', () => {
    const store = createExtendViewController()
    const onClose = vi.fn(() => store.controller.close())
    store.controller.open(spec('edit', { onClose }))
    store.dismiss()
    expect(onClose).toHaveBeenCalledExactlyOnceWith('dismiss')
  })
})

describe('extend view DOM lifecycle', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  let api: ExtendViewController
  const present = () => {
    const element = document.createElement('aside')
    element.className = 'test-right-panel'
    document.body.append(element)
    return { element, dispose: () => element.remove() }
  }
  async function boot(strict = false) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const host = createElement(ExtendViewHost, { present, children: (controller) => { api = controller; return createElement('button', { id: 'trigger' }, 'Open') } })
    await act(async () => root!.render(strict ? createElement(StrictMode, null, host) : host))
  }
  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.replaceChildren()
  })

  it('mounts lazily, preserves inputs on repeated opens and cleans on Escape', async () => {
    await boot()
    const cleanup = vi.fn()
    const mount = vi.fn((el: HTMLElement) => { el.innerHTML = '<input aria-label="Model name">'; return cleanup })
    const trigger = container.querySelector<HTMLButtonElement>('#trigger')!
    trigger.focus()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { api.open(spec('edit', { mount })) })
    expect(container.querySelector('.wb-extend')).toBeNull()
    expect(document.querySelector('.test-right-panel .wb-extend')).not.toBeNull()
    const input = document.querySelector('input')!
    input.value = 'Unsaved model'
    expect(document.activeElement).toBe(input)
    await act(async () => { api.open(spec('edit', { mount })) })
    expect(document.querySelector('input')).toBe(input)
    expect(input.value).toBe('Unsaved model')
    expect(mount).toHaveBeenCalledTimes(1)
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
  })

  it('respects a nested popup consuming Escape', async () => {
    await boot()
    await act(async () => { api.open(spec('popup', { mount: (el) => {
      el.innerHTML = '<input>'
      el.firstElementChild!.addEventListener('keydown', (e) => e.preventDefault())
    } })) })
    await act(async () => { document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('Escape still closes when a busy submit button has dropped focus to body', async () => {
    await boot()
    await act(async () => { api.open(spec('busy', { mount: (el) => { el.innerHTML = '<button>Save</button>' } })) })
    const button = document.querySelector<HTMLButtonElement>('.wb-extend-body button')!
    button.focus()
    button.blur() // happy-dom does not blur automatically when disabled, unlike Chromium.
    button.disabled = true
    expect(document.activeElement).toBe(document.body)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('unmount disposes plugin content and rejects late owner work', async () => {
    await boot()
    const cleanup = vi.fn(), onClose = vi.fn()
    await act(async () => { api.open(spec('edit', { mount: () => cleanup, onClose })) })
    await act(async () => root!.unmount())
    root = undefined
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledExactlyOnceWith('owner')
    expect(() => api.open(spec('late'))).toThrow('no longer mounted')
  })

  it('works after StrictMode effect replay', async () => {
    await boot(true)
    await act(async () => { api.open(spec('edit')) })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('changing the owner identity closes the extension without remounting the main content', async () => {
    await boot()
    const old = api
    await act(async () => { api.open(spec('edit')) })
    const button = container.querySelector('#trigger')
    await act(async () => root!.render(createElement(ExtendViewHost, { present, ownerKey: 'next-file', children: (controller) => {
      api = controller
      return createElement('button', { id: 'trigger' }, 'Open')
    } })))
    expect(container.querySelector('#trigger')).toBe(button)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(() => old.open(spec('late'))).toThrow('no longer mounted')
    await act(async () => { api.open(spec('next')) })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
