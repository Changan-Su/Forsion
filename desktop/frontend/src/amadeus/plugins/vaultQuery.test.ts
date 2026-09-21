// 只读 vault 查询面(2026-08-14):纯透传 + 桥缺席时的降级。
// 钉两件事:①真的转到 window.amadeus 的既有 IPC(不是自己造一份);
// ②**桥不存在时给空结果而不是抛** —— 插件侧的可选链只挡得住「宿主没这个方法」,
// 挡不住「方法在但 window.amadeus 是 undefined」(web / 台架未垫的场景)。
// api.ts 在模块加载时就把 window.amadeus 抓成常量,所以这里 mock 模块而不是塞 window。
import { describe, expect, it, beforeEach, vi } from 'vitest'

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../api', () => ({
  get amadeus() {
    return bridge.current
  },
}))

const { usePluginStore } = await import('./pluginStore')
const { usePageStore } = await import('../store/pageStore')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}

describe('只读 vault 查询面', () => {
  // 清单缓存是按 (kind, vaultRoot) 记的 —— 每个用例换一个 root 才不会吃到上一个用例的 1.5s 缓存。
  let n = 0
  beforeEach(() => {
    bridge.current = undefined
    usePageStore.setState({ vaultRoot: `/vault-${++n}` })
  })

  it('桥缺席时给空结果,不抛', async () => {
    const ctx = ctxOf('p-empty')
    await expect(ctx.app.listPages!()).resolves.toEqual([])
    await expect(ctx.app.listFiles!()).resolves.toEqual([])
    await expect(ctx.app.searchVault!('x')).resolves.toEqual([])
  })

  it('桥在时逐条透传(不是自己造一份实现)', async () => {
    const search = vi.fn().mockResolvedValue([{ path: 'a.md', title: 'a', snippet: 's', line: 1, score: 1 }])
    bridge.current = {
      listPages: vi.fn().mockResolvedValue(['a.md']),
      listFiles: vi.fn().mockResolvedValue(['img/a.png']),
      search,
    }
    const ctx = ctxOf('p-bridge')
    await expect(ctx.app.listPages!()).resolves.toEqual(['a.md'])
    await expect(ctx.app.listFiles!()).resolves.toEqual(['img/a.png'])
    await expect(ctx.app.searchVault!('kw')).resolves.toHaveLength(1)
    expect(search).toHaveBeenCalledWith('kw')
  })

  it('searchVault 的入参一律成串(插件传 null 也不许崩到主进程)', async () => {
    const search = vi.fn().mockResolvedValue([])
    bridge.current = { search }
    const ctx = ctxOf('p-coerce')
    await ctx.app.searchVault!(null as unknown as string)
    expect(search).toHaveBeenCalledWith('')
  })

  it('vaultRoot 读 pageStore(不重开库),没库时 null', () => {
    const ctx = ctxOf('p-root')
    usePageStore.setState({ vaultRoot: '' })
    expect(ctx.app.vaultRoot!()).toBeNull()
    usePageStore.setState({ vaultRoot: '/Users/x/vault' })
    expect(ctx.app.vaultRoot!()).toBe('/Users/x/vault')
  })
  it('⚠️路径归一成 / (Windows 主进程给的是 \\)', async () => {
    bridge.current = {
      listPages: vi.fn().mockResolvedValue(['a\\b\\c.md']),
      listFiles: vi.fn().mockResolvedValue(['img\\x.png']),
      search: vi.fn().mockResolvedValue([{ path: 'a\\b.md', title: 'b', snippet: 's', line: 1, score: 1 }]),
    }
    const ctx = ctxOf('p-slash')
    await expect(ctx.app.listPages!()).resolves.toEqual(['a/b/c.md'])
    await expect(ctx.app.listFiles!()).resolves.toEqual(['img/x.png'])
    expect((await ctx.app.searchVault!('q'))[0].path).toBe('a/b.md')
  })

  it('⚠️没有活动库时主进程会抛 —— 三条一律给空数组,不 reject', async () => {
    bridge.current = {
      listPages: vi.fn().mockRejectedValue(new Error('no vault')),
      listFiles: vi.fn().mockRejectedValue(new Error('no vault')),
      search: vi.fn().mockRejectedValue(new Error('no vault')),
    }
    const ctx = ctxOf('p-novault')
    await expect(ctx.app.listPages!()).resolves.toEqual([])
    await expect(ctx.app.listFiles!()).resolves.toEqual([])
    await expect(ctx.app.searchVault!('q')).resolves.toEqual([])
  })

  it('并发要清单只打一次盘(single-flight + 短缓存),换库立刻作废', async () => {
    const listPages = vi.fn().mockResolvedValue(['a.md'])
    bridge.current = { listPages }
    usePageStore.setState({ vaultRoot: '/vault-A' })
    const ctx = ctxOf('p-cache')
    await Promise.all([ctx.app.listPages!(), ctx.app.listPages!(), ctx.app.listPages!()])
    expect(listPages).toHaveBeenCalledTimes(1)
    usePageStore.setState({ vaultRoot: '/vault-B' }) // 换库 → 缓存不许命中
    await ctx.app.listPages!()
    expect(listPages).toHaveBeenCalledTimes(2)
  })

  // 2026-09-19 评审:Live3D 导入 = 列清单 → 拷模型(writeBytes)→ 写 live3d.json(writeFile)→ 立刻重扫,
  // 全程 < 1.5s → 重扫吃到拷贝前的缓存清单,新模型不显示。写盘落定后必须作废两种清单。
  // 负对照(已实跑红):去掉 writeFile / writeBytes 上的 `.finally(dropListCache)` → 本用例红。
  it('⚠️插件写盘之后清单缓存作废:列 → 写 → 列 必须真的再打一次盘(writeFile / writeBytes 都算)', async () => {
    const disk = new Set(['Live3D/README.md'])
    const listFiles = vi.fn(async () => [...disk])
    const listPages = vi.fn(async () => [...disk].filter((p) => p.endsWith('.md')))
    const writeTextFile = vi.fn(async (p: string) => { disk.add(p) })
    const saveVaultBytes = vi.fn(async (p: string) => { disk.add(p) })
    bridge.current = { listFiles, listPages, writeTextFile, saveVaultBytes }
    const ctx = ctxOf('p-write-drop')

    expect(await ctx.app.listFiles!()).toEqual(['Live3D/README.md'])
    await ctx.app.writeBytes!('Live3D/models/a/a.glb', new Uint8Array([1]))
    expect(await ctx.app.listFiles!()).toContain('Live3D/models/a/a.glb')
    expect(listFiles).toHaveBeenCalledTimes(2)

    await ctx.app.listPages!()
    await ctx.app.writeFile('Live3D/models/a/notes.md', '# a')
    expect(await ctx.app.listFiles!()).toContain('Live3D/models/a/notes.md')
    expect(await ctx.app.listPages!()).toContain('Live3D/models/a/notes.md') // .md 也会被 writeFile 写出 → pages 也要作废
    expect(listFiles).toHaveBeenCalledTimes(3)
    expect(listPages).toHaveBeenCalledTimes(2)

    // 写失败同样作废(finally):失败前可能已落了一半
    writeTextFile.mockRejectedValueOnce(new Error('disk full'))
    await expect(ctx.app.writeFile('Live3D/x.json', '{}')).rejects.toThrow('disk full')
    await ctx.app.listFiles!()
    expect(listFiles).toHaveBeenCalledTimes(4)
    // 不写盘时照旧吃 1.5s 缓存(没把缓存整个拆掉)
    await ctx.app.listFiles!()
    expect(listFiles).toHaveBeenCalledTimes(4)
  })
})
