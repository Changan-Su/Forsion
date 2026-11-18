/**
 * 旧插件设置接口 → 宿主设置零件(方案 P4,2026-11-18)的换算:插件作者一行不改,页面一律宿主零件画。
 * 钉住每种字段落到哪种零件、存的时机(即时存 / 只改本地等失焦)、分组,以及 registerSetting / registerSettingsView 的换法。
 */
import { describe, expect, it, vi } from 'vitest'
import type { PluginField } from '../services/backendService'
import type { SettingContribution, SettingsViewContribution } from '../amadeus/plugins/types'
import type { PluginSettingsItem } from '../../../shared/settingsPage'
import {
  engineFieldsToSchema, forsionSettingsGroup, numberFitsStepper, parseNumberInput, settingsViewGroups, type EngineSchemaContext,
} from './pluginSettingsSchema'

const ctx = (over: Partial<EngineSchemaContext> = {}): EngineSchemaContext => ({
  locale: 'zh', values: {}, generalTitle: '通用', openLabel: '打开',
  save: vi.fn().mockResolvedValue(undefined), edit: vi.fn(), mountSlot: vi.fn((slot: string) => () => () => void slot), openUrl: vi.fn(),
  ...over,
})
const item = (groups: { items: PluginSettingsItem[] }[] | undefined, id: string): PluginSettingsItem =>
  groups!.flatMap((g) => g.items).find((it) => it.id === id)!

const FIELDS: PluginField[] = [
  { key: 'on', type: 'toggle', label: '开启', labelEn: 'Enabled', help: '说明', helpEn: 'Help' },
  { key: 'sec', type: 'section', label: '外观', labelEn: 'Look', help: '一组', helpEn: 'A group' },
  { key: 'mode', type: 'select', label: '模式', options: [{ value: 'a', label: '甲', labelEn: 'A' }, { value: 'b', label: '乙' }], default: 'b' },
  { key: 'small', type: 'number', label: '小数', min: 1, max: 10 },
  { key: 'port', type: 'number', label: '端口', min: 1, max: 65535, default: 8080 },
  { key: 'name', type: 'text', label: '名字', placeholder: '写点什么' },
  { key: 'key', type: 'text', label: '密钥', secret: true },
  { key: 'long', type: 'textarea', label: '长文' },
  { key: 'longSecret', type: 'textarea', label: '长密钥', secret: true },
  { key: 'pics', type: 'image-list', label: '图片', itemFields: [] },
  { key: 'tip', type: 'note', label: '注意事项', tone: 'warn' },
  { key: 'docs', type: 'link', label: '文档', url: 'https://example.com/docs' },
]

describe('引擎插件 settings.fields → 宿主零件', () => {
  it('section 之前的字段进「通用」组,section 开新组(带说明);英文取 labelEn', () => {
    const { groups } = engineFieldsToSchema(FIELDS, ctx({ locale: 'en' }))
    expect(groups!.map((g) => [g.id, g.title, g.desc])).toEqual([['general', '通用', undefined], ['section:sec', 'Look', 'A group']])
    expect(item(groups, 'on')).toMatchObject({ type: 'switch', title: 'Enabled', desc: 'Help', value: false })
    expect(item(groups, 'mode')).toMatchObject({ type: 'select', value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: '乙' }] })
  })

  it('开关 / 下拉 / 步进器即时存;输入框只改本地(失焦由页面存)', async () => {
    const c = ctx({ values: { on: true, small: 4, name: 'x' } })
    const { groups } = engineFieldsToSchema(FIELDS, c)
    const sw = item(groups, 'on') as Extract<PluginSettingsItem, { type: 'switch' }>
    expect(sw.value).toBe(true)
    await sw.onChange(false)
    expect(c.save).toHaveBeenCalledWith('on', false)
    const sel = item(groups, 'mode') as Extract<PluginSettingsItem, { type: 'select' }>
    await sel.onChange('a')
    expect(c.save).toHaveBeenCalledWith('mode', 'a')
    const st = item(groups, 'small') as Extract<PluginSettingsItem, { type: 'stepper' }>
    expect(st).toMatchObject({ type: 'stepper', value: 4, min: 1, max: 10 })
    st.onChange!(5)
    expect(c.save).toHaveBeenCalledWith('small', 5)
    const name = item(groups, 'name') as Extract<PluginSettingsItem, { type: 'input' }>
    expect(name).toMatchObject({ type: 'input', inputType: 'text', value: 'x', placeholder: '写点什么' })
    name.onChange!('y')
    expect(c.edit).toHaveBeenCalledWith('name', 'y')
    expect(c.save).toHaveBeenCalledTimes(3)
  })

  it('大范围的数用输入框:合法数字转成 number,空 = 空串,乱写不存', () => {
    const c = ctx()
    const port = item(engineFieldsToSchema(FIELDS, c).groups, 'port') as Extract<PluginSettingsItem, { type: 'input' }>
    expect(port).toMatchObject({ type: 'input', value: '8080' })
    port.onChange!('9000'); port.onChange!(''); port.onChange!('9a')
    expect((c.edit as ReturnType<typeof vi.fn>).mock.calls).toEqual([['port', 9000], ['port', '']])
    expect(numberFitsStepper(1, 10)).toBe(true)
    expect(numberFitsStepper(0, 100)).toBe(false)
    expect(numberFitsStepper(undefined, 10)).toBe(false)
    expect(parseNumberInput(' -3.5 ')).toBe(-3.5)
  })

  it('secret 是密码框(多行的 secret 也是单行密码框);多行文本、图片列表是自定义块', () => {
    const c = ctx()
    const { groups } = engineFieldsToSchema(FIELDS, c)
    expect(item(groups, 'key')).toMatchObject({ type: 'input', inputType: 'password' })
    expect(item(groups, 'longSecret')).toMatchObject({ type: 'input', inputType: 'password' })
    expect(item(groups, 'textarea:long')).toMatchObject({ type: 'custom' })
    expect(item(groups, 'images:pics')).toMatchObject({ type: 'custom' })
    expect(c.mountSlot).toHaveBeenCalledWith('textarea:long')
    expect(c.mountSlot).toHaveBeenCalledWith('images:pics')
  })

  it('note 是没有控件的说明行;link 是一颗「打开」按钮', () => {
    const c = ctx()
    const { groups } = engineFieldsToSchema(FIELDS, c)
    expect(item(groups, 'tip')).toMatchObject({ type: 'value', title: '', desc: '注意事项', value: '' })
    const link = item(groups, 'docs') as Extract<PluginSettingsItem, { type: 'button' }>
    expect(link).toMatchObject({ type: 'button', title: '文档' })
    void link.buttons[0].onClick()
    expect(link.buttons[0].label).toBe('打开')
    expect(c.openUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('坏字段跳过,不整页画不出来', () => {
    const { groups } = engineFieldsToSchema([null as never, { key: 'x', type: 'weird' } as never, { key: 'ok', type: 'toggle', label: 'OK' }], ctx())
    expect(groups!.flatMap((g) => g.items.map((it) => it.id))).toEqual(['ok'])
  })
})

describe('Forsion 插件 registerSetting → 「通用」组', () => {
  const rows: SettingContribution[] = [
    { key: 'workFolder', type: 'text', label: '工作文件夹', default: 'Plugins/x' },
    { key: 'dark', type: 'boolean', label: '暗色', default: false },
    { key: 'count', type: 'number', label: '数量', default: 3, min: 1, max: 9 },
    { key: 'ms', type: 'number', label: '毫秒', default: 500, min: 0, max: 60000 },
    { key: 'name', type: 'text', label: '名字', default: '', description: '显示名' },
  ]
  it('boolean → 开关,小范围 number → 步进器,其余 → 输入框;宿主的工作文件夹排最后', () => {
    const store: Record<string, string> = { dark: 'true', count: '5' }
    const write = vi.fn()
    const g = forsionSettingsGroup(rows, { generalTitle: 'General', read: (d) => store[d.key] ?? String(d.default), write })!
    expect(g.title).toBe('General')
    expect(g.items.map((it) => [it.id, it.type])).toEqual([['dark', 'switch'], ['count', 'stepper'], ['ms', 'input'], ['name', 'input'], ['workFolder', 'input']])
    const dark = g.items[0] as Extract<PluginSettingsItem, { type: 'switch' }>
    expect(dark.value).toBe(true)
    void dark.onChange(false)
    expect(write).toHaveBeenLastCalledWith(rows[1], 'false')
    const count = g.items[1] as Extract<PluginSettingsItem, { type: 'stepper' }>
    expect(count).toMatchObject({ value: 5, min: 1, max: 9 })
    count.onChange!(6)
    expect(write).toHaveBeenLastCalledWith(rows[2], '6')
    const name = g.items[3] as Extract<PluginSettingsItem, { type: 'input' }>
    expect(name.desc).toBe('显示名')
    name.onChange!('abc')
    expect(write).toHaveBeenLastCalledWith(rows[4], 'abc')
  })
  it('没有行就没有这一组', () => {
    expect(forsionSettingsGroup([], { generalTitle: 'G', read: () => '', write: () => {} })).toBeNull()
  })
})

describe('registerSettingsView → 每个面板一组自定义块', () => {
  it('标题按函数现求,没给标题用宿主的组名;id 取调用方给的代号', () => {
    const mount = vi.fn()
    const views: SettingsViewContribution[] = [{ id: 'a', title: () => 'Snippets', mount }, { id: 'b', mount }]
    const groups = settingsViewGroups(views, { fallbackTitle: '更多设置', idOf: (d) => `${d.id}#1`, mount: () => () => () => {} })
    expect(groups.map((g) => [g.id, g.title, g.items[0].type, g.items[0].id])).toEqual([['view:a#1', 'Snippets', 'custom', 'a#1'], ['view:b#1', '更多设置', 'custom', 'b#1']])
  })
})
