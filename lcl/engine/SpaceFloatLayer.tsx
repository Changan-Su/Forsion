/** Space 作用域浮层的那一层(floatLayer.ts):WorkspaceHost 与 SingleColumnHost 各挂一个,盖住本窗口的三栏 / 单列内容区。 */
import { useLayoutEffect, useRef } from 'react'
import { registerSpaceFloatLayer } from './floatLayer'

export function SpaceFloatLayer(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => registerSpaceFloatLayer(ref.current!), [])
  return <div ref={ref} className="lcl-float-layer" data-scope="space" />
}
