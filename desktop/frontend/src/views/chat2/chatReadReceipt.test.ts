// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { messageIsVisible, trackChatReadReceipt } from './chatReadReceipt'
import { useApp } from '../../stores/appStore'
import { useAttention } from '../../stores/attentionStore'
let viewport: HTMLDivElement, message: HTMLDivElement
const rect = (top: number, bottom: number) => ({ left: 0, right: 300, top, bottom, height: bottom - top, width: 300 }) as DOMRect
beforeEach(() => {
  vi.useFakeTimers()
  viewport = document.createElement('div'); message = document.createElement('div')
  message.id = 'tocmsg-m1'; viewport.append(message); document.body.append(viewport)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 800 })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 600 })
  viewport.getBoundingClientRect = () => rect(0, 500)
  message.getBoundingClientRect = () => rect(20, 100)
  document.elementFromPoint = () => message
})
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers() })
it('requires focus and visibility; covered or other Space tabs do not count', () => {
  expect(messageIsVisible(message, viewport)).toBe(true)
  vi.mocked(document.hasFocus).mockReturnValue(false)
  expect(messageIsVisible(message, viewport)).toBe(false)
  vi.mocked(document.hasFocus).mockReturnValue(true)
  document.elementFromPoint = () => document.body
  expect(messageIsVisible(message, viewport)).toBe(false)
  document.elementFromPoint = () => message
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  expect(messageIsVisible(message, viewport)).toBe(false)
})
it('reading old history, hidden tabs and unmounted messages do not count', () => {
  message.getBoundingClientRect = () => rect(550, 650)
  expect(messageIsVisible(message, viewport)).toBe(false)
  message.getBoundingClientRect = () => rect(0, 0)
  expect(messageIsVisible(message, viewport)).toBe(false)
  message.remove()
  expect(messageIsVisible(message, viewport)).toBe(false)
})
it('receipts follow rendered split session, not global activeId; cleanup stops them', async () => {
  const read = vi.spyOn(useAttention.getState(), 'markRead').mockImplementation(() => {})
  useAttention.setState({ dm: { pinned: { unread: true, awaiting: false, count: 1 } } })
  useApp.setState({ activeId: 'other', messagesBySession: { pinned: [{ id: 'm1', role: 'assistant', content: 'hello', timestamp: 100, status: 'done' }] } } as any)
  const off = trackChatReadReceipt(viewport, 'pinned')
  await vi.advanceTimersByTimeAsync(750)
  expect(read).toHaveBeenCalledWith('pinned', 'm1')
  off(); read.mockClear()
  await vi.advanceTimersByTimeAsync(1500)
  expect(read).not.toHaveBeenCalled()
})
it('visible canvas branch acknowledges its own session even when a hidden stream has the same message id', async () => {
  const read = vi.spyOn(useAttention.getState(), 'markRead').mockImplementation(() => {})
  const card = document.createElement('div'); card.dataset.readSessionId = 'branch'
  const shown = document.createElement('div'); shown.id = 'tocmsg-m2'; card.append(shown); viewport.append(card)
  const hidden = document.createElement('div'); hidden.id = 'tocmsg-m2'; viewport.prepend(hidden)
  hidden.getBoundingClientRect = () => rect(0, 0)
  shown.getBoundingClientRect = () => rect(20, 100)
  document.elementFromPoint = () => shown
  useAttention.setState({ dm: {} })
  useApp.setState({ sessions: [{ id: 'branch', awaiting_user: true }], messagesBySession: { branch: [{ id: 'm2', role: 'assistant', content: 'reply', timestamp: 200, status: 'done' }] } } as any)
  const off = trackChatReadReceipt(viewport, 'other')
  await vi.advanceTimersByTimeAsync(750)
  expect(read).toHaveBeenCalledWith('branch', 'm2')
  off()
})
