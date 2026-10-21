/**
 * 默认日历 human/CALENDAR.db(10-21):dbStore 遇到 HUMAN_CAL 改走引擎接口,比对交换写 / 冲突重读重放照旧;
 * 日历成员里它排第一,旧位置镜像的那份(默认笔记库根上的 Calendar.db)不重复列出。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'

let engine: DbFile | null
let version = ''
const bump = (): void => { version = `h${Number(version.slice(1) || 0) + 1}` }
const readHumanCal = vi.fn(async () => engine
  ? { status: 'ok' as const, path: 'human://CALENDAR.db', data: structuredClone(engine), version }
  : { status: 'ok' as const, path: 'human://CALENDAR.db', data: base([]), version: '' })
const writeHumanCalCas = vi.fn(async (d: DbFile, v: string) => {
  if (v !== version) return { ok: false as const }
  engine = structuredClone(d); bump()
  return { ok: true as const, version }
})
vi.mock('./humanCalendarIo', () => ({
  HUMAN_CAL: 'human://CALENDAR.db',
  humanCalLegacy: () => '/Users/me/Forsion/Amadeus/Calendar.db',
  get readHumanCal() { return readHumanCal },
  get writeHumanCalCas() { return writeHumanCalCas },
}))
const vaultWrite = vi.fn()
vi.mock('../api', () => ({ amadeus: { readDatabase: vi.fn(), writeDatabase: vaultWrite, writeDatabaseCas: vaultWrite, onDbExternalChange: undefined } }))
vi.mock('./automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))

const { useDbStore } = await import('./dbStore')
const { withHumanCal, refreshHumanCal } = await import('./calendarMembers')

const H = 'human://CALENDAR.db'
const row = (id: string): DbFile['rows'][number] => ({ id, cells: { n: id, d: '2026-10-21' } })
function base(ids: string[]): DbFile {
  return { version: 2, name: 'My calendar', columns: [{ id: 'n', name: 'Name', type: 'text' }, { id: 'd', name: 'Date', type: 'calendarDate' }], rows: ids.map(row) }
}
const add = (id: string) => (d: DbFile): DbFile => ({ ...d, rows: [...d.rows, row(id)] })

describe('the default calendar in human/', () => {
  beforeEach(() => { vi.clearAllMocks(); useDbStore.setState({ entries: {} }) })

  it('creates the file on the first write and never touches the vault', async () => {
    engine = null; version = ''
    await useDbStore.getState().reload(H, H)
    useDbStore.getState().mutate(H, add('a'))
    await useDbStore.getState().flushAll(true)
    expect(writeHumanCalCas).toHaveBeenCalledWith(expect.anything(), '')
    expect(engine!.rows.map((r) => r.id)).toEqual(['a'])
    expect(useDbStore.getState().entries[H].version).toBe(version)
    expect(vaultWrite).not.toHaveBeenCalled()
  })

  it('a row synced in from another device while we were typing is kept: re-read, replay, write again', async () => {
    engine = base(['a']); version = 'h1'
    await useDbStore.getState().reload(H, H)
    useDbStore.getState().mutate(H, add('mine'))
    engine = base(['a', 'theirs']); bump() // 同步 / 镜像在防抖窗口里改了引擎那份
    await useDbStore.getState().flushAll(true)
    expect(engine!.rows.map((r) => r.id)).toEqual(['a', 'theirs', 'mine'])
  })

  it('coming back to the window while a write is pending does not replay it on top of itself (no duplicate row)', async () => {
    engine = base(['a']); version = 'h1'
    await useDbStore.getState().reload(H, H)
    useDbStore.getState().mutate(H, add('mine'))
    engine = base(['a', 'mine']); bump() // 写已经落到引擎,回执还没回来:引擎版本变了
    await refreshHumanCal()
    expect(useDbStore.getState().entries[H].data!.rows.map((r) => r.id)).toEqual(['a', 'mine'])
  })

  it('a calendar that could not be read at first (engine still starting) is read again later', async () => {
    readHumanCal.mockResolvedValueOnce({ status: 'missing' } as never)
    await useDbStore.getState().reload(H, H)
    expect(useDbStore.getState().entries[H].status).toBe('missing')
    engine = base(['a']); version = 'h1'
    await refreshHumanCal()
    expect(useDbStore.getState().entries[H].status).toBe('ok')
  })

  it('comes first among the calendars and hides the mirrored copy in the default vault', () => {
    const human = { path: H, name: 'My calendar', isNoteView: false, columns: base([]).columns, rows: [] }
    const vaultDb = (path: string) => ({ db: { ...human, path, name: path }, dateCol: 'd' })
    const out = withHumanCal(human, [vaultDb('Calendar.db'), vaultDb('Work/Calendar.db')], '/Users/me/Forsion/Amadeus')
    expect(out.map((m) => m.db.path)).toEqual([H, 'Work/Calendar.db'])
    // 别的库里同名的 Calendar.db 是另一本日历,照常列出
    expect(withHumanCal(human, [vaultDb('Calendar.db')], '/Users/me/Documents/WMOS').map((m) => m.db.path)).toEqual([H, 'Calendar.db'])
    expect(withHumanCal(null, [vaultDb('Calendar.db')], '/x').map((m) => m.db.path)).toEqual(['Calendar.db'])
  })
})
