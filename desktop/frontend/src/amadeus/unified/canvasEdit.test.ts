// 白板写侧的三条不变式。第一条是**毁数据级**的,单独写在最前面。
import { describe, it, expect } from 'vitest'
import { rawList, patchElement, removeElements, moveElements, freshElId, newShape, addConnector, setElementText, rawTree, setParent, pruneTree, childrenOf } from './canvasEdit'
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
