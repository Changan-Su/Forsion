// @vitest-environment happy-dom
/** 人员候选的开销纪律(2026-09-02,Codex 第二波评审 [medium]:聚焦一下就无上限并发全库 + 反复全量扫描)。
 *  候选集合本身的语义单测在 propertyTypes.builtins.test.ts 的 person 段;这里只钉三件会静默退化的事:
 *  ① topByCount 取前 N 是 O(n) 选取而非整排,并列次数下的先后与输入顺序无关;
 *  ② personCountOf 按 entries 身份备忘(同一份 entries 只数一遍 —— 键盘每敲一下不重扫全库);
 *  ③ pullVaultDbs 并发封顶 4,且已在 store 里的库不重复发 load。
 *  ponytail: 用 createElement / 直接调函数,不渲染 PersonCell —— 要量的是这三条,不是 DOM。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'

let inFlight = 0
let peak = 0
let asked: string[] = []
/** 受控的读库:每次故意留一个 microtask 之外的空档,好让并发真的叠起来。 */
vi.mock('../../api', () => ({
  amadeus: {
    readDatabase: async (path: string) => {
      asked.push(path)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { status: 'ok', path, version: 1, data: { version: 1, name: path, columns: [], rows: [] } }
    },
  },
}))

const { countPersonNames, personCountOf, pullVaultDbs, topByCount } = await import('./PersonCell')
const { useDbStore } = await import('../../store/dbStore')
const { usePageStore } = await import('../../store/pageStore')

const personDb = (name: string, ...names: string[]): DbFile => ({
  version: 1,
  name,
  columns: [{ id: 'p1', name: '负责人', type: 'person' }],
  rows: names.map((n, i) => ({ id: `r${i}`, cells: { p1: n } })),
})

beforeEach(() => {
  inFlight = 0
  peak = 0
  asked = []
  useDbStore.setState({ entries: {} })
  usePageStore.setState({ files: [] })
})

describe('topByCount:O(n) 取前 N', () => {
  const m = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o))

  it('次数降序、并列按名字 zh 序;截到 limit', () => {
    const c = m({ 王五: 2, 李四: 2, Alice: 1, 张三: 5 })
    expect(topByCount(c, '', 8)).toEqual(['张三', '李四', '王五', 'Alice'])
    expect(topByCount(c, '', 2)).toEqual(['张三', '李四'])
    expect(topByCount(c, '', 1)).toEqual(['张三'])
    expect(topByCount(c, '', 0)).toEqual([])
  })

  it('并列次数的先后与输入顺序无关(选取式实现最容易在这里退化成「先到先得」)', () => {
    const names = ['丙', '甲', '乙', '丁']
    const forward = topByCount(m(Object.fromEntries(names.map((n) => [n, 1]))), '', 3)
    const backward = topByCount(m(Object.fromEntries([...names].reverse().map((n) => [n, 1]))), '', 3)
    expect(forward).toEqual(backward)
    expect(forward).toEqual([...names].sort((a, b) => a.localeCompare(b, 'zh')).slice(0, 3))
  })

  it('候选比 limit 多很多时也只留 limit 个,且恰是全序里的前 limit', () => {
    const many = m(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`u${String(i).padStart(3, '0')}`, i % 7])))
    const got = topByCount(many, '', 8)
    const want = [...many.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .slice(0, 8)
      .map(([n]) => n)
    expect(got).toEqual(want) // 与「整排后截断」逐字一致
  })

  it('query 大小写无关子串过滤,在截断之前生效', () => {
    const c = m({ Alice: 9, alicia: 1, Bob: 8 })
    expect(topByCount(c, 'ali', 8)).toEqual(['Alice', 'alicia'])
    expect(topByCount(c, ' ALI ', 1)).toEqual(['Alice'])
    expect(topByCount(c, '查无此人', 8)).toEqual([])
  })
})

describe('personCountOf:按 entries 身份备忘', () => {
  it('同一份 entries 只数一遍(返回同一个 Map),换了对象才重数', () => {
    const a = { 'a.db': { status: 'ok' as const, path: 'a.db', data: personDb('A', '李四') } }
    const first = personCountOf(a)
    expect(first.get('李四')).toBe(1)
    expect(personCountOf(a)).toBe(first) // 身份稳定 → 可直接当 useMemo 依赖
    const b = { ...a, 'b.db': { status: 'ok' as const, path: 'b.db', data: personDb('B', '李四', '王五') } }
    const second = personCountOf(b)
    expect(second).not.toBe(first)
    expect(second.get('李四')).toBe(2)
    expect(countPersonNames([personDb('A', '李四')]).get('李四')).toBe(1) // 底层纯函数不吃缓存
  })
})

describe('pullVaultDbs:并发封顶 + 不重复发', () => {
  it('12 张 .db → 同时在飞的不超过 4 张,最终全部载入', async () => {
    usePageStore.setState({ files: Array.from({ length: 12 }, (_, i) => `d${i}.db`).concat(['笔记.md']) })
    pullVaultDbs()
    await vi.waitFor(() => expect(Object.keys(useDbStore.getState().entries)).toHaveLength(12), { timeout: 2000 })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // 确实并发了,不是退化成串行
    expect(asked).not.toContain('笔记.md') // 只拉 .db
  })

  it('已在 store 里的库不重复发 load(第二次打开下拉只补新增的那张)', async () => {
    usePageStore.setState({ files: ['a.db', 'b.db'] })
    pullVaultDbs()
    await vi.waitFor(() => expect(Object.keys(useDbStore.getState().entries)).toHaveLength(2), { timeout: 2000 })
    asked = []
    usePageStore.setState({ files: ['a.db', 'b.db', 'c.db'] })
    pullVaultDbs()
    await vi.waitFor(() => expect(Object.keys(useDbStore.getState().entries)).toHaveLength(3), { timeout: 2000 })
    expect(asked).toEqual(['c.db'])
  })
})
