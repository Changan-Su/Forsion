// ctx.internals 的底座(2026-11-16,插件内部接口开放方案 B):只读副本、订阅、第二级的共享模块表、出错归因与熔断。
// 负对照(已实跑红):① copy() 去掉跳过函数那条、并让非对象原样返回 → 「副本里没有函数」红;
// ② subscribe 去掉 queued 合并 → 「同一轮两次 set 只算一遍」红;③ reportInternalsFault 去掉 counted → 「同一个错误对象只算一次」红。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

vi.mock('../api', () => ({ get amadeus() { return undefined } }))
vi.mock('../../coreTangu/sharedModules.generated', () => ({
  SHARED_MODULES: { 'host:demo.ts': { value: 1, bump() { return 2 } }, 'zustand': { create: 'zustand.create' } },
}))

const m = await import('./pluginInternals')
const { provideInternalStore } = await import('./internalsStores')

class Box { constructor(public x = 1) {} }

describe('snapshotOf:冻结的普通数据', () => {
  it('副本里没有函数和类实例;Date / Map / Set 换成数据', () => {
    const src = {
      n: 1, s: 'a', b: true, nil: null, und: undefined,
      fn: () => 1, box: new Box(), when: new Date(5),
      map: new Map([['k', { v: 1 }]]), set: new Set([1, 2]),
      list: [1, { deep: () => 0, keep: 'x' }],
    }
    const c = m.snapshotOf(src) as Record<string, unknown>
    expect(c).toEqual({ n: 1, s: 'a', b: true, nil: null, und: undefined, when: 5, map: [['k', { v: 1 }]], set: [1, 2], list: [1, { keep: 'x' }] })
    expect('fn' in c).toBe(false)
    expect('box' in c).toBe(false)
  })

  it('整棵都冻住,改不动', () => {
    const c = m.snapshotOf({ a: { b: [1] } }) as { a: { b: number[] } }
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.a)).toBe(true)
    expect(Object.isFrozen(c.a.b)).toBe(true)
    expect(() => { 'use strict'; (c.a as Record<string, unknown>).b = 2 }).toThrow()
  })

  it('访问器不读', () => {
    let hits = 0
    const src = { get x() { hits++; return 1 }, y: 2 }
    expect(m.snapshotOf(src)).toEqual({ y: 2 })
    expect(hits).toBe(0)
  })

  it('没变的子树复用同一份副本(一次更新只复制变了的路径)', () => {
    const keep = { big: [1, 2, 3] }
    const a = m.snapshotOf({ keep, n: 1 }) as { keep: unknown }
    const b = m.snapshotOf({ keep, n: 2 }) as { keep: unknown }
    expect(b.keep).toBe(a.keep)
  })

  it('有环也不死循环', () => {
    const o: Record<string, unknown> = { a: 1 }
    o.self = o
    const c = m.snapshotOf(o) as Record<string, unknown>
    expect(c.self).toBe(c)
  })

  // 以下四条与 sameData 环、同轮退订、只看栈帧三条是 Codex 11-16 评审的回归。负对照(都已实跑红):① Date 改回 o.getTime();
  // ② 去掉 volatileSeen 那行 copies.delete;③ 数组改回 o[i] 直接读;④ 去掉 catch 里的 copies.delete;⑤ sameData 去掉成对去重;
  // ⑥ 退订不置 stopped;⑦ faultOwner 改回整段 includes
  it('Date 按原型的 getTime 取数:实例上覆盖的 getTime 交不出别的东西', () => {
    const d = new Date(7)
    const host = { secret: 1 }
    Object.defineProperty(d, 'getTime', { value: () => host })
    expect(m.snapshotOf({ d })).toEqual({ d: 7 })
  })

  it('子树里有 Map:原地改了之后再读是新的(含 Map 的祖先不留副本)', () => {
    const map = new Map([['k', 1]])
    const state = { nested: { map } }
    expect(m.snapshotOf(state)).toEqual({ nested: { map: [['k', 1]] } })
    map.set('k', 2)
    expect(m.snapshotOf(state)).toEqual({ nested: { map: [['k', 2]] } })
  })

  it('数组下标上的 getter 不执行', () => {
    let hits = 0
    const arr: unknown[] = [1, 2]
    Object.defineProperty(arr, 0, { get() { hits++; return { leak: true } }, enumerable: true })
    expect(m.snapshotOf({ arr })).toEqual({ arr: [undefined, 2] })
    expect(hits).toBe(0)
  })

  it('复制到一半抛错:半成品不留,下一次照样完整复制、冻住', () => {
    let boom = true
    const inner = new Proxy({ v: 1 }, { ownKeys(t) { if (boom) throw new Error('x'); return Reflect.ownKeys(t) } })
    const outer = [inner]
    expect(() => m.snapshotOf(outer)).toThrow('x')
    boom = false
    const c = m.snapshotOf(outer) as unknown[]
    expect(c).toEqual([{ v: 1 }])
    expect(Object.isFrozen(c)).toBe(true)
  })
})

describe('sameData', () => {
  it('按数据比,不按引用', () => {
    expect(m.sameData({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(m.sameData({ a: [1] }, { a: [1, 2] })).toBe(false)
    expect(m.sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(m.sameData([], {})).toBe(false)
  })

  it('内容一样的环形数据判等,不比到深度上限再判不等', () => {
    const a: Record<string, unknown> = { n: 1 }; a.self = a
    const b: Record<string, unknown> = { n: 1 }; b.self = b
    const c: Record<string, unknown> = { n: 2 }; c.self = c
    expect(m.sameData(a, b)).toBe(true)
    expect(m.sameData(a, c)).toBe(false)
  })
})

function harness(raw = false) {
  const store = create<{ count: number; items: string[]; inc(): void }>((set) => ({
    count: 0, items: [], inc: () => set((s) => ({ count: s.count + 1 })),
  }))
  provideInternalStore('test', store)
  let alive = true
  const undos: Array<() => void> = []
  const api = m.createInternalsApi({
    pluginId: 'p-test',
    raw,
    alive: () => alive,
    own: (_k, undo) => { undos.push(undo); return undo },
  })
  return { store, api, kill: () => { alive = false; for (const u of undos.splice(0)) u() } }
}

describe('read / subscribe', () => {
  it('read 给冻结副本;选择函数拿到的也是副本,碰不到动作', () => {
    const { store, api } = harness()
    store.setState({ count: 3 })
    expect(api.read('test', (s) => (s as { count: number }).count)).toBe(3)
    expect(api.read('test', (s) => typeof (s as { inc?: unknown }).inc)).toBe('undefined')
    expect(Object.isFrozen(api.read('test'))).toBe(true)
    expect(api.read('nope')).toBeUndefined()
    expect(api.stores()).toContain('test')
  })

  it('同一轮两次 set 只算一遍、只通知一次;数据没变不通知', async () => {
    const { store, api } = harness()
    const seen: Array<[unknown, unknown]> = []
    let runs = 0
    api.subscribe('test', (s) => { runs++; return (s as { count: number }).count }, (now, prev) => { seen.push([now, prev]) })
    expect(runs).toBe(1) // 订阅时先算一遍当基线
    store.getState().inc()
    store.getState().inc()
    await Promise.resolve()
    expect(runs).toBe(2)
    expect(seen).toEqual([[2, 0]])
    store.setState({ items: [] }) // count 没变
    await Promise.resolve()
    expect(seen).toHaveLength(1)
  })

  it('选择函数返回新对象,内容一样也不通知', async () => {
    const { store, api } = harness()
    const cb = vi.fn()
    api.subscribe('test', (s) => ({ c: (s as { count: number }).count }), cb)
    store.setState({ items: ['x'] })
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })

  it('同一轮里退订:已经排上的那一次也不回调(Codex 11-16)', async () => {
    const { store, api } = harness()
    const cb = vi.fn()
    const off = api.subscribe('test', (s) => (s as { count: number }).count, cb)
    store.getState().inc()
    off()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })

  it('停用后:read 给 undefined,订阅被宿主撤掉', async () => {
    const { store, api, kill } = harness()
    const cb = vi.fn()
    api.subscribe('test', (s) => (s as { count: number }).count, cb)
    kill()
    store.getState().inc()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
    expect(api.read('test')).toBeUndefined()
  })
})

describe('第二级 raw', () => {
  it('没声明就没有', () => {
    expect(harness(false).api.raw).toBeUndefined()
  })

  it('按键取共享表里的模块,记下取用;不在表里 reject', async () => {
    const { api } = harness(true)
    m.takeRawUsage('p-test')
    const mod = await api.raw!.import('host:demo.ts')
    expect(mod.value).toBe(1)
    expect(typeof mod.bump).toBe('function') // 真对象:函数照给
    await expect(api.raw!.import('host:missing.ts')).rejects.toThrow(/shared module table/)
    expect(await api.raw!.modules()).toEqual(['host:demo.ts', 'zustand'])
    expect(m.rawModulesUsedBy('p-test')).toEqual(['host:demo.ts'])
    expect(m.takeRawUsage('p-test')).toEqual(['host:demo.ts'])
    expect(m.rawModulesUsedBy('p-test')).toEqual([])
  })

  it('停用后 import reject', async () => {
    const { api, kill } = harness(true)
    kill()
    await expect(api.raw!.import('host:demo.ts')).rejects.toThrow(/disabled/)
  })
})

describe('出错归因与熔断', () => {
  let trip: ReturnType<typeof vi.fn>
  beforeEach(() => {
    trip = vi.fn()
    m.setInternalsTrip(trip as unknown as (id: string) => void)
    m.dropInternalsLive('p-fault')
  })

  it('只认当前这一版的 sourceURL', () => {
    const v1 = m.nextInternalsSourceUrl('p-fault')
    m.markInternalsLive('p-fault', v1)
    const v2 = m.nextInternalsSourceUrl('p-fault')
    m.markInternalsLive('p-fault', v2)
    expect(v1).not.toBe(v2)
    expect(m.faultOwner({ stack: `Error: x\n    at f (${v2}:3:1)` })).toBe('p-fault')
    expect(m.faultOwner({ stack: `Error: x\n    at f (${v1}:3:1)` })).toBeNull()
    expect(m.faultOwner({ stack: 'Error: x\n    at host.js:1:1' })).toBeNull()
  })

  it('只看栈帧,不看消息;filename 要整段对上(Codex 11-16)', () => {
    const url = m.nextInternalsSourceUrl('p-fault')
    m.markInternalsLive('p-fault', url)
    // 负对照(已实跑红):faultOwner 改回在整段 stack 里 includes → 这一条红
    expect(m.faultOwner({ stack: `Error: Cannot fetch ${url}\n    at host.js:1:1` })).toBeNull()
    expect(m.faultOwner({ stack: `Error: x\n    at ${url}:2:5` })).toBe('p-fault')
    expect(m.faultOwner({ stack: `Error: x\n    at f (app://local/${url}:2:5)` })).toBe('p-fault')
    expect(m.faultOwner({}, url)).toBe('p-fault')
    expect(m.faultOwner({}, `${url}.map`)).toBeNull()
    expect(m.faultOwner({}, `x${url}`)).toBeNull()
  })

  it('同一个错误对象只算一次(window.onerror 和宿主自己的归因可能报同一个)', () => {
    m.markInternalsLive('p-fault', m.nextInternalsSourceUrl('p-fault'))
    const e = new Error('same')
    for (let i = 0; i < 3; i++) m.reportInternalsFault('p-fault', e, i)
    expect(trip).not.toHaveBeenCalled()
  })

  it('60 秒内 3 次熔断一次;隔得久的不累计', () => {
    m.markInternalsLive('p-fault', m.nextInternalsSourceUrl('p-fault'))
    m.reportInternalsFault('p-fault', new Error('a0'), 0)
    m.reportInternalsFault('p-fault', new Error('a1'), 1)
    m.reportInternalsFault('p-fault', new Error('b'), 70_000) // 前两条已过窗口
    m.reportInternalsFault('p-fault', new Error('c'), 70_001)
    expect(trip).not.toHaveBeenCalled()
    m.reportInternalsFault('p-fault', new Error('d'), 70_002)
    expect(trip).toHaveBeenCalledTimes(1)
    expect(trip).toHaveBeenCalledWith('p-fault')
  })

  it('不在运行的插件不算', () => {
    m.reportInternalsFault('p-fault', new Error('a'), 0)
    m.reportInternalsFault('p-fault', new Error('b'), 1)
    m.reportInternalsFault('p-fault', new Error('c'), 2)
    expect(trip).not.toHaveBeenCalled()
  })

  it('订阅回调抛错算到插件头上', async () => {
    const store = create<{ n: number }>(() => ({ n: 0 }))
    provideInternalStore('fault', store)
    m.markInternalsLive('p-fault', m.nextInternalsSourceUrl('p-fault'))
    const api = m.createInternalsApi({ pluginId: 'p-fault', raw: false, alive: () => true, own: (_k, u) => u })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.subscribe('fault', (s) => (s as { n: number }).n, () => { throw new Error('boom') })
    for (let i = 1; i <= 3; i++) { store.setState({ n: i }); await Promise.resolve() }
    err.mockRestore()
    expect(trip).toHaveBeenCalledTimes(1)
  })
})

describe('只在本机桌面', () => {
  it('不是 Electron 就不给', () => {
    expect(m.internalsAvailable()).toBe(false)
  })
})
