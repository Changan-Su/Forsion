import { describe, expect, it, vi } from 'vitest'
import { createQuitGuards, type QuitBlock } from './quitGuard'

const setup = (answer: boolean | (() => Promise<boolean>)) => {
  const asked: QuitBlock[] = []
  const quit = vi.fn()
  const g = createQuitGuards({
    locale: () => 'zh',
    ask: (b) => { asked.push(b); return typeof answer === 'function' ? answer() : Promise.resolve(answer) },
    quit,
  })
  return { g, asked, quit }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('quitGuard', () => {
  it('没人拦 → 照常退;有人说没做完 → 拦下问,点退出再退一次就放行', async () => {
    const { g, asked, quit } = setup(true)
    expect(g.intercept()).toBe(false)
    let busy = true
    g.add((l) => (busy ? { message: l === 'zh' ? '还有 2 个文件在传' : 'x', detail: 'd' } : null))
    expect(g.intercept()).toBe(true)
    await flush()
    expect(asked).toEqual([{ message: '还有 2 个文件在传', detail: 'd' }])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(g.intercept()).toBe(false) // 确认过的这一次放行
    busy = false
  })

  it('点取消:不退;下次退出还会问。对话框开着再按退出不叠第二个框', async () => {
    let resolve!: (v: boolean) => void
    const { g, asked, quit } = setup(() => new Promise((r) => { resolve = r }))
    g.add(() => ({ message: 'busy' }))
    expect(g.intercept()).toBe(true)
    expect(g.intercept()).toBe(true)
    expect(asked.length).toBe(1)
    resolve(false)
    await flush()
    expect(quit).not.toHaveBeenCalled()
    expect(g.intercept()).toBe(true)
    expect(asked.length).toBe(2)
  })

  it('插件的 guard 抛错 / 给坏值 = 当没事,不能因此退不出去;退订后不再问', async () => {
    const { g } = setup(true)
    g.add(() => { throw new Error('boom') })
    g.add(() => ({ message: '' }) as QuitBlock)
    expect(g.intercept()).toBe(false)
    const off = g.add(() => ({ message: 'busy' }))
    off()
    expect(g.intercept()).toBe(false)
  })

  it('重启的框开着时再按退出:不叠第二个框;退出的框开着时点重启:答「退出」由重启接手,不单纯退出', async () => {
    let resolve!: (v: boolean) => void
    const { g, asked, quit } = setup(() => new Promise((r) => { resolve = r }))
    g.add(() => ({ message: 'busy' }))
    const restart = g.confirmFirst()
    expect(g.intercept()).toBe(true)
    expect(asked.length).toBe(1)
    resolve(true)
    expect(await restart).toBe(true)
    await flush()
    expect(quit).not.toHaveBeenCalled()
    g.reset()
    expect(g.intercept()).toBe(true)
    const restart2 = g.confirmFirst()
    expect(asked.length).toBe(2)
    resolve(true)
    expect(await restart2).toBe(true)
    await flush()
    expect(quit).not.toHaveBeenCalled()
  })

  it('重启 / 装更新:先问一次,点了退出后面的 before-quit 不再问;取消就不重启', async () => {
    const yes = setup(true)
    yes.g.add(() => ({ message: 'busy' }))
    expect(await yes.g.confirmFirst()).toBe(true)
    expect(yes.g.intercept()).toBe(false)
    yes.g.reset()
    expect(yes.g.intercept()).toBe(true)
    const no = setup(false)
    no.g.add(() => ({ message: 'busy' }))
    expect(await no.g.confirmFirst()).toBe(false)
    expect(no.g.intercept()).toBe(true)
  })
})
