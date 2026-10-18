// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./chat2/Composer2', () => ({ Composer2: () => null }))
const { BEFORE_SEND_MAX_MS, sendGate } = await import('./newChatComposer')

const later = <T = boolean | void>() => { let done!: (v: T) => void; const p = new Promise<T>((r) => { done = r }); return { p, done } }
const never = new Promise<void>(() => {})

afterEach(() => { vi.useRealTimers() })

describe('ctx.tangu.mountComposer 的发送闸(主页插件化 S2)', () => {
  it('插件的 beforeSend 放完动效才发;明确回 false 就不发', async () => {
    const run = vi.fn(async (text: string) => text === 'hi')
    expect(await sendGate(() => true, never)(run, false)('hi')).toBe(true)
    expect(await sendGate(() => false, never)(run, false)('hi')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('beforeSend 抛错照样发:装饰动画不许吃掉用户按下的那一下', async () => {
    const run = vi.fn(async () => true)
    expect(await sendGate(() => { throw new Error('anim') }, never)(run, false)()).toBe(true)
    expect(await sendGate(() => Promise.reject(new Error('anim')), never)(run, false)()).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('发送和开通话共用一把锁:动效没放完又按通话 = 没动,第一下的内容不被顶掉', async () => {
    const anim = later()
    const gate = sendGate(() => anim.p, never)
    const send = vi.fn(async (text: string) => !!text)
    const call = vi.fn(async () => 'session')
    const first = gate(send, false)('first')
    expect(await gate(send, false)('second')).toBe(false)
    expect(await gate(call, null)()).toBe(null)
    anim.done()
    expect(await first).toBe(true)
    expect(send.mock.calls).toEqual([['first']])
    expect(call).not.toHaveBeenCalled()
    expect(await gate(call, null)()).toBe('session') // 放完之后锁重新打开
  })

  it('等动效时挂载被卸(插件停用,transitionend 永远不来)→ 照样发出去', async () => {
    const unmounted = later<void>()
    const run = vi.fn(async () => true)
    const sent = sendGate(() => new Promise(() => {}), unmounted.p)(run, false)()
    unmounted.done()
    expect(await sent).toBe(true)
  })

  it(`beforeSend 一直不回:最多等 ${BEFORE_SEND_MAX_MS}ms 就发`, async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => true)
    const sent = sendGate(() => new Promise(() => {}), never)(run, false)()
    await vi.advanceTimersByTimeAsync(BEFORE_SEND_MAX_MS)
    expect(await sent).toBe(true)
  })
})
