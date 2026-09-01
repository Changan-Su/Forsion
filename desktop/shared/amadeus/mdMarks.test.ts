import { describe, expect, it } from 'vitest'
import { parseCalDate } from './db/calDate'
import { findMarkLine, parseMdMarks, withChecked, withDue } from './mdMarks'

const P = 'note.md'
const T = 'note'
const parse = (md: string) => parseMdMarks(md, P, T)
const D = '2026-09-01'
const DT = '2026-09-01T14:30'

describe('parseMdMarks', () => {
  it('无 @ 标记 = 什么都不出(旧「任何 - [ ] 都算待办」口径已废)', () => {
    expect(parse('- [ ] a\n* [x] b\n普通一行\n# 标题')).toEqual([])
  })

  it('三种项目符号 + 大小写 X 都算任务;标记从文本里摘干净', () => {
    const r = parse(`- [ ] a @${D}\n* [x] b @${D}\n+ [X] c @${D}`)
    expect(r.map((t) => [t.text, t.checked, t.isTask, t.due])).toEqual([
      ['a', false, true, D], ['b', true, true, D], ['c', true, true, D],
    ])
  })

  it('勾选框 → 待办;普通行块 → 日程(isTask 分流)', () => {
    const r = parse(`- [ ] 交周报 @${D}\n周会 @${DT}`)
    expect(r.map((m) => [m.text, m.isTask])).toEqual([['交周报', true], ['周会', false]])
  })

  it('落盘串就是 calendarDate 编码 —— 下游 parseCalDate 直接吃(零适配的根据)', () => {
    const r = parse(`周会 @2026-09-01T09:00/2026-09-01T10:30`)
    expect(parseCalDate(r[0].due)).toEqual({ start: '2026-09-01T09:00', end: '2026-09-01T10:30', allDay: false })
    expect(parseCalDate(parse(`全天 @${D}`)[0].due)?.allDay).toBe(true)
  })

  it('@remind: 单独出现时兼作日期;两个都写时各归各位', () => {
    expect(parse(`吃药 @remind:${DT}`)[0]).toMatchObject({ due: DT, remind: DT })
    expect(parse(`体检 @${D} @remind:2026-08-31T20:00`)[0]).toMatchObject({ due: D, remind: '2026-08-31T20:00' })
  })

  it('负对照:@ 前非空白不触发(邮箱 / 词中 @)', () => {
    expect(parse(`寄给 foo@${D} 看看`)).toEqual([])
    expect(parse(`a@${DT}`)).toEqual([])
  })

  it('负对照:日期形状不对不触发', () => {
    expect(parse('@2026-9-1 会\n@2200 会\n@remind: 会\n@2026-09-01T14 会')).toEqual([])
  })

  it('收尾标点后仍然算(中文句号/逗号/右括号)', () => {
    expect(parse(`周会 @${D}。`)[0].due).toBe(D)
    expect(parse(`(周会 @${D})`)[0].due).toBe(D)
  })

  it('负对照:形状对但日子不存在的一律不算(平年 2-29 / 4-31),闰年 2-29 算', () => {
    expect(parse(`会 @2026-02-29\n会 @2026-04-31`)).toEqual([])
    expect(parse(`会 @2028-02-29`)[0].due).toBe('2028-02-29')
    expect(parse(`会 @2026-01-01/2026-02-30`)).toEqual([]) // 区间任一侧不存在即整条不算
  })

  it('四反引号围栏可以合法包住三反引号(闭围栏不得更短,且不带 info)', () => {
    expect(parse('````\n```\n- [ ] 代码示例里的 @2026-09-01\n```\n````\n- [ ] 真的 @2026-09-01'))
      .toEqual([expect.objectContaining({ text: '真的' })])
    // 带 info 的那行不是闭围栏(CommonMark),块仍开着
    expect(parse('```\n``` js\n- [ ] 仍在块里 @2026-09-01\n```')).toEqual([])
  })

  it('围栏代码块里的标记不算,且只有同种栅栏能收口', () => {
    expect(parse(`\`\`\`\n- [ ] 代码里的 @${D}\n\`\`\`\n- [ ] 真的 @${D}`)).toHaveLength(1)
    expect(parse(`\`\`\`md\n~~~\n- [ ] 仍在 \`\`\` 里 @${D}\n\`\`\`\n- [ ] 真的 @${D}`)).toHaveLength(1)
    expect(parse(`~~~\n- [ ] 代码里的 @${D}\n~~~`)).toHaveLength(0)
  })

  it('记住最近的上级标题;标题自己带标记时归属上一级', () => {
    const r = parse(`- [ ] 无归属 @${D}\n# 一级\n- [ ] 甲 @${D}\n### 三级 @${D}\n- [ ] 乙 @${D}`)
    expect(r.map((m) => [m.heading, m.text])).toEqual([
      ['', '无归属'], ['一级', '甲'], ['一级', '三级'], ['三级', '乙'],
    ])
  })

  it('普通行块剥掉行首块标记(引用 / 项目符号 / 序号)', () => {
    const r = parse(`> 引用 @${D}\n- 列表 @${D}\n3. 序号 @${D}`)
    expect(r.map((m) => m.text)).toEqual(['引用', '列表', '序号'])
  })

  it('摘掉标记后只剩 HTML/空白的行不算', () => {
    expect(parse(`- [ ] <br /> @${D}\n- [ ] 真的 @${D}`)).toEqual([expect.objectContaining({ text: '真的' })])
    expect(parse(`@${D}`)).toEqual([])
  })

  it('行号是 1-based,针对传入的这份文本', () => {
    expect(parse(`# h\n\n- [ ] x @${D}`)[0].line).toBe(3)
  })

  it('必须有一个空格分隔:`-[ ]` / `- []` 不是任务(降级成普通行块)', () => {
    expect(parse(`-[ ] a @${D}\n- [] b @${D}`).map((m) => m.isTask)).toEqual([false, false])
  })

  // 与编辑器互锁:structuralSource.ts 把任务块写回磁盘的字面形态必须能被本解析器认出。
  // 负对照:把下面任一 SOURCE 改成 `-[ ] ` 之类,这条必须变红。
  it('编辑器写回磁盘的任务形态解析得出来(与 structuralSource 互锁)', () => {
    const SOURCE = { unchecked: '- [ ] ', checked: '- [x] ' }
    const r = parse(`${SOURCE.unchecked}未完 @${D}\n${SOURCE.checked}已完 @${D}`)
    expect(r.map((t) => [t.text, t.checked, t.isTask])).toEqual([['未完', false, true], ['已完', true, true]])
  })
})

describe('withDue / withChecked（回写用的纯函数）', () => {
  it('改日程标记,行里其余部分一个字节不动', () => {
    expect(withDue(`- [ ] 交周报 @${D} #tag`, '2026-10-02T09:00')).toBe('- [ ] 交周报 @2026-10-02T09:00 #tag')
    expect(withDue(`周会 @${DT}`, `${D}T09:00/${D}T10:30`)).toBe(`周会 @${D}T09:00/${D}T10:30`)
  })

  it('日程 + 提醒并存时只动日程那条', () => {
    expect(withDue(`体检 @${D} @remind:2026-08-31T20:00`, '2026-09-05'))
      .toBe('体检 @2026-09-05 @remind:2026-08-31T20:00')
  })

  it('整行只有 @remind: 时改的就是它(它本来就兼作日期)', () => {
    expect(withDue('吃药 @remind:2026-09-01T08:00', '2026-09-02T08:00')).toBe('吃药 @remind:2026-09-02T08:00')
  })

  it('没有可改的标记 = null(绝不瞎写)', () => {
    expect(withDue('普通一行', '2026-09-01')).toBeNull()
    expect(withDue('会 @2026-02-29', '2026-09-01')).toBeNull() // 非法日期不是标记
  })

  it('勾选框往返,三种项目符号都认;非任务行 = null', () => {
    expect(withChecked(`- [ ] a @${D}`, true)).toBe(`- [x] a @${D}`)
    expect(withChecked(`  * [x] b @${D}`, false)).toBe(`  * [ ] b @${D}`)
    expect(withChecked(`+ [X] c @${D}`, false)).toBe(`+ [ ] c @${D}`)
    expect(withChecked(`周会 @${D}`, true)).toBeNull()
  })
})

describe('findMarkLine（清洗坐标 → 磁盘坐标）', () => {
  const file = ['---', 'title: x', 'aliases: [重复行]', '---', '重复行', '正文', '重复行'].join('\n')

  it('跳过 frontmatter 后按第 occ 条同文行定位', () => {
    expect(findMarkLine(file, '重复行', 0)).toBe(4)
    expect(findMarkLine(file, '重复行', 1)).toBe(6)
    expect(findMarkLine(file, '不存在', 0)).toBe(-1)
    expect(findMarkLine(file, '重复行', 2)).toBe(-1)
  })

  // ⚠️ 负对照:注释体里一行与目标逐字相同 —— 不跳注释就会占掉 occ=0 的名额,静默改错行。
  it('多行注释体里的同文行不占名额', () => {
    const f = ['<!--', '- [ ] 交周报 @2026-09-01', '-->', '- [ ] 交周报 @2026-09-01'].join('\n')
    expect(findMarkLine(f, '- [ ] 交周报 @2026-09-01', 0)).toBe(3)
  })

  it('与解析器的 occ 端到端对齐(同一篇里两行逐字相同)', () => {
    const body = ['---', 'k: v', '---', '- [ ] 买菜 @2026-09-01', '## 二', '- [ ] 买菜 @2026-09-01'].join('\n')
    const cleaned = body.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '')
    const marks = parseMdMarks(cleaned, P, T)
    expect(marks).toHaveLength(2)
    expect(marks.map((m) => findMarkLine(body, m.raw, m.occ))).toEqual([3, 5])
  })
})
