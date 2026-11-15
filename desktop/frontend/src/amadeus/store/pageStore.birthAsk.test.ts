/** 新笔记出生先问插件(ctx.registerNoteBirth,2026-11-16):哪些入口问、给的内容随出生那一写落盘、换库 / 同名并发的兜底。
 *  问插件本身的取舍(顺序、取消、超时、抛错)在 plugins/templateHooks.test.ts;真窗口在 scripts/plugin-birth-race.check.cjs。 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const disk = new Map<string, string>()
const writes: Array<{ path: string; text: string; opts?: { create?: boolean; base?: string; expectedRoot?: string } }> = []
const dispatched: Array<{ type: string; path?: string }> = []

async function fresh(bridge: Record<string, unknown> = {}) {
  vi.resetModules()
  disk.clear()
  writes.length = 0
  dispatched.length = 0
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; defaultPrevented = false
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail }
    preventDefault() { this.defaultPrevented = true }
  })
  vi.stubGlobal('window', {
    amadeus: {
      readTextFile: async (p: string) => disk.get(p) ?? null,
      writeTextFile: async (p: string, text: string, o?: { create?: boolean; base?: string; expectedRoot?: string }) => {
        writes.push({ path: p, text, opts: o })
        if (o?.create && disk.has(p)) return { ok: false, current: disk.get(p) }
        disk.set(p, text)
        return o?.create ? { ok: true } : undefined
      },
      newPage: async () => { throw new Error('no v3 birth') },
      loadPage: async () => { throw new Error('host navigates') },
      listPages: async () => [...disk.keys()].filter((k) => k.endsWith('.md')),
      listFolders: async () => [],
      listFiles: async () => [...disk.keys()],
      backlinks: async () => [],
      listPageProps: async () => [],
      setPageFrontmatter: async () => {},
      ...bridge,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: { type: string; detail?: { path?: string } }) => { dispatched.push({ type: e.type, path: e.detail?.path }); return false }, // 宿主接管导航
  })
  const ps = await import('./pageStore')
  const hooks = await import('../plugins/templateHooks')
  ps.usePageStore.setState({ vaultRoot: '/v', pages: [], files: [], folders: [], status: 'ready' })
  return { ...ps, hooks }
}

afterEach(() => { vi.unstubAllGlobals() })
// 第一次冷 import pageStore(整张依赖图现编译)在高负载机器上能超过默认 5 秒:先热一遍,后面的 resetModules 只重新求值。
beforeAll(async () => { await fresh(); vi.unstubAllGlobals() }, 120_000)

const writeOf = (p: string) => writes.filter((w) => w.path === p)

describe('registerNoteBirth × 出生入口', () => {
  it('新建笔记(文件夹里):问插件,内容随那一次仅新建写落盘,然后才导航', async () => {
    const { usePageStore, hooks } = await fresh()
    const seen: unknown[] = []
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: (i) => { seen.push({ path: i.path, folder: i.folder }); return '# From plugin\n' } })
    await usePageStore.getState().createPageInFolder('Inbox')
    expect(seen).toEqual([{ path: 'Inbox/untitled.md', folder: 'Inbox' }])
    expect(writeOf('Inbox/untitled.md')).toHaveLength(1) // 一写成型,没有「先空后填」
    expect(writeOf('Inbox/untitled.md')[0]).toMatchObject({ text: '# From plugin\n', opts: { create: true } })
    expect(dispatched).toContainEqual({ type: 'amadeus:navigate-note', path: 'Inbox/untitled.md' })
  })

  it('快切新建 / 未解析链接确认(路径限定与子笔记)/ 子笔记都问', async () => {
    const { usePageStore, hooks } = await fresh()
    const asked: string[] = []
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: (i) => { asked.push(i.path); return `filled:${i.path}` } })
    await usePageStore.getState().createWikiPage('Quick')
    usePageStore.setState({ pendingWikiCreate: { name: 'dir/Deep', sourcePath: null } })
    await usePageStore.getState().confirmWikiCreate()
    usePageStore.setState({ pages: ['Parent.md'], pendingWikiCreate: { name: 'Kid', sourcePath: 'Parent.md' } })
    await usePageStore.getState().confirmWikiCreate()
    await usePageStore.getState().createChildNote('Parent.md', 'Other')
    expect(asked).toEqual(['Quick.md', 'dir/Deep.md', 'Parent.fd/Kid.md', 'Parent.fd/Other.md'])
    for (const p of asked) expect(disk.get(p)).toBe(`filled:${p}`)
  })

  it('笔记视图加行不问(调用方随后写属性 / 复制内容进去),照旧空白出生', async () => {
    const { hooks } = await fresh()
    const initial = vi.fn(() => 'should not be used')
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial })
    const { useNoteViewStore } = await import('./noteViewStore')
    const p = await useNoteViewStore.getState().addNote('Folder')
    expect(initial).not.toHaveBeenCalled()
    expect(writeOf(p)[0]).toMatchObject({ text: '', opts: { create: true } })
  })

  it('插件都不给(null)→ 照旧空白出生;磁盘上已有 → 不问、不写', async () => {
    const { usePageStore, hooks } = await fresh()
    const initial = vi.fn(() => null)
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial })
    await usePageStore.getState().createWikiPage('Plain')
    expect(writeOf('Plain.md')[0].text).toBe('')
    disk.set('Exists.md', '# keep\n')
    initial.mockClear()
    await usePageStore.getState().createWikiPage('Exists')
    expect(initial).not.toHaveBeenCalled()
    expect(writeOf('Exists.md')).toEqual([])
    expect(disk.get('Exists.md')).toBe('# keep\n')
  })

  it('等插件的途中换了库:不写、不导航(照原路径写就落进了另一个库)', async () => {
    const { usePageStore, birthNoteFile, hooks } = await fresh()
    let answer: (v: string) => void = () => {}
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: () => new Promise<string>((r) => { answer = r }) })
    const born = birthNoteFile('Note.md', { ask: true })
    await new Promise((r) => setTimeout(r, 0))
    usePageStore.setState({ vaultRoot: '/other' })
    answer('# late')
    expect(await born).toBe('failed')
    expect(writes).toEqual([])
  })

  it('排在后面的同名出生:轮到它时库已换 → 不建(不落进新库)', async () => {
    const { usePageStore, birthNoteFile, hooks } = await fresh()
    let answer: (v: string) => void = () => {}
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: () => new Promise<string>((r) => { answer = r }) })
    const first = birthNoteFile('Same.md', { ask: true })
    const second = birthNoteFile('Same.md')
    await new Promise((r) => setTimeout(r, 0))
    usePageStore.setState({ vaultRoot: '/other' })
    answer('# late')
    expect(await first).toBe('failed')
    expect(await second).toBe('failed')
    expect(writes).toEqual([])
    // 新库里自己发起的同名出生不受前一个库那条队的牵连
    expect(await birthNoteFile('Same.md')).toBe('created')
  })

  it('宿主支持按库根写时带上 expectedRoot(主进程锁内再核一次)', async () => {
    const { birthNoteFile, hooks } = await fresh({ scopedTextWrites: true })
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: () => 'x' })
    expect(await birthNoteFile('Scoped.md', { ask: true })).toBe('created')
    expect(writeOf('Scoped.md')[0].opts).toMatchObject({ create: true, expectedRoot: '/v' })
    // 不问插件的出生照旧(不带 expectedRoot,一字不差的老路)
    expect(await birthNoteFile('Plain.md')).toBe('created')
    expect(writeOf('Plain.md')[0].opts?.expectedRoot).toBeUndefined()
  })

  it('同一路径的出生排队:等插件时又来一次同名新建 → 后者看到已存在,只写一次', async () => {
    const { birthNoteFile, hooks } = await fresh()
    let answer: (v: string) => void = () => {}
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: () => new Promise<string>((r) => { answer = r }) })
    const first = birthNoteFile('untitled.md', { ask: true })
    const second = birthNoteFile('untitled.md', { ask: true })
    await new Promise((r) => setTimeout(r, 0))
    answer('# T')
    expect(await first).toBe('created')
    expect(await second).toBe('exists')
    expect(writeOf('untitled.md')).toHaveLength(1)
    expect(disk.get('untitled.md')).toBe('# T')
  })

  it('插件抛错 → 照旧空白出生,笔记照常打开', async () => {
    const { usePageStore, hooks } = await fresh()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hooks.registerNoteBirth('tpl', () => 'Tpl', { id: 'b', initial: () => { throw new Error('boom') } })
    await usePageStore.getState().createWikiPage('Err')
    expect(writeOf('Err.md')[0].text).toBe('')
    expect(dispatched).toContainEqual({ type: 'amadeus:navigate-note', path: 'Err.md' })
  })
})
