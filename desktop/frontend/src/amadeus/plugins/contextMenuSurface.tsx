/** `ctx.ui.contextMenu`(2026-10-18,主页插件化 S7):宿主样式的右键菜单 —— 和内置主页、Ribbon 一样的 `.ctx-menu` + CtxMenuButtons,
 *  按视口坐标落位、放不下自己翻面。同一时刻只开一个;点菜单外、按 Esc、窗口失焦、点了某一项都会关。 */
import { createRoot } from 'react-dom/client'
import { Check } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { CtxMenuButtons } from '../../components/CtxMenuButtons'

export interface PluginMenuItem { label: string; run(): void; checked?: boolean; disabled?: boolean; danger?: boolean }

let current: (() => void) | null = null

export function openPluginContextMenu(x: number, y: number, items: readonly PluginMenuItem[], guard: (run: () => void) => void): () => void {
  current?.()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let open = true
  const close = (): void => {
    if (!open) return
    open = false
    if (current === close) current = null
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', close)
    root.unmount()
    host.remove()
  }
  const onDown = (e: PointerEvent): void => { if (!(e.target instanceof Node) || !host.contains(e.target)) close() }
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', close)
  const anyChecked = items.some((it) => typeof it.checked === 'boolean')
  root.render(
    <OverlayAt className="ctx-menu" x={x} y={y} role="menu" onContextMenu={(e) => e.preventDefault()}>
      <CtxMenuButtons items={items.map((it, i) => ({
        id: `i${i}`,
        label: it.label,
        disabled: it.disabled,
        danger: it.danger,
        icon: anyChecked ? <Check size={13} style={{ opacity: it.checked ? 1 : 0 }} /> : undefined,
        run: () => { close(); guard(() => it.run()) },
      }))} />
    </OverlayAt>,
  )
  current = close
  return close
}
