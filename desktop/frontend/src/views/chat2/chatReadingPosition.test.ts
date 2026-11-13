// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureChatPosition, chatReadingKey, readChatPosition, rememberChatPosition, restoreChatPosition, trackChatReading } from './chatReadingPosition'
function stream(prefixHeight = 0) {
  const root = document.body.appendChild(document.createElement('div'))
  Object.defineProperty(root, 'clientHeight', { value: 400 })
  Object.defineProperty(root, 'scrollHeight', { value: 1800 + prefixHeight })
  root.getBoundingClientRect = () => ({ top: 0, bottom: 400, height: 400 } as DOMRect)
  for (let i = 0; i < 4; i++) {
    const message = root.appendChild(document.createElement('div'))
    message.id = `tocmsg-m${i}`
    message.getBoundingClientRect = () => ({ top: prefixHeight + i * 400 - root.scrollTop, bottom: prefixHeight + (i + 1) * 400 - root.scrollTop } as DOMRect)
  }
  return root
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })
describe('conversation reading position', () => {
  it('a remounted Space returns to the same message and offset after content above changes', () => {
    const key = chatReadingKey('reading', 'chat#1', 'session-1'), original = stream()
    original.scrollTop = 450
    const saved = captureChatPosition(original, false)
    expect(saved).toMatchObject({ messageId: 'tocmsg-m1', offset: -50 })
    rememberChatPosition(key, saved); original.remove()
    const returned = stream(200), follow = { current: true }, controller = trackChatReading(key, returned, follow)
    controller.restore(false)
    expect(follow.current).toBe(false)
    expect(returned.scrollTop).toBe(650)
    expect(captureChatPosition(returned, false).offset).toBe(-50)
    controller.dispose()
  })
  it('same conversation in two split Views keeps independent anchors', () => {
    const left = chatReadingKey('split', 'left', 'same'), right = chatReadingKey('split', 'right', 'same')
    const a = stream(), b = stream(); a.scrollTop = 100; b.scrollTop = 900
    rememberChatPosition(left, captureChatPosition(a, false)); rememberChatPosition(right, captureChatPosition(b, false))
    a.scrollTop = b.scrollTop = 0
    restoreChatPosition(a, readChatPosition(left)!); restoreChatPosition(b, readChatPosition(right)!)
    expect([a.scrollTop, b.scrollTop]).toEqual([100, 900])
  })
  it('a follower returns to the new bottom while an explicit search owns its destination', () => {
    const key = chatReadingKey('follow', 'chat', 'session')
    rememberChatPosition(key, { follow: true, top: 800, offset: 0 })
    const root = stream(300); restoreChatPosition(root, readChatPosition(key)!)
    expect(root.scrollTop).toBe(2100)
    const follows = { current: true }, controller = trackChatReading(key, root, follows, true)
    root.scrollTop = 100; controller.restore(false)
    expect(follows.current).toBe(false); expect(root.scrollTop).toBe(100); controller.dispose()
  })
  it('manual scroll and search cancel correction, including delayed history', () => {
    for (const event of ['wheel', 'lcl:scroll-to-element']) {
      const key = chatReadingKey(event, 'chat', 'session')
      rememberChatPosition(key, { follow: false, messageId: 'tocmsg-m1', top: 420, offset: -20 })
      const root = stream(), controller = trackChatReading(key, root, { current: true })
      controller.restore(true); root.dispatchEvent(new Event(event)); root.scrollTop = 73; controller.restore(false)
      expect(root.scrollTop).toBe(73); expect(controller.restoring).toBe(false); controller.dispose()
    }
  })
  it('does not replace an anchor with zero geometry during unmount', () => {
    const key = chatReadingKey('unmount', 'chat', 'session'), root = stream(); root.scrollTop = 450
    rememberChatPosition(key, captureChatPosition(root, false))
    const controller = trackChatReading(key, root, { current: false })
    root.remove(); root.scrollTop = 0; controller.dispose()
    expect(readChatPosition(key)?.top).toBe(450)
  })
  it('resumes a restored background tab when its detached DOM becomes visible', () => {
    let resized: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {} disconnect() {}
    })
    const key = chatReadingKey('background', 'chat', 'session'), root = stream()
    rememberChatPosition(key, { follow: false, messageId: 'tocmsg-m1', top: 450, offset: -50 })
    root.remove()
    const controller = trackChatReading(key, root, { current: false })
    controller.restore(false)
    expect(root.scrollTop).toBe(0)
    document.body.appendChild(root); resized?.()
    expect(root.scrollTop).toBe(450)
    controller.dispose()
  })
})
