// 2026-09-19 新 ctx 接缝的宿主侧:ctx.desk.registerCompanion / ctx.tangu.agentStatus·subscribeAgentStatus·startChat /
// ctx.app.writeBytes·readBytes。钉的是**闸与吊销**(执行半在 tanguProbe.test.ts / agentStatus.test.ts):
//  ① ctx.desk 只在 Tangu 探针在 + 桌面端时注入;注册即生效、update({mode}) 就地翻 always、禁用 / setup 抛错统一撤;
//     旧一代 handle 在重新启用后变哑(不许改新一代的条目);
//  ② startChat 探针给得出才注入;send:true 只放行本插件捆绑包**播种的** Agent(清单有 + 主进程
//     bundleAgentOwned 认标记;撞名 / 桥缺这条 / IPC 抛 → 预填);folder 经 hostPath 同一函数解析,
//     `..` / 绝对路径 / 非本机执行 → 不带 cwd;禁用后(含等归属 IPC 那一拍)不再开对话,且把 alive 递给探针;
//  ③ writeBytes / readBytes 只在桥有对应方法时挂;字节按视图取(Float32Array 不许被逐元素截断);
//  ④ subscribeAgentStatus 的退订在禁用时由宿主统一收。
// 负对照(已实跑红):startChat 的 `send: !!o?.send && own` 去掉 `&& own` → ②「别家 Agent 降级为预填」红;
// own 改回只看清单(`own = listed`)→ ②「撞名」「桥缺 bundleAgentOwned」红;去掉 IPC 之后的 ctxAlive 复查 → ②「等 IPC 时被禁用」红;
// revokers 里去掉 revokeDeskCompanions → ①「禁用即撤」红;ctx.desk 闸去掉 currentPlatform 判断 → ①「web 端没有 ctx.desk」红。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../api', () => ({
  get amadeus() {
    return bridge.current
  },
}))

const { usePluginStore } = await import('./pluginStore')
const { usePageStore } = await import('../store/pageStore')
const { setTanguProbe, idleAgentStatus } = await import('./tanguSeam')
const { activeDeskCompanion, deskReplacedByCompanion, deskAcceptsFiles, __resetDeskCompanions } = await import('./deskCompanion')
type Ctx = import('./types').PluginContext
type Plugin = import('./types').AmadeusPlugin
type Probe = import('./tanguSeam').TanguProbe

const BUNDLE = { agents: ['live3d-importer'], enginePlugins: [], skills: [], spaces: [] }

function ctxOf(id: string, over: Partial<Plugin> = {}): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c }, ...over }])
  return ref!
}

const baseProbe = (over: Partial<Probe> = {}): Probe => ({
  activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
  hostExecution: () => true,
  ...over,
})

beforeEach(() => {
  bridge.current = undefined
  __resetDeskCompanions()
  usePageStore.setState({ vaultRoot: '/v' })
  setTanguProbe(baseProbe())
})
afterEach(() => {
  setTanguProbe(null)
  vi.unstubAllGlobals()
})

describe('ctx.desk(Agent Desk 伴随面)', () => {
  const def = { id: 'avatar', mode: 'idle' as const, mount: () => {} }

  it('Tangu 桌面宿主注入;没有探针(纯 Amadeus 壳)不注入', () => {
    expect(typeof ctxOf('p-desk').desk?.registerCompanion).toBe('function')
    setTanguProbe(null)
    expect(ctxOf('p-desk').desk).toBeUndefined()
  })

  it('web 端没有 ctx.desk(Desk 只在桌面 Tangu 出现;端判定走 currentPlatform 单源)', () => {
    vi.stubGlobal('window', { tangu: { cloudWeb: true } })
    expect(ctxOf('p-desk').desk).toBeUndefined()
  })

  it('注册即成为生效者;update({mode}) 就地翻 always → Desk 不再收文件;禁用即撤', () => {
    const ctx = ctxOf('p-desk')
    const h = ctx.desk!.registerCompanion(def)
    expect(activeDeskCompanion()).toMatchObject({ key: 'plugin:p-desk:avatar', pluginId: 'p-desk', mode: 'idle' })
    expect(deskReplacedByCompanion()).toBe(false)
    h.update({ mode: 'always' })
    expect(deskReplacedByCompanion()).toBe(true)
    expect(deskAcceptsFiles(true)).toBe(false)
    usePluginStore.getState().disable('p-desk')
    expect(activeDeskCompanion()).toBeNull()
    expect(deskAcceptsFiles(true)).toBe(true)
  })

  it('setup 注册后抛错 → 伴随面同样被撤', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ctxOf('p-throw', { setup: (c) => { c.desk!.registerCompanion(def); throw new Error('boom') } })
    expect(activeDeskCompanion()).toBeNull()
  })

  it('旧一代 handle 在重新启用后变哑;吊销后的 ctx 不能再注册', () => {
    let gen = 0
    const handles: Array<import('./deskCompanion').DeskCompanionHandle> = []
    const ctxs: Ctx[] = []
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id: 'p-gen', name: 'p-gen', version: '0', setup: (c) => { gen++; ctxs.push(c); handles.push(c.desk!.registerCompanion(def)) } }])
    usePluginStore.getState().disable('p-gen')
    usePluginStore.getState().enable('p-gen')
    expect(gen).toBe(2)
    handles[0].update({ mode: 'always' })
    handles[0].dispose()
    expect(activeDeskCompanion()).toMatchObject({ key: 'plugin:p-gen:avatar', mode: 'idle' }) // 新一代没被动
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ctxs[0].desk!.registerCompanion({ ...def, id: 'ghost' })
    expect(activeDeskCompanion()?.key).toBe('plugin:p-gen:avatar')
  })
})

describe('ctx.tangu.startChat 的放行规则', () => {
  const startChat = vi.fn(async (_o: import('./tanguSeam').TanguStartChatOptions) => ({ ok: true }))
  beforeEach(() => {
    startChat.mockClear()
    setTanguProbe(baseProbe({ startChat }))
  })
  const lastArg = () => startChat.mock.calls.at(-1)![0]

  it('探针没有 startChat(旧台架)→ 方法不存在;有 → 注入', () => {
    setTanguProbe(baseProbe())
    expect(ctxOf('p-sc').tangu!.startChat).toBeUndefined()
    setTanguProbe(baseProbe({ startChat }))
    expect(typeof ctxOf('p-sc').tangu!.startChat).toBe('function')
  })

  it('send:true 只对本插件捆绑包播种的 Agent 生效;别家 Agent / 没指定 Agent 一律降级为预填', async () => {
    const owned = vi.fn(async (pid: string, slug: string) => pid === 'p-sc' && slug === 'live3d-importer')
    bridge.current = { bundleAgentOwned: owned }
    const ctx = ctxOf('p-sc', { bundle: BUNDLE })
    await ctx.tangu!.startChat!({ agent: 'live3d-importer', prompt: 'import', send: true })
    expect(lastArg()).toMatchObject({ agent: 'live3d-importer', prompt: 'import', send: true })
    expect(owned).toHaveBeenLastCalledWith('p-sc', 'live3d-importer')
    await ctx.tangu!.startChat!({ agent: 'xyra', prompt: 'import', send: true })
    expect(lastArg()).toMatchObject({ agent: 'xyra', send: false })
    await ctx.tangu!.startChat!({ prompt: 'import', send: true })
    expect(lastArg().send).toBe(false)
    expect(lastArg().agent).toBeUndefined()
    // 同一个 slug,但是别的插件在调 → 不是它的捆绑 Agent
    const other = ctxOf('p-other')
    await other.tangu!.startChat!({ agent: 'live3d-importer', prompt: 'import', send: true })
    expect(lastArg().send).toBe(false)
    // 清单外的 slug / 预填请求都不问主进程(每次预填不白付一次 IPC)
    expect(owned).toHaveBeenCalledTimes(1)
    await ctx.tangu!.startChat!({ agent: 'live3d-importer', prompt: 'import' })
    expect(lastArg().send).toBe(false)
    expect(owned).toHaveBeenCalledTimes(1)
  })

  it('撞名:清单里有 xyra,但引擎没播成(用户自己的 xyra 先在,没有本插件的标记)→ 降级为预填', async () => {
    // 引擎 seedBundleAgents 对已存在的 slug 永不覆盖、永不写 .bundle-origin → 主进程判 false
    const owned = vi.fn(async (_pid: string, slug: string) => slug === 'live3d-importer')
    bridge.current = { bundleAgentOwned: owned }
    const ctx = ctxOf('p-sc', { bundle: { ...BUNDLE, agents: ['live3d-importer', 'xyra'] } })
    await ctx.tangu!.startChat!({ agent: 'xyra', prompt: 'import', send: true })
    expect(owned).toHaveBeenLastCalledWith('p-sc', 'xyra')
    expect(lastArg()).toMatchObject({ agent: 'xyra', prompt: 'import', send: false })
    await ctx.tangu!.startChat!({ agent: 'live3d-importer', prompt: 'import', send: true }) // 同一插件真播种的照常直发
    expect(lastArg()).toMatchObject({ agent: 'live3d-importer', send: true })
  })

  it('fail closed:桥缺 bundleAgentOwned(web / 移动 / Unit / 台架)、IPC 抛、回非 true → 自家清单里的 Agent 也只预填', async () => {
    const ctx = ctxOf('p-sc', { bundle: BUNDLE })
    const cases: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { bundleAgentOwned: vi.fn(async () => { throw new Error('ipc down') }) },
      { bundleAgentOwned: vi.fn(async () => 'yes') },
    ]
    for (const b of cases) {
      bridge.current = b
      const r = await ctx.tangu!.startChat!({ agent: 'live3d-importer', prompt: 'import', send: true })
      expect(r).toEqual({ ok: true })
      expect(lastArg(), JSON.stringify(b && Object.keys(b))).toMatchObject({ agent: 'live3d-importer', send: false })
    }
  })

  it('等归属 IPC 那一拍里被禁用 → ok:false,不碰探针', async () => {
    let release!: (v: boolean) => void
    bridge.current = { bundleAgentOwned: vi.fn(() => new Promise<boolean>((r) => { release = r })) }
    const ctx = ctxOf('p-sc', { bundle: BUNDLE })
    const n = startChat.mock.calls.length
    const pending = ctx.tangu!.startChat!({ agent: 'live3d-importer', prompt: 'import', send: true })
    usePluginStore.getState().disable('p-sc')
    release(true)
    expect(await pending).toEqual({ ok: false, error: 'plugin disabled' })
    expect(startChat.mock.calls.length).toBe(n)
  })

  it('folder → cwd:与 ctx.app.hostPath 同一函数;`..` / 绝对路径 / 非本机执行 → 不带 cwd', async () => {
    const ctx = ctxOf('p-sc', { bundle: BUNDLE })
    await ctx.tangu!.startChat!({ prompt: 'x', folder: 'Live3D/' })
    expect(lastArg().cwd).toBe('/v/Live3D')
    expect(lastArg().cwd).toBe(ctx.app.hostPath!('Live3D'))
    for (const bad of ['../outside', 'Live3D/../../etc', '/etc', 'C:/x']) {
      await ctx.tangu!.startChat!({ prompt: 'x', folder: bad })
      expect(lastArg(), bad).not.toHaveProperty('cwd')
    }
    setTanguProbe(baseProbe({ startChat, hostExecution: () => false }))
    await ctx.tangu!.startChat!({ prompt: 'x', folder: 'Live3D' })
    expect(lastArg()).not.toHaveProperty('cwd')
    usePageStore.setState({ vaultRoot: null })
    setTanguProbe(baseProbe({ startChat }))
    await ctx.tangu!.startChat!({ prompt: 'x', folder: 'Live3D' })
    expect(lastArg()).not.toHaveProperty('cwd')
  })

  it('活性:递 alive 给探针;禁用后 alive 翻 false,再调直接 ok:false 且不碰探针', async () => {
    const ctx = ctxOf('p-sc', { bundle: BUNDLE })
    await ctx.tangu!.startChat!({ prompt: 'x' })
    const alive = lastArg().alive!
    expect(alive()).toBe(true)
    usePluginStore.getState().disable('p-sc')
    expect(alive()).toBe(false)
    const n = startChat.mock.calls.length
    expect(await ctx.tangu!.startChat!({ prompt: 'x' })).toEqual({ ok: false, error: 'plugin disabled' })
    expect(startChat.mock.calls.length).toBe(n)
  })
})

describe('ctx.tangu.agentStatus / subscribeAgentStatus', () => {
  it('探针缺这两条(旧台架)→ agentStatus 恒 idle;subscribe 返回可调用的退订', () => {
    const ctx = ctxOf('p-st')
    expect(ctx.tangu!.agentStatus!()).toEqual(idleAgentStatus(null))
    expect(ctx.tangu!.agentStatus!('s1')).toEqual(idleAgentStatus('s1'))
    expect(() => ctx.tangu!.subscribeAgentStatus!(() => {})()).not.toThrow()
  })

  it('透传到探针(调用时才读,台架事后换探针也跟得上);禁用时宿主统一退订', () => {
    const ctx = ctxOf('p-st')
    const unsub = vi.fn()
    const sub = vi.fn(() => unsub)
    const status = { ...idleAgentStatus('s1'), phase: 'speaking' as const }
    setTanguProbe(baseProbe({ agentStatus: () => status, subscribeAgentStatus: sub }))
    expect(ctx.tangu!.agentStatus!('s1')).toBe(status)
    const cb = () => {}
    ctx.tangu!.subscribeAgentStatus!(cb, 's1')
    expect(sub).toHaveBeenCalledWith(cb, 's1')
    usePluginStore.getState().disable('p-st')
    expect(unsub).toHaveBeenCalledTimes(1)
    ctx.tangu!.subscribeAgentStatus!(cb) // 吊销后的 ctx 不再订阅
    expect(sub).toHaveBeenCalledTimes(1)
  })
})

describe('ctx.tangu.agents(Agent 名册,2026-09-20)', () => {
  it('探针缺这条(旧宿主 / 台架假探针)→ 空数组,不抛(插件退回「只认当前会话的 Agent」)', () => {
    expect(ctxOf('p-ag').tangu!.agents!()).toEqual([])
  })

  it('调用时才读探针(台架事后换探针也跟得上)', () => {
    const ctx = ctxOf('p-ag')
    setTanguProbe(baseProbe({ agents: () => [{ slug: 'xyra', name: 'Xyra' }] }))
    expect(ctx.tangu!.agents!()).toEqual([{ slug: 'xyra', name: 'Xyra' }])
  })
})

describe('ctx.app.writeBytes / readBytes', () => {
  it('桥没有 saveVaultBytes / readVaultBytes → 方法整个不存在', () => {
    bridge.current = {}
    const ctx = ctxOf('p-bytes')
    expect(ctx.app.writeBytes).toBeUndefined()
    expect(ctx.app.readBytes).toBeUndefined()
  })

  it('字节按视图透传(ArrayBuffer / Uint8Array 子视图 / Float32Array);非字节 → reject;禁用后 no-op', async () => {
    const saveVaultBytes = vi.fn(async (_p: string, _b: Uint8Array) => {})
    bridge.current = { saveVaultBytes }
    const ctx = ctxOf('p-bytes')
    await ctx.app.writeBytes!('Live3D/a.vrm', new Uint8Array([1, 2, 3]).buffer)
    expect(saveVaultBytes.mock.calls[0][0]).toBe('Live3D/a.vrm')
    expect(saveVaultBytes.mock.calls[0][1]).toBeInstanceOf(Uint8Array)
    expect([...saveVaultBytes.mock.calls[0][1]]).toEqual([1, 2, 3])
    const big = new Uint8Array([9, 8, 7, 6, 5])
    await ctx.app.writeBytes!('b.bin', big.subarray(1, 3))
    expect([...saveVaultBytes.mock.calls[1][1]]).toEqual([8, 7])
    expect(saveVaultBytes.mock.calls[1][1].buffer.byteLength).toBe(2) // 子视图只拷自己那段,不把整块 buffer 送过 IPC
    await ctx.app.writeBytes!('c.bin', new Float32Array([1.5]) as unknown as Uint8Array)
    expect(saveVaultBytes.mock.calls[2][1].byteLength).toBe(4) // 4 字节原样,不是被截断成 1 个元素
    await expect(ctx.app.writeBytes!('d.bin', 'nope' as unknown as Uint8Array)).rejects.toThrow(TypeError)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    usePluginStore.getState().disable('p-bytes')
    await ctx.app.writeBytes!('e.bin', new Uint8Array([1]))
    expect(saveVaultBytes).toHaveBeenCalledTimes(3)
  })

  it('readBytes:透传;桥抛(不存在 / 越界 / 没有库)→ null,不抛', async () => {
    const readVaultBytes = vi.fn(async (p: string) => {
      if (p === 'ok.bin') return new Uint8Array([4, 2])
      throw new Error('No vault is open')
    })
    bridge.current = { readVaultBytes }
    const ctx = ctxOf('p-bytes')
    expect([...(await ctx.app.readBytes!('ok.bin'))!]).toEqual([4, 2])
    expect(await ctx.app.readBytes!('missing.bin')).toBeNull()
  })
})
