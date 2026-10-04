import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

// root 不建在调用方给的 el 上,建在宿主自己加进 el 的一层里(display:contents:不出盒子,el 的 flex / 百分比高度
// 照旧落到里面那棵树上)。el 始终是调用方的:dispose 同步摘掉这一层,之后清空 el、在它上面再挂都行。
// 直接建在 el 上时,「dispose → 清空 el → 再挂」会撞上晚一个 microtask 才落地的卸载(React 18+ 不许在渲染周期里
// 同步 unmount):同一拍再挂复用了旧 root,画进已被摘走的节点(空白);晚一拍 / 不再挂,卸载去删一个已不在 el 里的
// 节点(removeChild 抛 NotFoundError)。2026-10-04 在 ctx.tangu.mountChat 上实测到。
// ⚠️ 所以别用 `el > .x` 选宿主渲染的节点,也别假设它是 el.firstElementChild。
interface HostMount { layer: HTMLElement; root: Root; gen: number }
const mountsByEl = new WeakMap<HTMLElement, HostMount>()
let mountGen = 0

/** 摘层是同步的,卸载推迟到 microtask。旧树必须真卸掉(effect 清理、订阅退订),不然就是泄漏。 */
function retire(m: HostMount): void {
  m.layer.remove()
  queueMicrotask(() => {
    try {
      m.root.unmount()
    } catch (e) {
      console.error('[amadeus] 卸载插件挂载树失败', e)
    }
  })
}

/** 往插件的 DOM 里挂一棵宿主 React 树;返回 dispose。各挂载接口(mountBlocks / mountNoteView / ctx.ui.* /
 *  ctx.table / ctx.dashboard / ctx.tangu.mountChat)共用。
 *  · 同一个 el 上一份还没 dispose 就再挂 = 原地更新:同一个 root 只换 render 内容,组件实例与 DOM 身份不变
 *    (表格 / 输入卡 / 编辑器的 update 靠它);被顶掉的旧 disposer 作废,只有最新那个收得掉。
 *  · 一层一个 root,同一个容器上不会有两个;旧 disposer 晚到或被重复调用,碰不到后来的挂载。 */
export function mountHostReact(el: HTMLElement, node: ReactNode): () => void {
  const gen = ++mountGen
  let mount = mountsByEl.get(el)
  // 调用方没 dispose 就把 el 清空了:那一层已经不在 el 里,当它收掉,另起一层
  if (mount && mount.layer.parentNode !== el) {
    retire(mount)
    mount = undefined
  }
  if (mount) mount.gen = gen
  else {
    const layer = el.appendChild(document.createElement('div'))
    layer.style.display = 'contents'
    mount = { layer, root: createRoot(layer), gen }
    mountsByEl.set(el, mount)
  }
  const mine = mount
  mine.root.render(node)
  return () => {
    if (mountsByEl.get(el)?.gen !== gen) return // 已收过,或被后来的挂载 / 更新接管(代际号全局唯一)
    mountsByEl.delete(el)
    retire(mine)
  }
}
