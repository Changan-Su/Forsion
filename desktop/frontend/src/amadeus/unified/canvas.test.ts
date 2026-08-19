// 画布数据层的契约测试(2026-08-16 Phase 1)。钉的是三条**会毁数据**的不变式,不是覆盖率:
//   1. 折叠没成功过 → 绝不剥 canvas 键(P0:打开这种文件敲一个字画布就没了)
//   2. cards 之外的字段逐字保管(P0:Phase 1 的代码不许吃掉 Phase 2 写的 elements / 未知键)
//   3. 懒物化 —— 没卡片且磁盘上本来没这个键 → 一个字节都不写(用户 2026-08-16 拍板)
import { describe, expect, it } from 'vitest'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { parseCanvasJson, deriveCanvasJson, deriveCards } from './canvas'

/** deriveCards 只碰 doc.forEach / node.type.name / node.attrs —— 用最小替身即可诚实覆盖,
 *  不必为纯函数契约把整套 PM schema 搭起来。 */
const docOf = (...cards: Array<Record<string, unknown>>): ProseNode =>
  ({ forEach: (f: (n: ProseNode, off: number, i: number) => void) => cards.forEach((attrs, i) => f({ type: { name: 'amadeusCanvasCard' }, attrs } as unknown as ProseNode, i, i)) }) as unknown as ProseNode

const EMPTY = docOf()
const ONE = docOf({ anchor: 'c1', x: 900, y: 40, w: 480, h: 0 })

describe('parseCanvasJson', () => {
  it('接受最小合法形状,拒绝坏形状(fail-closed)', () => {
    expect(parseCanvasJson('{"v":1,"cards":[]}')).toEqual({ v: 1, cards: [] })
    expect(parseCanvasJson(null)).toBeNull()
    expect(parseCanvasJson('{')).toBeNull()
    expect(parseCanvasJson('[1,2]')).toBeNull()
    expect(parseCanvasJson('{"v":2,"cards":[]}')).toBeNull() // v 超出认知:按无画布渲染,调用方逐字保留
    expect(parseCanvasJson('{"v":1,"mode":"edgeless"}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"cards":[{"ref":"a b","x":0,"y":0,"w":10}]}')).toBeNull() // 锚形态
    expect(parseCanvasJson('{"v":1,"cards":[{"ref":"c1","x":0,"y":0,"w":0}]}')).toBeNull() // 宽度必须 >0
    expect(parseCanvasJson('{"v":1,"cards":[{"ref":"c1","x":0,"y":0,"w":9},{"ref":"c1","x":1,"y":1,"w":9}]}')).toBeNull() // 重复锚=歧义
  })

  it('数值字段必须是真 number:字符串数字一律整键作废', () => {
    // 曾用 Number.isFinite(Number(v)) 判,`"900"` 过关但下游 int() 只认 number → 静默回默认值,
    // 用户的坐标/宽度当场变成 0/400。宁可整键 fail-closed 由调用方逐字保留。
    expect(parseCanvasJson('{"v":1,"cards":[{"ref":"c1","x":"900","y":0,"w":480}]}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"cards":[{"ref":"c1","x":0,"y":0,"w":"480"}]}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"cards":[{"ref":"c1","x":0,"y":0,"w":480,"h":"500"}]}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"main":{"x":"5","y":0,"w":700}}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"main":{"x":5,"y":6,"w":700}}')).toEqual({ v: 1, main: { x: 5, y: 6, w: 700 } })
  })
})

const NONE: ReadonlySet<string> = new Set()
const own = (...refs: string[]): ReadonlySet<string> => new Set(refs)

describe('deriveCanvasJson', () => {
  it('懒物化:没卡片 + 磁盘上没这个键 → 一字不写', () => {
    expect(deriveCanvasJson(EMPTY, null, 'doc', NONE)).toBeNull()
    // 切到画布模式本身不算用过画布(方案 §4):模式给的是 canvas,照样不写。
    expect(deriveCanvasJson(EMPTY, null, 'canvas', NONE)).toBeNull()
  })

  it('首次拖出卡片 → 物化,带 mode/main/cards', () => {
    const out = JSON.parse(deriveCanvasJson(ONE, null, 'canvas', NONE)!)
    expect(out.v).toBe(1)
    expect(out.mode).toBe('canvas')
    expect(out.main.w).toBeGreaterThan(0)
    expect(out.cards).toEqual([{ ref: 'c1', x: 900, y: 40, w: 480 }]) // h=0 不落盘(随内容自适应)
  })

  it('P0 磁盘上的卡不在归属集合里 → 整行逐字保留,绝不剥键也绝不覆盖', () => {
    const stored = '{"v":1,"mode":"canvas","cards":[{"ref":"c9","x":10,"y":20,"w":300}]}'
    // ① 折叠失败(doc 零卡):判成「用户删光了」剥键 = 打开就敲一个字画布全没。
    expect(deriveCanvasJson(EMPTY, stored, 'doc', NONE)).toBe(stored)
    // ② 折叠失败后又拖出一张新卡:只挡「卡为空」的话这里会用只含新卡的数组整体替换,c9 永久丢失。
    expect(deriveCanvasJson(ONE, stored, 'canvas', own('c1'))).toBe(stored)
    // ③ c9 确实折出来过、用户又把卡全删了 → 这才是解散,剥键。
    expect(deriveCanvasJson(EMPTY, stored, 'doc', own('c9'))).toBeNull()
  })

  it('P0 本实例自己建的卡 → 当场收回必须能解散(不能只认「折出过」)', () => {
    // 普通笔记首次拖出一张卡 → 物化;不重开页面立刻收回。若归属只认折叠,这里会把刚写的行原样
    // 留着,重开又按旧 cards 折回卡片 —— 用户的收回操作复活。
    const stored = deriveCanvasJson(ONE, null, 'canvas', NONE)!
    expect(deriveCanvasJson(EMPTY, stored, 'canvas', own('c1'))).toBeNull()
  })

  it('cards 之外的字段字段级保管(elements / 未知键 / main)', () => {
    const stored = '{"v":1,"mode":"doc","main":{"x":5,"y":6,"w":700},"cards":[],"elements":[{"id":"e1","type":"shape"}],"futureKey":{"a":1}}'
    const out = JSON.parse(deriveCanvasJson(ONE, stored, 'canvas', NONE)!)
    expect(out.elements).toEqual([{ id: 'e1', type: 'shape' }])
    expect(out.futureKey).toEqual({ a: 1 })
    expect(out.main).toEqual({ x: 5, y: 6, w: 700 })
    expect(out.mode).toBe('canvas') // mode 跟着当前模式走
    expect(out.cards).toEqual([{ ref: 'c1', x: 900, y: 40, w: 480 }])
  })

  it('modeOverride=null → 不碰盘上的 mode(移动端只改正文不许覆写桌面的画布模式)', () => {
    const stored = '{"v":1,"mode":"canvas","cards":[{"ref":"c1","x":900,"y":40,"w":480}]}'
    expect(JSON.parse(deriveCanvasJson(ONE, stored, null, own('c1'))!).mode).toBe('canvas')
    expect(JSON.parse(deriveCanvasJson(ONE, stored, 'doc', own('c1'))!).mode).toBe('doc')
  })

  it('卡片清空但白板元素还在 → 不剥键(主卡永在,方案 §3.2)', () => {
    const stored = '{"v":1,"cards":[{"ref":"c1","x":0,"y":0,"w":300}],"elements":[{"id":"e1"}]}'
    const out = JSON.parse(deriveCanvasJson(EMPTY, stored, 'doc', own('c1'))!)
    expect(out.cards).toEqual([])
    expect(out.elements).toEqual([{ id: 'e1' }])
  })

  it('磁盘那行读不懂 → 原样回吐(绝不用派生结果覆盖看不懂的内容)', () => {
    expect(deriveCanvasJson(ONE, '{坏掉的 JSON', 'canvas', own('c1'))).toBe('{坏掉的 JSON')
    expect(deriveCanvasJson(EMPTY, '{"v":99}', 'doc', own('c1'))).toBe('{"v":99}')
  })

  it('坐标一律取整(fm 体积,方案 §3.1 量化)', () => {
    const out = JSON.parse(deriveCanvasJson(docOf({ anchor: 'c1', x: 12.7, y: -3.2, w: 480.6, h: 0 }), null, 'canvas', NONE)!)
    expect(out.cards[0]).toEqual({ ref: 'c1', x: 13, y: -3, w: 481 })
  })

  it('deriveCards 跳过没有合法锚的卡(空锚落盘就是 `<!-- a  -->` 毁格式)', () => {
    expect(deriveCards(docOf({ anchor: '', x: 0, y: 0, w: 300 }, { anchor: 'c2', x: 1, y: 2, w: 300 }))).toEqual([{ ref: 'c2', x: 1, y: 2, w: 300 }])
  })
})
