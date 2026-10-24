import { describe, expect, it } from 'vitest'
import type { SketchItem, ToolEvent } from '../../types'
import { partitionToolSegment } from './EditorialMessage'
import { sketchFromToolEvent } from '../../tangu/store/tanguSlice'

const done = (id: string, name: string): ToolEvent => ({ id, name, done: true, result: 'ok' })

describe('EditorialMessage inline Sketch ordering', () => {
  it('keeps native documents at their tool position alongside legacy sketches', () => {
    const events = [done('read', 'read_file'), done('native', 'intelligent_ui'), done('legacy', 'sketch')]
    const legacy = { callId: 'legacy', html: '<p>old</p>' }
    expect(partitionToolSegment(events, [legacy])).toEqual([
      { t: 'tools', events: [events[0]] },
      { t: 'intelligent', event: events[1] },
      { t: 'tools', events: [events[2]] },
      { t: 'sketch', item: legacy },
    ])
  })
  it('draws no tool row above a native document unless that call was rejected', () => {
    const ok = done('native', 'intelligent_ui')
    const streaming: ToolEvent = { id: 'live', name: 'intelligent_ui', done: false, arguments: '{"document":"{' }
    const rejected: ToolEvent = { id: 'bad', name: 'intelligent_ui', done: true, result: 'Error: invalid Intelligent UI document. blocks[2].inputIds' }
    expect(partitionToolSegment([ok])).toEqual([{ t: 'intelligent', event: ok }])
    expect(partitionToolSegment([streaming], [], true)).toEqual([{ t: 'intelligent', event: streaming }])
    // 被拒收后模型重写了:残缺的那份不画,只留它的工具行(错误在里面);重写的那份照常不带工具行
    expect(partitionToolSegment([rejected, ok])).toEqual([
      { t: 'tools', events: [rejected] },
      { t: 'intelligent', event: ok },
    ])
    // 重写的那份还在生成、或者又被拒收:前一份照旧画着,不能让回答里一时什么都没有
    expect(partitionToolSegment([rejected, streaming], [], true)).toEqual([
      { t: 'tools', events: [rejected] },
      { t: 'intelligent', event: rejected },
      { t: 'intelligent', event: streaming },
    ])
    const again: ToolEvent = { ...rejected, id: 'bad2' }
    expect(partitionToolSegment([rejected, again]).filter((p) => p.t === 'intelligent')).toEqual([
      { t: 'intelligent', event: rejected },
      { t: 'intelligent', event: again },
    ])
    // 被拒收后没有重写(模型改用文字):那份照旧画出来,由文档自己标明内容不完整
    expect(partitionToolSegment([rejected, done('read', 'read_file')])).toEqual([
      { t: 'tools', events: [rejected] },
      { t: 'intelligent', event: rejected },
      { t: 'tools', events: [done('read', 'read_file')] },
    ])
  })
  it('places every completed Sketch immediately after its own tool call', () => {
    const events = [done('read1', 'read_file'), done('sk1', 'sketch'), done('run1', 'run_bash'), done('sk2', 'sketch')]
    const sketches: SketchItem[] = [
      { callId: 'sk1', html: '<p>ONE</p>' },
      { callId: 'sk2', html: '<p>TWO</p>' },
    ]
    const parts = partitionToolSegment(events, sketches)
    expect(parts.map((part) => part.t === 'tools' ? `tools:${part.events.map((ev) => ev.id).join(',')}` : part.t === 'sketch' ? `sketch:${part.item.callId}` : `intelligent:${part.event.id}`)).toEqual([
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

  it('draws the card under its 10-20 name too (intelligent_ui_html); sketch stays for older history and engines', () => {
    const streaming: ToolEvent = { id: 'h1', name: 'intelligent_ui_html', done: false, arguments: '{"html":"<h1>NEW</h1>' }
    expect(partitionToolSegment([streaming], [], true)[1]).toEqual({ t: 'sketch', item: { callId: 'h1', html: '<h1>NEW</h1>', draft: true } })
    const finished: ToolEvent = { ...streaming, done: true, isError: false, result: 'HTML card rendered in the conversation.', arguments: '{"html":"<h1>NEW</h1>"}' }
    expect(sketchFromToolEvent(finished)).toEqual({ callId: 'h1', html: '<h1>NEW</h1>' })
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
