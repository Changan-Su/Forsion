// @vitest-environment happy-dom
/**
 * 随包 Space 换了主人(同一个包从本地安装换成商店安装):旧主人的视图在换代时已被关掉,`space:<id>` 里只剩空占位,
 * 以前一进去就是空的 Space,要手点「恢复默认布局」。现在丢掉这份存档,照新主人的配方重建。
 * 主人没换(普通重载)/ 插件只是被关掉:存档原样留着(重新启用即原样回来)。
 */
import { beforeEach, expect, it } from 'vitest'
import { registerView, saveNamedLayout, loadNamedLayout, spaceLayoutName, type LayoutBlob } from '@lcl/engine'
import { loadUserSpaces } from './userSpaces'

const STORE = 'market-00000000-0000-4000-8000-00000000000a'
const recipe = (owner: string) => JSON.stringify({ id: 'demo', name: 'Demo', layout: { main: [{ type: `plugin:${owner}:chat` }], left: [], right: [] } })
let listing: Array<{ slug: string; json: string; plugin: string }> = []
const blob = { version: 4, dockview: { panels: { a: { id: 'a', params: { __loc: 'main', __type: 'home' } } } }, sidebars: { left: { visible: false, stash: [] }, right: { visible: false, stash: [] } } } as unknown as LayoutBlob

beforeEach(() => {
  ;(window as any).tangu = { spacesList: async () => listing, appVersion: async () => '9.9.9' }
  for (const owner of ['demo-suite', STORE]) registerView({ type: `plugin:${owner}:chat`, displayName: () => 'chat', factory: () => null })
})

it('同一个 Space 换了主人:丢掉存着的布局;主人没换:存档留着', async () => {
  listing = [{ slug: 'demo', json: recipe('demo-suite'), plugin: 'demo-suite' }]
  await loadUserSpaces()
  saveNamedLayout(spaceLayoutName('demo'), blob)
  await loadUserSpaces() // 主人没换、配方没变
  expect(loadNamedLayout(spaceLayoutName('demo'))).not.toBeNull()
  listing = [{ slug: 'demo', json: recipe(STORE), plugin: STORE }] // 换成商店那份
  await loadUserSpaces()
  expect(loadNamedLayout(spaceLayoutName('demo'))).toBeNull()
})
