/** 折叠容器的 React 壳(8.10)。真身是宿主 base.css 的 `data-motion="collapse"`(grid-template-rows 0fr ↔ 1fr 过渡,
 *  打断接着走、不量高度;时长 / 曲线 = --collapse-duration / --collapse-ease)。插件不用 React 也能直接写那两个属性。
 *  壳多做三件 CSS 做不到的事:
 *  - 收起时留住最后一版内容放完收起,再卸载(调用处照旧写 open={x}>{x && …},收着时不必算整棵子树);
 *  - 首次挂上就是开着的不播(DESIGN §3 动效规矩 6:恢复 / 新建不做入场),之后每次点开都从收着长出来;
 *  - 展开完了挂 data-settled 放开裁切,行上探出去的拖动落点线(top:-4px 之类)不被裁掉(10-25 Codex 评审)。 */
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// ponytail: 只在 transitionend 不来时兜底(减少动态效果 / 没有过渡的环境),不读 token
const SETTLE_FALLBACK_MS = 400

export function AnimatedCollapse({ open, children }: { open: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const kept = useRef<ReactNode>(children)
  if (open) kept.current = children
  const [present, setPresent] = useState(open)
  const [shown, setShown] = useState(open)
  const [settled, setSettled] = useState(open)
  if (open && !present) setPresent(true)
  if (!open && shown) { setShown(false); setSettled(false) }
  // 先按收着的样子算一遍样式,再改成开着,才有从 0fr 起步的过渡
  useLayoutEffect(() => {
    if (!open || shown) return
    void ref.current?.offsetHeight
    setShown(true)
  }, [open, shown])
  useEffect(() => {
    const el = ref.current
    if (!el || !present || settled || open !== shown) return
    const end = (): void => { if (open) setSettled(true); else setPresent(false) }
    const onEnd = (e: TransitionEvent): void => { if (e.target === el && e.propertyName === 'grid-template-rows') end() }
    el.addEventListener('transitionend', onEnd)
    const t = window.setTimeout(end, SETTLE_FALLBACK_MS)
    return () => { el.removeEventListener('transitionend', onEnd); window.clearTimeout(t) }
  }, [open, shown, settled, present])
  if (!present) return null
  return (
    <div ref={ref} data-motion="collapse" data-open={shown} data-settled={settled || undefined}>
      <div>{kept.current}</div>
    </div>
  )
}
