// 插件前置依赖的纯函数(2026-10-02)。钉:原因按「没装 → 被挡 → 版本低 → 成环 → 没在跑」的先后报;
// 拓扑序前置在前、其余保持传入顺序;环不进正常序;依赖方是传递闭包。
// 负对照:把 unmetDependencies 里成环那一支删掉 → 第三条红(环上的被报成 off,用户以为去开一下就好);
// topoOrder 改回按 id 排 → 第四条红;topoOrder 失败时改回 state.delete(重新展开)→ 分层环那条红。
import { describe, expect, it } from 'vitest'
import { dependentsOf, topoOrder, unmetDependencies, type DepNode } from './pluginDeps'

const n = (id: string, requires: Array<string | { id: string; minVersion?: string }> = [], over: Partial<DepNode> = {}): DepNode => ({
  id, version: '1.0.0', requiresPlugins: requires.map((r) => (typeof r === 'string' ? { id: r } : r)), ...over,
})
const reasons = (p: DepNode, all: DepNode[], active: string[] = [], wanted: string[] = []): string[] =>
  unmetDependencies(p, all, (id) => active.includes(id), (id) => wanted.includes(id)).map((u) => `${u.dep.id}:${u.reason}`)

describe('unmetDependencies', () => {
  it('齐了 = 装了且在跑;装了但关着 / 开着没在跑 分开报', () => {
    const all = [n('a'), n('b'), n('c'), n('x', ['a', 'b', 'c'])]
    expect(reasons(all[3], all, ['a'], ['c'])).toEqual(['b:off', 'c:waiting'])
    expect(reasons(all[3], all, ['a', 'b', 'c'])).toEqual([])
  })

  it('没装 / 被门禁挡 / 版本不够', () => {
    const all = [n('blk', [], { blocked: 'api' }), n('old', [], { version: '1.2.0' }), n('x', ['gone', 'blk', { id: 'old', minVersion: '1.10' }])]
    expect(reasons(all[2], all, ['blk', 'old'])).toEqual(['gone:missing', 'blk:blocked', 'old:version'])
    expect(unmetDependencies(all[2], all, () => true, () => true)[2].have).toBe('1.2.0')
  })

  it('互相依赖(含间接)报 cycle,不是 off', () => {
    const all = [n('a', ['b']), n('b', ['c']), n('c', ['a'])]
    expect(reasons(all[0], all)).toEqual(['b:cycle'])
  })
})

describe('topoOrder / dependentsOf', () => {
  it('前置排在依赖方前面,其余保持传入顺序;环上的排到最后', () => {
    const all = [n('z'), n('app', ['lib']), n('lib'), n('c1', ['c2']), n('c2', ['c1']), n('m')]
    expect(topoOrder(all).map((x) => x.id)).toEqual(['z', 'lib', 'app', 'm', 'c1', 'c2'])
  })

  it('底层成环的分层图:每个节点只展开一次(不是指数级,Codex 10-02)', () => {
    const layers = 16
    const all: DepNode[] = [n('L0a', ['L0b']), n('L0b', ['L0a'])]
    for (let i = 1; i < layers; i++) all.push(n(`L${i}a`, [`L${i - 1}a`, `L${i - 1}b`]), n(`L${i}b`, [`L${i - 1}a`, `L${i - 1}b`]))
    let reads = 0
    for (const x of all) {
      const deps = x.requiresPlugins
      Object.defineProperty(x, 'requiresPlugins', { get: () => { reads += 1; return deps } })
    }
    const order = topoOrder(all)
    expect(order.map((x) => x.id)).toEqual(all.map((x) => x.id)) // 全在环上或走得到环:按原顺序排到最后
    expect(reads).toBeLessThanOrEqual(all.length)
  })

  it('依赖方是传递闭包,不含自己', () => {
    const all = [n('base'), n('mid', ['base']), n('top', ['mid']), n('other')]
    expect(dependentsOf('base', all).map((x) => x.id)).toEqual(['mid', 'top'])
    expect(dependentsOf('other', all)).toEqual([])
  })
})
