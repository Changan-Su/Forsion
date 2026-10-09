import { describe, expect, it } from 'vitest'
import type { SketchItem, ToolEvent } from '../../types'
import { partitionToolSegment } from './EditorialMessage'

const done = (id: string, name: string): ToolEvent => ({ id, name, done: true, result: 'ok' })

describe('EditorialMessage inline Sketch ordering', () => {
  it('places every completed Sketch immediately after its own tool call', () => {
    const events = [done('read1', 'read_file'), done('sk1', 'sketch'), done('run1', 'run_bash'), done('sk2', 'sketch')]
    const sketches: SketchItem[] = [
      { callId: 'sk1', html: '<p>ONE</p>' },
      { callId: 'sk2', html: '<p>TWO</p>' },
    ]
    const parts = partitionToolSegment(events, sketches)
    expect(parts.map((part) => part.t === 'tools' ? `tools:${part.events.map((ev) => ev.id).join(',')}` : `sketch:${part.item.callId}`)).toEqual([
      'tools:read1,sk1',
      'sketch:sk1',
      'tools:run1,sk2',
      'sketch:sk2',
    ])
  })

  it('keeps rejected or unfinished Sketch calls in the tool group without drawing a phantom card', () => {
    const events = [done('sk-bad', 'sketch'), done('read1', 'read_file')]
    expect(partitionToolSegment(events, [])).toEqual([{ t: 'tools', events }])
  })

  it('draws a draft card for a streaming (unfinished) Sketch only while the message is live', () => {
    const streaming: ToolEvent = { id: 'sk1', name: 'sketch', done: false, arguments: '{"title":"柱状图","html":"<h1>HALF</h1><scr' }
    const events = [streaming, done('read1', 'read_file')]
    // 直播:草稿卡紧跟在它的工具行后面,html 是半截 JSON 里解出来的那部分
    expect(partitionToolSegment(events, [], true)).toEqual([
      { t: 'tools', events: [streaming] },
      { t: 'sketch', item: { callId: 'sk1', html: '<h1>HALF</h1><scr', title: '柱状图', draft: true } },
      { t: 'tools', events: [events[1]] },
    ])
    // 历史 / 中断:同样的事件不出幻影卡
    expect(partitionToolSegment(events, [], false)).toEqual([{ t: 'tools', events }])
    // html 还没流到(只到了 title)→ 不画空卡
    expect(partitionToolSegment([{ id: 'sk2', name: 'sketch', done: false, arguments: '{"title":"x"' }], [], true))
      .toEqual([{ t: 'tools', events: [{ id: 'sk2', name: 'sketch', done: false, arguments: '{"title":"x"' }] }])
    // 终稿到了(sketches 里有)→ 正式卡优先,不再是草稿
    const final = { callId: 'sk1', html: '<h1>FULL</h1>' }
    expect(partitionToolSegment([streaming], [final], true)).toEqual([{ t: 'tools', events: [streaming] }, { t: 'sketch', item: final }])
  })
})
