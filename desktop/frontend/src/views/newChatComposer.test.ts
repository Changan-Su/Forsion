// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

vi.mock('./chat2/Composer2', () => ({ Composer2: () => null }))
const { guardedSend } = await import('./newChatComposer')

const later = () => { let done!: (v: boolean | void) => void; const p = new Promise<boolean | void>((r) => { done = r }); return { p, done } }

describe('ctx.tangu.mountComposer 的发送闸(主页插件化 S2)', () => {
  it('插件的 beforeSend 放完动效才发;明确回 false 就不发', async () => {
    const run = vi.fn(async (text: string) => text === 'hi')
    expect(await guardedSend(() => true, run, false)('hi')).toBe(true)
    expect(await guardedSend(() => false, run, false)('hi')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('beforeSend 抛错照样发:装饰动画不许吃掉用户按下的那一下', async () => {
    const run = vi.fn(async () => true)
    expect(await guardedSend(() => { throw new Error('anim') }, run, false)()).toBe(true)
    expect(await guardedSend(() => Promise.reject(new Error('anim')), run, false)()).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('同一时刻只放一次:动效没放完又按一下 = 第二下没发,第一下的内容不被第二下顶掉', async () => {
    const gate = later()
    const run = vi.fn(async (text: string) => !!text)
    const send = guardedSend(() => gate.p, run, false)
    const first = send('first')
    expect(await send('second')).toBe(false)
    gate.done()
    expect(await first).toBe(true)
    expect(run.mock.calls).toEqual([['first']])
    expect(await send('third')).toBe(true) // 放完之后闸重新打开
  })
})
