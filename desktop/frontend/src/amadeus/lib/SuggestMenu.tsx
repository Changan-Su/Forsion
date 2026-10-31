// 光标旁的补全浮层:编辑器 `#` 补全和 ChatBox 的 suggest 共用同一份外观与键盘行为。
// 查询串驻留在输入区,面板只在捕获阶段拦导航键(↑↓/Enter/Tab/Esc),字母照常落进去。
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { OverlayAt } from './clampMenu'

export interface SuggestMenuItem {
  key: string
  label: ReactNode
  hint?: ReactNode
}

interface Props {
  items: SuggestMenuItem[]
  left: number
  top: number
  anchorTop?: number
  className?: string
  /** 变了就把高亮挪回第一行(查询串)。 */
  resetKey?: unknown
  onPick: (index: number) => void
  onClose: () => void
  /** 宿主输入区是否持焦;不持焦时一个键都不拦(L-04 同款)。 */
  focused?: () => boolean
}

export function SuggestMenu({ items, left, top, anchorTop, className = '', resetKey, onPick, onClose, focused }: Props) {
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [resetKey])
  const total = items.length

  // useLayoutEffect:见 WikiSuggest 同处注释(被动 effect 的 cleanup 晚于 DOM 移除,窗口里的 Enter 会被过期面板吞掉)。
  useLayoutEffect(() => {
    if (total === 0) return // 看不见的面板一个键都不许拦
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return // 输入法组字放行(L-08 同款)
      if (focused && !focused()) return
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        setActive((a) => Math.min(a + 1, total - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation()
        if (items[active]) onPick(active)
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (total === 0) return null
  const reveal = (i: number) => (i === active ? (el: HTMLButtonElement | null) => el?.scrollIntoView({ block: 'nearest' }) : undefined)
  return (
    <OverlayAt className={`wiki-suggest ${className}`} x={left} y={top} anchorTop={anchorTop} role="menu" onMouseDown={(e) => e.preventDefault()}>
      {items.map((item, i) => (
        <button
          key={item.key}
          className="wiki-item"
          data-active={i === active || undefined}
          ref={reveal(i)}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(i)
          }}
          role="menuitem"
        >
          <span className="wiki-item-name">{item.label}</span>
          {item.hint != null && item.hint !== '' && <span className="wiki-item-hint">{item.hint}</span>}
        </button>
      ))}
    </OverlayAt>
  )
}
