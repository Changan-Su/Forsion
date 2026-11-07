import { afterEach, describe, expect, it } from 'vitest'
import { addCommand, noteCommandUse, removeCommand, setCommandObserver, useCommandStore } from './commandRegistry'

afterEach(() => { setCommandObserver(null); removeCommand('t.c') })

describe('命令观察者(宿主遥测)', () => {
  it('带来源的入口报 (id, 来源);没挂观察者 / 观察者抛错都不影响', () => {
    const seen: Array<[string, string]> = []
    noteCommandUse('t.a', 'palette') // 没挂:什么都不做
    setCommandObserver((id, source) => seen.push([id, source]))
    noteCommandUse('t.a', 'palette')
    noteCommandUse('t.b', 'hotkey')
    expect(seen).toEqual([['t.a', 'palette'], ['t.b', 'hotkey']])
    setCommandObserver(() => { throw new Error('boom') })
    expect(() => noteCommandUse('t.a', 'ribbon')).not.toThrow()
  })
  it('注册的命令原样存(不包一层):对象身份、this、返回值都不变', () => {
    class Cmd {
      #n = 41
      id = 't.c'
      title = 'C'
      run(): number { return ++this.#n } // 私有字段:换了 this 就会抛
    }
    const cmd = new Cmd()
    addCommand(cmd as never)
    const stored = useCommandStore.getState().commands.find((c) => c.id === 't.c')
    expect(stored).toBe(cmd)
    expect((stored as unknown as Cmd).run()).toBe(42)
  })
})
