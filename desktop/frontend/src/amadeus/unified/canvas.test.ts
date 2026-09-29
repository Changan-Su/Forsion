// 画布数据层的契约测试(2026-08-16 Phase 1)。钉的是三条**会毁数据**的不变式,不是覆盖率:
//   1. 折叠没成功过 → 绝不剥 canvas 键(P0:打开这种文件敲一个字画布就没了)
//   2. cards 之外的字段逐字保管(P0:Phase 1 的代码不许吃掉 Phase 2 写的 elements / 未知键)
//   3. 懒物化 —— 没卡片且磁盘上本来没这个键 → 一个字节都不写(用户 2026-08-16 拍板)
import { describe, expect, it } from 'vitest'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { parseCanvasJson, deriveCanvasJson, deriveCards, deriveCardColors, withMain } from './canvas'
import { canvasColorCss, setElementColor } from './canvasEdit'

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
    expect(parseCanvasJson('{"v":1,"main":{"x":5,"y":6,"w":700,"h":"500"}}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"main":{"x":5,"y":6,"w":700,"h":-1}}')).toBeNull()
    expect(parseCanvasJson('{"v":1,"main":{"x":5,"y":6,"w":700}}')).toEqual({ v: 1, main: { x: 5, y: 6, w: 700 } })
    expect(parseCanvasJson('{"v":1,"main":{"x":5,"y":6,"w":700,"h":500}}')).toEqual({ v: 1, main: { x: 5, y: 6, w: 700, h: 500 } })
  })
})

describe('withMain', () => {
  it('主卡高度与普通卡片同口径：调整后落 h，回到自适应时剥掉 h', () => {
    expect(withMain(null, { x: 0, y: 0, w: 720 })).toBeNull()
    const sized = withMain(null, { x: 24, y: 48, w: 696, h: 312 })!
    expect(JSON.parse(sized).main).toEqual({ x: 24, y: 48, w: 696, h: 312 })
    const auto = withMain(sized, { x: 24, y: 48, w: 696, h: 0 })!
    expect(JSON.parse(auto).main).toEqual({ x: 24, y: 48, w: 696 })
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

describe('画布颜色(V-08,拍板 #9:存进 amadeus_canvas 顶层 cardColors,编码沿用 JSON Canvas)', () => {
  const C1 = { anchor: 'c1', x: 1, y: 2, w: 300, h: 0, color: '1' }
  const C2 = { anchor: 'c2', x: 1, y: 2, w: 300, h: 0, color: '' }
  const C3 = { anchor: 'c3', x: 0, y: 0, w: 300, h: 0, color: 7 } // 非字符串原值:原样保管,渲染时才收窄
  const OWN = new Set(['c1', 'c2', 'c3'])
  it('cards 条目里永远不带 color;颜色进顶层 cardColors(只含设过色的在场卡,原值原样)', () => {
    const doc = docOf(C1, C2, C3)
    expect(deriveCards(doc)).toEqual([{ ref: 'c1', x: 1, y: 2, w: 300 }, { ref: 'c2', x: 1, y: 2, w: 300 }, { ref: 'c3', x: 0, y: 0, w: 300 }])
    expect({ ...deriveCardColors(doc) }).toEqual({ c1: '1', c3: 7 })
    const line = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"c1","x":1,"y":2,"w":300},{"ref":"c2","x":1,"y":2,"w":300},{"ref":"c3","x":0,"y":0,"w":300}],"cardColors":{"c1":"1","c3":7,"gone":"2"}}'
    // 键序不动;不在场的孤儿条目(旧端删卡留下的)剪掉
    expect(deriveCanvasJson(doc, line, null, OWN)).toBe(line.replace(',"gone":"2"', ''))
  })
  it('全部无色 → 剥掉 cardColors 键;盘上没有该键、也没有颜色 → 一个字节不多(旧笔记零改写)', () => {
    const plain = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"c2","x":1,"y":2,"w":300}]}'
    expect(deriveCanvasJson(docOf(C2), plain, null, new Set(['c2']))).toBe(plain)
    expect(deriveCanvasJson(docOf(C2), plain.replace('}]}', '}],"cardColors":{"c2":"3"}}'), null, new Set(['c2']))).toBe(plain)
  })
  it('盘上 cardColors 不是对象(手改坏)且此刻没有颜色要写 → 原样留着;有颜色要写才换成派生值', () => {
    const bad = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"c2","x":1,"y":2,"w":300}],"cardColors":"??"}'
    expect(deriveCanvasJson(docOf(C2), bad, null, new Set(['c2']))).toBe(bad)
    expect(JSON.parse(deriveCanvasJson(docOf({ ...C2, color: '4' }), bad, null, new Set(['c2']))!).cardColors).toEqual({ c2: '4' })
  })
  it('首次物化(盘上无画布键)时有色卡同样写进 cardColors', () => {
    expect(JSON.parse(deriveCanvasJson(docOf(C1), null, null, new Set())!).cardColors).toEqual({ c1: '1' })
  })
  it('旧端存活(Codex P1):旧客户端的派生 = `{ ...stored, v, cards: 从 PM 节点重建 }`(45fc56d1 起至今) —— 颜色必须活过这一步', () => {
    // 逐字模拟旧端:条目只有 ref/x/y/w/h,其余一律重建丢失;顶层未知键随 `...stored` 原样搬运。
    const oldDerive = (line: string): string => {
      const stored = JSON.parse(line) as { cards: Array<{ ref: string; x: number; y: number; w: number; h?: number }> }
      return JSON.stringify({ ...stored, v: 1, cards: stored.cards.map(({ ref, x, y, w, h }) => ({ ref, x, y, w, ...(h ? { h } : {}) })) })
    }
    // 两条写路径都要过:首次物化,以及盘上已有画布行时的常规派生
    const doc = docOf(C1, C2, C3)
    const first = deriveCanvasJson(doc, null, 'canvas', OWN)!
    const again = deriveCanvasJson(doc, first, null, OWN)!
    for (const mine of [first, again]) expect(JSON.parse(oldDerive(mine)).cardColors).toEqual({ c1: '1', c3: 7 })
  })
})

describe('画布颜色(V-08)· 渲染收窄与元素写侧', () => {
  it('canvasColorCss 只认预设 1–6 与 #rrggbb;认不出的一律不渲染(原值不动)', () => {
    expect(canvasColorCss('3')).toBe('var(--amx-cv-3)')
    expect(canvasColorCss('#12AB34')).toBe('#12AB34')
    for (const bad of ['0', '7', 'red', '#abc', '#12ab34;x:y', 1, null, '']) expect(canvasColorCss(bad)).toBeNull()
  })
  it('setElementColor:设色 / null 删键;没变化时原样返回同一个数组(调用方据此零写入)', () => {
    const list: unknown[] = [{ id: 'a', type: 'shape', note: 'x' }, { id: 'b', type: 'frame', color: '2' }, 'junk']
    const set = setElementColor(list, new Set(['a']), '5')
    expect(set[0]).toEqual({ id: 'a', type: 'shape', note: 'x', color: '5' })
    expect(set[2]).toBe('junk')
    const cleared = setElementColor(list, new Set(['b']), null)
    expect(cleared[1]).toEqual({ id: 'b', type: 'frame' })
    expect(setElementColor(list, new Set(['b']), '2')).toBe(list)
    expect(setElementColor(list, new Set(['a']), null)).toBe(list)
  })
})
