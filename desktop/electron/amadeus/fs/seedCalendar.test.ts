/** 库根种子 Calendar.db 的清理:四种情况 + 只碰库根那一份。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isUntouchedCalendarSeed } from '../../../../tangu-agent/src/contracts/dbRowMerge'
import { trashSeedCalendar } from './seedCalendar'
import { VaultManager } from './vaultManager'

const columns = (done = 'checkbox') => [
  { id: 'a', name: '名称', type: 'text' },
  { id: 'b', name: '日期', type: 'calendarDate' },
  { id: 'c', name: '完成', type: done },
]
const seedRows = [
  { id: 'r1', cells: { a: '欢迎使用 Calendar Space', b: '2026-10-01T10:00/2026-10-01T11:00', c: true } },
  { id: 'r2', cells: { a: '整理本周任务', b: '2026-10-02' } },
  { id: 'r3', cells: { a: '项目评审', b: '2026-10-03T14:00/2026-10-03T15:30' } },
]
const seed = (over: Record<string, unknown> = {}) => ({ version: 1, name: '我的日历', columns: columns(), rows: seedRows, ...over })
const text = (db: unknown) => `${JSON.stringify(db, null, 2)}\n`

describe('isUntouchedCalendarSeed', () => {
  it('counts zero rows and the three untouched demo rows as empty, in every seeded shape', () => {
    expect(isUntouchedCalendarSeed(text(seed({ rows: [] })))).toBe(true)
    expect(isUntouchedCalendarSeed(text(seed()))).toBe(true)
    expect(isUntouchedCalendarSeed(text(seed({ columns: columns('todo') })))).toBe(true) // server 云库与老桌面的种子
    expect(isUntouchedCalendarSeed(text({ version: 1, name: 'Calendar', rows: [], columns: [{ id: 'a', name: 'Name', type: 'text' }, { id: 'b', name: 'Date', type: 'calendarDate' }, { id: 'c', name: 'Done', type: 'checkbox' }] }))).toBe(true) // Unit 英文种子
  })
  it('anything the user touched is theirs', () => {
    expect(isUntouchedCalendarSeed(text(seed({ rows: [...seedRows, { id: 'r4', cells: { a: '看牙医' } }] })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [{ ...seedRows[0], cells: { ...seedRows[0].cells, c: false } }, seedRows[1], seedRows[2]] })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [{ ...seedRows[1], cells: { ...seedRows[1].cells, b: '2026-10-05' } }, seedRows[0], seedRows[2]] })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: seedRows.slice(0, 2) })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [], name: '工作日历' })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [], views: [{ id: 'v', name: '月', type: 'calendar' }] })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [], columns: [...columns(), { id: 'd', name: '地点', type: 'text' }] })))).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [], columns: [{ ...columns()[0], width: 240 }, ...columns().slice(1)] })))).toBe(false)
  })
  it('unreadable is not empty', () => {
    expect(isUntouchedCalendarSeed(null)).toBe(false)
    expect(isUntouchedCalendarSeed('')).toBe(false)
    expect(isUntouchedCalendarSeed('{not json')).toBe(false)
    expect(isUntouchedCalendarSeed('{"rows":[]}')).toBe(false)
    expect(isUntouchedCalendarSeed('[]')).toBe(false)
    expect(isUntouchedCalendarSeed(text(seed({ rows: [], columns: columns().map(({ name, type }) => ({ name, type })) })))).toBe(false) // 列没有 id,parseDb 也不认
    expect(isUntouchedCalendarSeed(text(seed({ rows: [], version: undefined })))).toBe(false)
  })
})

describe('trashSeedCalendar', () => {
  let root: string
  let vault: VaultManager
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'seed-calendar-'))
    vault = new VaultManager()
    vault.setRoot(root)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('moves an untouched seed into the vault trash, restorable under its old name', async () => {
    await writeFile(join(root, 'Calendar.db'), text(seed()))
    expect(await trashSeedCalendar(vault)).toBe(true)
    expect(await readdir(root)).not.toContain('Calendar.db')
    expect((await vault.listTrash()).map((e) => e.original)).toEqual(['Calendar.db'])
  })
  it('does nothing when there is no file', async () => {
    expect(await trashSeedCalendar(vault)).toBe(false)
    expect(await readdir(root)).toEqual([])
  })
  it('leaves a calendar with data and a corrupt file byte for byte', async () => {
    for (const body of [text(seed({ rows: [...seedRows, { id: 'r4', cells: { a: '看牙医' } }] })), '{not json']) {
      await writeFile(join(root, 'Calendar.db'), body)
      expect(await trashSeedCalendar(vault)).toBe(false)
      expect(await readFile(join(root, 'Calendar.db'), 'utf8')).toBe(body)
    }
    expect(await vault.listTrash()).toEqual([])
  })
  it('puts the file back when sync wrote real events between the check and the move', async () => {
    await writeFile(join(root, 'Calendar.db'), text(seed()))
    const pulled = text(seed({ rows: [...seedRows, { id: 'r4', cells: { a: '另一台设备加的' } }] }))
    const racing = {
      getRoot: () => vault.getRoot(), absPath: (rel: string) => vault.absPath(rel), listTrash: () => vault.listTrash(), restoreTrash: (name: string) => vault.restoreTrash(name),
      trashEntry: async (rel: string) => { await writeFile(join(root, rel), pulled); return vault.trashEntry(rel) }, // 云同步不拿 dbLock,正好落在这里
    }
    expect(await trashSeedCalendar(racing)).toBe(false)
    expect(await readFile(join(root, 'Calendar.db'), 'utf8')).toBe(pulled)
    expect(await vault.listTrash()).toEqual([])
  })
  it('does not touch the new vault when the vault changes while waiting for the lock', async () => {
    await writeFile(join(root, 'Calendar.db'), text(seed()))
    const other = mkdtempSync(join(tmpdir(), 'seed-calendar-other-'))
    const real = text(seed({ rows: [...seedRows, { id: 'r4', cells: { a: '看牙医' } }] }))
    await writeFile(join(other, 'Calendar.db'), real)
    try {
      const switching = {
        getRoot: () => vault.getRoot(), listTrash: () => vault.listTrash(), restoreTrash: (name: string) => vault.restoreTrash(name), trashEntry: (rel: string) => vault.trashEntry(rel),
        absPath: (rel: string) => { const abs = vault.absPath(rel); queueMicrotask(() => vault.setRoot(other)); return abs }, // 用户在第一次检查之后换了库
      }
      expect(await trashSeedCalendar(switching)).toBe(false)
      expect(await readFile(join(other, 'Calendar.db'), 'utf8')).toBe(real)
      expect(await vault.listTrash()).toEqual([])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
  it('only ever looks at the vault root', async () => {
    await mkdir(join(root, 'Work'))
    await writeFile(join(root, 'Work', 'Calendar.db'), text(seed()))
    expect(await trashSeedCalendar(vault)).toBe(false)
    expect(await readdir(join(root, 'Work'))).toEqual(['Calendar.db'])
  })
})
