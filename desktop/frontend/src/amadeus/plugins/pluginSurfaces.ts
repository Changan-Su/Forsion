/** 插件自有表面的登记册(2026-11-19,ctx.ui.capture / record 的归属判定)。
 *
 *  宿主把一块容器交给插件时(registerView 的 mount(el)、ctx.ui.float 的浮层、openDialog / popover 的 mount(el))
 *  在这里记一笔「这块归哪个插件」;判归属时从元素往上找(跨 shadow root),第一块登记过的容器说了算。
 *  ⚠️ 只认这里的 WeakMap,不认 DOM 属性:`data-guide-owner` / `data-float-owner` 谁都能写。
 *  ⚠️ 这是契约闸,不是沙箱:插件和宿主同一个渲染进程,够得着 window.tangu.*。它挡的是「插件按约定只截自己」之外的误用,
 *  挡不住存心绕过的代码。
 *  没登记的表面(工具结果卡、设置页、嵌入渲染器)第一期不算插件自有,截不了 —— 写进了契约。 */

const owners = new WeakMap<Element, string>()

/** 登记 `el` 归 `pluginId`;返回撤销函数(只撤自己这一笔:同一块容器后来换了主人就不动)。 */
export function markPluginSurface(el: Element, pluginId: string): () => void {
  owners.set(el, pluginId)
  return () => { if (owners.get(el) === pluginId) owners.delete(el) }
}

/** 组合树上的父节点:普通父元素,或 shadow root 的宿主元素。 */
export function composedParent(node: Element): Element | null {
  if (node.parentElement) return node.parentElement
  const root = node.getRootNode?.()
  return root && (root as ShadowRoot).host instanceof Element ? (root as ShadowRoot).host : null
}

/** `inner` 是不是 `outer` 自己或它的(组合树)后代。 */
export function composedContains(outer: Element, inner: Element): boolean {
  for (let n: Element | null = inner; n; n = composedParent(n)) if (n === outer) return true
  return false
}

/** 元素所在的插件表面归谁;不在任何登记过的表面里 = null。 */
export function pluginSurfaceOwner(el: Element): string | null {
  for (let n: Element | null = el; n; n = composedParent(n)) {
    const id = owners.get(n)
    if (id !== undefined) return id
  }
  return null
}
