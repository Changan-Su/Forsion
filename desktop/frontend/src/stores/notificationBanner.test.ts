// @vitest-environment happy-dom
/**
 * 原生横幅的胶水(connectNativeBanner,mobile/src/nativeChrome.ts 装原生顶栏时调):桥的哪一半坏了,提示都得有人画。
 * - `banner` 事件注册失败:不登记 presenter(页面画);注册成功后才登记。
 * - `setBanner` 被拒:撤掉 presenter(页面接着画),并让原生层收起它可能还画着的那张。
 * - 回落网页顶栏(off):presenter 撤掉。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectNativeBanner, nativeBannerPresenter, type NativeBannerBridge, type NativeBannerPayload } from './notificationBanner'
import { resetNotificationThrottle, useNotifications } from './notificationStore'

const card: NativeBannerPayload = { id: 'ntf-1', source: 'Biz', text: 'hello', action: 'Open', level: 'info', dismiss: 'Dismiss', hint: 'Swipe up' }
const tick = () => new Promise((r) => setTimeout(r, 0))
let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  useNotifications.getState().dismissAll()
  resetNotificationThrottle()
})
afterEach(() => { errors.mockRestore() })

function bridge(opts: { listen?: 'ok' | 'fail'; set?: (n: number) => 'ok' | 'fail' } = {}) {
  const calls: Array<(NativeBannerPayload & { theme: string }) | null> = []
  let onEvent: ((e: { id?: string; kind?: string }) => void) | null = null
  const b: NativeBannerBridge<string> = {
    setBanner: async ({ banner }) => {
      calls.push(banner)
      if ((opts.set?.(calls.length) ?? 'ok') === 'fail') throw new Error('INVALID_BANNER')
    },
    addListener: async (_event, cb) => {
      if (opts.listen === 'fail') throw new Error('not implemented')
      onEvent = cb
      return { remove: async () => {} }
    },
  }
  return { b, calls, fire: (e: { id?: string; kind?: string }) => onEvent?.(e) }
}

it('事件注册成功后才登记 presenter;屏上那条带着当时的主题发给原生层;原生报回的手势进 store', async () => {
  const { b, calls, fire } = bridge()
  const link = connectNativeBanner(b, { theme: () => 'light', live: () => true })
  expect(nativeBannerPresenter(), '事件还没注册好就登记:原生画的卡点 × 页面收不到').toBeNull()
  await tick()
  const p = nativeBannerPresenter()!
  expect(p).not.toBeNull()
  p(card)
  await tick()
  expect(calls).toEqual([{ ...card, theme: 'light' }])
  const run = vi.fn()
  const id = useNotifications.getState().notify({ text: 'x', action: { label: 'Open', run } })!
  fire({ id, kind: 'action' })
  expect(run).toHaveBeenCalledTimes(1)
  link.repaint()
  await tick()
  expect(calls).toHaveLength(2) // 换主题:屏上那条重发
  link.off()
  expect(nativeBannerPresenter(), '回落网页顶栏:页面接着画').toBeNull()
})

it('`banner` 事件注册失败:一直由页面画(负对照:失败也登记 → 这里红)', async () => {
  const { b, calls } = bridge({ listen: 'fail' })
  connectNativeBanner(b, { theme: () => 'light', live: () => true })
  await tick(); await tick()
  expect(nativeBannerPresenter()).toBeNull()
  expect(calls).toEqual([])
})

it('`setBanner` 被拒:撤掉 presenter(页面接着画),并让原生层收起可能还画着的那张;之后不再往原生层发(负对照:被拒不撤 → 这里红)', async () => {
  const { b, calls } = bridge({ set: (n) => (n === 2 ? 'fail' : 'ok') })
  connectNativeBanner(b, { theme: () => 'light', live: () => true })
  await tick()
  const p = nativeBannerPresenter()!
  p(card)
  await tick()
  p({ ...card, id: 'ntf-2', text: 'rejected' })
  await tick(); await tick()
  expect(nativeBannerPresenter(), '被拒后还登记着:用户看不见这张卡').toBeNull()
  expect(calls.map((c) => c?.id ?? null)).toEqual(['ntf-1', 'ntf-2', null])
  p({ ...card, id: 'ntf-3' })
  await tick()
  expect(calls).toHaveLength(3)
})

it('原生顶栏已经回落(live 为假)时事件才注册好:不登记', async () => {
  const { b } = bridge()
  connectNativeBanner(b, { theme: () => 'light', live: () => false })
  await tick()
  expect(nativeBannerPresenter()).toBeNull()
})
