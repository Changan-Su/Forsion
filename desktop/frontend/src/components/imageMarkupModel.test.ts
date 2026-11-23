import { describe, expect, it } from 'vitest'
import { attachmentCount, buildMarkupMessage, emptyHistory, record, redo, renumber, undo, whereOf, type Mark } from './imageMarkupModel'

const hat: Mark = { id: 1, kind: 'ellipse', text: '换成红色的贝雷帽', cx: 0.49, cy: 0.26, rx: 0.15, ry: 0.12 }
const cup: Mark = { id: 2, kind: 'pin', text: '换成透明玻璃杯，装冰美式', x: 0.78, y: 0.72 }

describe('imageMarkup', () => {
  it('九宫格方位按标记中心算(涂抹按包围盒中心)', () => {
    expect(whereOf(hat)).toBe('上方居中')
    expect(whereOf(cup)).toBe('右下')
    expect(whereOf({ id: 3, kind: 'stroke', text: '', points: [[0.05, 0.4], [0.3, 0.6]] })).toBe('左侧')
  })

  it('单张:附图 1 是原图、附图 2 是标注示意;每处一行,没写的那处按整体要求', () => {
    const text = buildMarkupMessage([{ name: 'gen-7a03.png', marks: [hat, cup, { id: 3, kind: 'pin', text: ' ', x: 0.1, y: 0.1 }] }], '其余别动')
    expect(text.split('\n')).toEqual([
      '按标注改附图 1（附图 2 是标注示意，只用来看改哪里）：',
      '1 上方居中圈出的地方：换成红色的贝雷帽',
      '2 右下点的位置：换成透明玻璃杯，装冰美式',
      '3 左上点的位置：按下面的要求改',
      '另外：其余别动',
      '其余保持不变。',
    ])
  })

  it('多张:逐张编号,附图序号跳过标注副本;附件数按有无标记算', () => {
    const entries = [{ name: 'a.png', marks: [hat] }, { name: 'b.png', marks: [] }, { name: 'c.png', marks: [cup] }]
    const lines = buildMarkupMessage(entries, '背景换浅黄').split('\n')
    expect(lines[0]).toBe('分别改下面 3 张图，每张单独改一次、只拿它自己的原图（标注示意只用来看改哪里）：')
    expect(lines).toContain('图 1（a.png，附图 1；附图 2 是它的标注示意）：')
    expect(lines).toContain('图 2（b.png，附图 3）：')
    expect(lines).toContain('图 3（c.png，附图 4；附图 5 是它的标注示意）：')
    expect(lines).toContain('每张都要：背景换浅黄')
    expect(attachmentCount(entries)).toBe(5)
  })

  it('撤销 / 重做按「一处」走,删掉后重编号', () => {
    let h = emptyHistory()
    let marks: Mark[] = []
    h = record(h, marks); marks = [hat]
    h = record(h, marks); marks = [hat, cup]
    const u = undo(h, marks)!
    expect(u.marks).toEqual([hat])
    const r = redo(u.h, u.marks)!
    expect(r.marks).toEqual([hat, cup])
    expect(undo(emptyHistory(), [])).toBeNull()
    expect(renumber([cup]).map((m) => m.id)).toEqual([1])
  })
})
