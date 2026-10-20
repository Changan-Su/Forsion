/** `ctx.ui.contextMenu`(2026-10-18,主页插件化 S7):宿主样式的右键菜单 —— 和内置主页、Ribbon 一样的 `.ctx-menu` + CtxMenuButtons,
 *  按视口坐标落位、放不下自己翻面;限高(`.ctx-menu-scroll`),项多 / 窗口矮时自己滚。同一时刻只开一个;点菜单外、按 Esc、
 *  窗口失焦都会关,点了某一项也关 —— `keepOpen` 时不关(勾选清单连勾),插件改完状态用句柄的 `update(items)` 换一份行。 */
import { createRoot } from 'react-dom/client'
import { Check } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { CtxMenuButtons } from '../../components/CtxMenuButtons'

export interface PluginMenuItem { label: string; run(): void; checked?: boolean; disabled?: boolean; danger?: boolean }
export interface PluginMenuOptions { keepOpen?: boolean }
/** 调用 = 关;`update` = 换一份行(关了之后是空操作)。 */
export type PluginMenuHandle = (() => void) & { update(items: readonly PluginMenuItem[]): void }

let current: (() => void) | null = null

export function openPluginContextMenu(
  x: number, y: number, items: readonly PluginMenuItem[], guard: (run: () => void) => void, onClosed?: () => void, opts: PluginMenuOptions = {},
): PluginMenuHandle {
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
    onClosed?.()
  }
  const onDown = (e: PointerEvent): void => { if (!(e.target instanceof Node) || !host.contains(e.target)) close() }
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', close)
  const paint = (list: readonly PluginMenuItem[]): void => {
    const anyChecked = list.some((it) => typeof it.checked === 'boolean')
    root.render(
      <OverlayAt className="ctx-menu ctx-menu-scroll" x={x} y={y} role="menu" onContextMenu={(e) => e.preventDefault()}>
        <CtxMenuButtons items={list.map((it, i) => ({
          id: `i${i}`,
          label: it.label,
          disabled: it.disabled,
          danger: it.danger,
          icon: anyChecked ? <Check size={13} style={{ opacity: it.checked ? 1 : 0 }} /> : undefined,
          run: () => { if (!opts.keepOpen) close(); guard(() => it.run()) },
        }))} />
      </OverlayAt>,
    )
  }
  paint(items)
  current = close
  return Object.assign(close, { update: (next: readonly PluginMenuItem[]) => { if (open) paint(next) } })
}
