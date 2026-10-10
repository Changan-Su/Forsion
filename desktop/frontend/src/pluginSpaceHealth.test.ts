/** 「开着的插件,它带的 Space 为什么没出现」:界面上的那句话,和给 agent 的那一行(引擎截在 200 字符)。
 *  夹具照 2026-10-10 那份用户插件:在跑、没报错、一个视图都没注册,随包 Space 因缺它自己的视图被跳过。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { useCommandStore } from '@lcl/engine/commandRegistry'
import { addCommand } from '@lcl/engine'
import { buildCommandCatalog, runAgentCommand } from './agentCommands'
import { translateFor } from './i18n'
import {
  hiddenSpaceName, hiddenSpaceReason, pluginProblemsForAgent, pluginStatusForAgent, setHiddenPluginSpaces, useHiddenPluginSpaces,
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
    expect(hiddenSpaceReason(t('zh'), 'forsion-cad', { ...MESH, views: ['plugin:other:x', 'qbird-home'] })).toBe('它需要的视图 plugin:other:x、qbird-home 这台设备上没有（来自别的插件，或更新版本的 Forsion）。')
    expect(hiddenSpaceReason(t('en'), 'forsion-cad', { ...MESH, code: 'min-app-version', need: '2.14.0', have: '2.13.1' })).toBe('Needs Forsion 2.14.0 or later (this is 2.13.1).')
    expect(hiddenSpaceReason(t('en'), 'forsion-cad', { slug: 's', code: 'invalid', detail: 'layout.main 至少要有一个视图' })).toBe('Its space.json did not pass validation.')
  })
  it('称呼跟随语言,解析不出名字时退到 id / 目录名', () => {
    expect(hiddenSpaceName(MESH, 'zh')).toBe('网格工作台')
    expect(hiddenSpaceName(MESH, 'en')).toBe('Mesh workbench')
    expect(hiddenSpaceName({ slug: 'dir', code: 'invalid', detail: '' }, 'en')).toBe('dir')
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
    expect(pluginStatusForAgent('nope')).toContain('no plugin "nope" in this window; ids: forsion-cad, ok')
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
      invoke: { description: 'x', params: { type: 'object', properties: { id: { type: 'string' } } }, run: (a) => (typeof a.id === 'string' && a.id ? pluginStatusForAgent(a.id) : pluginProblemsForAgent() || 'no plugin problems recorded by this window'), state: pluginProblemsForAgent },
    })
    expect(buildCommandCatalog().find((c) => c.id === 'plugin-status')?.state).toBe('1 plugin(s) with problems: forsion-cad (1 Space hidden)')
    expect(await runAgentCommand('plugin-status', { id: 'forsion-cad' })).toEqual({ ok: true, state: pluginStatusForAgent('forsion-cad') })
    setHiddenPluginSpaces({})
    expect(buildCommandCatalog().find((c) => c.id === 'plugin-status')?.state).toBeUndefined()
    expect(await runAgentCommand('plugin-status', {})).toEqual({ ok: true, state: 'no plugin problems recorded by this window' })
  })
})
