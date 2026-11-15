/** 宿主模板流程 × 插件模板处理器(ctx.registerTemplateProcessor,2026-11-16):处理器先拿原文、宿主后替换变量;
 *  抛错不插;等处理器的途中换库 / 换笔记不插(Codex 复核 P1);老格式模板交给插件的是正典源码(P2);日记两条路。
 *  真窗口(选择器列出插件文件夹、插入落盘):scripts/plugin-birth-race.check.cjs T1–T3。 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = {
  vaultRoot: '/v' as string | null,
  activePage: 'Note.md' as string | null,
  pages: [] as string[],
  blocks: {} as Record<string, { content: string }>,
  setBlockContent: vi.fn(),
  insertBlocksAfter: vi.fn(),
  refreshStructure: vi.fn(async () => {}),
}
let scope = 'main'
const birthNoteFile = vi.fn(async (..._a: unknown[]) => 'created' as const)
const inserted: Array<{ path: string; md: string }> = []

vi.mock('@amadeus/store/pageStore', () => ({
  usePageStore: { getState: () => state },
  noteOf: (s: typeof state) => s.activePage,
  activePageScope: () => scope,
  birthNoteFile: (...a: unknown[]) => birthNoteFile(...a),
}))
vi.mock('@amadeus/unified/lifecycle', () => ({
  unifiedInsertMarkdown: (path: string, md: string) => { inserted.push({ path, md }); return true },
  unifiedFmNow: () => '',
  unifiedPatchFm: () => Promise.resolve(),
}))
vi.mock('./amadeusNav', () => ({ openNote: async () => {} }))

const files = new Map<string, string>()
let readPageOverride: ((p: string) => unknown) | null = null

async function load() {
  vi.resetModules()
  vi.stubGlobal('window', {
    amadeus: {
      readTextFile: async (p: string) => files.get(p) ?? null,
      readPage: async (p: string) => {
        if (readPageOverride) return readPageOverride(p)
        const raw = files.get(p)
        if (raw == null) throw new Error(`Note not found: ${p}`)
        const { parsePageSource } = await import('@amadeus-shared/compiler')
        return parsePageSource(p, raw, '2026-01-01T00:00:00.000Z')
      },
    },
    tangu: { getConfig: async () => ({}) },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail } })
  const tpl = await import('./amadeusTemplates')
  const hooks = await import('@amadeus/plugins/templateHooks')
  ;(await import('./i18n')).setLocaleGlobal('zh')
  return { tpl, hooks }
}

function reset() {
  files.clear()
  inserted.length = 0
  readPageOverride = null
  scope = 'main'
  Object.assign(state, { vaultRoot: '/v', activePage: 'Note.md', pages: [], blocks: {} })
  state.setBlockContent.mockClear()
  state.insertBlocksAfter.mockClear()
  birthNoteFile.mockClear()
}

beforeAll(async () => { await load() }, 120_000) // 冷 import 在高负载机器上会超过默认 5 秒
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('insertTemplate × 模板处理器', () => {
  it('没有处理器:不读原文,照旧 readPage 插入(变量照旧替换)', async () => {
    reset()
    const { tpl } = await load()
    files.set('templates/t.md', 'Hello {{title}}\n')
    const read = vi.spyOn((window as unknown as { amadeus: { readTextFile: (p: string) => unknown } }).amadeus, 'readTextFile')
    await tpl.insertTemplate('templates/t.md', { v4Path: 'Note.md' })
    expect(read).not.toHaveBeenCalledWith('templates/t.md')
    expect(inserted).toEqual([{ path: 'Note.md', md: 'Hello Note' }])
  })

  it('处理器先拿原文({{title}} 还没替换),按注册顺序串起来;宿主随后替换变量', async () => {
    reset()
    const { tpl, hooks } = await load()
    files.set('templates/t.md', 'Hi {{title}} <%a%> <%b%>\n')
    const seen: unknown[] = []
    hooks.registerTemplateProcessor('p1', () => 'P1', { id: 'x', name: 'X', process: (s, i) => { seen.push([s, i]); return s.replace('<%a%>', 'A') } })
    hooks.registerTemplateProcessor('p2', () => 'P2', { id: 'x', name: 'Y', process: (s) => s.replace('<%b%>', 'B') })
    await tpl.insertTemplate('templates/t.md', { v4Path: 'Note.md' })
    expect(seen).toEqual([['Hi {{title}} <%a%> <%b%>\n', { templatePath: 'templates/t.md', targetPath: 'Note.md', kind: 'insert' }]])
    expect(inserted).toEqual([{ path: 'Note.md', md: 'Hi Note A B' }])
  })

  it('处理器抛错:什么都不插', async () => {
    reset()
    const { tpl, hooks } = await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    files.set('templates/t.md', 'Body\n')
    hooks.registerTemplateProcessor('bad', () => 'Bad', { id: 'x', name: 'X', process: () => { throw new Error('no') } })
    await tpl.insertTemplate('templates/t.md', { v4Path: 'Note.md' })
    expect(inserted).toEqual([])
  })

  it('等处理器的途中换了库:v4 不插;v3 换了笔记 / 换了面板也不插(不写进别的笔记的同号块)', async () => {
    reset()
    const { tpl, hooks } = await load()
    files.set('templates/t.md', 'Body\n')
    let release: (v: string | null) => void = () => {}
    hooks.registerTemplateProcessor('slow', () => 'S', { id: 'x', name: 'X', process: () => new Promise((r) => { release = r }) })

    const v4 = tpl.insertTemplate('templates/t.md', { v4Path: 'Note.md' })
    await new Promise((r) => setTimeout(r, 0))
    state.vaultRoot = '/other'
    release(null)
    await v4
    expect(inserted).toEqual([])

    state.vaultRoot = '/v'
    state.blocks = { '1': { content: '' } }
    const v3 = tpl.insertTemplate('templates/t.md', { afterId: '1', emptyBlock: true })
    await new Promise((r) => setTimeout(r, 0))
    state.activePage = 'Other.md' // 用户切到了另一篇,它恰好也有块 1
    release(null)
    await v3
    expect(state.setBlockContent).not.toHaveBeenCalled()
    expect(state.insertBlocksAfter).not.toHaveBeenCalled()

    state.activePage = 'Note.md'
    const v3b = tpl.insertTemplate('templates/t.md', { afterId: '1', emptyBlock: true })
    await new Promise((r) => setTimeout(r, 0))
    scope = 'split-2'
    release(null)
    await v3b
    expect(state.setBlockContent).not.toHaveBeenCalled()
  })

  it('v3:等的途中光标那一块被打了字 → 不覆盖,插在它后面', async () => {
    reset()
    const { tpl, hooks } = await load()
    files.set('templates/t.md', 'Body\n')
    let release: (v: string | null) => void = () => {}
    hooks.registerTemplateProcessor('slow', () => 'S', { id: 'x', name: 'X', process: () => new Promise((r) => { release = r }) })
    state.blocks = { '1': { content: '' } }
    const run = tpl.insertTemplate('templates/t.md', { afterId: '1', emptyBlock: true })
    await new Promise((r) => setTimeout(r, 0))
    state.blocks = { '1': { content: 'typed meanwhile' } }
    release(null)
    await run
    expect(state.setBlockContent).not.toHaveBeenCalled()
    expect(state.insertBlocksAfter).toHaveBeenCalledWith('1', ['Body'])
  })

  it('盘上原文解析出来不是 readPage 那份(老格式):交给插件的是正典重新编出的源码,不是过期的盘面', async () => {
    reset()
    const { tpl, hooks } = await load()
    files.set('templates/legacy.md', 'stale projection\n')
    const { parsePageSource } = await import('@amadeus-shared/compiler')
    readPageOverride = (p) => parsePageSource(p, 'Real sidecar body {{title}}\n', '2026-01-01T00:00:00.000Z')
    const seen: string[] = []
    hooks.registerTemplateProcessor('p', () => 'P', { id: 'x', name: 'X', process: (s) => { seen.push(s); return s } })
    await tpl.insertTemplate('templates/legacy.md', { v4Path: 'Note.md' })
    expect(seen[0]).toContain('Real sidecar body {{title}}')
    expect(seen[0]).not.toContain('stale projection')
    expect(inserted).toEqual([{ path: 'Note.md', md: 'Real sidecar body Note' }])
  })
})

describe('listTemplates × 插件文件夹', () => {
  it('templates/ 加上插件声明的文件夹(大小写不敏感、只列一次);规范化不了的文件夹不认', async () => {
    reset()
    const { tpl } = await load()
    state.pages = ['templates/a.md', 'Tpl/b.md', 'tpl/Sub/c.md', 'Other/d.md', 'Tplx/e.md']
    expect(tpl.listTemplates(['Tpl', 'Tpl/', '../Other', '/Other'])).toEqual(['templates/a.md', 'Tpl/b.md', 'tpl/Sub/c.md'])
    expect(tpl.listTemplates()).toEqual(['templates/a.md'])
  })
})

describe('openDailyNote', () => {
  it('没有日记模板:出生时问插件(ask);有日记模板:不问,出生后按 daily 插模板', async () => {
    reset()
    const { tpl, hooks } = await load()
    await tpl.openDailyNote()
    expect(birthNoteFile).toHaveBeenCalledWith(expect.stringMatching(/\.md$/), { ask: true })

    reset()
    const again = await load()
    state.pages = ['templates/daily.md']
    files.set('templates/daily.md', 'Daily {{title}}\n')
    const kinds: string[] = []
    again.hooks.registerTemplateProcessor('p', () => 'P', { id: 'x', name: 'X', process: (_s, i) => { kinds.push(i.kind); return null } })
    await again.tpl.openDailyNote()
    expect(birthNoteFile.mock.calls[0][1]).toBeUndefined()
    expect(kinds).toEqual(['daily'])
    expect(inserted).toHaveLength(1)
    void hooks
  })

  it('出生前清单落后、刷新后才看到日记模板:问过插件且插件给了内容 → 不再叠模板;插件没给 → 照旧套模板', async () => {
    for (const filled of [true, false]) {
      reset()
      const { tpl } = await load()
      files.set('templates/daily.md', 'Daily {{title}}\n')
      birthNoteFile.mockImplementation(async (...a: unknown[]) => { if (filled) files.set(String(a[0]), '# from plugin\n'); return 'created' })
      state.refreshStructure.mockImplementation(async () => { state.pages = ['templates/daily.md'] })
      await tpl.openDailyNote()
      expect(birthNoteFile.mock.calls[0][1]).toEqual({ ask: true })
      expect(inserted).toHaveLength(filled ? 0 : 1)
    }
    birthNoteFile.mockImplementation(async () => 'created')
    state.refreshStructure.mockImplementation(async () => {})
  })
})
