// 白板写侧的三条不变式。第一条是**毁数据级**的,单独写在最前面。
import { describe, it, expect } from 'vitest'
import { rawList, patchElement, removeElements, moveElements, freshElId, newShape, addConnector, setElementText, rawTree, setParent, pruneTree, childrenOf, isUnder, depthOf, runEndOf } from './canvasEdit'
import { withElements, parseCanvasJson } from './canvas'

/** 迁移产物的真实形状:形状带未来字段 `note`,顶层带未知键 `futureKey`。 */
const LINE = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"c1","x":0,"y":0,"w":400}],"elements":[{"id":"s1","type":"shape","shape":"rect","x":10,"y":20,"w":160,"h":90,"text":"形状","note":"未来字段"},{"id":"e1","type":"connector","from":{"ref":"c1"},"to":{"id":"s1"}}],"futureKey":{"a":1}}'

describe('未知字段的存活(§8:老端绝不吞新端的元素)', () => {
  it('挪动带未知字段的形状后,`note` 与顶层 `futureKey` 逐字还在', () => {
    const cur = parseCanvasJson(LINE)!
    const moved = moveElements(rawList(cur.elements), new Set(['s1']), 40, -5)
    const out = withElements(LINE, moved)!
    // ⚠️ 断言必须是**子串比对**:解析后比对字段数对「未知字段被删」一概照绿(本仓四次假绿的同一族)。
    expect(out).toContain('"note":"未来字段"')
    expect(out).toContain('"futureKey":{"a":1}')
    expect(out).toContain('"x":50,"y":15')
    // cards 段不归本路径管,必须原样。
    expect(out).toContain('"cards":[{"ref":"c1","x":0,"y":0,"w":400}]')
  })

  it('patch 只覆盖点名的键', () => {
    const [s1] = patchElement([{ id: 's1', type: 'shape', x: 1, y: 2, note: 'keep' }], 's1', { x: 9 }) as Record<string, unknown>[]
    expect(s1).toEqual({ id: 's1', type: 'shape', x: 9, y: 2, note: 'keep' })
  })

  it('认不出的条目(无 id / 非对象)原位保留,不参与编辑也不被丢弃', () => {
    const list: unknown[] = [{ type: 'shape' }, 42, { id: 's1', x: 0, y: 0 }]
    expect(moveElements(list, new Set(['s1']), 5, 5)).toEqual([{ type: 'shape' }, 42, { id: 's1', x: 5, y: 5 }])
    expect(removeElements(list, new Set(['s1']))).toEqual([{ type: 'shape' }, 42])
  })
})

describe('删除与连线', () => {
  it('删形状顺手剪掉端点落在它上面的连线;端点是卡锚的一条都不碰', () => {
    const list: unknown[] = [
      { id: 's1', type: 'shape', x: 0, y: 0, w: 10, h: 10 },
      { id: 'e1', type: 'connector', from: { id: 's1' }, to: { ref: 'c1' } },
      { id: 'e2', type: 'connector', from: { ref: 'c1' }, to: { ref: 'c2' } },
    ]
    expect(removeElements(list, new Set(['s1']))).toEqual([list[2]])
  })

  it('连线去重是无向的,自环不建', () => {
    const one = addConnector([], 'e:s1', 'c:c1')
    expect(one).toHaveLength(1)
    expect(addConnector(one, 'c:c1', 'e:s1')).toBe(one) // 反向重复 → 原表
    expect(addConnector(one, 'e:s1', 'e:s1')).toBe(one)
    expect(one[0]).toMatchObject({ type: 'connector', from: { id: 's1' }, to: { ref: 'c1' } })
  })

  it('新 id 避开表内已用的一切 id', () => {
    expect(freshElId([{ id: 's1' }, { id: 's2' }], 's')).toBe('s3')
    expect(newShape('s3', 'rect', 100, 100)).toMatchObject({ type: 'shape', shape: 'rect', x: 0, y: 40, w: 200, h: 120 })
  })

  it('文字置空 = 删键,不是写空串', () => {
    const [o] = setElementText([{ id: 's1', text: '旧' }], 's1', 'text', '') as Record<string, unknown>[]
    expect('text' in o).toBe(false)
  })
})

describe('withElements 的落盘口径', () => {
  it('磁盘上没有画布键 + 画了第一个元素 → 物化(懒物化的对位)', () => {
    const out = withElements(null, [{ id: 's1', type: 'shape', x: 0, y: 0, w: 10, h: 10 }])!
    expect(parseCanvasJson(out)).toMatchObject({ v: 1, mode: 'canvas' })
    expect(out).toContain('"elements":[{"id":"s1"')
  })

  it('没有画布键且元素为空 → 一个字节都不写', () => {
    expect(withElements(null, [])).toBe(null)
  })

  it('元素删光但卡片还在 → 只剥 elements 键,cards 不动', () => {
    const out = withElements(LINE, [])!
    expect(out).not.toContain('elements')
    expect(out).toContain('"cards":[{"ref":"c1"')
    expect(out).toContain('"futureKey"')
  })

  it('磁盘那行读不懂 → 逐字保留(绝不用派生结果覆盖看不懂的内容)', () => {
    expect(withElements('{坏', [{ id: 's1' }])).toBe('{坏')
  })
})

// 主卡哨兵 `m:`(2026-08-19):主卡也能长子节点。层级三件套只做字符串等值比较,理论上「不用改」——
// 但这是**落盘值**,所以钉一遍:哨兵进得去、剪不掉、也不会被当成一枚待清理的卡锚。
describe('层级里的主卡哨兵 m:', () => {
  it('认主卡当爹 → 逐字写进去;删掉别的卡不会顺手剪断它', () => {
    const t = setParent(rawTree({}), 'k1', 'm:')
    expect(t['k1']).toBe('m:')
    expect(childrenOf(t, 'm:')).toEqual(['k1'])
    // k9 没了:与 m: 无关的那条剪掉,挂在主卡下的一条原样留着(主卡永远不会「没了」)。
    const after = pruneTree(setParent(t, 'k2', 'k9'), new Set(['k9']))
    expect(after['k1']).toBe('m:')
    expect(after['k2']).toBeUndefined()
  })

  it('哨兵不与真锚撞号:锚的字符集不含冒号', () => {
    expect(/^[A-Za-z0-9_-]+$/.test('m:')).toBe(false)
  })
})

// 文档模式的层级呈现(2026-08-19 用户拍板「有父子属性的 Card 嵌套包裹,自由 Card 不被包裹」)。
// depthOf 决定缩进档位、isUnder 决定「搬哪一段」——两条都作用在**外部可改**的盘上数据,所以
// 认不出的父值必须一律降级成「没有爹」,不能抛、不能当层级。
describe('层级深度与子树归属', () => {
  const alive = new Set(['p', 'c', 'g'])

  it('自由卡深度 0;逐级 +1', () => {
    const t = setParent(setParent(rawTree({}), 'c', 'p'), 'g', 'c')
    expect(depthOf(t, 'p', alive)).toBe(0)
    expect(depthOf(t, 'c', alive)).toBe(1)
    expect(depthOf(t, 'g', alive)).toBe(2)
  })

  it('主卡哨兵 m: 当爹 = 深度 0(文档模式下主卡就是正文本身,子卡已经在它里面)', () => {
    expect(depthOf(setParent(rawTree({}), 'c', 'm:'), 'c', alive)).toBe(0)
  })

  it('父卡已经不在本篇(悬空父/手改坏的值)→ 停在这一层,不当层级也不报错', () => {
    expect(depthOf(setParent(rawTree({}), 'c', 'zzz'), 'c', alive)).toBe(0)
    expect(depthOf(rawTree({ c: 42 }), 'c', alive)).toBe(0)
  })

  it('盘上手改出的环不把遍历转死,深度也有上限', () => {
    const ring = rawTree({ a: 'b', b: 'a' })
    expect(depthOf(ring, 'a', new Set(['a', 'b']))).toBeLessThanOrEqual(6)
    // 一条长链按 cap 截断(再深只是把卡越推越窄)
    const long = rawTree({ n0: 'n1', n1: 'n2', n2: 'n3', n3: 'n4', n4: 'n5', n5: 'n6', n6: 'n7', n7: 'n8' })
    const all = new Set(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'])
    expect(depthOf(long, 'n0', all, 3)).toBe(3)
  })

  it('isUnder 认隔代、不认自己、不认反向', () => {
    const t = setParent(setParent(rawTree({}), 'c', 'p'), 'g', 'c')
    expect(isUnder(t, 'g', 'p')).toBe(true)
    expect(isUnder(t, 'p', 'g')).toBe(false)
    expect(isUnder(t, 'p', 'p')).toBe(false)
    expect(isUnder(rawTree({ a: 'b', b: 'a' }), 'a', 'zzz')).toBe(false) // 环里找不着的爹:走得完
  })

  // ⚠️ Codex 2026-08-20 critical:悬空父必须**逐跳**掐断,否则同一份盘上数据会有两套答案 ——
  // depthOf 说「c 没有爹(自由卡)」,段判定却说「c 是 p 的后代」→ 画框把自由卡圈进去,
  // 认爹搬迁还会把它跟着父段一起挪并落盘。
  it('isUnder 逐跳校验在场:中间那一环不在场 = 关系断在那里', () => {
    const t = rawTree({ c: 'ghost', ghost: 'p' })
    expect(isUnder(t, 'c', 'p')).toBe(true) // 不给 alive:纯 tree 语义(旧调用方原样)
    expect(isUnder(t, 'c', 'p', new Set(['c', 'p']))).toBe(false) // ghost 不在场 → 断
    expect(isUnder(t, 'c', 'p', new Set(['c', 'p', 'ghost']))).toBe(true) // 都在场 → 通
  })

  it('runEndOf:段遇非卡节点收边、悬空父不成段', () => {
    const items = [{ anchor: 'p', idx: 0 }, { anchor: 'c', idx: 1 }]
    expect(runEndOf(items, 0, rawTree({ c: 'p' }))).toBe(2) // 真父子 = 一段
    expect(runEndOf(items, 0, rawTree({ c: 'ghost', ghost: 'p' }))).toBe(1) // 悬空 = 各归各
    // idx 不连续(中间夹着正文)→ 就地收边,这是毁数据防线
    expect(runEndOf([{ anchor: 'p', idx: 0 }, { anchor: 'c', idx: 2 }], 0, rawTree({ c: 'p' }))).toBe(1)
  })
})
