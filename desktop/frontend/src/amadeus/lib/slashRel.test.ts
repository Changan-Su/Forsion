// 老版本在 Windows 上按 `a\b.md` 存下的本机状态,换成主进程一律给 `/` 之后还认得回来(2026-10-19)。
// 只看库根长相判 Windows,所以在 mac 上也能跑;mac 库里的 `\` 是合法文件名字符,必须原样。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { legacyWinRel, slashRel } from './vaultFiles'
import { clearDraft, readDraft, stashDraft } from '../unified/writeSafety'
import { readNoteLocked, writeNoteLocked } from '../unified/viewMemory'

const WIN = 'C:\\Users\\me\\Vault'
const MAC = '/Users/me/Vault'

let data = new Map<string, string>()
beforeEach(() => {
  data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
  })
})

describe('slashRel / legacyWinRel', () => {
  it('Windows 库换分隔符;mac 库与库外绝对路径原样', () => {
    expect(slashRel('夹\\子\\笔记.md', WIN)).toBe('夹/子/笔记.md')
    expect(slashRel('夹\\子\\笔记.md', '\\\\nas\\share\\Vault')).toBe('夹/子/笔记.md')
    expect(slashRel('夹\\子\\笔记.md', MAC)).toBe('夹\\子\\笔记.md')
    expect(slashRel('D:\\外面\\a.pdf', WIN)).toBe('D:\\外面\\a.pdf')
    expect(slashRel('/Users/me/Q1\\Q2.pdf', WIN)).toBe('/Users/me/Q1\\Q2.pdf') // mac 端看 Windows 库时本机的绝对路径
    expect(slashRel('夹\\a.md', null)).toBe('夹\\a.md')
    expect(legacyWinRel('夹/子/笔记.md', WIN)).toBe('夹\\子\\笔记.md')
    expect(legacyWinRel('夹/子/笔记.md', MAC)).toBeNull()
    expect(legacyWinRel('笔记.md', WIN)).toBeNull()
  })
})

describe('老 `\\` 键上的草稿', () => {
  it('按 `/` 路径读得到,读到就挪键,之后 clearDraft 删得掉', () => {
    stashDraft(WIN, '夹\\笔记.md', '没存的字', '旧正文', 'leaf-1')
    const d = readDraft(WIN, '夹/笔记.md', 'leaf-1')
    expect(d?.text).toBe('没存的字')
    expect([...data.keys()].some((k) => k.includes('夹\\笔记.md'))).toBe(false)
    clearDraft(WIN, '夹/笔记.md', undefined, d?.slot)
    expect(readDraft(WIN, '夹/笔记.md', 'leaf-1')).toBeNull()
  })

  it('mac 库不去找 `\\` 那份(那是另一篇笔记的名字)', () => {
    stashDraft(MAC, '夹\\笔记.md', '别人的字', '旧正文')
    expect(readDraft(MAC, '夹/笔记.md')).toBeNull()
  })
})

describe('老 `\\` 键上的锁', () => {
  it('按 `/` 路径仍是锁着的,解锁之后真解开', () => {
    writeNoteLocked(WIN, '夹\\笔记.md', true)
    expect(readNoteLocked(WIN, '夹/笔记.md')).toBe(true)
    writeNoteLocked(WIN, '夹/笔记.md', false)
    expect(readNoteLocked(WIN, '夹/笔记.md')).toBe(false)
  })

  it('两种写法都锁着时,解锁也真解开', () => {
    writeNoteLocked(WIN, '夹\\笔记.md', true)
    writeNoteLocked(WIN, '夹/笔记.md', true)
    writeNoteLocked(WIN, '夹/笔记.md', false)
    expect(readNoteLocked(WIN, '夹/笔记.md')).toBe(false)
  })

  it('挪键失败(配额满)也照样算锁着', () => {
    writeNoteLocked(WIN, '夹\\笔记.md', true)
    const real = localStorage.setItem
    localStorage.setItem = () => { throw new Error('QuotaExceededError') }
    try { expect(readNoteLocked(WIN, '夹/笔记.md')).toBe(true) } finally { localStorage.setItem = real }
  })
})

describe('日历配置', () => {
  it('Windows 库的 dbPath 读进来就是 `/`;mac 库原样', async () => {
    const cfg = (dbPath: string) => ({ colors: { [dbPath]: '#f00' }, hidden: [dbPath], defaultDbPath: dbPath, members: { [dbPath]: { dateCol: 'd' } }, migrated: true })
    data.set('amadeus.calendar.cfg', JSON.stringify({ [WIN]: cfg('日程\\任务.db'), [MAC]: cfg('日程\\任务.db') }))
    vi.resetModules()
    const { useCalendarConfig } = await import('../store/calendarConfigStore')
    const { byVault } = useCalendarConfig.getState()
    expect(byVault[WIN]).toMatchObject(cfg('日程/任务.db'))
    expect(byVault[MAC]).toMatchObject(cfg('日程\\任务.db'))
  })
})
