/** 「今天」那一节:手记按段切(最多 4 段)、Markdown 变纯文本。实际手记格式不固定(卜算子自己写),两种都要接得住。 */
import { describe, expect, it } from 'vitest'
import { plainText, splitJournal, todayJournalPath } from './museBriefData'

describe('splitJournal', () => {
  it('## 段头以时刻开头 → 时刻进左列;只留最后 4 段;顶部 # 标题不算', () => {
    const md = ['# 11 月 8 日', '', ...[1, 2, 3, 4, 5].map((i) => `## 0${i}:1${i} 第 ${i} 段\n正文 ${i}，见 [[Reading/摘录.md]]。`)].join('\n')
    const s = splitJournal(md)
    expect(s).toHaveLength(4)
    expect(s[0]).toEqual({ time: '02:12', label: '第 2 段', text: '正文 2，见 摘录。' })
    expect(s[3].time).toBe('05:15')
  })

  it('段头不是时刻:去掉编号当标题;列表、勾选、代码记号都去掉', () => {
    const md = "# Nightly note review\n\nDate: `2026-11-08`\n\n## 1. What changed today?\n- Notes created: `AGI-News/2026-11-08.md`\n- [ ] Follow up on **this**\n\n## 2. What did I learn?\n- Concepts: [latent swarms](https://arxiv.org)"
    expect(splitJournal(md)).toEqual([
      { time: '', label: 'What changed today?', text: 'Notes created: AGI-News/2026-11-08.md Follow up on this' },
      { time: '', label: 'What did I learn?', text: 'Concepts: latent swarms' },
    ])
  })

  it('没有 ## 段头:按空行分段;空文件 = 没有段', () => {
    expect(splitJournal('上午在改主页。\n\n下午读书。\n')).toEqual([
      { time: '', label: '', text: '上午在改主页。' },
      { time: '', label: '', text: '下午读书。' },
    ])
    expect(splitJournal('')).toEqual([])
  })

  it('长段截断加省略号', () => {
    const [s] = splitJournal(`## 段\n${'字'.repeat(400)}`)
    expect(s.text.endsWith('…')).toBe(true)
    expect(s.text.length).toBeLessThanOrEqual(281)
  })
})

describe('plainText / todayJournalPath', () => {
  it('双链留名、图片丢掉、引用记号去掉', () => {
    expect(plainText('> 见 [[Drafts/周会议程.md|议程]] ![x](a.png)')).toBe('见 周会议程')
  })
  it('按本地日期', () => {
    expect(todayJournalPath(new Date(2026, 10, 8, 23, 59))).toBe('Journal/2026-11-08.md')
  })
})
