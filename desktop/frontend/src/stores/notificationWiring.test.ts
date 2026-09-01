import { describe, expect, it } from 'vitest'
import type { MdMark } from '@amadeus-shared/mdMarks'
import { pendingReminders, remindKey } from './notificationWiring'

const at = (remind?: string, over: Partial<MdMark> = {}): MdMark => ({
  path: 'n.md', title: 'n', heading: '', text: '吃药', isTask: false, checked: false,
  due: remind ?? '', remind, line: 1, raw: `吃药 @remind:${remind ?? ''}`, occ: 0, ...over,
})
// 2026-09-01 10:00 本地时
const NOW = new Date(2026, 8, 1, 10, 0).getTime()
const V = '/Users/me/VaultA'

describe('pendingReminders', () => {
  it('到点了才弹:未来的不弹,刚过的弹', () => {
    expect(pendingReminders([at('2026-09-01T10:01')], NOW, {}, V)).toEqual([])
    expect(pendingReminders([at('2026-09-01T09:59')], NOW, {}, V)).toHaveLength(1)
  })

  it('迟到超过 24h 不补弹(开机不该被上周的提醒淹掉)', () => {
    expect(pendingReminders([at('2026-08-31T11:00')], NOW, {}, V)).toHaveLength(1) // 23h 前
    expect(pendingReminders([at('2026-08-31T09:00')], NOW, {}, V)).toEqual([]) // 25h 前
  })

  it('没写 @remind: 的行一条都不弹(哪怕有日期)', () => {
    expect(pendingReminders([at(undefined, { due: '2026-09-01T09:00' })], NOW, {}, V)).toEqual([])
  })

  it('弹过的不再弹', () => {
    const m = at('2026-09-01T09:00')
    expect(pendingReminders([m], NOW, { [remindKey(V, m)]: NOW - 1000 }, V)).toEqual([])
  })

  it('去重键不含行号:同一条提醒挪了行仍算弹过', () => {
    const m = at('2026-09-01T09:00')
    const moved = at('2026-09-01T09:00', { line: 42 })
    expect(pendingReminders([moved], NOW, { [remindKey(V, m)]: NOW - 1000 }, V)).toEqual([])
  })

  it('去重记录按 vault 隔离:另一个库里的同名同文本模板照样弹(Codex 评审)', () => {
    const m = at('2026-09-01T09:00', { path: 'Daily.md' })
    const firedInA = { [remindKey(V, m)]: NOW - 1000 }
    expect(pendingReminders([m], NOW, firedInA, V)).toEqual([])
    expect(pendingReminders([m], NOW, firedInA, '/Users/me/VaultB')).toHaveLength(1)
  })

  it('区间提醒按起始时刻判', () => {
    expect(pendingReminders([at('2026-09-01T09:00/2026-09-01T11:00')], NOW, {}, V)).toHaveLength(1)
  })
})
