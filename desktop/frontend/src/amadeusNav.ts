// Amadeus「打开笔记」的统一门面:搜索/标签/快切/反链等一律走这里,别直接调 loadPage。
// 语义(类 Obsidian):已有认领该笔记的编辑器 tab → 激活它;newTab(⌘点击)→ 新开 tab;
// 一个编辑器都没有(全被关掉)→ 带 notePath 新开;否则在当前(最近活动)编辑器里加载。
import { usePageStore } from '@amadeus/store/pageStore'
import { useWorkspace } from '@lcl/engine'

interface PanelLike { id: string; params?: Record<string, unknown> }

export async function openNote(path: string, opts?: { newTab?: boolean }): Promise<void> {
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  const editors = api?.panels.filter((p) => p.params?.__type === 'amadeus-editor') ?? []
  const hit = editors.find((p) => p.params?.notePath === path)
  if (hit) {
    ws.activateLeaf(hit.id) // 激活触发该 leaf 的 activate 效果异步加载
    await waitForActive(path)
    return
  }
  if (opts?.newTab || editors.length === 0) {
    // newTab(⌘点击)显式新开;「一个编辑器都没有」走 openView 默认的就地导航(当前 tab 变编辑器)。
    ws.openView('amadeus-editor', { notePath: path }, 'main', { newTab: opts?.newTab })
    await waitForActive(path)
    return
  }
  await usePageStore.getState().loadPage(path)
}

/** resolve 时笔记必须真的加载完(调用方靠它定位/高亮块);超时兜底防 leaf 效果没接住。 */
function waitForActive(path: string, timeoutMs = 3000): Promise<void> {
  if (usePageStore.getState().activePage === path) return Promise.resolve()
  return new Promise((resolve) => {
    const off = usePageStore.subscribe((s) => {
      if (s.activePage === path) { clearTimeout(t); off(); resolve() }
    })
    const t = setTimeout(() => { off(); resolve() }, timeoutMs)
  })
}
