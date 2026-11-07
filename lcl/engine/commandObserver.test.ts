import { afterEach, describe, expect, it } from 'vitest'
import { addCommand, removeCommand, runWithCommandSource, setCommandObserver, useCommandStore } from './commandRegistry'

afterEach(() => { setCommandObserver(null); for (const id of ['t.a', 't.b', 't.c']) removeCommand(id) })

describe('命令观察者(宿主遥测)', () => {
  it('带来源的入口跑命令 → 报 (id, 来源) 一次;命令里再调别的命令不重复记;没来源的调用不记', () => {
    const seen: Array<[string, string]> = []
    setCommandObserver((id, source) => seen.push([id, source]))
    let ran = 0
    addCommand({ id: 't.b', title: 'B', run: () => { ran++ } })
    addCommand({ id: 't.a', title: 'A', run: () => { ran++; useCommandStore.getState().run('t.b') } })
    runWithCommandSource('palette', () => useCommandStore.getState().run('t.a'))
    expect(seen).toEqual([['t.a', 'palette']])
    expect(ran).toBe(2)
    useCommandStore.getState().run('t.a') // 代码里直接跑:不记
    expect(seen).toHaveLength(1)
    runWithCommandSource('hotkey', () => useCommandStore.getState().run('missing')) // 不存在的命令:来源不残留
    useCommandStore.getState().run('t.b')
    expect(seen).toHaveLength(1)
  })
  it('invoke.run 也记;this 照旧指向命令对象;观察者抛错不影响命令', () => {
    setCommandObserver(() => { throw new Error('boom') })
    const got: unknown[] = []
    addCommand({
      id: 't.c', title: 'C', marker: 1,
      run() { got.push((this as { marker?: number }).marker) },
      invoke: { params: [], run(args: Record<string, unknown>) { got.push(args.v) } },
    } as never)
    runWithCommandSource('agent', () => useCommandStore.getState().run('t.c'))
    runWithCommandSource('agent', () => useCommandStore.getState().run('t.c', { v: 7 }))
    expect(got).toEqual([1, 7])
  })
})
