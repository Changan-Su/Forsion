/** 日历撤销:⌘Z 与通知条按钮共用一次;换了库就不撤(Codex 评审:否则 A 库的行写进 B 库 / 撤两次盖掉新值)。 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  vault: { vaultSide: 'local', vaultRoot: '/A' },
  set: vi.fn(),
  action: undefined as (() => void) | undefined,
}))
vi.mock('../../amadeus/store/dbAggregateStore', () => ({ setAggCell: (...a: unknown[]) => h.set(...a), deleteAggRow: () => [], restoreAggRow: () => {} }))
vi.mock('../../amadeus/store/pageStore', () => ({ usePageStore: { getState: () => h.vault } }))
vi.mock('../../stores/notificationStore', () => ({ notifyApp: (n: { action?: { run: () => void } }) => { h.action = n.action?.run } }))

const { rescheduleCalendarRow, undoLastCalendarEdit } = await import('./eventActions')
const db = { path: 'cal.db' } as never
const row = { rowId: 'r1' } as never
const undos = (): number => h.set.mock.calls.filter((c) => c[3] === '2026-10-16').length

describe('calendar undo', () => {
  it('⌘Z 撤过之后,通知条上的撤销不再生效', () => {
    rescheduleCalendarRow(db, row, 'date', '2026-10-16', '2026-10-17', 'x')
    expect(undoLastCalendarEdit()).toBe(true)
    h.action?.()
    expect(undos()).toBe(1)
    expect(undoLastCalendarEdit()).toBe(false)
  })
  it('换了库:⌘Z 和通知条都不撤', () => {
    h.set.mockClear()
    rescheduleCalendarRow(db, row, 'date', '2026-10-16', '2026-10-17', 'x')
    h.vault = { vaultSide: 'local', vaultRoot: '/B' }
    expect(undoLastCalendarEdit()).toBe(false)
    h.action?.()
    expect(undos()).toBe(0)
  })
})
