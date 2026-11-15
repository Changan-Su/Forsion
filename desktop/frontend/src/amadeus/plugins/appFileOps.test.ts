// ctx.app.createFolder / stat / renamePath / movePath(2026-11-16)。
// 钉:①边界 —— 工作文件夹里面、这一程自己建的(写到原本不存在的路径 / createFolder 真建的那几层)直接做,别的先问用户,
//   取消 = Error('user_declined') 且什么都不动;②改名挪动走文件树那几条链(renameNoteFile / renameDb / movePage /
//   renameFolder / moveFolder),不自己造;③那几条把失败吞进 store.error,做完按清单核结果;④名字与路径校验(越界、
//   改种类、点开头);⑤账本跟着改名走、删了就摘;⑥stat 只在桥有 statPath 时挂。确认框文案按测试钉的 zh 断言。
import { describe, expect, it, beforeEach, vi } from 'vitest'

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../api', () => ({
  get amadeus() {
    return bridge.current
  },
}))
const confirm = { answer: true, calls: [] as string[] }
vi.mock('./partsSurface', () => ({
  confirmPlugin: vi.fn(async (o: { title: () => string }) => { confirm.calls.push(o.title()); return confirm.answer }),
}))
const renameNoteFile = vi.fn()
vi.mock('../lib/noteRename', () => ({ renameNoteFile: (...a: unknown[]) => renameNoteFile(...a) }))
const renameDb = vi.fn()
vi.mock('../lib/dbFileOps', () => ({ renameDb: (...a: unknown[]) => renameDb(...a) }))

const { usePluginStore } = await import('./pluginStore')
const { usePageStore, remapScopePaths } = await import('../store/pageStore')
const { resetPluginCreatedForTests, isPluginCreated, markPluginCreated, followCreatedPath } = await import('./pluginCreated')
const { renameTarget, cleanVaultPath } = await import('./pluginFileOps')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}

/** 假库:清单 + 文件树动作。挪 / 改名成功 = 清单里换路径(文件夹连子树),再走真 remapScopePaths 发路径广播。 */
function vault(lists: { pages?: string[]; folders?: string[]; files?: string[] }, opts: { fail?: boolean } = {}) {
  const move = (from: string, to: string, prefix: boolean): void => {
    const map = (x: string): string => (x === from ? to : prefix && x.startsWith(`${from}/`) ? to + x.slice(from.length) : x)
    const s = usePageStore.getState()
    usePageStore.setState({ pages: s.pages.map(map), folders: s.folders.map(map), files: s.files.map(map) })
    remapScopePaths(from, to, prefix ? 'prefix' : 'file')
  }
  const dir = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const join = (d: string, n: string): string => (d ? `${d}/${n}` : n)
  const fail = (): boolean => { if (opts.fail) usePageStore.setState({ error: 'EPERM: operation not permitted' }); return !!opts.fail }
  const movePage = vi.fn(async (p: string, dest: string) => { if (!fail()) move(p, join(dest, p.split('/').pop()!), false) })
  const renameFolder = vi.fn(async (p: string, name: string) => { if (!fail()) move(p, join(dir(p), name), true) })
  const moveFolder = vi.fn(async (p: string, dest: string) => { if (!fail()) move(p, join(dest, p.split('/').pop()!), true) })
  const refreshStructure = vi.fn(async () => {})
  renameNoteFile.mockReset().mockImplementation(async (p: string, base: string) => { const to = join(dir(p), `${base}.md`); move(p, to, false); return to })
  renameDb.mockReset().mockImplementation(async (p: string, base: string) => { const to = join(dir(p), `${base}.db`); move(p, to, false); return to })
  usePageStore.setState({
    vaultRoot: '/vault', filesPendingFor: null, error: null,
    pages: lists.pages ?? [], folders: lists.folders ?? [], files: lists.files ?? [],
    movePage, renameFolder, moveFolder, refreshStructure,
  } as never)
  return { movePage, renameFolder, moveFolder, refreshStructure }
}

beforeEach(() => {
  bridge.current = {}
  confirm.answer = true
  confirm.calls = []
  resetPluginCreatedForTests()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('ctx.app.stat', () => {
  it('桥没有 statPath(网页)→ 方法整个不存在;有 → 透传归一后的路径,null 原样给', async () => {
    expect(ctxOf('s-web').app.stat).toBeUndefined()
    const statPath = vi.fn(async (p: string) => (p === 'a.md' ? { kind: 'file', size: 3, mtime: 10, ctime: null } : null))
    bridge.current = { statPath }
    const ctx = ctxOf('s-ok')
    await expect(ctx.app.stat!('/a.md')).resolves.toEqual({ kind: 'file', size: 3, mtime: 10, ctime: null })
    await expect(ctx.app.stat!('nope.md')).resolves.toBeNull()
    await expect(ctx.app.stat!('a/../../etc')).rejects.toThrow(/escapes the vault/)
    expect(statPath).toHaveBeenCalledTimes(2)
  })
})

describe('ctx.app.createFolder', () => {
  it('只建缺的那几层;已有的文件夹直接 resolve;只把真建的记进账本', async () => {
    const createFolder = vi.fn(async (parent: string, name: string) => {
      const p = parent ? `${parent}/${name}` : name
      usePageStore.setState({ folders: [...usePageStore.getState().folders, p] })
      return p
    })
    bridge.current = { createFolder }
    const ctx = ctxOf('cf-ok')
    vault({ folders: ['Notes'] })
    await ctx.app.createFolder!('Notes/2026/11')
    expect(createFolder.mock.calls).toEqual([['Notes', '2026'], ['Notes/2026', '11']])
    expect(isPluginCreated('cf-ok', 'Notes')).toBe(false)
    expect(isPluginCreated('cf-ok', 'Notes/2026')).toBe(true)
    expect(isPluginCreated('cf-ok', 'Notes/2026/11')).toBe(true)
    await ctx.app.createFolder!('Notes/2026')
    expect(createFolder).toHaveBeenCalledTimes(2)
    await ctx.app.createFolder!('')
  })

  it('有文件挡着 / 点开头 / 越界 / 没有库 → reject,什么都不建', async () => {
    const createFolder = vi.fn()
    bridge.current = { createFolder }
    const ctx = ctxOf('cf-bad')
    vault({ pages: ['Notes.md', 'A/b.md'], folders: ['A'] })
    await expect(ctx.app.createFolder!('A/b.md/c')).rejects.toThrow(/file is in the way/)
    await expect(ctx.app.createFolder!('.hidden/x')).rejects.toThrow(/starting with "\."/)
    await expect(ctx.app.createFolder!('A/../B')).rejects.toThrow(/escapes the vault/)
    await expect(ctx.app.createFolder!('A/ x')).rejects.toThrow(/Invalid folder name/)
    usePageStore.setState({ vaultRoot: null } as never)
    await expect(ctx.app.createFolder!('C')).rejects.toThrow(/No vault is open/)
    expect(createFolder).not.toHaveBeenCalled()
  })
})

describe('ctx.app.renamePath / movePath 的边界', () => {
  it('写到原本不存在的路径 = 自己建的:改名不问;写已有的文件不算,改名要问,取消 → user_declined 且不动', async () => {
    const statPath = vi.fn(async () => null)
    bridge.current = { statPath, writeTextFile: vi.fn(async () => {}) }
    const ctx = ctxOf('b-ledger')
    vault({ pages: ['Inbox/mine.md', 'Inbox/user.md'], folders: ['Inbox'] })
    usePageStore.setState({ pages: ['Inbox/user.md'] }) // 写之前 mine.md 不在
    await ctx.app.writeFile('Inbox/mine.md', '# mine')
    usePageStore.setState({ pages: ['Inbox/mine.md', 'Inbox/user.md'] })
    await ctx.app.writeFile('Inbox/user.md', '# overwritten') // 已在清单里:不走 stat、不记账
    expect(statPath).toHaveBeenCalledTimes(1)
    expect(isPluginCreated('b-ledger', 'Inbox/mine.md')).toBe(true)
    expect(isPluginCreated('b-ledger', 'Inbox/user.md')).toBe(false)

    await expect(ctx.app.renamePath!('Inbox/mine.md', 'Renamed')).resolves.toBe('Inbox/Renamed.md')
    expect(confirm.calls).toEqual([])
    expect(isPluginCreated('b-ledger', 'Inbox/Renamed.md')).toBe(true) // 账本跟着改名走
    expect(isPluginCreated('b-ledger', 'Inbox/mine.md')).toBe(false)

    confirm.answer = false
    await expect(ctx.app.renamePath!('Inbox/user.md', 'Taken')).rejects.toThrow('user_declined')
    expect(confirm.calls).toEqual(['「b-ledger」想把「Inbox/user.md」改名为「Taken.md」。'])
    expect(renameNoteFile).toHaveBeenCalledTimes(1)
    confirm.answer = true
    await expect(ctx.app.renamePath!('Inbox/user.md', 'Taken')).resolves.toBe('Inbox/Taken.md')
    expect(renameNoteFile).toHaveBeenLastCalledWith('Inbox/user.md', 'Taken')
  })

  it('工作文件夹里面直接做,工作文件夹本身与别的插件建的照样要问', async () => {
    const ctx = ctxOf('b-wf')
    const v = vault({ folders: ['Plugins', 'Plugins/b-wf', 'Plugins/b-wf/out', 'Dest'], pages: ['Plugins/b-wf/out/n.md', 'other.md'] })
    markPluginCreated('someone-else', 'other.md')
    await expect(ctx.app.movePath!('Plugins/b-wf/out/n.md', 'Dest')).resolves.toBe('Dest/n.md')
    expect(confirm.calls).toEqual([])
    await ctx.app.renamePath!('Plugins/b-wf', 'renamed')
    await ctx.app.movePath!('other.md', '')
    expect(confirm.calls.length).toBe(1) // other.md 已在根:同一位置不问也不动
    await ctx.app.movePath!('other.md', 'Dest')
    expect(confirm.calls).toEqual([
      '「b-wf」想把「Plugins/b-wf」改名为「renamed」。',
      '「b-wf」想把「other.md」移到「Dest」。',
    ])
    await ctx.app.movePath!('Dest/other.md', '')
    expect(confirm.calls[2]).toBe('「b-wf」想把「Dest/other.md」移到智库根目录。')
    expect(v.renameFolder).toHaveBeenCalledWith('Plugins/b-wf', 'renamed')
  })

  it('createFolder 建的文件夹改名 / 挪动不问,子树里的账本条目跟着走', async () => {
    const createFolder = vi.fn(async (parent: string, name: string) => {
      const p = parent ? `${parent}/${name}` : name
      usePageStore.setState({ folders: [...usePageStore.getState().folders, p] })
      return p
    })
    bridge.current = { createFolder }
    const ctx = ctxOf('b-folder')
    const v = vault({ folders: ['Projects'] })
    await ctx.app.createFolder!('Projects/Alpha')
    markPluginCreated('b-folder', 'Projects/Alpha/spec.md')
    usePageStore.setState({ pages: ['Projects/Alpha/spec.md'] })
    await expect(ctx.app.renamePath!('Projects/Alpha', 'Beta')).resolves.toBe('Projects/Beta')
    await expect(ctx.app.movePath!('Projects/Beta', '')).resolves.toBe('Beta')
    expect(confirm.calls).toEqual([])
    expect(v.moveFolder).toHaveBeenCalledWith('Projects/Beta', '')
    expect(isPluginCreated('b-folder', 'Beta')).toBe(true)
    expect(isPluginCreated('b-folder', 'Beta/spec.md')).toBe(true)
    await ctx.app.renamePath!('Projects', 'Renamed') // 用户原有的文件夹:要问
    expect(confirm.calls.length).toBe(1)
  })
})

describe('ctx.app.renamePath / movePath 的结果与拒绝', () => {
  it('文件树那条把失败吞进 store.error:没到位 → reject 带原因', async () => {
    const ctx = ctxOf('r-fail')
    vault({ folders: ['Plugins/r-fail', 'Plugins', 'D'], pages: ['Plugins/r-fail/a.md'] }, { fail: true })
    await expect(ctx.app.movePath!('Plugins/r-fail/a.md', 'D')).rejects.toThrow(/EPERM/)
  })

  it('目标已在 / 源不在 / 目标文件夹不在 / 挪进自己 / 挪 .db / 改不了的种类 → reject,不问也不动', async () => {
    const ctx = ctxOf('r-bad')
    const v = vault({ folders: ['A', 'A/sub'], pages: ['x.md', 'y.md'], files: ['pic.png', 't.db'] })
    await expect(ctx.app.renamePath!('x.md', 'y')).rejects.toThrow(/Target already exists: y.md/)
    await expect(ctx.app.renamePath!('nope.md', 'z')).rejects.toThrow(/No such file or folder/)
    await expect(ctx.app.movePath!('x.md', 'Nope')).rejects.toThrow(/No such folder/)
    await expect(ctx.app.movePath!('A', 'A/sub')).rejects.toThrow(/into itself/)
    await expect(ctx.app.movePath!('t.db', 'A')).rejects.toThrow(/Moving databases/)
    await expect(ctx.app.renamePath!('pic.png', 'p2.png')).rejects.toThrow(/not supported/)
    await expect(ctx.app.renamePath!('x.md', 'a/b')).rejects.toThrow(/Invalid name/)
    await expect(ctx.app.renamePath!('x.md', ' padded')).rejects.toThrow(/Invalid name/)
    await expect(ctx.app.renamePath!('x.md', '.hidden')).rejects.toThrow(/Invalid name/)
    await expect(ctx.app.renamePath!('x.md', 'x')).resolves.toBe('x.md') // 名字没变:原路径,不问
    expect(confirm.calls).toEqual([])
    expect(v.movePage).not.toHaveBeenCalled()
    expect(renameNoteFile).not.toHaveBeenCalled()
  })

  it('.db 走 renameDb;并发调用排队一项一项做', async () => {
    const ctx = ctxOf('r-db')
    vault({ folders: ['Plugins', 'Plugins/r-db'], files: ['Plugins/r-db/a.db', 'Plugins/r-db/b.db'] })
    let inFlight = 0, peak = 0
    renameDb.mockImplementation(async (p: string, base: string) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      const to = `Plugins/r-db/${base}.db`
      usePageStore.setState({ files: usePageStore.getState().files.map((x) => (x === p ? to : x)) })
      inFlight--
      return to
    })
    const got = await Promise.all([ctx.app.renamePath!('Plugins/r-db/a.db', 'A2'), ctx.app.renamePath!('Plugins/r-db/b.db', 'B2.db')])
    expect(got).toEqual(['Plugins/r-db/A2.db', 'Plugins/r-db/B2.db'])
    expect(peak).toBe(1)
  })

  it('停用中的确认框被收掉 → reject,不动', async () => {
    const ctx = ctxOf('r-off')
    vault({ pages: ['x.md'] })
    usePluginStore.getState().disable('r-off')
    await expect(ctx.app.renamePath!('x.md', 'y')).rejects.toThrow(/plugin disabled/)
    expect(renameNoteFile).not.toHaveBeenCalled()
  })
})

describe('renameTarget(纯函数)', () => {
  const none = (): null => null
  const canvas = (p: string): string | null => (p.toLowerCase().endsWith('.canvas.md') ? '.canvas.md' : null)
  it('补回后缀、不许改种类', () => {
    expect(renameTarget('a/n.md', false, 'm', none)).toBe('a/m.md')
    expect(renameTarget('a/n.md', false, 'm.md', none)).toBe('a/m.md')
    expect(renameTarget('t.db', false, 'u', none)).toBe('u.db')
    expect(renameTarget('d/x.canvas.md', false, 'y', canvas)).toBe('d/y.canvas.md')
    expect(renameTarget('d/x.canvas.md', false, 'y.canvas.md', canvas)).toBe('d/y.canvas.md')
    expect(renameTarget('w.excalidraw.md', false, 'z', none)).toBe('z.excalidraw.md')
    expect(renameTarget('k.dashboard.md', false, 'j', none)).toBe('j.dashboard.md')
    expect(renameTarget('A/B', true, 'C', none)).toBe('A/C')
    expect(() => renameTarget('n.md', false, 'm.excalidraw', none)).toThrow(/change the file type/)
    expect(() => renameTarget('n.md', false, 'm.canvas', canvas)).toThrow(/change the file type/)
    expect(() => renameTarget('w.excalidraw', false, 'z', none)).toThrow(/not supported/)
    expect(() => renameTarget('a.pdf', false, 'b', none)).toThrow(/not supported/)
  })
  it('cleanVaultPath:去首尾斜杠、反斜杠归一,`..` / 空段 / 盘符拒', () => {
    expect(cleanVaultPath('/a\\b/')).toBe('a/b')
    expect(cleanVaultPath('', true)).toBe('')
    expect(() => cleanVaultPath('')).toThrow()
    expect(() => cleanVaultPath('a//b')).toThrow(/escapes/)
    expect(() => cleanVaultPath('C:/x')).toThrow(/escapes/)
  })
})

describe('pluginCreated 账本', () => {
  it('按库分账;改名改指、删除摘掉;精确匹配', () => {
    usePageStore.setState({ vaultRoot: '/v1' } as never)
    markPluginCreated('p', 'A/x.md')
    markPluginCreated('p', 'F')
    markPluginCreated('p', 'F/in.md')
    expect(isPluginCreated('p', 'A/x.md')).toBe(true)
    expect(isPluginCreated('p', 'A/x.md', '/v2')).toBe(false)
    expect(isPluginCreated('q', 'A/x.md')).toBe(false)
    expect(isPluginCreated('p', 'F/other.md')).toBe(false)
    followCreatedPath('A/x.md', 'file', 'B/x.md')
    expect(isPluginCreated('p', 'B/x.md')).toBe(true)
    followCreatedPath('F', 'prefix', 'G')
    expect(isPluginCreated('p', 'G')).toBe(true)
    expect(isPluginCreated('p', 'G/in.md')).toBe(true)
    followCreatedPath('G', 'prefix', null)
    expect(isPluginCreated('p', 'G/in.md')).toBe(false)
    expect(isPluginCreated('p', 'B/x.md')).toBe(true)
    usePageStore.setState({ vaultRoot: null } as never)
  })
})
