/** Space 作用域浮层的那一层(floatLayer.ts):WorkspaceHost 与 SingleColumnHost 各挂一个,盖住本窗口的三栏 / 单列内容区。
 *  workspace.open 挂进浮层的 View(FloatViews)也从这里渲染:它们的元素在各作用域的层里,React 上留在壳的树里。 */
import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { registerSpaceFloatLayer } from './floatLayer'
import { FloatViews } from './FloatViews'

export function SpaceFloatLayer(): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => registerSpaceFloatLayer(ref.current!), [])
  return <>
    <div ref={ref} className="lcl-float-layer" data-scope="space" />
    <FloatViews />
  </>
}
