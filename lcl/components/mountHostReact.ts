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
 *  · 想保住组件状态就留着句柄调 render();dispose 再挂是一棵新树。 */
export function mountHostReact(el: HTMLElement, node: ReactNode): HostReactMount {
  mountByEl.get(el)?.dispose()
  const layer = el.appendChild(document.createElement('div'))
  layer.style.display = 'contents'
  const root = createRoot(layer)
  root.render(node)
  let alive = true
  const mount: HostReactMount = {
    render(next) {
      if (alive) root.render(next)
    },
    dispose() {
      if (!alive) return
      alive = false
      mountByEl.delete(el) // 活着的句柄一定就是 el 当前那一份(后来的挂载会先收掉它)
      layer.remove()
      // 旧树必须真卸掉(effect 清理、订阅退订),不然就是泄漏
      queueMicrotask(() => {
        try {
          root.unmount()
        } catch (e) {
          console.error('[amadeus] 卸载插件挂载树失败', e)
        }
      })
    },
  }
  mountByEl.set(el, mount)
  return mount
}
