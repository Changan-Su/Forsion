/**
 * activeMainPanel 在焦点离开主区时认「最后聚焦的主区组」—— 跑真 dockviewStore,只把 Dockview 换成最小桩
 * (同 bottomPanel.test.ts 先例)。真 Electron 那半在 desktop/scripts/active-tab.e2e.cjs 的 T3–T5;
 * 这里锁 Codex 复审点名的结构变化:
 *   ① 分屏右组聚焦 → 焦点进侧栏:返回右组前台,不是 panels 里的第一组
 *   ② 侧栏聚焦期间右组前台被关、同组顶上来一张:仍认右组
 *   ③ 换布局后组 id 被新布局复用:不认旧布局记下的组
 *   ④ 分屏时把主区标签拖进侧栏:moveTo 同步激活落点时 __loc 还是 main,不许把侧栏组记成主区组
 */
import { describe, it, expect } from 'vitest'
import { useWorkspace, activeMainPanel } from './dockviewStore'
import type { DockviewApi } from 'dockview-react'

type G = { id: string; activePanel: P | null; panels: P[] }
type P = { id: string; title: string; params: Record<string, unknown>; group: G; api: Record<string, unknown> }

function mkApi() {
  const panels: P[] = []
  const groups: Record<string, G> = {}
  const add = (id: string, loc: string, gid: string): P => {
    const group = (groups[gid] ??= { id: gid, activePanel: null, panels: [] })
    const p: P = {
      id, title: id, params: { __loc: loc, __type: 'launcher' }, group,
      api: {
        close() {}, setActive() {}, setTitle() {},
        updateParameters: (np: Record<string, unknown>) => { p.params = { ...p.params, ...np } },
        // 同真 Dockview 的次序:先挪进落点组并**同步**激活(WorkspaceHost 的激活回调里跑 refreshTabs),再轮到调用方改 __loc
        moveTo: (o: { group: G }) => {
          const from = p.group
          from.panels.splice(from.panels.indexOf(p), 1)
          from.activePanel = from.panels[from.panels.length - 1] ?? null
          o.group.panels.push(p); o.group.activePanel = p; p.group = o.group
          api.activePanel = p
          useWorkspace.getState().refreshTabs()
        },
      },
    }
    panels.push(p); group.panels.push(p)
    group.activePanel = p
    return p
  }
  const api = { panels, activePanel: null as P | null, getPanel: (id: string) => panels.find((p) => p.id === id), clear() { panels.length = 0; for (const k in groups) delete groups[k] }, toJSON: () => ({}) }
  useWorkspace.getState().setApi(api as unknown as DockviewApi)
  const focus = (p: P): void => { api.activePanel = p; useWorkspace.getState().refreshTabs() }
  const main = (): string | undefined => activeMainPanel(api as unknown as DockviewApi)?.id
  return { api, add, panels, groups, focus, main }
}

describe('activeMainPanel:焦点离开主区时认最后聚焦的主区组', () => {
  it('① 分屏右组聚焦后点侧栏 → 右组前台;② 其间右组前台被关、同组顶上来 → 仍认右组', () => {
    const { add, panels, focus, main } = mkApi()
    const side = add('workspace#1', 'left', 'g0')
    add('launcher#1', 'main', 'g1')
    const right = add('launcher#2', 'main', 'g2')
    focus(right)
    focus(side)
    expect(main()).toBe('launcher#2')
    panels.splice(panels.indexOf(right), 1)
    right.group.panels.splice(right.group.panels.indexOf(right), 1)
    add('launcher#3', 'main', 'g2')
    expect(main()).toBe('launcher#3')
  })

  it('③ 换布局后复用同名组 id:不认旧布局记下的组', () => {
    const { add, focus, main } = mkApi()
    add('workspace#1', 'left', 'g0')
    add('launcher#1', 'main', 'g1')
    focus(add('launcher#2', 'main', 'g2'))
    useWorkspace.getState().resetLayout()
    const side2 = add('workspace#1', 'left', 'g0')
    add('launcher#1', 'main', 'g1')
    add('chat#1', 'main', 'g2')
    focus(side2) // 新布局还没聚焦过主区
    expect(main()).toBe('launcher#1')
  })

  it('④ 分屏时把主区标签拖进侧栏 → 仍认源组(右组)剩下的前台', () => {
    const { add, groups, focus, main } = mkApi()
    add('workspace#1', 'left', 'g0')
    add('launcher#1', 'main', 'g1')
    add('launcher#2', 'main', 'g2')
    focus(add('launcher#3', 'main', 'g2'))
    useWorkspace.getState().dropView('launcher#3', { group: groups.g0, mode: 'tab', index: 0 } as never)
    expect(main()).toBe('launcher#2')
  })
})
