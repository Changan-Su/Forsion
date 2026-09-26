import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

// 一个容器只许有一个 React root。插件常「dispose 完立刻在同一个 el 上重挂」,而 unmount 推迟到
// microtask(React 18+ 不许在渲染周期里同步 unmount)—— 不认容器的话第二次 createRoot 会在仍被
// 标记为 root 的元素上再建一个,随后旧 root 的延迟 unmount 反过来把新挂载清掉(codex)。
const rootsByEl = new WeakMap<HTMLElement, { root: Root; gen: number }>()
let mountGen = 0

/** 往插件的 DOM 里挂一棵宿主 React 树(容器去重 + 代际校验 + microtask 延迟卸载三件套)。
 *  mountBlocks 与 mountNoteView(viewSurface)共用 —— 这套纪律漏一处就是「新挂载被旧 dispose 清掉」。 */
export function mountHostReact(el: HTMLElement, node: ReactNode): () => void {
  const gen = ++mountGen
  const existing = rootsByEl.get(el)
  const root = existing?.root ?? createRoot(el)
  rootsByEl.set(el, { root, gen })
  root.render(node)
  return () => {
    const cur = rootsByEl.get(el)
    if (!cur || cur.gen !== gen) return // 这个容器已经被新的挂载接管 → 本次 dispose 作废
    // ⚠️ 表项**不能**在这里同步删:React effect 的 cleanup→setup 同步连跑,同一 el 立即重挂时
    // 读不到 existing 就会在旧 root 仍挂载的容器上第二次 createRoot,而微任务里旧 root 的
    // unmount 又被新表项跳过 —— 旧树永久泄漏 + 同容器双 root(评审 P1,2026-08-14)。
    // 删除也推进微任务、按代际校验:同步重挂读到 existing → 复用同一 root 只换 render 内容。
    queueMicrotask(() => {
      if (rootsByEl.get(el)?.gen !== gen) return // 已被新挂载接管
      rootsByEl.delete(el)
      try {
        cur.root.unmount()
      } catch (e) {
        console.error('[amadeus] 卸载插件挂载树失败', e)
      }
    })
  }
}

