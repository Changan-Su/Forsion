/** 「今天」那一节:手记按段切(最多 4 段)、Markdown 变纯文本。实际手记格式不固定(卜算子自己写),两种都要接得住。 */
import { describe, expect, it } from 'vitest'
import { plainText, sortTracks, splitJournal, todayJournalPath, widgetCardKey } from './museBriefData'

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

describe('sortTracks', () => {
  const e = (id: string, date: string, repeat = '') => ({ id, name: id, date, repeat, auto: true, prompt: '', description: '', todo: false, lastRun: '' })
  it('按下一次发生排(不按写入顺序);一次性已过 / 没日期排最后', () => {
    const now = new Date(2026, 10, 8, 12, 0).getTime()
    const s = sortTracks([e('far', '2026-12-20 09:00'), e('past', '2026-11-01 09:00'), e('none', ''), e('tomorrow', '2026-11-09 09:00'), e('daily', '2026-11-01 08:00', '1d')], now)
    expect(s.map((x) => x.id)).toEqual(['daily', 'tomorrow', 'far', 'past', 'none']) // daily 明早 08:00 早于 tomorrow 09:00
  })
})

describe('widgetCardKey', () => {
  const card = (key: string, widgetId?: string) => ({ key, ref: widgetId ? { widgetId } : { builtin: key as 'todos' }, source: 'added' as const })
  const empty = { cards: [], hidden: [], proposed: [] }
  it('已经有一张指着这个小组件(藏着的 / 正提议的)→ 用那个键,不另起', () => {
    expect(widgetCardKey({ ...empty, hidden: [card('focus-week', 'w_1')] }, { id: 'w_1', name: 'weekly-focus' })).toBe('focus-week')
    expect(widgetCardKey({ ...empty, proposed: [{ key: 'p-1', ref: { widgetId: 'w_2' }, why: '' }] as never }, { id: 'w_2', name: 'x' })).toBe('p-1')
  })
  it('新起的键合法、避开内置卡名、撞了加序号', () => {
    expect(widgetCardKey(empty, { id: 'w_3', name: 'status' })).toBe('w-status')
    expect(widgetCardKey({ ...empty, cards: [card('w-status', 'w_9')] }, { id: 'w_3', name: 'Status' })).toBe('w-status-2')
    expect(widgetCardKey(empty, { id: 'w_4', name: '本周重点' })).toBe('w-widget')
    expect(widgetCardKey(empty, { id: 'w_5', name: 'a'.repeat(80) })).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
  })
})
