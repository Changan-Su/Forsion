/** 引擎那边还没有 human/CALENDAR.db 时桌面自己播种的空日历:两个窗口各播一份,列 id 必须一样 ——
 *  后写的那个 409 后重读前一个的表,重放的改动引用的列才对得上(Codex 评审 P1)。 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../services/engine/targets', () => ({
  homeTarget: () => ({ key: 'home' }),
  engineFetch: async () => new Response(JSON.stringify({ status: 'missing', legacy: null }), { status: 200 }),
}))

const { readHumanCal } = await import('./humanCalendarIo')

describe('seeding the default calendar', () => {
  it('two windows seeding at the same time get the same column ids', async () => {
    const a = await readHumanCal(), b = await readHumanCal()
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected a seeded calendar')
    expect(a.version).toBe('') // 第一次写按新建发
    expect(a.data.columns.map((c) => c.id)).toEqual(b.data.columns.map((c) => c.id))
  })
})
