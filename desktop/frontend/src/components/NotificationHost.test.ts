// @vitest-environment happy-dom
/**
 * 悬停暂停的收尾(check:layoutreset J 实测抓到):指针停在通知上 → 暂停计时;点了卡片上的「撤销」/ ×,卡片在指针下
 * 被移走,Chromium 不补 mouseleave → paused 一直挂着,之后所有通知都不再自己消失。现在:没有卡片了、或暂停期间指针
 * 移出通知区 → 恢复计时;指针仍在通知区里移动 → 保持暂停。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNotifications, notifyApp } from '../stores/notificationStore'

vi.mock('@lcl/engine', () => ({ useSpaceStore: (sel: (s: { activeSpaceId: string }) => unknown) => sel({ activeSpaceId: 'home' }) }))
const { NotificationHost } = await import('./NotificationHost')

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useNotifications.getState().dismissAll()
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
  notifyApp({ text: 'hovered', level: 'info' })
  await act(async () => root.render(React.createElement(NotificationHost)))
  const card = host.querySelector('.ntf-text')!
  // 真实鼠标:指针事件与鼠标事件成对出现
  await fire(card, [ptr('pointerover', 'mouse'), mouse('mouseover')])
  expect(useNotifications.getState().paused).toBe(true)
  await act(async () => { vi.advanceTimersByTime(20_000) })
  expect(useNotifications.getState().items, '鼠标停在卡片上,卡片不该到点消失').toHaveLength(1)
  await fire(card, [ptr('pointerout', 'mouse'), mouse('mouseout')])
  expect(useNotifications.getState().paused).toBe(false)
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(useNotifications.getState().items).toHaveLength(0)
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
