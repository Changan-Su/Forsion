// @vitest-environment happy-dom
/**
 * ctx.closeView(id, { collapse: true }) 落在同一侧的收起补间里(toggleSidebar 已把 visible 置假、panel 还没关):
 * 那块 panel 归补间收尾,不许 closeLeaf —— 否则「侧栏最后一个」补出空占位,收起变成开着的空侧栏
 * (2.13.8-beta.4 蓬洲云打包验收间歇红,dockTrace 实证:收起后 92ms 第二次收起 → closeViewsOfType → 补占位)。
 * 负对照(实跑红过):去掉 pluginViews close() 里的 collapsing 判定 → 第一条红(closeLeaf 被调到右栏那块)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { syncPluginViews } from './pluginViews'

const T = 'plugin:p:info'
const panel = (id: string, loc: string, type = T) => ({ id, params: { __loc: loc, __type: type } })
const original = useWorkspace.getState()
afterEach(() => { useWorkspace.setState(original, true) })

function arrange(state: Record<string, unknown>) {
  const spies = { closeLeaf: vi.fn(), toggleSidebar: vi.fn(), closeViewsOfType: vi.fn(), refreshTabs: vi.fn() }
  useWorkspace.setState({ ...spies, leftVisible: true, leftTabs: [{ type: 'workspace' }], ...state } as never)
  syncPluginViews()
  return { ...spies, close: usePluginStore.getState().viewControls!.close }
}

describe('closeView collapse × 收起补间', () => {
  it('右栏正在收起(visible 已假、panel 还在):第二次收起不关它,主区同类照关', () => {
    const s = arrange({ rightVisible: false, rightTabs: [{ type: T }], api: { panels: [panel('main-1', 'main'), panel('info-1', 'right')] } })
    s.close(T, { collapse: true })
    expect(s.closeLeaf).toHaveBeenCalledTimes(1)
    expect(s.closeLeaf).toHaveBeenCalledWith('main-1')
    expect(s.toggleSidebar).not.toHaveBeenCalled()
    expect(s.closeViewsOfType).not.toHaveBeenCalled()
  })
  it('右栏开着、只有它:收起该侧', () => {
    const s = arrange({ rightVisible: true, rightTabs: [{ type: T }], api: { panels: [panel('info-1', 'right')] } })
    s.close(T, { collapse: true })
    expect(s.toggleSidebar).toHaveBeenCalledWith('right')
    expect(s.closeLeaf).not.toHaveBeenCalled()
  })
  it('右栏开着、还有别的视图:照常关它(不收起)', () => {
    const s = arrange({ rightVisible: true, rightTabs: [{ type: T }, { type: 'outline' }], api: { panels: [panel('info-1', 'right'), panel('o-1', 'right', 'outline')] } })
    s.close(T, { collapse: true })
    expect(s.toggleSidebar).not.toHaveBeenCalled()
    expect(s.closeLeaf).toHaveBeenCalledWith('info-1')
  })
  it('不带 collapse、或没有 Dockview api(单列 store):照旧 closeViewsOfType', () => {
    const s = arrange({ rightVisible: false, rightTabs: [], api: { panels: [panel('info-1', 'right')] } })
    s.close(T)
    expect(s.closeViewsOfType).toHaveBeenCalledWith(T)
    const t = arrange({ rightVisible: false, rightTabs: [], api: null })
    t.close(T, { collapse: true })
    expect(t.closeViewsOfType).toHaveBeenCalledWith(T)
  })
})
