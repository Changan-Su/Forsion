// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement, StrictMode, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ExtendViewHost } from '@lcl/engine/ExtendViewHost'
import { createExtendViewController, type ExtendViewController, type ExtendViewOptions, type ExtendViewPresenter } from '@lcl/engine/extendView'
import { LocaleProvider, setLocaleGlobal, useI18n } from '../../i18n'
import { useStudioTools, type StudioTool } from './useStudioTools'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })
let host: HTMLDivElement, reactRoot: Root | null
let api: ReturnType<typeof useStudioTools>
let controller: ExtendViewController
let mounted: string[], unmounted: string[]
let presentations: Array<{ element: HTMLElement; options: ExtendViewOptions; dispose: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn> }>
let visibility: { isVisible: boolean; onDidVisibilityChange(listener: () => void): { dispose(): void } }
let visibilityListener: (() => void) | undefined

function Draft({ kind, side, value }: { kind: StudioTool; side: string; value: string }) {
  const { locale } = useI18n()
  const [draft, setDraft] = useState('')
  useEffect(() => { mounted.push(kind); return () => { unmounted.push(kind) } }, [kind])
  return createElement('div', { 'data-draft-kind': kind },
    createElement('span', { 'data-runtime': true }, `${locale}:${side}:${value}`),
    createElement('input', { 'aria-label': kind, value: draft, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value) }),
    createElement('button', { onClick: () => setDraft('Unsaved project draft') }, 'Edit draft'))
}

function Project({ extension, project = '/projects/a', value = 'initial', embeddedFallback = false }: { extension?: ExtendViewController; project?: string; value?: string; embeddedFallback?: boolean }) {
  api = useStudioTools(extension, project, { embeddedFallback })
  return createElement('div', { 'data-project': project },
    createElement('button', { 'data-opener': true }, 'Owner'),
    api.render((kind, side) => createElement(Draft, { kind, side, value })))
}

const present: ExtendViewPresenter = (options) => {
  const element = document.createElement('aside')
  element.dataset.panel = options.side ?? 'right'
  document.body.append(element)
  const record = { element, options, dispose: vi.fn(() => { element.remove() }), activate: vi.fn() }
  presentations.push(record)
  return record
}

async function render(project = '/projects/a', value = 'initial', strict = false) {
  const tree = createElement(LocaleProvider, null,
    createElement(ExtendViewHost, { present, owner: visibility, children: (extension) => {
      controller = extension
      return createElement(Project, { extension, project, value })
    } }))
  await act(async () => { reactRoot!.render(strict ? createElement(StrictMode, null, tree) : tree) })
}

const input = () => document.querySelector<HTMLInputElement>('.wb-extend input')!
beforeEach(() => {
  setLocaleGlobal('zh')
  mounted = []; unmounted = []; presentations = []
  visibilityListener = undefined
  visibility = { isVisible: true, onDidVisibilityChange: (listener) => {
    visibilityListener = listener
    return { dispose: () => { visibilityListener = undefined } }
  } }
  host = document.createElement('div'); document.body.append(host); reactRoot = createRoot(host)
})
afterEach(async () => {
  if (reactRoot) await act(async () => { reactRoot!.unmount() })
  reactRoot = null
  document.body.replaceChildren()
  setLocaleGlobal('zh')
})

describe('project-owned native Studio tools', () => {
  it('keeps command-facing callbacks stable across runtime and active-tool updates', async () => {
    await render()
    const first = api
    await act(async () => { api.open('brief') })
    await render('/projects/a', 'updated')
    expect(api.open).toBe(first.open)
    expect(api.close).toBe(first.close)
    expect(api.render).toBe(first.render)
    await act(async () => { api.close() })
    expect(api.open).toBe(first.open)
    await render('/projects/b')
    expect(api.open).not.toBe(first.open)
  })

  it('lazily uses the native panel and refocuses the same tool without remounting its draft', async () => {
    await render()
    expect(document.querySelector('.csu-tool-slot')).toBeNull()
    await act(async () => { expect(api.open('brief')).toBe(true) })
    const first = input(), handle = api.active!.handle
    await act(async () => { document.querySelector<HTMLButtonElement>('.wb-extend [data-draft-kind] button')!.click() })
    expect(first.value).toBe('Unsaved project draft')
    expect(first.closest('[data-panel="right"]')).not.toBeNull()
    expect(host.querySelector('.wb-extend')).toBeNull()
    await act(async () => { api.open('brief') })
    expect(api.active!.handle).toBe(handle)
    expect(input()).toBe(first)
    expect(input().value).toBe('Unsaved project draft')
    expect(mounted).toEqual(['brief'])
    expect(presentations).toHaveLength(1)
    expect(presentations[0].activate).toHaveBeenCalledTimes(2)
  })

  it('moves one live React tree across all three panels and remembers the chosen placement', async () => {
    await render()
    await act(async () => { api.open('issues') })
    expect(api.active!.side).toBe('bottom')
    const first = input()
    await act(async () => { document.querySelector<HTMLButtonElement>('.wb-extend [data-draft-kind] button')!.click() })
    for (const side of ['left', 'right', 'bottom'] as const) {
      await act(async () => { api.open('issues', side) })
      expect(input()).toBe(first)
      expect(input().value).toBe('Unsaved project draft')
      expect(first.closest(`[data-panel="${side}"]`)).not.toBeNull()
      expect(document.querySelector('[data-runtime]')!.textContent).toBe(`zh:${side}:initial`)
    }
    expect(mounted).toEqual(['issues'])
    expect(unmounted).toEqual([])
    await act(async () => { api.open('issues', 'left'); api.close() })
    expect(api.active).toBeNull()
    expect(first.isConnected).toBe(false)
    await act(async () => { api.open('issues') })
    expect(api.active!.side).toBe('left')
    expect(input()).toBe(first)
  })

  it('keeps each visited tool draft while switching, closing, and receiving new runtime props', async () => {
    await render()
    await act(async () => { api.open('brief') })
    const brief = input()
    await act(async () => { document.querySelector<HTMLButtonElement>('.wb-extend [data-draft-kind] button')!.click() })
    for (const kind of ['history', 'checks', 'issues', 'setup'] as const) await act(async () => { api.open(kind) })
    expect(mounted).toHaveLength(5)
    expect(unmounted).toEqual([])
    expect(brief.isConnected).toBe(false)
    await render('/projects/a', 'updated')
    await act(async () => { api.open('brief') })
    expect(input()).toBe(brief)
    expect(input().value).toBe('Unsaved project draft')
    expect(document.querySelector('[data-runtime]')!.textContent).toBe('zh:right:updated')
    await act(async () => { api.close() })
    expect(document.querySelector('.wb-extend')).toBeNull()
    expect(unmounted).toEqual([])
    await act(async () => { api.open('brief') })
    expect(input()).toBe(brief)
    expect(mounted).toHaveLength(5)
  })

  it('retains the application locale context and lazily translates native titles', async () => {
    await render()
    await act(async () => { api.open('brief') })
    const first = input()
    await act(async () => { setLocaleGlobal('en') })
    expect(input()).toBe(first)
    expect(document.querySelector('[data-runtime]')!.textContent).toBe('en:right:initial')
    const title = presentations[0].options.title
    expect(typeof title === 'function' ? title() : title).toBe('Project brief')
    await act(async () => { api.open('brief', 'left') })
    expect(document.querySelector('.wb-extend')!.getAttribute('aria-label')).toBe('Project brief')
  })

  it('handles Escape and owner hiding, rejects late opens, and restores the same draft when visible', async () => {
    await render()
    await act(async () => { api.open('setup') })
    const first = input()
    first.focus()
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(api.active).toBeNull()
    await act(async () => { api.open('setup') })
    expect(input()).toBe(first)
    await act(async () => { visibility.isVisible = false; visibilityListener!() })
    expect(api.active).toBeNull()
    await act(async () => { expect(api.open('brief')).toBe(false) })
    expect(mounted).toEqual(['setup'])
    await act(async () => { visibility.isVisible = true; visibilityListener!(); api.open('setup') })
    expect(input()).toBe(first)
  })

  it('cleans an old project without closing a successor owned by the same host controller', async () => {
    await render()
    await act(async () => { api.open('brief') })
    const oldApi = api, oldInput = input()
    await act(async () => {
      controller.open({ id: 'other-owner', title: 'Other', mount: (element) => { element.textContent = 'Other content' } })
    })
    expect(api.active).toBeNull()
    await render('/projects/b')
    expect(document.querySelector('.wb-extend')!.textContent).toContain('Other content')
    expect(oldInput.isConnected).toBe(false)
    expect(unmounted).toEqual(['brief'])
    await act(async () => { expect(oldApi.open('brief')).toBe(false); oldApi.close() })
    expect(document.querySelector('.wb-extend')!.textContent).toContain('Other content')
    await act(async () => { api.open('brief') })
    expect(input()).not.toBe(oldInput)
    expect(input().value).toBe('')
  })

  it('unmounts all cached trees and its own extension after a real project unmount', async () => {
    await render()
    await act(async () => { api.open('brief') })
    await act(async () => { api.open('issues') })
    const oldApi = api, handle = api.active!.handle
    await act(async () => { reactRoot!.unmount(); reactRoot = null })
    expect(handle.isOpen).toBe(false)
    expect(document.querySelector('.wb-extend')).toBeNull()
    expect(unmounted.sort()).toEqual(['brief', 'issues'])
    expect(oldApi.open('setup')).toBe(false)
  })

  it('survives StrictMode replay and provides a no-op fallback on hosts without the controller', async () => {
    await render('/projects/a', 'initial', true)
    await act(async () => { expect(api.open('brief')).toBe(true) })
    expect(input()).not.toBeNull()
    await act(async () => { reactRoot!.render(createElement(Project, {})) })
    expect(api.active).toBeNull()
    await act(async () => { expect(api.open('brief')).toBe(false); api.close() })
    expect(api.render(() => 'Unused')).toEqual([])
  })

  it('optionally presents embedded tools with the same cached draft and application locale', async () => {
    await act(async () => { reactRoot!.render(createElement(LocaleProvider, null, createElement(Project, { embeddedFallback: true }))) })
    await act(async () => { expect(api.open('brief')).toBe(true) })
    const first = host.querySelector<HTMLInputElement>('.csu-embedded-tool input')!
    const handle = api.active!.handle
    expect(first).not.toBeNull()
    expect(host.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('项目简报')
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-draft-kind] button')!.click(); api.open('brief') })
    expect(api.active!.handle).toBe(handle)
    host.querySelector<HTMLButtonElement>('[data-opener]')!.focus()
    await act(async () => { api.open('brief') })
    expect(document.activeElement).toBe(first)
    await act(async () => { api.open('brief', 'left') })
    expect(host.querySelector('.csu-embedded-tool input')).toBe(first)
    expect(first.value).toBe('Unsaved project draft')
    await act(async () => { api.open('issues') })
    expect(first.isConnected).toBe(false)
    await act(async () => { api.close(); api.open('brief'); setLocaleGlobal('en') })
    expect(host.querySelector('.csu-embedded-tool input')).toBe(first)
    expect(first.value).toBe('Unsaved project draft')
    expect(host.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Project brief')
    expect(host.querySelector('.csu-embedded-tool-head button')!.getAttribute('aria-label')).toBe('Close')
    expect(unmounted).toEqual([])
    expect(mounted).toEqual(['brief', 'issues'])
    await act(async () => { host.querySelector<HTMLButtonElement>('.csu-embedded-tool-head button')!.click() })
    expect(api.active).toBeNull()
    expect(host.querySelector('.csu-embedded-tool')).toBeNull()
  })

  it('embedded Escape only closes the tool that contains focus and respects nested consumers', async () => {
    await act(async () => { reactRoot!.render(createElement(Project, { embeddedFallback: true })) })
    await act(async () => { api.open('setup') })
    const field = host.querySelector<HTMLInputElement>('.csu-embedded-tool input')!
    const outside = host.querySelector<HTMLButtonElement>('[data-opener]')!
    outside.focus()
    await act(async () => { outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(api.active!.kind).toBe('setup')
    field.focus()
    const consume = (event: KeyboardEvent) => event.preventDefault()
    field.addEventListener('keydown', consume)
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(api.active!.kind).toBe('setup')
    field.removeEventListener('keydown', consume)
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(api.active).toBeNull()
    expect(field.isConnected).toBe(false)
  })

  it('revokes local handles and cached fallback content on project changes and unmount', async () => {
    await act(async () => { reactRoot!.render(createElement(Project, { embeddedFallback: true })) })
    await act(async () => { api.open('brief') })
    const old = api, handle = api.active!.handle
    await act(async () => { reactRoot!.render(createElement(Project, { embeddedFallback: true, project: '/projects/b' })) })
    expect(handle.isOpen).toBe(false)
    expect(old.open('issues')).toBe(false)
    expect(host.querySelector('.csu-embedded-tool')).toBeNull()
    expect(unmounted).toEqual(['brief'])
    await act(async () => { api.open('history') })
    const current = api.active!.handle
    await act(async () => { reactRoot!.unmount(); reactRoot = null })
    expect(current.isOpen).toBe(false)
    expect(unmounted).toEqual(['brief', 'history'])
  })

  it('does not detach a relocated portal when a previous lease finishes cleanup late', async () => {
    const store = createExtendViewController()
    await act(async () => { reactRoot!.render(createElement(Project, { extension: store.controller })) })
    await act(async () => { api.open('brief', 'right') })
    const oldOptions = store.getSnapshot()!.options
    const oldTarget = document.createElement('div'), nextTarget = document.createElement('div')
    document.body.append(oldTarget, nextTarget)
    const oldCleanup = oldOptions.mount(oldTarget, api.active!.handle)
    const first = oldTarget.querySelector('input')
    await act(async () => { api.open('brief', 'left') })
    const nextCleanup = store.getSnapshot()!.options.mount(nextTarget, api.active!.handle)
    if (typeof oldCleanup === 'function') oldCleanup()
    expect(nextTarget.querySelector('input')).toBe(first)
    expect(mounted).toEqual(['brief'])
    if (typeof nextCleanup === 'function') nextCleanup()
  })
})
