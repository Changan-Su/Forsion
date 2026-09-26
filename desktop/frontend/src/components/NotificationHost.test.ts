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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const move = (target: EventTarget) => act(async () => { target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })) })

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
