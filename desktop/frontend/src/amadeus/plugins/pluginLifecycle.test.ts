// @vitest-environment happy-dom
/**
 * 插件宿主的时间维 + 空间维(2026-10-02,对标 Cordis)。钉:
 *  ① 副作用账:后进先出撤、一条坏了不连累别的、关账后再登记当场撤;
 *  ② setup 同步抛错 / async setup reject → 抛错前登记的主题 <style>、订阅全撤,切片清空,记下错因;
 *  ③ 前置依赖:没齐装着但开不了(偏好不动);前置装上 / 打开 → 自动激活;前置停用 → 依赖方**先**停,前置回来自动恢复;
 *  ④ 差量重载:代码没变的插件不拆不装;只换掉变了的那个,它的依赖方跟着重起(攥着的是前置旧那一代);
 *  ⑤ 前置离场的每条路(停用 / 消失 / 换代 / 异步失败)都是依赖方先停:它收尾时还能经前置的 ctx 落盘。
 * 负对照(实跑过):reconcile 的停止那一轮改成正序 → ③ 的「先停依赖方」红;applySources 去掉 sameRuntime 快路 → ④ 红;
 * effectScope.close 里去掉 try/catch → ① 第二条红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[] }))
vi.mock('../api', () => ({
  amadeus: { listPlugins: async () => env.sources, listPages: async () => [], listFiles: async () => [] },
}))
const { usePluginStore, pluginFootprint, unmetPluginDeps } = await import('./pluginStore')
const { createEffectScope } = await import('./effectScope')

type Log = string[]
const g = globalThis as unknown as { __log: Log }
const src = (id: string, code: string, over: Partial<ExternalPluginSource> = {}): ExternalPluginSource => ({
  name: id, version: '1.0.0', apiVersion: 1, code, ...over, id,
})
/** 插件体:setup 记一笔,disposer 再记一笔 —— 顺序就是证据。 */
const LOGGED = (id: string, extra = ''): string =>
  `globalThis.__log.push('up:${id}');${extra} return () => globalThis.__log.push('down:${id}')`
const st = () => usePluginStore.getState()

beforeEach(() => {
  localStorage.clear()
  document.head.innerHTML = ''
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false, themes: [], commands: [] })
  env.sources = []
  g.__log = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('副作用账', () => {
  it('后进先出撤;关账后再登记的当场撤并拿到空操作', () => {
    const log: string[] = []
    const scope = createEffectScope('p')
    scope.own('a', () => log.push('a'))
    const h = scope.own('b', () => log.push('b'))
    scope.own('c', () => log.push('c'))
    h() // 提前撤掉一条:关账时不再撤第二遍
    scope.close()
    expect(log).toEqual(['b', 'c', 'a'])
    scope.own('late', () => log.push('late'))()
    expect(log).toEqual(['b', 'c', 'a', 'late'])
  })

  it('一条撤销抛错不连累其余', () => {
    const log: string[] = []
    const scope = createEffectScope('p')
    scope.own('ok1', () => log.push('ok1'))
    scope.own('bad', () => { throw new Error('boom') })
    scope.own('ok2', () => log.push('ok2'))
    scope.close()
    expect(log).toEqual(['ok2', 'ok1'])
  })
})

describe('setup 失败回滚', () => {
  const PARTIAL = `ctx.registerTheme({ id: 't1', label: 't', swatch: '#000', css: '.x{}' });
    ctx.registerCommand({ id: 'c', title: 'c', run() {} });
    ctx.subscribeLocale(() => globalThis.__log.push('locale-cb'));`

  it('同步抛错:主题 <style>、命令、订阅全撤,记下错因', async () => {
    env.sources = [src('bad', `${PARTIAL} throw new Error('nope')`)]
    await st().loadExternal()
    expect(st().activeIds).not.toContain('bad')
    expect(document.getElementById('amadeus-plugin-theme-t1')).toBeNull()
    expect(st().commands.filter((c) => c.pluginId === 'bad')).toEqual([])
    expect(pluginFootprint('bad')).toEqual({ registrations: 0, effects: [] })
    expect(st().lastSetupError.bad).toBe('nope')
  })

  it('async setup reject:同样回滚;依赖它的跟着停', async () => {
    env.sources = [
      src('slow', `${PARTIAL} return new Promise((_, reject) => { globalThis.__reject = reject })`),
      src('user', LOGGED('user'), { requiresPlugins: [{ id: 'slow' }] }),
    ]
    await st().loadExternal()
    expect(st().activeIds).toEqual(['slow', 'user']) // 同步那段返回即算激活
    expect(pluginFootprint('slow').effects.map((e) => e.kind)).toEqual(['theme', 'subscription'])
    ;(globalThis as unknown as { __reject: (e: Error) => void }).__reject(new Error('later'))
    await vi.waitFor(() => expect(st().lastSetupError.slow).toBe('later'))
    expect(st().activeIds).toEqual([])
    expect(document.getElementById('amadeus-plugin-theme-t1')).toBeNull()
    expect(g.__log).toEqual(['up:user', 'down:user'])
  })

  it('前置 async setup reject → 依赖方先停,收尾经前置 ctx 的调用不被拦(Codex 10-02)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.sources = [
      src('slow', `globalThis.__libSave = (x) => ctx.registerCommand({ id: 'save-' + x, title: x, run() {} });
        return new Promise((_, reject) => { globalThis.__reject = reject })`),
      src('user', `return () => globalThis.__libSave('draft')`, { requiresPlugins: [{ id: 'slow' }] }),
    ]
    await st().loadExternal()
    expect(st().activeIds).toEqual(['slow', 'user'])
    ;(globalThis as unknown as { __reject: (e: Error) => void }).__reject(new Error('later'))
    await vi.waitFor(() => expect(st().lastSetupError.slow).toBe('later'))
    expect(st().activeIds).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).not.toContain('被忽略') // 依赖方收尾时前置的 ctx 还活着
  })
})

describe('前置依赖', () => {
  it('前置没装:装着但开不了,偏好不动;前置装上自动激活', async () => {
    env.sources = [src('app', LOGGED('app'), { requiresPlugins: [{ id: 'lib' }] })]
    await st().loadExternal()
    st().enable('app')
    expect(st().activeIds).toEqual([])
    expect(unmetPluginDeps(st().plugins[0]).map((u) => u.reason)).toEqual(['missing'])
    env.sources = [...env.sources, src('lib', LOGGED('lib'))]
    await st().reloadExternal()
    expect(st().activeIds).toEqual(['lib', 'app'])
    expect(g.__log).toEqual(['up:lib', 'up:app'])
  })

  it('用户关着的插件前置没齐时 enable 不生效;关前置 → 依赖方先停,开回来自动恢复', async () => {
    env.sources = [src('lib', LOGGED('lib')), src('app', LOGGED('app'), { requiresPlugins: [{ id: 'lib', minVersion: '1.0' }] })]
    await st().loadExternal()
    st().disable('lib')
    expect(g.__log).toEqual(['up:lib', 'up:app', 'down:app', 'down:lib']) // 依赖方先停,它收尾时前置还在
    expect(st().disabledIds).toEqual(['lib']) // app 的偏好没动:它是「在等前置」,不是被关了
    st().disable('app')
    st().enable('app')
    expect(st().disabledIds).toContain('app') // 前置没齐 → 开不了
    st().enable('lib')
    expect(st().activeIds).toEqual(['lib'])
    st().enable('app')
    expect(st().activeIds).toEqual(['lib', 'app'])
  })

  it('版本不够 / 互相依赖:永远不激活', async () => {
    env.sources = [
      src('lib', LOGGED('lib'), { version: '0.9.0' }),
      src('app', LOGGED('app'), { requiresPlugins: [{ id: 'lib', minVersion: '1.0' }] }),
      src('c1', LOGGED('c1'), { requiresPlugins: [{ id: 'c2' }] }),
      src('c2', LOGGED('c2'), { requiresPlugins: [{ id: 'c1' }] }),
    ]
    await st().loadExternal()
    expect(st().activeIds).toEqual(['lib'])
  })
})

describe('差量重载', () => {
  it('没变的不拆不装;只换掉变了的那个,它的依赖方跟着重起', async () => {
    env.sources = [src('lib', LOGGED('lib')), src('app', LOGGED('app'), { requiresPlugins: [{ id: 'lib' }] }), src('solo', LOGGED('solo'))]
    await st().loadExternal()
    g.__log = []
    await st().reloadExternal()
    expect(g.__log).toEqual([])
    env.sources = [src('lib', LOGGED('lib', '/* v2 */')), env.sources[1], { ...env.sources[2], name: 'Solo renamed' }]
    await st().reloadExternal()
    expect(g.__log).toEqual(['down:app', 'down:lib', 'up:lib', 'up:app']) // solo 不动;app 先停后起
    expect(st().plugins.find((p) => p.id === 'solo')?.name).toBe('Solo renamed') // 元数据照刷
    expect(st().activeIds).toEqual(expect.arrayContaining(['lib', 'app', 'solo']))
  })

  it('来源没了 → 拆掉丢弃,依赖方随之暂停', async () => {
    env.sources = [src('lib', LOGGED('lib')), src('app', LOGGED('app'), { requiresPlugins: [{ id: 'lib' }] })]
    await st().loadExternal()
    g.__log = []
    env.sources = [env.sources[1]]
    await st().reloadOne('lib')
    expect(g.__log).toEqual(['down:app', 'down:lib']) // 依赖方先停
    expect(st().plugins.map((p) => p.id)).toEqual(['app'])
    expect(st().activeIds).toEqual([])
  })
})
