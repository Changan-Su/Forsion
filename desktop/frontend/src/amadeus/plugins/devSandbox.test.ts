// @vitest-environment happy-dom
/**
 * Forsion Sandbox 的**渲染层**那半(2026-09-21)。钉五件:
 *  ① 开发副本求值时**多一个 console 形参**(按插件记账),已安装插件那条路**一个字都不能变**
 *     —— 断言方式是让插件自己报 `typeof console.__devProxy`,不是读代码相信;
 *  ② 记账转发原样不改、有顶(200 条 / 每条 2000 字)、循环引用不抛(记日志把应用弄崩是最蠢的死法);
 *  ③ 视图挂载失败按插件记账并有顶(20 条);
 *  ④ 热重载把开发者**正开着的预览标签页开回来** —— teardown 会先关 leaf 再反注册,不恢复 = 每改一行代码
 *     预览就被关掉一次;收起侧栏里没被关掉的那些不许重复开,没重新注册的不许去撞注册表;
 *  ⑤ 重载即清账,来源没了连条目一起丢。
 * 负对照见文件末尾注释。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

// ⚠️环境必须是 happy-dom:pluginStore 的 resolveExternalSources 顶头裸读 window.__FORSION_UNIT_PAGE__,
// node 环境下那是 ReferenceError,会被 loadExternal 的 try/catch 吞成「一个插件都没有」——测试全绿却什么都没跑。
const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[], onList: null as null | (() => void) }))
vi.mock('../api', () => ({
  amadeus: {
    listPlugins: async () => { env.onList?.(); return env.sources },
    listPages: async () => [], listFiles: async () => [],
  },
}))

const { usePluginStore } = await import('./pluginStore')
const { useAchievements } = await import('../../achievements/store')
const { useDevRecords, devConsoleFor, recordDevMountError, formatDevLogArgs } = await import('./devRecords')
const { useDevPluginState, getDevPluginState, reloadDevPlugin, clearDevPluginLogs, setDevViewBridge } = await import('./devSandbox')
type DevPluginState = import('./devSandbox').DevPluginState

const probe = (): Array<{ id: string; devProxy: string }> => (globalThis as unknown as { __probe: Array<{ id: string; devProxy: string }> }).__probe

const source = (over: Partial<ExternalPluginSource> & { id: string }): ExternalPluginSource => ({
  name: over.id, version: '0.0.1', apiVersion: 1, code: '', ...over,
})
/** 插件体:自报拿到的 console 是不是开发态代理。 */
const PROBE_CODE = (id: string, extra = ''): string =>
  `globalThis.__probe.push({ id: ${JSON.stringify(id)}, devProxy: typeof console.__devProxy });${extra}`

const reset = (): void => {
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false })
  useDevRecords.setState({ byId: {} })
  ;(globalThis as unknown as { __probe: unknown[] }).__probe = []
  env.sources = []
  env.onList = null
  setDevViewBridge(null)
}
beforeEach(reset)
afterEach(() => { setDevViewBridge(null); vi.restoreAllMocks() })

describe('求值路径:开发副本有 console 代理,已安装插件没有', () => {
  it('⚠️已安装插件拿到的是全局真 console(少一个形参、少一个实参,与从前逐字相同)', async () => {
    env.sources = [
      source({ id: 'inst', code: PROBE_CODE('inst') }),
      source({ id: 'devp', code: PROBE_CODE('devp'), dev: true, devRoot: '/p/devp', devProductId: 'p_000000000001' }),
    ]
    await usePluginStore.getState().loadExternal()
    expect(probe()).toEqual([
      { id: 'inst', devProxy: 'undefined' }, // 全局 console 上没有 __devProxy
      { id: 'devp', devProxy: 'boolean' },
    ])
  })

  it('开发副本的 console 转发给真 console 且落进记账;清空只清日志', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp', "console.warn('hi', { a: 1 });") })]
    await usePluginStore.getState().loadExternal()
    expect(spy).toHaveBeenCalledWith('hi', { a: 1 }) // 原样转发,参数一个不改
    const st = getDevPluginState('devp')
    expect(st.logs.map((l) => [l.level, l.text])).toEqual([['warn', 'hi {"a":1}']])
    expect(st.logs[0].at).toBeGreaterThan(0)
    clearDevPluginLogs('devp')
    expect(getDevPluginState('devp').logs).toEqual([])
  })

  it('async setup 的 reject 记成 setupError(否则设置页与 Studio 都显示「已启用」)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    env.sources = [source({ id: 'devp', dev: true, code: 'return Promise.reject(new Error("boom"))' })]
    await usePluginStore.getState().loadExternal()
    await Promise.resolve() // 让 reject 传播
    await Promise.resolve()
    expect(getDevPluginState('devp').setupError).toBe('boom')
  })
})

describe('毁档防线:开发副本不给注册自定义文件类型', () => {
  // 主进程的扩展名保护(collectPluginExts → listPages 排除)只扫已安装目录。清单里声明 fileExtensions 会被判
  // 'dev-fileext' 拒载,但删掉那一行就能载入 —— setup 里的 registerFileType 才是真正危险的那半,必须在这里挡。
  const FT_CODE = (id: string): string =>
    `globalThis.__probe.push({ id: ${JSON.stringify(id)}, devProxy: String(ctx.registerFileType({ extensions: ['.foo.md'], displayName: 'Foo', icon: 'file', open() {} })) });`

  it('⚠️开发副本:返回 false 且切片里没有它;同样的代码装成安装版照常注册', async () => {
    env.sources = [
      source({ id: 'devft', code: FT_CODE('devft'), dev: true, devRoot: '/p/devft', devProductId: 'p_000000000002' }),
      source({ id: 'instft', code: FT_CODE('instft') }),
    ]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await usePluginStore.getState().loadExternal()
    expect(probe().find((p) => p.id === 'devft')?.devProxy).toBe('false')
    expect(probe().find((p) => p.id === 'instft')?.devProxy).not.toBe('false')
    expect(usePluginStore.getState().fileTypes.map((o) => o.pluginId)).toEqual(['instft'])
  })
})

describe('记账的顶与安全', () => {
  it('日志 200 条封顶,留最新的', () => {
    const c = devConsoleFor('devp') as Console & Record<string, (...a: unknown[]) => void>
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (let i = 0; i < 205; i++) c.log(`n${i}`)
    const logs = useDevRecords.getState().byId.devp.logs
    expect(logs).toHaveLength(200)
    expect(logs[0].text).toBe('n5')
    expect(logs[199].text).toBe('n204')
  })

  it('单条 2000 字封顶', () => {
    expect(formatDevLogArgs(['x'.repeat(5000)])).toHaveLength(2001) // 2000 + 省略号
  })

  it('⚠️循环引用 / 抛错的 toString / BigInt 都不许抛(记日志弄崩应用是最蠢的死法)', () => {
    const circular: Record<string, unknown> = { name: 'root' }
    circular.self = circular
    const hostile = { get boom(): never { throw new Error('nope') } }
    const noProto = Object.create(null) as object
    const c = devConsoleFor('devp') as Console & Record<string, (...a: unknown[]) => void>
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => c.error(circular, hostile, noProto, 10n, Symbol('s'), () => {})).not.toThrow()
    const text = useDevRecords.getState().byId.devp.logs[0].text
    expect(text).toContain('[Circular]')
    expect(useDevRecords.getState().byId.devp.logs).toHaveLength(1)
  })

  it('视图挂载错误按插件记账(含栈头)且 20 条封顶', () => {
    for (let i = 0; i < 25; i++) recordDevMountError('devp', `view-${i}`, new Error(`fail ${i}`))
    const errs = getDevPluginState('devp').mountErrors
    expect(errs).toHaveLength(20)
    expect(errs[0].viewId).toBe('view-5')
    expect(errs[19].message).toMatch(/^Error: fail 24 — at /)
  })
})

describe('对外状态', () => {
  it('loaded / active / blocked / shadowsInstalled 如实反映开发副本', async () => {
    env.sources = [
      source({ id: 'devp', dev: true, code: PROBE_CODE('devp'), shadowsInstalled: true, devProductId: 'p_000000000001' }),
      source({ id: 'blk', dev: true, code: '', blocked: 'dev-fileext', blockedReason: 'fileExtensions…' }),
      source({ id: 'inst', code: PROBE_CODE('inst') }),
    ]
    await usePluginStore.getState().loadExternal()
    expect(getDevPluginState('devp')).toMatchObject({ loaded: true, active: true, blocked: null, shadowsInstalled: true })
    expect(getDevPluginState('blk')).toMatchObject({ loaded: true, active: false, blocked: 'dev-fileext', blockedReason: 'fileExtensions…' })
    // 已安装来源不是开发副本:Studio 不该把它当成「我的项目跑起来了」
    expect(getDevPluginState('inst')).toMatchObject({ loaded: false, active: false, shadowsInstalled: false })
    expect(getDevPluginState('never-heard-of')).toMatchObject({ loaded: false, active: false, logs: [], mountErrors: [] })
  })

  it('⚠️useDevPluginState 挂在真 React 上:状态没变不重渲(zustand v5 里返回新对象 = 快照每次都变 = 无限重渲)', async () => {
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'log').mockImplementation(() => {})
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp') })]
    await usePluginStore.getState().loadExternal()

    const seen: DevPluginState[] = []
    const Probe: React.FC<{ tick: number }> = () => { seen.push(useDevPluginState('devp')); return null }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(React.createElement(Probe, { tick: 1 })))
    expect(seen[0]).toMatchObject({ loaded: true, active: true })

    // 父组件重渲(store 一个字节没变)→ 必须还是**同一个对象**:换了引用,消费方拿它做 deps 的
    // effect / memo 就每渲染一次重跑一次(Studio 面板的控制台会自己滚回顶、订阅反复拆装)。
    await act(async () => root.render(React.createElement(Probe, { tick: 2 })))
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe(seen[0])

    // 不相干的 store 变动(别的插件的错误记录)不该把这个面板重渲
    const before = seen.length
    await act(async () => { usePluginStore.setState((s) => ({ lastSetupError: { ...s.lastSetupError, other: 'x' } })) })
    expect(seen.length).toBe(before)

    // 自己的日志来了要更新
    await act(async () => { devConsoleFor('devp').log('tick') })
    expect(seen[seen.length - 1].logs.map((l) => l.text)).toEqual(['tick'])
    await act(async () => root.unmount())
    host.remove()
  })
})

describe('reloadDevPlugin', () => {
  type View = { type: string; params: Record<string, unknown>; loc: 'main' | 'left' | 'right' }
  const trace: string[] = []
  const install = (open: View[], registered: Set<string>, opened: View[], closeOnReload: (list: View[]) => View[]): void => {
    let live = open
    trace.length = 0
    env.onList = () => { live = closeOnReload(live) } // reloadOne 拉来源的那一刻 = teardown 关 leaf 的那一刻
    setDevViewBridge({
      snapshot: (prefix) => live.filter((v) => v.type.startsWith(prefix)),
      isRegistered: (type) => registered.has(type),
      open: (type, params, loc) => { opened.push({ type, params, loc }); trace.push(`open:${type}`) },
      captureFocus: () => { trace.push('capture'); return () => trace.push('restore') },
    })
  }

  it('把重载时被关掉的预览标签页原位开回来(主区 / 侧栏各归各位)', async () => {
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp') })]
    await usePluginStore.getState().loadExternal()
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp', '// v2') })]
    const opened: View[] = []
    install(
      [
        { type: 'plugin:devp:main', params: { file: 'a.md' }, loc: 'main' },
        { type: 'plugin:devp:side', params: {}, loc: 'right' },
        { type: 'plugin:other:x', params: {}, loc: 'main' }, // 别家的插件视图:不归我管
      ],
      new Set(['plugin:devp:main', 'plugin:devp:side', 'plugin:other:x']),
      opened,
      (list) => list.filter((v) => !v.type.startsWith('plugin:devp:')), // teardown 关掉自己的
    )
    await reloadDevPlugin('devp')
    expect(opened).toEqual([
      { type: 'plugin:devp:main', params: { file: 'a.md' }, loc: 'main' },
      { type: 'plugin:devp:side', params: {}, loc: 'right' },
    ])
    // 焦点:重载**之前**记、全部重开**之后**放回去(重开的 leaf 会自动前置 → 不还就等于每次热重载
    // 都把开发者从 Studio 抢到预览上)
    expect(trace).toEqual(['capture', 'open:plugin:devp:main', 'open:plugin:devp:side', 'restore'])
  })

  it('⚠️没被关掉的(收起侧栏 stash 里的)不许再开一遍;新版本不再提供的视图不去撞注册表', async () => {
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp') })]
    await usePluginStore.getState().loadExternal()
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp', '// v2') })]
    const opened: View[] = []
    install(
      [
        { type: 'plugin:devp:stashed', params: {}, loc: 'left' },
        { type: 'plugin:devp:gone', params: {}, loc: 'main' },
      ],
      new Set(['plugin:devp:stashed']), // gone 这次没注册回来
      opened,
      (list) => list.filter((v) => v.type !== 'plugin:devp:gone'), // stashed 活着
    )
    await reloadDevPlugin('devp')
    expect(opened).toEqual([])
  })

  it('没听说过的 id / 从没加载过的 id 都不抛(第一次打开开关走的就是这条)', async () => {
    const opened: View[] = []
    install([], new Set(), opened, (l) => l)
    await expect(reloadDevPlugin('never-loaded')).resolves.toBeUndefined()
    env.sources = [source({ id: 'fresh', dev: true, code: PROBE_CODE('fresh') })]
    await reloadDevPlugin('fresh') // 第一次加载
    expect(probe().map((p) => p.id)).toEqual(['fresh'])
    expect(getDevPluginState('fresh').loaded).toBe(true)
  })

  it('⚠️开发副本与安装版代码一字不差时,dev 标志照样要换过来(只比代码 = 开关按了等于没按)', async () => {
    const code = PROBE_CODE('same')
    env.sources = [source({ id: 'same', code })]
    await usePluginStore.getState().loadExternal()
    expect(getDevPluginState('same').loaded).toBe(false)
    env.sources = [source({ id: 'same', code, dev: true, devRoot: '/p/same', devProductId: 'p_000000000002' })]
    await reloadDevPlugin('same')
    expect(getDevPluginState('same')).toMatchObject({ loaded: true, active: true })
    // 撤下开发副本:安装版原样回来,dev 标志必须落回 false(否则卸载守卫永远拒)
    env.sources = [source({ id: 'same', code })]
    await reloadDevPlugin('same')
    expect(getDevPluginState('same').loaded).toBe(false)
  })

  it('重载即清账;来源整个没了连条目一起丢', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp', "console.log('first run');") })]
    await usePluginStore.getState().loadExternal()
    recordDevMountError('devp', 'v1', new Error('mount failed'))
    expect(getDevPluginState('devp').logs).toHaveLength(1)
    env.sources = [source({ id: 'devp', dev: true, code: PROBE_CODE('devp', '// v2') })]
    await reloadDevPlugin('devp')
    expect(getDevPluginState('devp').logs).toEqual([])
    expect(getDevPluginState('devp').mountErrors).toEqual([]) // 上一份代码的故障史不算到新代码头上
    env.sources = []
    await reloadDevPlugin('devp')
    expect('devp' in useDevRecords.getState().byId).toBe(false)
  })
})

describe('桌面壳接线(静态探针 —— 这几行在 tsx 里,单测的 import 链够不着)', () => {
  // happy-dom 下 import.meta.url 不是 file: 方案 → 从 vitest 的 cwd(= desktop 包根)取,并先断言文件在:
  // 路径写错了就该红,不能悄悄变成「读了个空串,两条断言都过不了也发现不了」。
  const SHELL = resolve(process.cwd(), 'frontend/src/pluginViews.tsx')
  const SANDBOX = resolve(process.cwd(), 'frontend/src/amadeus/plugins/devSandbox.ts')
  const shell = existsSync(SHELL) ? readFileSync(SHELL, 'utf8') : ''

  it('插件视图工厂把 pluginId 传下去,挂载失败才归得了属', () => {
    expect(existsSync(SHELL), SHELL).toBe(true)
    expect(shell).toMatch(/pluginId=\{type\.split\(':'\)\[1\]\}/)
    expect(shell).toMatch(/recordDevMountError\(pluginId, def\.id, e\)/)
  })

  it('⚠️主区重开必须显式 newTab(openView 的主区默认是就地导航,会把开发者的 Studio 标签页原地换成预览)', () => {
    const bridgeBlock = shell.slice(shell.indexOf('setDevViewBridge({'))
    expect(bridgeBlock).toMatch(/openView\(type, params, loc, loc === 'main' \? \{ newTab: true \}/)
  })

  it('热重载的工作台接缝由桌面壳注入(插件宿主自己不 import @lcl)', () => {
    expect(shell).toContain('setDevViewBridge({')
    expect(readFileSync(SANDBOX, 'utf8')).not.toMatch(/^\s*import[^\n]*'@lcl/m) // 注释里提它可以,import 不行
  })
})

// 负对照(已实跑,见交付说明):
//  · toPlugin 里把 dev 分支也走 new Function('ctx', code) → 「已安装 vs 开发副本」那条红(devProxy 全是 undefined);
//  · reloadOne 的跳过条件去掉 dev/devRoot 比对 → 「代码一字不差」那条红;
//  · reloadDevPlugin 去掉重载后的第二次快照 → 「stash 不许重复开」那条红;
//  · toPlugin 里去掉 clearDevRecords / reloadOne 里去掉 dropDevRecords → 「重载即清账」那条红;
//  · devRecords 的 push 去掉封顶 → 200/20 两条红。

describe('撤权优先:重载不许「装作成功」(Codex 评审)', () => {
  const DEV = (id: string, code: string): ExternalPluginSource => source({ id, code, dev: true, devRoot: `/p/${id}`, devProductId: 'p_00000000000a' })

  it('⚠️来源列表读不出来:开发副本当场拆掉,并把错误抛给调用方(绝不出现「授权已撤、实例还在、界面报成功」)', async () => {
    env.sources = [DEV('devx', PROBE_CODE('devx'))]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().activeIds).toContain('devx')
    env.onList = () => { throw new Error('ipc down') }
    await expect(reloadDevPlugin('devx')).rejects.toThrow(/ipc down/)
    expect(usePluginStore.getState().activeIds).not.toContain('devx')
    expect(usePluginStore.getState().plugins.some((p) => p.id === 'devx')).toBe(false)
  })

  it('显式重载是 force:源码一字没变也真拆真装(setup 因瞬时原因抛过错要能重试;只改 manifest 时旧实例也得换)', async () => {
    env.sources = [DEV('devf', PROBE_CODE('devf'))]
    await usePluginStore.getState().loadExternal()
    expect(probe().filter((p) => p.id === 'devf')).toHaveLength(1)
    await reloadDevPlugin('devf')
    expect(probe().filter((p) => p.id === 'devf')).toHaveLength(2)
  })

  it('同一个项目改了 manifest.id:旧 id 名下那份实例一并拆掉,新旧不并存', async () => {
    env.sources = [DEV('old-id', PROBE_CODE('old-id'))]
    await usePluginStore.getState().loadExternal()
    env.sources = [DEV('new-id', PROBE_CODE('new-id'))]
    await reloadDevPlugin('new-id')
    expect(usePluginStore.getState().activeIds).toContain('new-id')
    expect(usePluginStore.getState().plugins.some((p) => p.id === 'old-id')).toBe(false)
  })
})

describe('async setup 的代次', () => {
  it('⚠️上一版迟到的 reject 不许把已经装好的新一版标成失败;迟到交回的 disposer 当场收掉', async () => {
    const g = globalThis as unknown as { __late: { reject?: (e: Error) => void; resolve?: (d: () => void) => void; disposed: number } }
    g.__late = { disposed: 0 }
    const V1 = 'return new Promise((resolve, reject) => { globalThis.__late.reject = reject })'
    const V1b = 'return new Promise((resolve) => { globalThis.__late.resolve = resolve })'
    const mk = (code: string): ExternalPluginSource => source({ id: 'gen', code, dev: true, devRoot: '/p/gen', devProductId: 'p_00000000000b' })
    env.sources = [mk(V1)]
    await usePluginStore.getState().loadExternal()
    env.sources = [mk(V1b)] // 第 2 版装好
    await reloadDevPlugin('gen')
    g.__late.reject?.(new Error('v1 exploded late'))
    await Promise.resolve(); await Promise.resolve()
    expect(getDevPluginState('gen').setupError).toBeNull()
    env.sources = [mk('return () => {}')] // 第 3 版装好之后,第 2 版才交回它的 disposer
    await reloadDevPlugin('gen')
    g.__late.resolve?.(() => { g.__late.disposed++ })
    await Promise.resolve(); await Promise.resolve()
    expect(g.__late.disposed).toBe(1)
  })

  it('⚠️过期的续体醒来再 register* 一律作废:重载后不出现两份命令,卸载后不留幽灵', async () => {
    const g = globalThis as unknown as { __wake: Array<() => void> }
    g.__wake = []
    // 常见写法:await 之后才登记。解构 ctx 是为了钉住「闸装在成员上,不是装在 ctx 外面的一层壳上」。
    const CODE = (title: string): string => `const { registerCommand, registerStatusItem } = ctx
      return new Promise((resolve) => { globalThis.__wake.push(() => {
        registerCommand({ id: 'late', title: ${JSON.stringify(title)}, run() {} })
        registerStatusItem({ id: 's', text: 'x' }).update({ text: 'y' }) // 作废之后交回来的 handle 也不许抛
        ctx.achievements.registerSeries({ id: 'late', title: 'late', achievements: [{ id: 'a', title: 'a', desc: '', event: 'e', goal: 1, points: 1 }] })
        resolve(undefined)
      }) })`
    const mk = (title: string): ExternalPluginSource => source({ id: 'ghost', code: CODE(title), dev: true, devRoot: '/p/ghost', devProductId: 'p_00000000000c' })
    const mine = (): string[] => usePluginStore.getState().commands.filter((c) => c.pluginId === 'ghost').map((c) => String(c.item.title))
    env.sources = [mk('v1')]
    await usePluginStore.getState().loadExternal()
    env.sources = [mk('v2')]
    await reloadDevPlugin('ghost')
    g.__wake[1]!() // 第 2 版(现役)正常登记
    g.__wake[0]!() // 第 1 版迟到
    expect(mine()).toEqual(['v2'])
    env.sources = [] // 卸载:来源没了
    await reloadDevPlugin('ghost')
    g.__wake[0]!(); g.__wake[1]!()
    expect(mine()).toEqual([])
    expect(usePluginStore.getState().statusItems.filter((o) => o.pluginId === 'ghost')).toEqual([])
    expect(useAchievements.getState().pluginSeries.filter((x) => x.pluginId === 'ghost')).toEqual([]) // 嵌在 ctx.achievements 里的那条登记同一道闸
  })
})
