// 钉住:星期名与时长摘要跟随界面语言。
// 这两处当年是模块级中文常量 —— WEEKDAYS 还被 CalendarView / CalendarConfigView 当 React key 直接渲染,
// 所以改成函数是**跨三个文件**的联动;姊妹测试 dateUtils.test.ts 只钉 zh 那侧,退回硬编码它不会红,这里会。
import { describe, expect, it } from 'vitest'
import { weekdays, dowLabel, fmtDur } from './dateUtils'
import { setLocaleGlobal } from '../../i18n'

describe('日历日期文案跟随语言', () => {
  it('星期短名 + 「周X」标签', () => {
    setLocaleGlobal('zh')
    expect(weekdays()).toEqual(['日', '一', '二', '三', '四', '五', '六'])
    expect(dowLabel(3)).toBe('周三')
    setLocaleGlobal('en')
    expect(weekdays()).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    expect(dowLabel(3)).toBe('Wed') // ⚠️ 不是「周Wed」:en 的 dowLabel 模板没有前缀
    setLocaleGlobal('zh')
  })

  it('时长摘要', () => {
    setLocaleGlobal('en')
    expect(fmtDur(30)).toBe('30 min')
    expect(fmtDur(60)).toBe('1 h')
    expect(fmtDur(90)).toBe('1 h 30 min')
    expect(fmtDur(1440)).toBe('1 d')
    expect(fmtDur(0)).toBe('')
    setLocaleGlobal('zh')
  })
})
