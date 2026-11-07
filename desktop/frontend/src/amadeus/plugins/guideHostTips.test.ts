// @vitest-environment happy-dom
/**
 * 宿主自己的上手提示(guideTips.ts 的 registerHostTip,2026-11-07 LCL 表面规范第一期:通话键首次提示并进来)。
 *  · 额外动作占「不再提示」的位置:点了收提示('ok' = 记看过)再执行;
 *  · 「看过」记在宿主那一格(owner = forsion),markHostTipSeen 正出着就收掉;
 *  · 读不到的存储当「不知道」(hostTipSeen 返回 undefined),不当没看过。
 * 节奏(停手、等弹窗、一天几条)和插件提示同一个 pickTip,纯函数那半在 guideTips.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSpotlight, showTip } from './guideSpotlight'
import { HOST_TIP_OWNER, hostTipSeen, markHostTipSeen, registerHostTip, tipState } from './guideTips'

const button = (): HTMLElement => {
  const el = document.createElement('button')
  el.dataset.guideAnchor = 'chat-call'
  el.getBoundingClientRect = () => ({ x: 300, y: 500, left: 300, top: 500, width: 28, height: 28, right: 328, bottom: 528, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}
const frames = async (n = 3): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null))) }

beforeEach(() => { document.body.innerHTML = ''; localStorage.clear() })
afterEach(() => closeSpotlight())

describe('showTip extra action', () => {
  it('takes the place of "don\'t show again"; clicking it finishes ok, then runs', async () => {
    const el = button()
    const run = vi.fn()
    const done = showTip(HOST_TIP_OWNER, { find: () => el, style: 'ring', title: 'T', body: 'B', dock: false, extra: { label: '换个音色', run } })
    await frames()
    const left = document.querySelector<HTMLButtonElement>('.guide-spot-card .guide-spot-mute')!
    expect(left.textContent).toBe('换个音色')
    left.click()
    expect(await done).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.guide-spot-card')).toBeNull()
  })
  it('without extra keeps "don\'t show again" → mute', async () => {
    const el = button()
    const done = showTip('some-plugin', { find: () => el, style: 'ring', title: 'T', body: 'B', dock: false })
    await frames()
    document.querySelector<HTMLButtonElement>('.guide-spot-card .guide-spot-mute')!.click()
    expect(await done).toBe('mute')
  })
})

describe('host tips bookkeeping', () => {
  it('registers under the host owner and marks seen', () => {
    registerHostTip({ id: 'voice-call', at: 'chat-call', style: 'ring', resolve: () => ({ title: 't', body: 'b' }) })
    expect(hostTipSeen('voice-call')).toBe(false)
    expect(tipState(HOST_TIP_OWNER, 'voice-call')).toBe('waiting')
    markHostTipSeen('voice-call')
    expect(hostTipSeen('voice-call')).toBe(true)
    expect(tipState(HOST_TIP_OWNER, 'voice-call')).toBe('seen')
  })
  it('unreadable storage = unknown, not "never seen"', () => {
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    try { expect(hostTipSeen('never-written')).toBeUndefined() } finally { get.mockRestore() }
  })
})
