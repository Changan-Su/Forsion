import { describe, it, expect } from 'vitest'
import type { SpaceDefinition } from '@lcl/engine'
import { launcherTiles } from './newTabModel'

const sp = (id: string, extra: Partial<SpaceDefinition> = {}): SpaceDefinition =>
  ({ id, name: id, build() {}, sidebarDefaults: { left: [], right: [] }, ...extra })
const VIEWS: Record<string, { kind?: 'entity' | 'collection' | 'aux' | 'page'; idParam?: string }> = {
  chat: { kind: 'entity', idParam: 'sessionId' },
  'chat-panel': { kind: 'aux' },
  calendar: { kind: 'collection' },
  'todo-list': { kind: 'collection' },
  'code-studio': { kind: 'page' },
  'amadeus-db': { kind: 'entity', idParam: 'dbPath' },
  'plugin:gardener:diff': { kind: 'page' },
  'plugin:gardener:inbox': { kind: 'page' },
  'plugin:cu:window': { kind: 'page' },
  launcher: { kind: 'page' },
}
const getView = (t: string) => VIEWS[t]
const run = (spaces: SpaceDefinition[], owners: Record<string, string> = {}, plugin: string[] = []) => {
  const r = launcherTiles(spaces, getView, (id) => owners[id], plugin)
  return { tiles: r.tiles.map((t) => [t.space.id, ...t.views.map((v) => v.type)]), free: r.free }
}

describe('launcherTiles', () => {
  it('缺省取固定在主区的视图;主区是「某一条会话」的 Space 不出格子', () => {
    expect(run([
      sp('tangu', { pinned: { main: [{ type: 'chat', params: { followActive: true } }] } }),
      sp('coding', { pinned: { main: [{ type: 'code-studio', params: {} }] } }),
    ]).tiles).toEqual([['coding', 'code-studio']])
  })

  it('launcherViews 压过 pinned.main,第一项是点格子开的', () => {
    expect(run([sp('calendar', {
      pinned: { main: [{ type: 'calendar', params: {} }] },
      launcherViews: [{ type: 'calendar', params: {} }, { type: 'todo-list', params: {} }],
    })]).tiles).toEqual([['calendar', 'calendar', 'todo-list']])
  })

  it('插件 Space:配方主区在前,所属插件的其余视图跟在后面,不重复;aux 和没带身份的 entity 滤掉', () => {
    const r = run(
      [sp('garden', { launcherViews: [{ type: 'plugin:gardener:diff', params: {} }, { type: 'chat-panel', params: {} }, { type: 'chat', params: {} }] })],
      { garden: 'gardener' },
      ['plugin:gardener:inbox', 'plugin:gardener:diff', 'plugin:cu:window'],
    )
    expect(r.tiles).toEqual([['garden', 'plugin:gardener:diff', 'plugin:gardener:inbox']])
    expect(r.free).toEqual(['plugin:cu:window']) // 没带 Space 的插件视图 = 独立视图
  })

  it('带身份参数的 entity 留下,同类型两份不同文件算两项', () => {
    expect(run([sp('erp', { launcherViews: [
      { type: 'amadeus-db', params: { dbPath: 'a.db' } }, { type: 'amadeus-db', params: { dbPath: 'b.db' } }, { type: 'amadeus-db', params: { dbPath: 'a.db' } },
    ] })]).tiles).toEqual([['erp', 'amadeus-db', 'amadeus-db']])
  })

  it('存成 Space 时主区里开着的空白页不算内容', () => {
    expect(run([sp('saved', { launcherViews: [{ type: 'launcher', params: {} }, { type: 'code-studio', params: {} }] })]).tiles).toEqual([['saved', 'code-studio']])
  })

  it('视图没注册(插件 / 内置包被关掉)→ 那一格跟着消失;一个插件带两个 Space 时视图只归第一个', () => {
    expect(run([sp('gone', { pinned: { main: [{ type: 'homepage', params: {} }] } })]).tiles).toEqual([])
    expect(run([sp('a'), sp('b')], { a: 'gardener', b: 'gardener' }, ['plugin:gardener:diff']).tiles).toEqual([['a', 'plugin:gardener:diff']])
  })
})
