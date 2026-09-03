// 层级树纯逻辑:缩进序 / 多根 / 兄弟序 / 多值取首 id;环·超深·重复 id 一律退平铺,
// **孤儿(父被筛/搜没了)当根**(不退平铺,只记进 orphanIds)—— 2026-09-02 编排者裁决,理由见 tree.ts 文件头。
// 头号不变式:**任何输入下输出行数 == 输入行数**(种子化模糊用例把它当机器判据)。
import { describe, expect, it } from 'vitest'
import { MAX_TREE_DEPTH, buildTree, parentIdOf } from './tree'
import type { CellValue } from './schema'

type Row = { id: string; cells: Record<string, CellValue> }
/** `'k1'` = 根;`'k2<k1'` = k2 的父是 k1。 */
const rowsOf = (...spec: string[]): Row[] =>
  spec.map((s) => {
    const [id, p] = s.split('<')
    const cells: Record<string, CellValue> = {}
    if (p) cells.p = p
    return { id, cells }
  })
const shape = (rows: Row[]): string[] => buildTree(rows, 'p').nodes.map((n) => `${'  '.repeat(n.depth)}${n.row.id}${n.hasKids ? '*' : ''}`)

describe('buildTree(层级树)', () => {
  it('前序摊平:父在前子紧随,depth 逐级 +1,有子节点的行 hasKids', () => {
    // k1 ├ k2 ─ k3 ;k4 独立根;k5 独立根
    const t = buildTree(rowsOf('k1', 'k2<k1', 'k3<k2', 'k4', 'k5'), 'p')
    expect(t.flat).toBe(false)
    expect(t.reason).toBe(null)
    expect(t.nodes.map((n) => [n.row.id, n.depth, n.hasKids])).toEqual([
      ['k1', 0, true], ['k2', 1, true], ['k3', 2, false], ['k4', 0, false], ['k5', 0, false],
    ])
  })

  it('多根 + 子节点散在输入各处:父在前、子紧随(不按输入序平摊)', () => {
    expect(shape(rowsOf('a', 'b', 'a1<a', 'b1<b', 'a2<a'))).toEqual(['a*', '  a1', '  a2', 'b*', '  b1'])
  })

  it('兄弟保持输入序 —— 用户排序只在兄弟间生效(输入换序 → 兄弟换序,父子关系不变)', () => {
    expect(shape(rowsOf('a', 'a2<a', 'a1<a'))).toEqual(['a*', '  a2', '  a1'])
    expect(shape(rowsOf('a', 'a1<a', 'a2<a'))).toEqual(['a*', '  a1', '  a2'])
  })

  it('空值 / 缺键 / 非字符串 cell = 根(不是孤儿);多值关联取第一个 id 当父', () => {
    expect(parentIdOf(undefined)).toBe('')
    expect(parentIdOf('')).toBe('')
    expect(parentIdOf(null)).toBe('')
    expect(parentIdOf(7)).toBe('')
    expect(parentIdOf(true)).toBe('')
    expect(parentIdOf(['', 'x', 'y'])).toBe('x') // 多父 = DAG,只认第一个
    expect(parentIdOf([])).toBe('')
    const rows: Row[] = [{ id: 'a', cells: {} }, { id: 'b', cells: { p: null } }, { id: 'c', cells: { p: 0 } }, { id: 'd', cells: { p: ['a', 'b'] } }]
    const t = buildTree(rows, 'p')
    expect(t.flat).toBe(false)
    expect(t.nodes.map((n) => [n.row.id, n.depth])).toEqual([['a', 0], ['d', 1], ['b', 0], ['c', 0]])
  })

  it('treeCol 缺 = 平铺(reason=off,不是异常);空表也不炸', () => {
    const t = buildTree(rowsOf('a', 'b<a'), undefined)
    expect([t.flat, t.reason]).toEqual([true, 'off'])
    expect(t.nodes.map((n) => n.depth)).toEqual([0, 0])
    expect(buildTree([], 'p')).toEqual({ nodes: [], flat: false, reason: null, cycleIds: [], orphanIds: [] })
  })

  it('环(自指 / A→B→A)→ 退平铺,行一条不少,cycleIds 记下爬不到根的行', () => {
    const self = buildTree(rowsOf('a<a', 'b'), 'p')
    expect([self.flat, self.reason, self.cycleIds]).toEqual([true, 'cycle', ['a']])
    expect(self.nodes.map((n) => [n.row.id, n.depth, n.hasKids])).toEqual([['a', 0, false], ['b', 0, false]])

    const two = buildTree(rowsOf('a<b', 'b<a', 'c'), 'p')
    expect([two.flat, two.reason]).toEqual([true, 'cycle'])
    expect(two.cycleIds).toEqual(['a', 'b'])
    expect(two.nodes).toHaveLength(3)

    // 挂在环下面的行也爬不到根 → 一并计入 cycleIds(但仍然一行不少)
    const under = buildTree(rowsOf('a<b', 'b<a', 'c<a'), 'p')
    expect(under.cycleIds).toEqual(['a', 'b', 'c'])
    expect(under.nodes).toHaveLength(3)
  })

  it('孤儿(父 id 不在本行集里 —— 含被筛选/搜索掉的父)→ **当根**,树保住,只记进 orphanIds', () => {
    const t = buildTree(rowsOf('a', 'b<gone'), 'p')
    expect([t.flat, t.reason, t.orphanIds]).toEqual([false, null, ['b']])
    expect(t.nodes.map((n) => [n.row.id, n.depth])).toEqual([['a', 0], ['b', 0]])
  })

  it('孤儿当根:它下面的完好子树**保住缩进**(裁决的正题 —— 一个孤儿不该把整棵树压平)', () => {
    // 「筛掉了 b 的父」的常态:b 当根,c 仍缩进在 b 下面;a 那棵完全不受影响
    const t = buildTree(rowsOf('a', 'a1<a', 'b<gone', 'c<b'), 'p')
    expect(t.flat).toBe(false)
    expect(t.orphanIds).toEqual(['b'])
    expect(shape(rowsOf('a', 'a1<a', 'b<gone', 'c<b'))).toEqual(['a*', '  a1', 'b*', '  c'])
    // 多个孤儿也照样各自当根(按输入序)
    expect(buildTree(rowsOf('x<gone1', 'y<gone2'), 'p').orphanIds).toEqual(['x', 'y'])
  })

  it('孤儿与平铺可同时成立:环仍退平铺,但 orphanIds 照实带出(平铺了也看得见)', () => {
    const t = buildTree(rowsOf('a<b', 'b<a', 'c<gone'), 'p')
    expect([t.flat, t.reason]).toEqual([true, 'cycle'])
    expect(t.cycleIds).toEqual(['a', 'b'])
    expect(t.orphanIds).toEqual(['c'])
    // 反过来:'off' / 'dup' 在父指针那趟之前就退了 → orphanIds 恒 []
    expect(buildTree(rowsOf('b<gone'), undefined).orphanIds).toEqual([])
    expect(buildTree([{ id: 'a', cells: { p: 'gone' } }, { id: 'a', cells: {} }], 'p').orphanIds).toEqual([])
  })

  it('重复行 id → 退平铺(按 id 建表会吞行,先于树逻辑挡住)', () => {
    const t = buildTree([{ id: 'a', cells: {} }, { id: 'a', cells: {} }], 'p')
    expect([t.flat, t.reason, t.nodes.length]).toEqual([true, 'dup', 2])
  })

  it(`深度上限 ${MAX_TREE_DEPTH}:恰好到顶仍成树,再深一级退平铺(行数照旧相等)`, () => {
    const chain = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, cells: (i ? { p: `n${i - 1}` } : {}) as Record<string, CellValue> }))
    const ok = buildTree(chain(MAX_TREE_DEPTH + 1), 'p') // depth 0..MAX
    expect(ok.flat).toBe(false)
    expect(ok.nodes[ok.nodes.length - 1].depth).toBe(MAX_TREE_DEPTH)
    const deep = buildTree(chain(MAX_TREE_DEPTH + 2), 'p')
    expect([deep.flat, deep.reason, deep.nodes.length]).toEqual([true, 'depth', MAX_TREE_DEPTH + 2])
    expect(deep.nodes.every((n) => n.depth === 0)).toBe(true)
  })

  it('深度**从孤儿自己起算**:孤儿在链顶 = 与真根同款(照旧超深);孤儿在链中 = 重新扎根,深度反而变浅', () => {
    const chain = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, cells: (i ? { p: `n${i - 1}` } : {}) as Record<string, CellValue> }))
    // ① 链顶 n0 的父指向不在场的 ghost → n0 是孤儿根(depth 0),下面 MAX+1 级照旧超深退平铺
    //    (被筛掉的祖先不上屏、不占缩进 → 不计入;这条闸守的是**渲染缩进**上限)
    const topOrphan = chain(MAX_TREE_DEPTH + 2)
    topOrphan[0].cells = { p: 'ghost' }
    const a = buildTree(topOrphan, 'p')
    expect([a.flat, a.reason, a.orphanIds]).toEqual([true, 'depth', ['n0']])
    expect(a.nodes).toHaveLength(MAX_TREE_DEPTH + 2)
    // ② 同一条链,改成筛掉 n0(n1 的父不在场)→ n1 重新扎根,整条链短一级,恰好不超深 = 成树
    //    → 「重新扎根只会**减少**深度」的机器证据:同样长的链,筛过之后反而能画出来
    const midOrphan = chain(MAX_TREE_DEPTH + 2).slice(1)
    const b = buildTree(midOrphan, 'p')
    expect([b.flat, b.reason, b.orphanIds]).toEqual([false, null, ['n1']])
    expect(b.nodes.map((n) => n.depth)).toEqual(Array.from({ length: MAX_TREE_DEPTH + 1 }, (_, i) => i))
    expect(b.nodes[0].depth).toBe(0) // 孤儿 n1 就是根
  })

  it('不变式(种子化模糊,含环/孤儿/自指/重复 id/脏值):输出行数与 id 多重集恒等于输入', () => {
    // 线性同余伪随机:同一种子恒定复现,红了照种子就能重跑
    let seed = 20260902
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let iter = 0; iter < 400; iter++) {
      const n = 1 + rnd(12)
      const ids = Array.from({ length: n }, (_, i) => `r${i}`)
      const rows: Row[] = ids.map((id) => {
        const roll = rnd(10)
        const cells: Record<string, CellValue> =
          roll < 2 ? {} // 根
            : roll < 3 ? { p: id } // 自指
              : roll < 4 ? { p: 'ghost' } // 孤儿
                : roll < 5 ? { p: rnd(2) ? 42 : null } // 脏值
                  : roll < 6 ? { p: [ids[rnd(n)], ids[rnd(n)]] } // 多值
                    : { p: ids[rnd(n)] } // 随机父(大概率造出环)
        return { id: rnd(20) === 0 ? ids[rnd(n)] : id, cells } // 5% 概率制造重复 id
      })
      const t = buildTree(rows, 'p')
      expect(t.nodes).toHaveLength(rows.length)
      expect(t.nodes.map((x) => x.row.id).sort()).toEqual(rows.map((r) => r.id).sort())
      if (t.flat) expect(t.nodes.every((x) => x.depth === 0 && !x.hasKids)).toBe(true)
      else expect(t.nodes.every((x) => x.depth <= MAX_TREE_DEPTH)).toBe(true)
      // 孤儿当根后的两条附加判据:orphanIds ⊆ 输入行 id;成树时每个孤儿的节点 depth 恒 0(它就是根)
      const idSet = new Set(rows.map((r) => r.id))
      expect(t.orphanIds.every((id) => idSet.has(id))).toBe(true)
      if (!t.flat) expect(t.nodes.filter((x) => t.orphanIds.includes(x.row.id)).every((x) => x.depth === 0)).toBe(true)
    }
  })
})
