/** per-tab 导航历史:栈按 leafId 隔离、去重、前进截断、drop/reset 清理。 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useNav } from './navStore'

const nav = () => useNav.getState()
const entry = (key: string, log: string[]) => ({ key, restore: () => { log.push(key) } })

describe('navStore per-leaf', () => {
  beforeEach(() => useNav.getState().reset())

  it('栈按 leaf 隔离,back 只动本 leaf', () => {
    const log: string[] = []
    nav().record('A', entry('a1', log))
    nav().record('A', entry('a2', log))
    nav().record('B', entry('b1', log))
    nav().back('A')
    expect(log).toEqual(['a1'])
    expect(nav().stacks.A.idx).toBe(0)
    expect(nav().stacks.B.idx).toBe(0) // B 不受影响
  })

  it('同 key 去重;新记录截断 forward', async () => {
    const log: string[] = []
    nav().record('A', entry('a1', log))
    nav().record('A', entry('a1', log)) // 去重
    expect(nav().stacks.A.entries).toHaveLength(1)
    nav().record('A', entry('a2', log))
    nav().back('A')
    await Promise.resolve() // navigating 闸在 restore 的 finally(microtask)后才放开
    nav().record('A', entry('a3', log)) // 在 idx0 处压入 → a2 被截断
    expect(nav().stacks.A.entries.map((e) => e.key)).toEqual(['a1', 'a3'])
  })

  it('restore 期间 navigating 闸:restore 内的 record 不入栈', async () => {
    const log: string[] = []
    nav().record('A', { key: 'a1', restore: () => { nav().record('A', entry('ax', log)) } })
    nav().record('A', entry('a2', log))
    nav().back('A') // 触发 a1.restore → 其内 record 应被闸
    await Promise.resolve()
    expect(nav().stacks.A.entries.map((e) => e.key)).toEqual(['a1', 'a2'])
  })

  it('越界 back/forward 与未知 leaf 均 no-op', () => {
    const log: string[] = []
    nav().back('missing')
    nav().record('A', entry('a1', log))
    nav().back('A') // idx0 → 无更早
    nav().forward('A') // 顶端 → 无更新
    expect(log).toEqual([])
  })

  it('drop 删栈;reset 清全部', () => {
    const log: string[] = []
    nav().record('A', entry('a1', log))
    nav().record('B', entry('b1', log))
    nav().drop('A')
    expect(nav().stacks.A).toBeUndefined()
    expect(nav().stacks.B).toBeDefined()
    nav().reset()
    expect(Object.keys(nav().stacks)).toHaveLength(0)
  })
})
