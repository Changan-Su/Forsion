import { useLayoutEffect, useRef } from 'react'
import type { ExtendViewSide } from './extendView'

// One shared renderer, with owner-scoped content. Never registered in the permanent view catalogue.
export const nativeExtendTargets = new Map<string, HTMLElement>()

export function NativeExtendView({ id, side }: { id: string; side: ExtendViewSide }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = ref.current!
    const target = nativeExtendTargets.get(id)
    if (!target) return
    host.append(target)
    return () => { if (target.parentElement === host) target.remove() }
  }, [id])
  return <div ref={ref} className={`wb-view wb-view--${side} wb-native-extend`} data-transient-view={id} />
}
