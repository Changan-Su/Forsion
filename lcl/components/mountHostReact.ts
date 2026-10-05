import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'

/** 一次挂载的句柄。所有权跟着它走:原地更新、卸载都只认它,不认容器。 */
export interface HostReactMount {
  /** 原地重渲染:同一个 root 只换内容,组件实例与 DOM 身份不变。已卸载 / 已被后来的挂载接走时无效。 */
  render(node: ReactNode): void
  /** 幂等。同步摘掉宿主那一层(之后 el 立刻归还调用方),React 的卸载推迟到 microtask。 */
  dispose(): void
}

// 一个 el 上同一时刻只有一棵宿主树:后来的挂载先把前一份收掉。
const mountByEl = new WeakMap<HTMLElement, HostReactMount>()
// el 最近一次交给了谁:一次公开的挂载调用(真正挂载还在等动态 import),或一次已经落地的挂载。
const claimByEl = new WeakMap<HTMLElement, object>()

/** 公开的挂载调用一进来就同步认领 el;返回的函数在动态 import 落地时问一句「el 还归这次调用吗」。
 *  这之后 el 上又来过别的挂载调用(不管它先落地还是后落地)→ false:这次调用作废,不能再挂 ——
 *  不然先请求、后落地的那份会把后请求的收掉(请求顺序才是插件的意思,落地顺序不是)。 */
export function claimHostMount(el: HTMLElement): () => boolean {
  const claim = {}
  claimByEl.set(el, claim)
  return () => claimByEl.get(el) === claim
}

/** 往插件的 DOM 里挂一棵宿主 React 树。各挂载接口(mountBlocks / mountNoteView / ctx.ui.* / ctx.table /
 *  ctx.dashboard / ctx.tangu.mountChat)共用。
 *
 *  root 不建在调用方给的 el 上,建在宿主自己加进 el 的一层里(display:contents:不出盒子,el 的 flex / 百分比高度
 *  照旧落到里面那棵树上)。el 始终是调用方的:dispose 同步摘掉这一层,之后清空 el、在它上面再挂都行。
 *  直接建在 el 上时,「dispose → 清空 el → 再挂」会撞上晚一个 microtask 才落地的卸载(React 18+ 不许在渲染周期里
 *  同步 unmount):同一拍再挂画进已被摘走的节点(空白);晚一拍 / 不再挂,卸载去删一个已不在 el 里的节点
 *  (removeChild 抛 NotFoundError)。2026-10-04 在 ctx.tangu.mountChat 上实测到。
 *  ⚠️ 所以别用 `el > .x` 选宿主渲染的节点,也别假设它是 el.firstElementChild。
 *
 *  · 一层一个 root:同一个容器上不会有两个 root;句柄只碰自己那一层,旧句柄晚到或被重复调用,碰不到后来的挂载。
 *  · el 上一份没 dispose 就再挂:前一份被收掉(旧树照样卸),它的句柄此后是哑的 —— 晚到的 render 顶不掉后来那份。
 *    调用方没 dispose 就把 el 清空了再挂,走的也是这条。
 *  · 想保住组件状态就留着句柄调 render();dispose 再挂是一棵新树。
 *  · onDispose:这次挂载结束时恰好调一次,不管是自己 dispose 的还是被后来的挂载收掉的。挂在树外面的东西
 *    (body 上的弹层宿主、内存作用域的 store、上层句柄的 alive)在这里收,别只写在上层自己的 dispose() 里。 */
export function mountHostReact(el: HTMLElement, node: ReactNode, onDispose?: () => void): HostReactMount {
  const previous = mountByEl.get(el)
  const layer = el.appendChild(document.createElement('div'))
  layer.style.display = 'contents'
  const root = createRoot(layer)
  root.render(node)
  let alive = true
  const mount: HostReactMount = {
    render(next) {
      if (!alive) return
      if (layer.parentNode !== el) el.appendChild(layer) // 调用方没 dispose 就清空过 el:把那一层接回去,组件状态还在
      root.render(next)
    },
    dispose() {
      if (!alive) return
      alive = false
      if (mountByEl.get(el) === mount) mountByEl.delete(el) // 被后来的挂载收掉时,登记已经是它的了
      layer.remove()
      // 旧树必须真卸掉(effect 清理、订阅退订),不然就是泄漏
      queueMicrotask(() => {
        try {
          root.unmount()
        } catch (e) {
          console.error('[amadeus] 卸载插件挂载树失败', e)
        }
      })
      try {
        onDispose?.()
      } catch (e) {
        console.error('[amadeus] 插件挂载的收尾回调抛错', e)
      }
    },
  }
  // 先登记这一份,再收前一份:前一份的收尾回调里要是又往这个 el 上挂(重入),它收掉的是这一份 ——
  // 后调用的收掉先调用的,el 里不会留两棵树,登记也不会被盖乱。
  mountByEl.set(el, mount)
  claimByEl.set(el, mount)
  previous?.dispose()
  return mount
}
