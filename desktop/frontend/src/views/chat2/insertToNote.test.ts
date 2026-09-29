// 回答插回笔记(评审 G3-08)的聊天侧:从用户消息里认出「问 Tangu」的出处(Composer 把引用拼成 `> ` 行,末行是 `— [[路径#标题]]`)。
import { describe, it, expect } from 'vitest'
import type { UiMessage } from '../../types'
import { askOriginOf, parseAskOrigin, replyMarkdown } from './insertToNote'
import { composeOutgoing } from './Composer2'

/** 与 Composer2 发送时同一条拼法(引用条 → `> ` 行 + 空行 + 正文)。 */
const sent = (quote: string, text: string) => composeOutgoing('', `${quote.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`, text)
const msg = (id: string, role: UiMessage['role'], content: string): UiMessage => ({ id, role, content, status: 'done', timestamp: 1 })

describe('parseAskOrigin', () => {
  it('选区引用:路径 + 标题 + 原文', () => {
    expect(parseAskOrigin(sent('需要润色的文字\n— [[dir/笔记.md#第二节]]', '帮我改短一点'))).toEqual({
      path: 'dir/笔记.md', anchor: { heading: '第二节', text: '需要润色的文字' },
    })
  })
  it('跨块引用保留行;没有标题只带路径', () => {
    expect(parseAskOrigin(sent('甲段\n乙段\n— [[a.md]]', '解释'))).toEqual({ path: 'a.md', anchor: { text: '甲段\n乙段' } })
  })
  it('普通消息 / 聊天里划线的引用(没有出处行)→ null', () => {
    expect(parseAskOrigin('随便问问')).toBeNull()
    expect(parseAskOrigin(sent('上一条回答里的一句', '展开说说'))).toBeNull()
  })
})

describe('askOriginOf', () => {
  const list = [
    msg('u1', 'user', sent('被问的段落\n— [[n.md#标题]]', '改写')),
    msg('a1', 'assistant', '改写版'),
    msg('u2', 'user', '再短一点'),
    msg('a2', 'assistant', '更短版'),
    msg('u3', 'user', '换个话题'),
  ]
  it('追问几轮后的回答仍认同一处出处', () => {
    expect(askOriginOf(list, 'a2')?.path).toBe('n.md')
    expect(askOriginOf(list, 'a1')?.anchor).toEqual({ heading: '标题', text: '被问的段落' })
  })
  it('出处之前的回答不认后面的引用', () => {
    expect(askOriginOf([msg('a0', 'assistant', 'hi'), ...list], 'a0')).toBeNull()
  })
})

describe('replyMarkdown', () => {
  it('公式定界符与聊天渲染同口径,代码块原样', () => {
    expect(replyMarkdown('面积 \\(a^2\\)\n\n```ts\nconst x = "\\\\(no\\\\)"\n```\n')).toBe('面积 $a^2$\n\n```ts\nconst x = "\\\\(no\\\\)"\n```')
  })
})
