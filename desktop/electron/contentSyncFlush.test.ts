import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createContentFlush, type FlushReason } from './contentSyncFlush'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('flushes one second after the app lost focus, not when focus comes back within that second', () => {
  let focused = false
  const calls: FlushReason[] = []
  const f = createContentFlush({ focused: () => focused })
  f.add((r) => { calls.push(r) })
  f.blur(); vi.advanceTimersByTime(900); f.focus(); vi.advanceTimersByTime(1000)
  expect(calls).toEqual([]) // Alt-Tab 一下又回来
  f.blur(); vi.advanceTimersByTime(1000)
  expect(calls).toEqual(['blur'])
  // 从一扇窗切到本应用另一扇:blur 先到、focus 晚到也一样不算(到点时再看有没有窗口拿着焦点)
  focused = true; f.blur(); vi.advanceTimersByTime(1000)
  expect(calls).toEqual(['blur'])
  f.suspend(); expect(calls).toEqual(['blur', 'suspend'])
})

it('quit waits for pending pushes up to the cap, only once per quit, and never blocks on a broken hook', async () => {
  const f = createContentFlush({ focused: () => false })
  expect(f.quit()).toBeNull() // 没人登记:照常退
  f.reset()
  let finish!: () => void
  f.add(() => new Promise<void>((r) => { finish = r }))
  f.add(() => { throw new Error('broken plugin') })
  f.add(() => Promise.reject(new Error('push failed')))
  f.add(() => undefined) // 没有要推的
  let done = false
  const waiting = f.quit(5000)!
  void waiting.then(() => { done = true })
  await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false)
  finish(); await vi.advanceTimersByTimeAsync(0); expect(done).toBe(true)
  expect(f.quit()).toBeNull() // 重启那条路冲过了,紧跟着的 before-quit 不再冲
  f.reset()
  const stuck = f.quit(5000)!
  let released = false
  void stuck.then(() => { released = true })
  await vi.advanceTimersByTimeAsync(4999); expect(released).toBe(false)
  await vi.advanceTimersByTimeAsync(1); expect(released).toBe(true) // 推不完也到点放行
})

it('nothing held means the hook returns nothing and quit does not wait', () => {
  const f = createContentFlush({ focused: () => false })
  f.add(() => undefined)
  expect(f.quit()).toBeNull()
})
