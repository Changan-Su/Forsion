import { describe, it, expect } from 'vitest'
import type { MsgSeg } from '../types'
import { pushTextSeg, pushToolSeg, recordToUi, segmentsFromHistory, settleSegments } from './appStore'

// Item 3 直播穿插的核心:文字/工具按发生顺序成段,连续工具并块,文字介入即分块。
describe('msg segments (interleave + consecutive grouping)', () => {
  it('preserves order and merges consecutive same-kind segments', () => {
    let segs = pushTextSeg(undefined, 'hi ')
    segs = pushTextSeg(segs, 'there')              // 文字并入同段
    segs = pushToolSeg(segs, 't1')
    segs = pushToolSeg(segs, 't2')                 // 连续工具并入同块
    segs = pushTextSeg(segs, 'done')               // 文字介入 → 新段
    segs = pushToolSeg(segs, 't3')                 // 又一独立工具块
    expect(segs).toEqual([
      { t: 'text', text: 'hi there' },
      { t: 'tools', ids: ['t1', 't2'] },
      { t: 'text', text: 'done' },
      { t: 'tools', ids: ['t3'] },
    ])
  })

  it('empty text delta is a no-op (no phantom text segment)', () => {
    expect(pushTextSeg([{ t: 'tools', ids: ['t1'] }], '')).toEqual([{ t: 'tools', ids: ['t1'] }])
  })

  it('rebuilds text -> sketch -> text -> sketch -> text from persisted content offsets', () => {
    const first = '先看第一张。'
    const middle = '\n\n再看第二张。'
    const tail = '\n\n最后总结。'
    const content = first + middle + tail
    const m = recordToUi({
      id: 'a1', role: 'model', content,
      tool_calls: [
        { id: 'sk1', ui_content_offset: first.length, function: { name: 'sketch', arguments: JSON.stringify({ html: '<p>ONE</p>' }) } },
        { id: 'sk2', ui_content_offset: (first + middle).length, function: { name: 'sketch', arguments: JSON.stringify({ html: '<p>TWO</p>' }) } },
      ],
      tool_results: [
        { tool_call_id: 'sk1', content: 'ok' },
        { tool_call_id: 'sk2', content: 'ok' },
      ],
    })
    expect(m.segments).toEqual([
      { t: 'text', text: first },
      { t: 'tools', ids: ['sk1'] },
      { t: 'text', text: middle },
      { t: 'tools', ids: ['sk2'] },
      { t: 'text', text: tail },
    ])
    expect(m.sketches?.map((item) => item.callId)).toEqual(['sk1', 'sk2'])
  })

  it('does not guess positions for legacy or malformed mixed-version history', () => {
    const events = [
      { id: 't1', name: 'read_file', done: true, contentOffset: 1 },
      { id: 't2', name: 'sketch', done: true },
    ]
    expect(segmentsFromHistory('abc', events)).toBeUndefined()
    expect(segmentsFromHistory('abc', [{ ...events[0], contentOffset: 4 }])).toBeUndefined()
    expect(recordToUi({
      id: 'legacy', role: 'model', content: '旧消息',
      tool_calls: [{ id: 'sk0', function: { name: 'sketch', arguments: JSON.stringify({ html: '<p>OLD</p>' }) } }],
      tool_results: [{ tool_call_id: 'sk0', content: 'ok' }],
    }).segments).toBeUndefined()
  })

  it('settleSegments: 正常 run 只差空白不重排;文本兜底剔掉的标记撤下、前导正文与工具位置按终稿', () => {
    const events = [{ id: 'fb0', name: 'read_file', done: true }]
    const content = `先读文件。

结果是 42。`
    const offsets = [{ id: 'fb0', offset: '先读文件。'.length }]
    const clean: MsgSeg[] = [{ t: 'text', text: '先读文件。 ' }, { t: 'tools', ids: ['fb0'] }, { t: 'text', text: ' 结果是 42。' }]
    expect(settleSegments(content, clean, events, offsets)).toBeUndefined()
    // 同一轮里前导正文 + 手写的调用标记一起流了出来,server 兜底解析成 fb0 并从正文剔除
    const leaked: MsgSeg[] = [{ t: 'text', text: '先读文件。 <｜｜DSML｜｜invoke name="read_file"></｜｜DSML｜｜invoke>' }, { t: 'tools', ids: ['fb0'] }, { t: 'text', text: '结果是 42。' }]
    expect(settleSegments(content, leaked, events, offsets)).toEqual([
      { t: 'text', text: '先读文件。' },
      { t: 'tools', ids: ['fb0'] },
      { t: 'text', text: content.slice('先读文件。'.length) },
    ])
    expect(settleSegments(content, leaked, events, undefined)).toBeUndefined()
  })
})
