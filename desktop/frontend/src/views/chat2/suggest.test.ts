import { describe, it, expect } from 'vitest'
import { splitSuggestions } from './suggest'

const F = '```'

describe('splitSuggestions', () => {
  it('普通消息原样返回', () => {
    const raw = `这是一段回答。\n\n${F}ts\nconst a = 1\n${F}`
    const r = splitSuggestions(raw)
    expect(r.text).toBe(raw)
    expect(r.items).toEqual([])
  })

  it('摘出建议,正文里不留围栏痕迹', () => {
    const { text, items } = splitSuggestions(
      `那最稳妥的是设两次提醒。\n\n${F}forsion-suggest\n提醒我今天 11:30 准备 12 点的会议\n每周五 17:00 提醒我整理本周笔记\n${F}\n`,
    )
    expect(text).toBe('那最稳妥的是设两次提醒。')
    expect(items).toEqual(['提醒我今天 11:30 准备 12 点的会议', '每周五 17:00 提醒我整理本周笔记'])
  })

  it('模型在讲解这个功能本身 —— 外层围栏里的示例不能变成真芯片,也不能被删掉', () => {
    const raw = `你可以这么写:\n\n\`\`\`\`markdown\n${F}forsion-suggest\n提醒我明天 8 点开会\n${F}\n\`\`\`\`\n`
    const { text, items } = splitSuggestions(raw)
    expect(items).toEqual([])
    expect(text).toContain('forsion-suggest')
    expect(text).toContain('提醒我明天 8 点开会')
  })

  it('四反引号也能收口(CommonMark:收口数 ≥ 开栏数),后面的正文要留住', () => {
    const { text, items } = splitSuggestions(
      `正文\n${F}forsion-suggest\n提醒我明天 8 点开会\n\`\`\`\`\n这句正文必须保留`,
    )
    expect(items).toEqual(['提醒我明天 8 点开会'])
    expect(text).toBe('正文\n这句正文必须保留')
  })

  it('已完成却没收口 = 模型写坏了 → 还回正文,不许吞', () => {
    const raw = `好的。\n${F}forsion-suggest\n提醒我明天 8 点开会\n后面还有正文`
    const { text, items } = splitSuggestions(raw)
    expect(items).toEqual([])
    expect(text).toBe(raw)
  })

  it('流式中还没收口 —— 先藏起来,别让裸围栏闪一下', () => {
    const { text, items } = splitSuggestions(`好的。\n\n${F}forsion-suggest\n提醒我今天 11:3`, { streaming: true })
    expect(text).toBe('好的。')
    expect(items).toEqual([]) // 未收口不出芯片(芯片本来也只在 done 才渲染)
  })

  it('围栏被工具块切成两段 —— 状态续读,建议不泄漏进正文', () => {
    const a = splitSuggestions(`前文\n${F}forsion-suggest\n`, { streaming: true })
    const b = splitSuggestions(`提醒我明天 8 点开会\n${F}\n尾文`, { streaming: true, state: a.state })
    expect(a.text).toBe('前文')
    expect(b.text).toBe('尾文')
    expect(b.items).toEqual(['提醒我明天 8 点开会'])
  })

  it('剥掉项目符号/序号,丢掉过短过长的行,最多 3 条', () => {
    const { items } = splitSuggestions(
      [`${F}forsion-suggest`, '- 每天提醒我喝水', '2. 每周五整理笔记', '继续', '每月底导出账单', 'x'.repeat(81), '每天九点提醒我', F].join('\n'),
    )
    expect(items).toEqual(['每天提醒我喝水', '每周五整理笔记', '每月底导出账单']) // 「继续」太短被挡:不给单词芯片洗成用户指令
  })
})
