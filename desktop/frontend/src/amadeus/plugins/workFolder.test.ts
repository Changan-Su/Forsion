// 插件工作文件夹的缺省值(2026-10-14 用户定):所有插件的产物收进库里的 `Plugins/` 一个文件夹,库根只多这一项。
import { beforeEach, expect, it, vi } from 'vitest'
import { usePluginStore } from './pluginStore'
import type { AmadeusPlugin } from './types'
import { usePageStore } from '../store/pageStore'

const mem = new Map<string, string>()
const fakeLocalStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
}

beforeEach(() => {
  mem.clear()
  usePageStore.setState({ vaultRoot: null, folders: [] })
  vi.stubGlobal('localStorage', fakeLocalStorage)
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
})

it('缺省按英文 ID 命名;显示名称不影响目录;用户指定目录优先', () => {
  let folder = (): string => ''
  const plugin: AmadeusPlugin = { id: 'readflow', name: '稍后/读', version: '0', setup: (ctx) => { folder = () => ctx.app.workFolder() } }
  usePluginStore.getState().init([plugin])
  expect(folder()).toBe('Plugins/readflow')
  const row = usePluginStore.getState().settings.find((s) => s.pluginId === 'readflow' && s.item.key === 'workFolder')
  expect(row?.item.default).toBe('Plugins/readflow')
  mem.set('plugin.readflow.workFolder', 'Reading')
  expect(folder()).toBe('Reading')
  mem.set('plugin.readflow.workFolder', '../escape')
  expect(folder()).toBe('Plugins/readflow') // 非法值退回缺省,不出库
})

it('⚠️显示名清洗后全是点(`..`)→ 退回插件 id,不能变成 `Plugins/..`(= 库根)(codex)', () => {
  let folder = (): string => ''
  usePluginStore.getState().init([{ id: 'dots', name: '..', version: '0', setup: (ctx) => { folder = () => ctx.app.workFolder() } }])
  expect(folder()).toBe('Plugins/dots')
})

it('existing display-name folders stay readable per vault until schema-aware migration opts in', () => {
  usePageStore.setState({ vaultRoot: '/old', folders: ['Plugins/稍后读'] })
  let getFolder!: NonNullable<Parameters<AmadeusPlugin['setup']>[0]>['app']['workFolder']
  usePluginStore.getState().init([{ id: 'readflow', name: '稍后读', version: '0', setup: ctx => { getFolder = ctx.app.workFolder } }])
  expect(getFolder()).toBe('Plugins/稍后读')
  expect(getFolder({ preferId: true })).toBe('Plugins/readflow')
  usePageStore.setState({ vaultRoot: '/new', folders: [] })
  expect(getFolder()).toBe('Plugins/readflow')
  usePageStore.setState({ folders: ['Plugins/稍后读'] })
  expect(getFolder()).toBe('Plugins/readflow') // A late external folder cannot redirect an active task.
  usePageStore.setState({ vaultRoot: '/old', folders: [] })
  expect(getFolder()).toBe('Plugins/稍后读')
  mem.set('plugin.readflow.workFolder', 'My folders/中文')
  expect(getFolder({ preferId: true })).toBe('My folders/中文')
})
