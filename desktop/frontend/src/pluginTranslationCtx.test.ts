// @vitest-environment happy-dom
/**
 * 翻译插件的三个新口子(2026-11-24,契约:仓根 docs/ToBeImproved/翻译插件设置与服务方案_2026-11-24/契约.md):
 * ctx.secrets 只在宿主桥有 pluginSecrets 时注入、码原样还原;ctx.registerTranslationEngine / ctx.translation 和
 * ctx.tangu.translate 同一道门,停用即撤销登记;use 只认自己登记的引擎;结果卡「用 Forsion 模型重试」经 run 的 signal
 * 让 ctx.tangu.translate 带上 noEngine。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource, PluginSecretsIpcResult } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({
  sources: [] as ExternalPluginSource[],
  secrets: null as null | ((op: string, pluginId: string, key?: string, value?: string) => Promise<PluginSecretsIpcResult>),
}))
vi.mock('./amadeus/api', () => ({
  amadeus: {
    listPlugins: async () => env.sources,
    listPages: async () => [],
    listFiles: async () => [],
    get pluginSecrets() { return env.secrets ?? undefined },
  },
}))
const { usePluginStore } = await import('./amadeus/plugins/pluginStore')
const { setTanguProbe } = await import('./amadeus/plugins/tanguSeam')
const engines = await import('./amadeus/plugins/translationEngines')
const { bindSelectionRun, unbindSelectionRun } = await import('./amadeus/plugins/selectionRun')

type Ctx = {
  secrets?: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; has(k: string): Promise<boolean>; keys(): Promise<string[]>; delete(k: string): Promise<void> }
  registerTranslationEngine?(def: unknown): () => void
  translation?: { current(): Promise<{ engine: { pluginId: string; id: string; name: string } | null; model: { id?: string; name: string } }>; use(id: string | null): Promise<void>; subscribe(cb: () => void): () => void }
  tangu?: { translate(req: { text: string; language: string; signal?: AbortSignal }): Promise<{ text: string }> }
}
const g = globalThis as unknown as { __ctx: Ctx }
const st = () => usePluginStore.getState()
const load = async (id = 'translation'): Promise<Ctx> => {
  env.sources = [{ id, name: id, version: '1.0.0', apiVersion: 1, code: 'globalThis.__ctx = ctx' }]
  await st().loadExternal()
  return g.__ctx
}
const completeCalls: Array<Record<string, unknown>> = []

beforeEach(() => {
  localStorage.clear()
  engines.__resetTranslationEnginesForTest()
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false, themes: [], commands: [] })
  env.sources = []
  env.secrets = null
  completeCalls.length = 0
  setTanguProbe({
    complete: async (req: unknown) => { completeCalls.push(req as Record<string, unknown>); return { text: 'T', toolCallText: false } },
    translateModelInfo: async () => ({ id: 'qwen-mt', name: 'Qwen MT Flash' }),
  } as never)
})
afterEach(() => { setTanguProbe(null); localStorage.clear() })

describe('ctx.secrets', () => {
  it('is absent without the host bridge (web / mobile)', async () => {
    expect((await load()).secrets).toBeUndefined()
  })

  it('passes the plugin id and restores the error code', async () => {
    const calls: unknown[][] = []
    env.secrets = async (...a) => {
      calls.push(a)
      if (a[0] === 'get') return { ok: false, code: 'secrets_locked', message: 'locked' }
      if (a[0] === 'has') return { ok: true, value: true }
      return { ok: true, value: null }
    }
    const ctx = await load()
    await ctx.secrets!.set('svc.deepl', '{"key":"k"}')
    expect(calls[0]).toEqual(['set', 'translation', 'svc.deepl', '{"key":"k"}'])
    expect(await ctx.secrets!.has('svc.deepl')).toBe(true)
    await expect(ctx.secrets!.get('svc.deepl')).rejects.toMatchObject({ code: 'secrets_locked', name: 'PluginSecretsError' })
  })
})

describe('translation engines', () => {
  it('registers, can be chosen through ctx.translation, and is dropped when the plugin is disabled', async () => {
    const ctx = await load()
    const off = ctx.registerTranslationEngine!({ id: 'deepl', name: 'DeepL', translate: async () => 'x' })
    expect(engines.listTranslationEngines().map((e) => e.key)).toEqual(['translation:deepl'])
    expect((await ctx.translation!.current()).engine).toBeNull()
    expect((await ctx.translation!.current()).model).toEqual({ id: 'qwen-mt', name: 'Qwen MT Flash' })
    let n = 0
    ctx.translation!.subscribe(() => { n++ })
    await ctx.translation!.use('deepl')
    expect((await ctx.translation!.current()).engine).toEqual({ pluginId: 'translation', id: 'deepl', name: 'DeepL' })
    expect(n).toBe(1)
    await expect(ctx.translation!.use('google')).rejects.toThrow(/not an engine this plugin registered/)
    await ctx.translation!.use(null)
    expect(engines.chosenEngineKey()).toBeNull()
    expect(typeof off).toBe('function')
    st().disable('translation')
    expect(engines.listTranslationEngines()).toHaveLength(0)
  })

  it('rejects malformed definitions without registering', async () => {
    const ctx = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [null, { id: 'Bad', name: 'x', translate: async () => '' }, { id: 'ok', name: 'x' }, { id: 'ok', translate: async () => '' }]) ctx.registerTranslationEngine!(bad)
    expect(engines.listTranslationEngines()).toHaveLength(0)
    warn.mockRestore()
  })

  it('another plugin cannot switch to someone else\'s engine', async () => {
    const owner = await load('translation')
    owner.registerTranslationEngine!({ id: 'deepl', name: 'DeepL', translate: async () => 'x' })
    env.sources = [
      { id: 'translation', name: 'translation', version: '1.0.0', apiVersion: 1, code: 'globalThis.__owner = ctx; ctx.registerTranslationEngine({ id: "deepl", name: "DeepL", translate: async () => "x" })' },
      { id: 'other', name: 'other', version: '1.0.0', apiVersion: 1, code: 'globalThis.__ctx = ctx' },
    ]
    await st().loadExternal()
    await expect(g.__ctx.translation!.use('deepl')).rejects.toThrow()
  })

  it('"retry with Forsion models" reaches ctx.tangu.translate as noEngine for that run only', async () => {
    const ctx = await load()
    const ac = new AbortController()
    bindSelectionRun(ac.signal, { pluginId: 'translation', noEngine: true })
    await ctx.tangu!.translate({ text: 'hi', language: 'English', signal: ac.signal })
    unbindSelectionRun(ac.signal)
    await ctx.tangu!.translate({ text: 'hi', language: 'English' })
    expect(completeCalls.map((c) => c.noEngine)).toEqual([true, undefined])
  })
})
