/** Android 系统返回先关编辑器里最上层的浮层(评审 G2-12)。此前块菜单 / 图片大图 / askString / 胶囊的「⋯」与「+」
 *  都不听返回:按一下返回直接把整篇笔记关掉,askString 对话框还孤零零留在屏幕上。
 *
 *  契约沿用 MobileRoot 已有的那条:返回键上派发**可取消**的 `forsion:mobile-back`,谁接了谁 preventDefault,
 *  MobileRoot 见 defaultPrevented 就不再往下走(关视图 / 挂起)。本模块在 window 上挂**捕获相位**监听 ——
 *  事件就派发在 window 上,目标相位里捕获监听先于冒泡监听(壳里 SingleColumnHost / 设置页那几个)跑,
 *  编辑器浮层压在它们上面,理应先关。栈:打开即压栈、关闭 / 卸载即出栈,一次返回只关**最后打开**的那一层。
 *  桌面上这个事件从不派发 = 零开销。 */
import { useEffect, useRef } from 'react'

const stack: Array<() => void> = []
let installed = false

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('forsion:mobile-back', (e) => {
    const top = stack[stack.length - 1]
    if (!top || e.defaultPrevented) return
    e.preventDefault()
    e.stopImmediatePropagation() // 一次返回只关一层:壳里的 sheet 监听这一下别跟着关
    top()
  }, true)
}

/** 非 React 的浮层用:打开时调,返回的函数在关闭 / 卸载时调(出栈)。 */
export function pushMobileBack(close: () => void): () => void {
  install()
  stack.push(close)
  return () => {
    const i = stack.lastIndexOf(close)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** React 浮层用:open 期间在栈上;返回键 = 调 close(取最新一次渲染的 close)。 */
export function useMobileBackClose(open: boolean, close: () => void): void {
  const ref = useRef(close)
  ref.current = close
  useEffect(() => {
    if (!open) return
    return pushMobileBack(() => ref.current())
  }, [open])
}
