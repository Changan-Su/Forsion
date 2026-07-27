import { describe, it, expect } from 'vitest'
import { caretSegIndex } from './EditorialMessage'
import type { MsgSeg, ToolEvent } from '../../types'

// 用户实报:一条消息里多次调工具时,每个文字段尾部都留着一个闪烁光标(截图里 4 个)。
// 约定:光标只落在整条消息的真正末尾,且末尾是文字才有 —— 末尾挂着工具组时一个都不显示。
const ev = (id: string): ToolEvent => ({ id, name: 'x', arguments: '{}' } as ToolEvent)

describe('caretSegIndex(流式光标只跟末尾)', () => {
  it('末尾是文字 → 只有那一段(中间的文字段一律不带)', () => {
    const segs: MsgSeg[] = [
      { t: 'text', text: '好,先看看' },
      { t: 'tools', ids: ['a'] },
      { t: 'text', text: '有不少笔记' },
      { t: 'tools', ids: ['b'] },
      { t: 'text', text: '给你展示:' },
    ]
    expect(caretSegIndex(segs, [ev('a'), ev('b')])).toBe(4)
  })

  it('末尾是工具组(还在跑、没开始吐字)→ 下标落在工具段,正文分支不匹配 = 零光标', () => {
    const segs: MsgSeg[] = [
      { t: 'text', text: '需要找到实际文件路径' },
      { t: 'tools', ids: ['a'] },
    ]
    const at = caretSegIndex(segs, [ev('a')])
    expect(at).toBe(1)
    expect(segs[at].t).not.toBe('text') // 关键:文字段永远拿不到它
  })

  it('尾部渲染成 null 的段不算末尾:空文字段、ids 解析不到事件的工具段都跳过', () => {
    const segs: MsgSeg[] = [
      { t: 'text', text: '正文' },
      { t: 'tools', ids: ['ghost'] }, // 事件还没到 → ToolGroup 渲染 null
      { t: 'text', text: '' }, // 刚开的空段 → 渲染 null
    ]
    expect(caretSegIndex(segs, [])).toBe(0)
  })

  it('全空 → -1(谁都不匹配)', () => {
    expect(caretSegIndex([], [])).toBe(-1)
    expect(caretSegIndex([{ t: 'text', text: '' }], [])).toBe(-1)
  })
})
