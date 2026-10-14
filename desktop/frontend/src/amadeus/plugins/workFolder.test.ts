// 插件工作文件夹的缺省值(2026-10-14 用户定):所有插件的产物收进库里的 `Plugins/` 一个文件夹,库根只多这一项。
import { beforeEach, expect, it, vi } from 'vitest'
import { usePluginStore } from './pluginStore'
import type { AmadeusPlugin } from './types'

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
  vi.stubGlobal('localStorage', fakeLocalStorage)
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
})

it('缺省 = Plugins/<显示名>(名字里的路径非法字符清掉);设置行的默认值是同一份;用户填了就用用户的', () => {
  let folder = (): string => ''
  const plugin: AmadeusPlugin = { id: 'readflow', name: '稍后/读', version: '0', setup: (ctx) => { folder = () => ctx.app.workFolder() } }
  usePluginStore.getState().init([plugin])
  expect(folder()).toBe('Plugins/稍后读')
  const row = usePluginStore.getState().settings.find((s) => s.pluginId === 'readflow' && s.item.key === 'workFolder')
  expect(row?.item.default).toBe('Plugins/稍后读')
  mem.set('plugin.readflow.workFolder', 'Reading')
  expect(folder()).toBe('Reading')
  mem.set('plugin.readflow.workFolder', '../escape')
  expect(folder()).toBe('Plugins/稍后读') // 非法值退回缺省,不出库
})
