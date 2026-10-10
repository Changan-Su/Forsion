/** 「开着的插件,它带的 Space 为什么没出现」:界面上的那句话,和给 agent 的那一行(引擎截在 200 字符)。
 *  夹具照 2026-10-10 那份用户插件:在跑、没报错、一个视图都没注册,随包 Space 因缺它自己的视图被跳过。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { useCommandStore } from '@lcl/engine/commandRegistry'
import { addCommand } from '@lcl/engine'
import { buildCommandCatalog, runAgentCommand } from './agentCommands'
import { translateFor } from './i18n'
import {
  hiddenSpaceName, hiddenSpaceReason, pluginProblemsForAgent, pluginReportForAgent, pluginStatusForAgent, setHiddenPluginSpaces, useHiddenPluginSpaces,
  type HiddenSpace,
} from './pluginSpaceHealth'

const plugin = (id: string, patch: Partial<AmadeusPlugin> = {}): AmadeusPlugin => ({ id, name: id, version: '1.5.0', ...patch } as AmadeusPlugin)
const MESH: HiddenSpace = {
  slug: 'forsioncfd-mesh', id: 'forsioncfd-mesh', name: { zh: '网格工作台', en: 'Mesh workbench' }, code: 'missing-views',
  views: ['plugin:forsion-cad:mesh-workbench'], detail: '引用了未注册的视图: plugin:forsion-cad:mesh-workbench',
}
const t = (locale: 'zh' | 'en') => (key: string, vars?: Record<string, string | number>) => translateFor(locale, key, vars)

beforeEach(() => {
  usePluginStore.setState({ plugins: [plugin('forsion-cad'), plugin('ok', { version: '2.0.0' })], activeIds: ['forsion-cad', 'ok'], disabledIds: [], lastSetupError: {}, views: [{ pluginId: 'ok', item: { id: 'desk', title: 'Desk' } }] } as never)
  setHiddenPluginSpaces({ 'forsion-cad': [MESH] })
})

describe('界面上的原因', () => {
  it('缺的是插件自己的视图 → 说明是插件自己的代码没注册(只报短 id);两种语言都有', () => {
    expect(hiddenSpaceReason(t('zh'), 'forsion-cad', MESH)).toBe('它需要的视图 mesh-workbench 没有注册。插件加载时没有报错，但它的代码没有注册这个视图，问题多半在插件自己的 main.js 里。')
    const en = hiddenSpaceReason(t('en'), 'forsion-cad', MESH)
    expect(en).toContain('(mesh-workbench) was never registered')
    expect(en).not.toMatch(/[一-鿿]/)
  })
  it('缺的是别人的视图 / 应用版本不够 / 配方写坏 → 各说各的,原始校验串不上正文', () => {
    // 只知道「没注册」,不知道它本该从哪来(也可能是配方里写错了字):不替它断言来源
    expect(hiddenSpaceReason(t('zh'), 'forsion-cad', { ...MESH, views: ['plugin:other:x', 'qbird-home'] })).toBe('它需要的视图 plugin:other:x、qbird-home 在这台设备上没有注册。可能是提供它的插件没装或没开、需要更新版本的 Forsion，或者 space.json 里的类型写错了。')
    expect(hiddenSpaceReason(t('en'), 'forsion-cad', { ...MESH, code: 'min-app-version', need: '2.14.0', have: '2.13.1' })).toBe('Needs Forsion 2.14.0 or later (this is 2.13.1).')
    expect(hiddenSpaceReason(t('en'), 'forsion-cad', { slug: 's', code: 'invalid', detail: 'layout.main 至少要有一个视图' })).toBe('Its space.json did not pass validation.')
  })
  it('称呼跟随语言,解析不出名字时退到 id / 目录名', () => {
    expect(hiddenSpaceName(MESH, 'zh')).toBe('网格工作台')
    expect(hiddenSpaceName(MESH, 'en')).toBe('Mesh workbench')
    expect(hiddenSpaceName({ slug: 'dir', code: 'invalid', detail: '' }, 'en')).toBe('dir')
    // 配方校验放得过 { zh: '…', en: {} }:英文界面下不许把那个对象交出去渲染
    expect(hiddenSpaceName({ ...MESH, name: { zh: '网格', en: {} as never } }, 'en')).toBe('网格')
    expect(hiddenSpaceName({ ...MESH, name: { en: 7 as never } }, 'zh')).toBe('forsioncfd-mesh')
  })
  it('内容没变不换引用', () => {
    const before = useHiddenPluginSpaces.getState().byPlugin
    setHiddenPluginSpaces({ 'forsion-cad': [{ ...MESH }] })
    expect(useHiddenPluginSpaces.getState().byPlugin).toBe(before)
  })
})

describe('给 agent 的那一行', () => {
  it('在跑、没报错、零视图、Space 缺它自己的视图 —— 一行说全,且不超引擎的 200 字符', () => {
    const line = pluginStatusForAgent('forsion-cad')
    expect(line).toBe('forsion-cad 1.5.0: running, no load error; hidden Space forsioncfd-mesh: needs view mesh-workbench, which this plugin did not register; views registered: none')
    expect(line.length).toBeLessThanOrEqual(200)
    expect(pluginStatusForAgent('ok')).toBe('ok 2.0.0: running, no load error; views registered: desk')
  })
  it('没在跑的各说原因;没在跑时不报「Space 没出现」(那是结果不是原因)', () => {
    usePluginStore.setState({ activeIds: ['ok'], lastSetupError: { 'forsion-cad': `TypeError: ctx.nope is not a function ${'x'.repeat(400)}` } })
    const failed = pluginStatusForAgent('forsion-cad')
    expect(failed).toContain('failed to load: TypeError: ctx.nope is not a function')
    expect(failed).not.toContain('hidden Space')
    expect(failed.length).toBeLessThanOrEqual(200)
    usePluginStore.setState({ disabledIds: ['forsion-cad'], lastSetupError: {} })
    expect(pluginStatusForAgent('forsion-cad')).toContain('turned off by the user')
    usePluginStore.setState({ disabledIds: [], plugins: [plugin('forsion-cad', { blocked: 'minApp' }), plugin('ok')] })
    expect(pluginStatusForAgent('forsion-cad')).toContain('blocked by the host (minApp)')
    expect(pluginStatusForAgent('nope')).toBe('no plugin "nope" in this window (ask by the id in manifest.json); ids: forsion-cad, ok')
  })
  it('拿安装目录名 / 展示名来问也对得上(目录名常常不是 manifest id);回执以真 id 开头', () => {
    usePluginStore.setState({ plugins: [plugin('forsion-cad', { name: 'ForsionCFD' }), plugin('ok')] })
    expect(pluginStatusForAgent('forsioncfd')).toMatch(/^forsion-cad 1\.5\.0: running/)
    expect(pluginStatusForAgent('Forsion_CAD')).toMatch(/^forsion-cad 1\.5\.0: running/)
    expect(pluginStatusForAgent('---')).toContain('no plugin "---"')
  })
  it('不带 id:只有一个出问题就直接给它的详情(带错误原文),多个给一览,都正常说没有', () => {
    usePluginStore.setState({ activeIds: ['ok'], lastSetupError: { 'forsion-cad': 'TypeError: ctx.workspace.openSplit is not a function' } })
    expect(pluginReportForAgent('')).toBe('forsion-cad 1.5.0: failed to load: TypeError: ctx.workspace.openSplit is not a function; views registered: none')
    usePluginStore.setState({ activeIds: [], lastSetupError: { 'forsion-cad': 'boom', ok: 'bang' } })
    expect(pluginReportForAgent('')).toBe('2 plugin(s) with problems: forsion-cad (failed to load), ok (failed to load)')
    usePluginStore.setState({ activeIds: ['forsion-cad', 'ok'], lastSetupError: {} })
    setHiddenPluginSpaces({})
    expect(pluginReportForAgent('')).toBe('no plugin problems recorded by this window')
    expect(pluginReportForAgent('ok')).toBe(pluginStatusForAgent('ok'))
  })
  it('插件热重载后把视图注册上了、配方还没重扫:那条记录不再算数(不会一边列着视图一边说它没注册)', () => {
    usePluginStore.setState({ views: [{ pluginId: 'forsion-cad', item: { id: 'mesh-workbench', title: 'Mesh' } }] } as never)
    expect(pluginStatusForAgent('forsion-cad')).toBe('forsion-cad 1.5.0: running, no load error; views registered: mesh-workbench')
    expect(pluginProblemsForAgent()).toBe('')
    // 还缺别人的视图的那条照旧算
    setHiddenPluginSpaces({ 'forsion-cad': [{ ...MESH, views: ['plugin:forsion-cad:mesh-workbench', 'plugin:other:x'] }] })
    expect(pluginStatusForAgent('forsion-cad')).toContain('hidden Space forsioncfd-mesh')
  })
  it('一览只点名有问题的;用户自己关掉的不算;都正常时是空串(目录里就不带 state)', () => {
    expect(pluginProblemsForAgent()).toBe('1 plugin(s) with problems: forsion-cad (1 Space hidden)')
    usePluginStore.setState({ activeIds: [], disabledIds: ['ok'], lastSetupError: { 'forsion-cad': 'boom' } })
    expect(pluginProblemsForAgent()).toBe('1 plugin(s) with problems: forsion-cad (failed to load)')
    usePluginStore.setState({ activeIds: ['forsion-cad'], lastSetupError: {} })
    setHiddenPluginSpaces({})
    expect(pluginProblemsForAgent()).toBe('')
  })
  it('经命令面走一遍:目录里带一览,run_ui_command 的回执就是那一行', async () => {
    useCommandStore.setState({ commands: [] })
    addCommand({
      id: 'plugin-status', title: 'Plugin status', run: () => {},
      invoke: { description: 'x', params: { type: 'object', properties: { id: { type: 'string' } } }, run: (a) => pluginReportForAgent(typeof a.id === 'string' ? a.id : ''), state: pluginProblemsForAgent },
    })
    expect(buildCommandCatalog().find((c) => c.id === 'plugin-status')?.state).toBe('1 plugin(s) with problems: forsion-cad (1 Space hidden)')
    expect(await runAgentCommand('plugin-status', { id: 'forsion-cad' })).toEqual({ ok: true, state: pluginStatusForAgent('forsion-cad') })
    setHiddenPluginSpaces({})
    expect(buildCommandCatalog().find((c) => c.id === 'plugin-status')?.state).toBeUndefined()
    expect(await runAgentCommand('plugin-status', {})).toEqual({ ok: true, state: 'no plugin problems recorded by this window' })
  })
})

describe('以主窗的记录为准', () => {
  // 设置浮窗有自己的插件宿主,能注册的视图可以和主窗不同;徽标挂在设置窗里,却要说主窗功能条上的事。
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  it('主窗写进 localStorage;别的窗口读它、跟着 storage 事件更新,自己算出来的那份不作数', async () => {
    const store = new Map<string, string>()
    const listeners: Array<(e: { key: string | null }) => void> = []
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
    vi.resetModules()
    const main = await import('./pluginSpaceHealth')
    main.setHiddenPluginSpaces({ 'forsion-cad': [MESH] })
    expect(JSON.parse(store.get('forsion_plugin_space_health')!)['forsion-cad'][0].slug).toBe('forsioncfd-mesh')

    vi.resetModules()
    const other = await import('./pluginSpaceHealth')
    // window 只在调用那一刻才有:先 import 再 stub,免得别的模块在装载时把这里当成浏览器
    vi.stubGlobal('window', { addEventListener: (_: string, fn: (e: { key: string | null }) => void) => { listeners.push(fn) } })
    other.followMainWindowSpaceHealth()
    expect(other.useHiddenPluginSpaces.getState().byPlugin['forsion-cad']).toHaveLength(1)
    other.setHiddenPluginSpaces({ 'good-probe': [MESH] }) // 本窗自己那遍配方装载的结果:不采信、也不许盖掉主窗写的
    expect(Object.keys(other.useHiddenPluginSpaces.getState().byPlugin)).toEqual(['forsion-cad'])
    expect(JSON.parse(store.get('forsion_plugin_space_health')!)['good-probe']).toBeUndefined()
    store.set('forsion_plugin_space_health', '{"x":"not a list","forsion-cad":[]}')
    listeners.forEach((fn) => fn({ key: 'forsion_plugin_space_health' }))
    expect(other.useHiddenPluginSpaces.getState().byPlugin).toEqual({ 'forsion-cad': [] })
  })
})
