// @vitest-environment happy-dom
/** 模型选择器里当前会员档位用不了的模型:照常列出、变淡带锁,点了不选中、就地说明;原生菜单同一道闸;cap 读不到一个都不锁。 */
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNativeSheetPresenter, type NativeSheetPayload } from '@lcl/engine'
import { setLocaleGlobal } from '../i18n'
import { installModelPickerPresenter } from './modelPickerHost'
import { ModelPill, type ModelPillGroup } from './ModelPill'

const GROUPS = [{ label: 'Forsion', source: 'forsion', options: [
  { id: 'cheap', name: 'Cheap', source: 'forsion', multiplier: 1 },
  { id: 'edge', name: 'Edge', source: 'forsion', multiplier: 2.5 },
  { id: 'pricey', name: 'Pricey', source: 'forsion', multiplier: 5 },
  { id: 'mine', name: 'Mine', source: 'direct' },
] }] as ModelPillGroup[]

let el: HTMLDivElement
let root: Root
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  window.tangu = {
    accountQuota: vi.fn().mockResolvedValue({ status: 200, json: { dailyLimit: 100, weeklyLimit: 100, modelMultiplierCap: 2.5 } }),
    openPayCenter: vi.fn().mockResolvedValue({ ok: true }),
  } as any
  el = document.createElement('div'); document.body.append(el); root = createRoot(el)
})
afterEach(async () => { await act(async () => { root.unmount() }); el.remove(); delete window.tangu; vi.unstubAllGlobals() })

const mount = async (over: Partial<ComponentProps<typeof ModelPill>> = {}) => {
  const onSelect = vi.fn()
  await act(async () => { root.render(createElement(ModelPill, { modelId: 'cheap', groups: GROUPS, onSelect, ...over })) })
  await tick()
  return onSelect
}
const openModelPane = async () => {
  await act(async () => { el.querySelector<HTMLButtonElement>('.model-pill-btn')!.click() })
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-pane-trigger="model"]')!.click() })
}
const item = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.cm-sub .menu-item')].find((b) => (b.querySelector('.model-lock-name > span') || b.querySelector('.grow'))?.textContent === name)!

describe('网页菜单', () => {
  it('倍率 > 上限的变淡带锁,= 上限与自带模型照常;点它不选中,行下说明 + 升级会员', async () => {
    const onSelect = await mount()
    await openModelPane()
    expect(item('Pricey').classList.contains('is-locked')).toBe(true)
    expect(item('Pricey').getAttribute('aria-disabled')).toBe('true')
    expect(item('Pricey').textContent).toContain('升级后可用')
    expect(item('Edge').classList.contains('is-locked')).toBe(false)
    expect(item('Mine').classList.contains('is-locked')).toBe(false)
    await act(async () => { item('Pricey').click() })
    expect(onSelect).not.toHaveBeenCalled()
    const tip = document.querySelector('.cm-lock-tip')
    expect(tip?.textContent).toContain('当前会员档位不能使用 Pricey。升级会员或换一个模型。')
    await act(async () => { tip!.querySelector<HTMLButtonElement>('.cm-lock-upgrade')!.click() })
    expect(window.tangu!.openPayCenter).toHaveBeenCalledOnce()
    await openModelPane()
    await act(async () => { item('Edge').click() })
    expect(onSelect).toHaveBeenCalledWith('edge')
  })

  it('已经选着用不了的模型:按钮上标锁,不替用户换', async () => {
    const onSelect = await mount({ modelId: 'pricey' })
    const btn = el.querySelector<HTMLButtonElement>('.model-pill-btn')!
    expect(btn.dataset.tierLocked).toBe('true')
    expect(btn.querySelector('.pill-lock')).not.toBeNull()
    expect(btn.getAttribute('aria-label')).toContain('升级后可用')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('cap 读不到(读失败 / 没登录)或 -1:一个都不锁', async () => {
    window.tangu!.accountQuota = vi.fn().mockRejectedValue(new Error('offline')) as any
    await mount({ modelId: 'pricey' })
    expect(el.querySelector('.model-pill-btn')!.hasAttribute('data-tier-locked')).toBe(false)
    await openModelPane()
    expect(document.querySelectorAll('.cm-sub .menu-item.is-locked')).toHaveLength(0)
  })
  it('cap = -1 = 不限', async () => {
    window.tangu!.accountQuota = vi.fn().mockResolvedValue({ status: 200, json: { dailyLimit: 1, weeklyLimit: 1, modelMultiplierCap: -1 } }) as any
    await mount()
    await openModelPane()
    expect(document.querySelectorAll('.cm-sub .menu-item.is-locked')).toHaveLength(0)
  })
})

describe('手机原生合并菜单', () => {
  it('选中用不了的模型不落,改弹一张原生小卡给升级会员', async () => {
    const seen: NativeSheetPayload[] = []
    let answer: unknown = { id: 'model:0:2' }
    const off = installNativeSheetPresenter(async (payload) => { seen.push(payload); const a = answer; answer = null; return a })
    try {
      const onSelect = await mount({ icon: null, onThinkingChange: vi.fn(), thinkingLevel: 'medium', hub: { title: 'Hub', back: 'Back', extra: () => [] } })
      await act(async () => { el.querySelector<HTMLButtonElement>('.model-pill-btn')!.click() })
      await tick()
      expect(onSelect).not.toHaveBeenCalled()
      const last = seen.at(-1)!
      expect(last.kind === 'menu' && last.title).toBe('Pricey')
      const models = seen[0].kind === 'menu' ? seen[0].sections[0].items[0].children!.flatMap((s) => s.items) : []
      expect(models[2].detail).toContain('升级后可用')
    } finally { off() }
  })
})

describe('原生模型选择器(辅助模型槽也走同一道闸)', () => {
  it('在原生选择器里把辅助模型选成用不了的:不写进设置', async () => {
    const off = installModelPickerPresenter(async (request) => Object.fromEntries(request.fields.map((f) => [f.id, f.id === 'backgroundModelId' ? 'pricey' : f.id === 'model' ? 'pricey' : f.value])))
    try {
      const onDefaultModelChange = vi.fn()
      const modelsResponse = { models: [
        { id: 'cheap', name: 'Cheap', provider: 'f', source: 'forsion', modelType: 'llm', multiplier: 1 },
        { id: 'pricey', name: 'Pricey', provider: 'f', source: 'forsion', modelType: 'llm', multiplier: 5 },
      ], directProviders: [] } as never
      const onSelect = await mount({ modelsResponse, defaultModelIds: { backgroundModelId: '', imageModelId: '', visionModelId: '' }, onDefaultModelChange })
      await act(async () => { el.querySelector<HTMLButtonElement>('.model-pill-btn')!.click() })
      await tick()
      expect(onDefaultModelChange).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
    } finally { off() }
  })
})
