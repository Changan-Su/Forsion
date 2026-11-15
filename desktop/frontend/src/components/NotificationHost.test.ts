// @vitest-environment happy-dom
/**
 * 悬停暂停的收尾(check:layoutreset J 实测抓到):指针停在通知上 → 暂停计时;点了卡片上的「撤销」/ ×,卡片在指针下
 * 被移走,Chromium 不补 mouseleave → paused 一直挂着,之后所有通知都不再自己消失。现在:没有卡片了、或暂停期间指针
 * 移出通知区 → 恢复计时;指针仍在通知区里移动 → 保持暂停。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNotifications, notifyApp, resetNotificationThrottle } from '../stores/notificationStore'
import { onNativeBannerEvent, setNativeBannerPresenter, type NativeBannerPayload } from '../stores/notificationBanner'

vi.mock('@lcl/engine', () => ({ useSpaceStore: (sel: (s: { activeSpaceId: string }) => unknown) => sel({ activeSpaceId: 'home' }) }))
const { NotificationHost } = await import('./NotificationHost')

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useNotifications.getState().setBanner(false)
  useNotifications.getState().dismissAll()
  resetNotificationThrottle()
  useNotifications.setState({ prefs: { enabled: true, osEnabled: false, events: {} }, paused: false })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const move = (target: EventTarget) => act(async () => { target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })) })
// React 的 onPointerEnter / onMouseEnter 由冒泡的 pointerover / mouseover 合成,直接派 *enter 不触发。
const fire = (target: EventTarget, events: Event[]) => act(async () => { for (const e of events) target.dispatchEvent(e) })
const ptr = (type: string, pointerType: string) => new PointerEvent(type, { bubbles: true, pointerType, isPrimary: true })
const mouse = (type: string) => new MouseEvent(type, { bubbles: true })
/** 触屏 / 手写笔点一下卡片正文:先是指针事件,抬手后浏览器补发兼容鼠标事件(mouseover → mouseenter …),之后没有配对的离开。 */
const tapSequence = (pointerType: string): Event[] => [
  ptr('pointerover', pointerType), ptr('pointerdown', pointerType), ptr('pointerup', pointerType), ptr('pointerout', pointerType),
  mouse('mouseover'), mouse('mousemove'), mouse('mousedown'), mouse('mouseup'), mouse('click'),
]

it.each(['touch', 'pen'])('%s 点一下卡片不暂停计时,卡片照常到点消失(安卓真壳:点过之后卡片一直不走)', async (pointerType) => {
  vi.useFakeTimers()
  notifyApp({ text: 'tapped but ignored', level: 'info' }) // info 停留 5000ms
  await act(async () => root.render(React.createElement(NotificationHost)))
  await fire(host.querySelector('.ntf-text')!, tapSequence(pointerType))
  expect(useNotifications.getState().paused, `${pointerType} 点按后挂上了暂停,且不会有离开事件来解除`).toBe(false)
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(useNotifications.getState().items, '点过的卡片没按时消失').toHaveLength(0)
})

it('鼠标悬停照旧暂停,移出后续走剩余时间', async () => {
  vi.useFakeTimers()
  notifyApp({ text: 'hovered', level: 'info' }) // 5000ms
  await act(async () => root.render(React.createElement(NotificationHost)))
  const card = host.querySelector('.ntf-text')!
  await act(async () => { vi.advanceTimersByTime(2000) })
  // 真实鼠标:指针事件与鼠标事件成对出现
  await fire(card, [ptr('pointerover', 'mouse'), mouse('mouseover')])
  expect(useNotifications.getState().paused).toBe(true)
  await act(async () => { vi.advanceTimersByTime(20_000) })
  expect(useNotifications.getState().items, '鼠标停在卡片上,卡片不该到点消失').toHaveLength(1)
  await fire(card, [ptr('pointerout', 'mouse'), mouse('mouseout')])
  expect(useNotifications.getState().paused).toBe(false)
  await act(async () => { vi.advanceTimersByTime(2999) })
  expect(useNotifications.getState().items, '移出后应续走剩余的 3000ms,而不是重新计满').toHaveLength(1)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(useNotifications.getState().items).toHaveLength(0)
})

it('鼠标停在卡片上时再用手指点一下(触屏笔记本):触屏的离开不解除鼠标的暂停', async () => {
  vi.useFakeTimers()
  notifyApp({ text: 'hybrid', level: 'info' })
  await act(async () => root.render(React.createElement(NotificationHost)))
  const card = host.querySelector('.ntf-text')!
  await fire(card, [ptr('pointerover', 'mouse'), mouse('mouseover')])
  await fire(card, tapSequence('touch'))
  expect(useNotifications.getState().paused, '手指抬起的 pointerout 把鼠标悬停的暂停解除了').toBe(true)
  await act(async () => { vi.advanceTimersByTime(20_000) })
  expect(useNotifications.getState().items).toHaveLength(1)
})

it('leaving the window and unmounting the host cannot leave notification timers paused', async () => {
  notifyApp({ text: 'first' })
  await act(async () => root.render(React.createElement(NotificationHost)))
  await act(async () => useNotifications.getState().pause())
  await act(async () => window.dispatchEvent(new Event('blur')))
  expect(useNotifications.getState().paused).toBe(false)
  await act(async () => useNotifications.getState().pause())
  await act(async () => root.render(null))
  expect(useNotifications.getState().paused).toBe(false)
})

it('点掉指针下最后一张卡片:暂停随之解除', async () => {
  notifyApp({ text: 'Layout restored', action: { label: 'Undo', run: () => {} }, durationMs: 8000 })
  await act(async () => root.render(React.createElement(NotificationHost)))
  await act(async () => useNotifications.getState().pause()) // 指针移到卡片上
  expect(useNotifications.getState().paused).toBe(true)
  await act(async () => host.querySelector<HTMLButtonElement>('.ntf-action')!.click())
  expect(useNotifications.getState().items).toHaveLength(0)
  expect(useNotifications.getState().paused, '卡片没了还挂着暂停:下一条通知永远不会自己消失').toBe(false)
})

it('还有别的卡片时:指针在通知区里移动保持暂停,移出通知区即恢复计时', async () => {
  notifyApp({ text: 'first', action: { label: 'Undo', run: () => {} } })
  notifyApp({ text: 'second' })
  await act(async () => root.render(React.createElement(NotificationHost)))
  await act(async () => useNotifications.getState().pause())
  await act(async () => host.querySelector<HTMLButtonElement>('.ntf-action')!.click())
  expect(useNotifications.getState().items).toHaveLength(1)
  await move(host.querySelector('.ntf-wrap')!)
  expect(useNotifications.getState().paused).toBe(true)
  await move(document.body)
  expect(useNotifications.getState().paused).toBe(false)
})


// ── 手机横幅(MobileRoot 挂 <NotificationHost phone />):窄于 640 才是横幅,有原生 presenter 交原生、没有画 DOM ──
const narrow = (on: boolean): void => {
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({
    matches: on && q === '(max-width: 639px)', media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList)
}
const phoneHost = () => act(async () => root.render(React.createElement(NotificationHost, { phone: true })))
const pointer = (type: string, clientY: number) => new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientY })

it('手机窄屏、没有原生外壳(网页版手机):画 DOM 横幅 —— 一行来源、一行正文、按钮和 × 靠右,× 的读屏名跟着语言', async () => {
  narrow(true)
  notifyApp({ text: '3 件事等你处理', sourceLabel: '商业版', title: '待我处理', event: 'plugin:biz', action: { label: '去工作台', run: () => {} } })
  notifyApp({ text: 'second', event: 'plugin:x' })
  await phoneHost()
  expect(useNotifications.getState().banner).toBe(true)
  expect(host.querySelector('.ntf-wrap'), '窄屏手机不该再画右上角堆叠').toBeNull()
  const cards = host.querySelectorAll('.ntf-banner')
  expect(cards).toHaveLength(1) // 一次一条,不显示 +N
  expect(host.querySelector('.ntf-more')).toBeNull()
  expect(host.querySelector('.ntf-banner-source')!.textContent).toBe('商业版 · 待我处理')
  expect(host.querySelector('.ntf-banner-text')!.textContent).toBe('3 件事等你处理')
  expect(host.querySelector('.ntf-banner-action')!.textContent).toBe('去工作台')
  expect(host.querySelector('.ntf-banner-close')!.getAttribute('aria-label')).toBe('收起')
})

it('宽屏手机(Pad、横屏)照桌面放右上角;桌面不传 phone 就算窄也是堆叠', async () => {
  narrow(false)
  notifyApp({ text: 'wide' })
  await phoneHost()
  expect(host.querySelector('.ntf-wrap .ntf')).not.toBeNull()
  expect(useNotifications.getState().banner).toBe(false)
  narrow(true)
  await act(async () => root.render(React.createElement(NotificationHost)))
  expect(host.querySelector('.ntf-banner')).toBeNull()
  expect(host.querySelector('.ntf-close')!.getAttribute('aria-label'), '× 的读屏名原来写死英文 dismiss').toBe('收起')
})

it('DOM 横幅:点正文 = 执行按钮动作;点 × = 用户自己收(同一来源冷却 2 分钟)', async () => {
  narrow(true)
  const run = vi.fn()
  notifyApp({ text: 'hello', event: 'plugin:biz', action: { label: 'Open', run } })
  await phoneHost()
  await act(async () => { host.querySelector<HTMLElement>('.ntf-banner-text')!.click() })
  expect(run).toHaveBeenCalledTimes(1)
  expect(useNotifications.getState().items).toHaveLength(0)
  vi.useFakeTimers()
  await act(async () => { vi.advanceTimersByTime(30_000) }) // 点动作的冷却 30 秒
  await act(async () => { notifyApp({ text: 'again', event: 'plugin:biz' }); vi.advanceTimersByTime(300) })
  await act(async () => { host.querySelector<HTMLButtonElement>('.ntf-banner-close')!.click() })
  expect(useNotifications.getState().items).toHaveLength(0)
  await act(async () => { vi.advanceTimersByTime(119_000) })
  expect(notifyApp({ text: 'still cooling', event: 'plugin:biz' })).toBeNull()
})

it('DOM 横幅:往上滑过 24px 收起(算用户自己收的),不够就弹回;往下拉不动', async () => {
  narrow(true)
  notifyApp({ text: 'swipe me', event: 'plugin:biz' })
  await phoneHost()
  const card = host.querySelector<HTMLElement>('.ntf-banner')!
  // 慢慢滑:每一步隔 60ms(合成事件的时间戳就是派发那一刻,挤在一起就成了「一甩」)
  const slow = async (ys: number[]): Promise<void> => {
    await fire(card, [pointer('pointerdown', ys[0])])
    for (const y of ys.slice(1)) { await new Promise((r) => setTimeout(r, 60)); await fire(card, [pointer('pointermove', y)]) }
    await new Promise((r) => setTimeout(r, 60))
    await fire(card, [pointer('pointerup', ys.at(-1)!)])
  }
  await slow([100, 92, 85])
  expect(useNotifications.getState().items, '只慢慢滑了 15px 就收起了').toHaveLength(1)
  await slow([100, 120, 140])
  expect(useNotifications.getState().items, '往下拉不该收起').toHaveLength(1)
  await slow([100, 90, 80, 70])
  expect(useNotifications.getState().items, '滑过 24px 没收起').toHaveLength(0)
  expect(notifyApp({ text: 'cooling', event: 'plugin:biz' }), '上滑收起应算用户自己收的,进 2 分钟冷却').toBeNull()
  // 一甩:只动了 12px,但很快
  await act(async () => { notifyApp({ text: 'flick me', event: 'plugin:fl' }); await new Promise((r) => setTimeout(r, 350)) })
  const flick = host.querySelector<HTMLElement>('.ntf-banner')!
  await fire(flick, [pointer('pointerdown', 100), pointer('pointermove', 93), pointer('pointermove', 88), pointer('pointerup', 88)])
  expect(useNotifications.getState().items, '往上一甩没收起').toHaveLength(0)
})

it('有原生外壳:不画 DOM,把屏上这一条交给原生层;原生报回的手势按 id 找,走了的不作数', async () => {
  narrow(true)
  const seen: Array<NativeBannerPayload | null> = []
  const off = setNativeBannerPresenter((b) => { seen.push(b) })
  try {
    const run = vi.fn()
    notifyApp({ text: '3 件事等你处理', sourceLabel: '商业版', title: '待我处理', level: 'warning', event: 'plugin:biz', action: { label: '去工作台', run } })
    await phoneHost()
    expect(host.querySelector('.ntf-banner, .ntf-wrap')).toBeNull()
    const last = seen.at(-1)!
    expect(last).toMatchObject({ source: '商业版 · 待我处理', text: '3 件事等你处理', action: '去工作台', level: 'warning', dismiss: '收起', hint: '上滑或点 × 收起' })
    onNativeBannerEvent('stale-id', 'action')
    expect(run).not.toHaveBeenCalled()
    await act(async () => onNativeBannerEvent(last.id, 'action'))
    expect(run).toHaveBeenCalledTimes(1)
    expect(seen.at(-1), '动作执行后原生层该收起').toBeNull()
    await act(async () => { notifyApp({ text: 'next', event: 'plugin:other' }); await new Promise((r) => setTimeout(r, 350)) })
    const next = seen.at(-1)!
    expect(next.text).toBe('next')
    await act(async () => onNativeBannerEvent(next.id, 'dismiss'))
    expect(useNotifications.getState().items).toHaveLength(0)
    expect(notifyApp({ text: 'cooling', event: 'plugin:other' }), '原生层上滑 / 点 × 也算用户自己收的').toBeNull()
    // 常驻的那张在 × 往回报的路上被新来的顶回队列:用户点的 × 照样算数,新来的走了它不再回来
    // (负对照:只认屏上这一条 → 这里红)
    resetNotificationThrottle()
    const pinClosed = vi.fn()
    await act(async () => { notifyApp({ text: 'pinned', sticky: true, event: 'plugin:pin', onClose: pinClosed }); await new Promise((r) => setTimeout(r, 350)) })
    const pinned = seen.at(-1)!
    expect(pinned.text).toBe('pinned')
    await act(async () => { notifyApp({ text: 'newcomer', event: 'plugin:new' }); await new Promise((r) => setTimeout(r, 350)) })
    expect(seen.at(-1)?.text, '常驻的该给新来的让位').toBe('newcomer')
    const newcomer = seen.at(-1)!
    await act(async () => { notifyApp({ text: 'third', event: 'plugin:third' }) })
    expect(useNotifications.getState().queue.map((n) => n.text)).toEqual(['pinned', 'third'])
    await act(async () => { onNativeBannerEvent(pinned.id, 'dismiss'); await new Promise((r) => setTimeout(r, 350)) })
    const st = useNotifications.getState()
    expect(st.queue.map((n) => n.text), '晚到的 × 没把让位的常驻收掉,或者收错了排在后面的').toEqual(['third'])
    expect(st.items.map((n) => n.id), '屏上那条不该被动,也不该被顶掉').toEqual([newcomer.id])
    expect(seen.at(-1)?.id, '原生层还该显示新来的那条').toBe(newcomer.id)
    expect(pinClosed, '常驻那张的 onClose 只调一次').toHaveBeenCalledTimes(1)
    expect(notifyApp({ text: 'pin again', event: 'plugin:pin' }), '常驻的(节流管不着)收起不开始冷却').not.toBeNull()
    await act(async () => { useNotifications.getState().dismiss(newcomer.id); await new Promise((r) => setTimeout(r, 350)) })
    expect(seen.at(-1)?.text, '新来的走了,轮到排在后面的,常驻的不再回来').toBe('third')
    await act(async () => { useNotifications.getState().dismissAll() })
    expect(useNotifications.getState().items).toHaveLength(0)
    expect(pinClosed).toHaveBeenCalledTimes(1)
  } finally { await act(async () => off()) }
  // presenter 撤了(桥坏了):改画 DOM
  await act(async () => { notifyApp({ text: 'fallback', event: 'plugin:z' }); await new Promise((r) => setTimeout(r, 350)) })
  expect(host.querySelector('.ntf-banner-text')?.textContent).toBe('fallback')
})
