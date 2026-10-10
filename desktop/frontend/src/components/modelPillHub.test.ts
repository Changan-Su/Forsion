// @vitest-environment happy-dom
/** 手机上模型药丸点开的合并菜单(ModelPill 的 hub):行、选项页、选中后的落点、原生呈现不了时的回落。 */
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_MENU_MAX_ITEMS, installNativeSheetPresenter, type NativeSheetPayload } from '@lcl/engine'
import { setLocaleGlobal } from '../i18n'
import { ModelPill, type ModelPillGroup } from './ModelPill'

const model = (id: string, name: string) => ({ id, name, provider: 'test', source: 'direct' as const })
const GROUPS = [{ label: 'Test', options: [model('a', 'Model A'), model('b', 'Model B')] }] as ModelPillGroup[]
let el: HTMLDivElement
let root: Root
let off: () => void
let seen: NativeSheetPayload[]
let answer: unknown
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] }) // the web menu's edge nudge asks for it
  seen = []; answer = null
  off = installNativeSheetPresenter(async (payload) => { seen.push(payload); if (answer === 'refuse') throw new Error('no host'); return answer })
  el = document.createElement('div'); document.body.append(el); root = createRoot(el)
})
afterEach(async () => { await act(async () => { root.unmount() }); el.remove(); off(); vi.unstubAllGlobals() })

const mount = async (over: Partial<ComponentProps<typeof ModelPill>> = {}) => {
  const fn = { onSelect: vi.fn(), onThinkingChange: vi.fn(), runMode: vi.fn(), onUnavailable: vi.fn() }
  await act(async () => {
    root.render(createElement(ModelPill, {
      modelId: 'a', groups: GROUPS, thinkingLevel: 'medium', onSelect: fn.onSelect, onThinkingChange: fn.onThinkingChange, icon: null,
      hub: { title: 'Hub', back: 'Back', onUnavailable: fn.onUnavailable, extra: () => [{ id: 'mode', label: 'Mode', detail: 'Now', children: [{ items: [{ id: 'plan-mode', label: 'Plan', run: fn.runMode }] }] }] },
      ...over,
    }))
  })
  return fn
}
const tap = () => act(async () => { (el.querySelector('.model-pill-btn') as HTMLButtonElement).click() })
const rows = () => { const p = seen.at(-1)!; return p.kind === 'menu' ? p.sections.flatMap((s) => s.items) : [] }

describe('model key as one native menu (phone)', () => {
  it('lists model, thinking effort and the caller\'s rows, each with its current value and a page of choices', async () => {
    await mount()
    await tap()
    expect(rows().map((r) => r.id)).toEqual(['field:model', 'field:thinking', 'mode'])
    expect([rows()[0].detail, !!rows()[1].detail, rows()[2].detail]).toEqual(['Model A', true, 'Now']) // (the effort's label lives in another module's messages)
    const models = rows()[0].children!.flatMap((s) => s.items)
    expect(models.map((m) => [m.id, m.label, !!m.checked])).toEqual([['model:0:0', 'Model A', true], ['model:0:1', 'Model B', false]])
    expect(rows()[0].search).toBeTruthy()
    expect(el.querySelector('.composer-menu--model')).toBeNull() // the web menu stays shut
    expect(el.querySelector('.model-pill-btn svg.lucide-bot')).toBeNull()
  })
  it('a pick goes to the same callbacks as the picker; the caller\'s row runs its own handler', async () => {
    const fn = await mount()
    answer = { id: 'model:0:1' }; await tap()
    expect(fn.onSelect).toHaveBeenCalledWith('b')
    answer = { id: 'thinking:0:0' }; await tap()
    expect(fn.onThinkingChange).toHaveBeenCalledTimes(1)
    answer = { id: 'plan-mode' }; await tap()
    expect(fn.runMode).toHaveBeenCalledTimes(1)
    expect(fn.onUnavailable).not.toHaveBeenCalled()
  })
  it('a second tap before the first is answered withdraws the first: its late answer is not applied', async () => {
    const fn = await mount()
    const pending: Array<{ signal: AbortSignal; answer: (v: unknown) => void }> = []
    off(); off = installNativeSheetPresenter((_p, signal) => new Promise((resolve) => { pending.push({ signal, answer: resolve }) }))
    await tap(); await tap()
    expect(pending.map((p) => p.signal.aborted)).toEqual([true, false])
    await act(async () => { pending[0].answer({ id: 'model:0:1' }) })
    expect(fn.onSelect).not.toHaveBeenCalled()
    await act(async () => { pending[1].answer(null) })
    expect(fn.onUnavailable).not.toHaveBeenCalled()
  })
  it('a host that cannot present it, or a catalog over the native limit, reports "unavailable" instead of dead-ending', async () => {
    const fn = await mount()
    answer = 'refuse'; await tap()
    expect(fn.onUnavailable).toHaveBeenCalledTimes(1)
    expect(el.querySelector('.composer-menu--model')).not.toBeNull() // the same tap goes on to the picker / web menu
    await tap() // (closes it)
    const many = [{ label: 'Test', options: Array.from({ length: NATIVE_MENU_MAX_ITEMS + 1 }, (_, i) => model(`m${i}`, `M ${i}`)) }] as ModelPillGroup[]
    const big = await mount({ groups: many, modelId: 'm0' })
    seen = []; answer = null; await tap()
    expect(seen).toEqual([]) // never sent: it would be refused whole
    expect(big.onUnavailable).toHaveBeenCalledTimes(1)
    expect(el.querySelector('.composer-menu--model')).not.toBeNull() // this tap falls through to the picker / web menu
  })
})
