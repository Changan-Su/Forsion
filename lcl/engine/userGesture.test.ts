import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inUserGesture, installUserGestureTracking, markUserGesture } from './userGesture'

beforeEach(() => { vi.useFakeTimers(); vi.runAllTimers() })
afterEach(() => { vi.useRealTimers() })

function target() {
  const listeners = new Map<string, (e: Event) => void>()
  return {
    listeners,
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => { listeners.set(type, fn as (e: Event) => void) },
    removeEventListener: (type: string) => { listeners.delete(type) },
    fire: (type: string, isTrusted: boolean) => listeners.get(type)?.({ type, isTrusted } as Event),
  }
}

it('真实的点按 / 按键算用户手势,只到这个任务结束(零延迟定时器);脚本派发的不算', () => {
  const t = target()
  const off = installUserGestureTracking(t)
  for (const type of ['pointerup', 'click', 'touchend', 'keydown', 'drop']) expect(t.listeners.has(type), type).toBe(true)
  expect(t.listeners.has('scroll')).toBe(false)
  t.fire('click', false)
  expect(inUserGesture(), '脚本 el.click() 不是用户').toBe(false)
  t.fire('click', true)
  expect(inUserGesture()).toBe(true)
  vi.advanceTimersByTime(0)
  expect(inUserGesture(), '这个任务结束后,后来的网络回调 / 定时器不算(负对照:不清 → 这里红)').toBe(false)
  off()
  expect(t.listeners.size).toBe(0)
})

it('原生面板上的选择(nativeSheet)由宿主直接标记,同样只到任务结束', () => {
  markUserGesture()
  markUserGesture()
  expect(inUserGesture()).toBe(true)
  vi.advanceTimersByTime(0)
  expect(inUserGesture()).toBe(false)
})
