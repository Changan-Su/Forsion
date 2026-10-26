/** `ctx.ui.contextMenu`(2026-10-18,主页插件化 S7):宿主样式的右键菜单 —— 和内置主页、Ribbon 一样的 `.ctx-menu`,
 *  按视口坐标落位、放不下自己翻面;限高(`.ctx-menu-scroll`),项多 / 窗口矮时自己滚。同一时刻只开一个;点菜单外、按 Esc、
 *  窗口失焦都会关,点了某一项也关 —— `keepOpen` 时不关(勾选清单连勾),插件改完状态用句柄的 `update(items)` 换一份行。
 *  走查续八 8.16(2026-10-26):行带图标 / 快捷键提示,分隔线、小节标题;锚在按钮下(`{ anchor, align }`);
 *  Android 上同一份数据走原生底部抽屉(lcl nativeSheetMenu,小节 = 抽屉的分组)。 */
import { createRoot } from 'react-dom/client'
import { Check } from 'lucide-react'
import { OverlayAt, nativeSheetPresenter, runNativeSheetMenu, type SheetMenuSection } from '@lcl/engine'
import { pluginText } from './pluginText'
import { vocabIcon } from './pluginIcon'
import './pluginParts.css'

export type PluginMenuEntry =
  | { kind: 'item'; label: unknown; run(): void; icon?: string; shortcut?: string; checked?: boolean; disabled?: boolean; danger?: boolean }
  | { kind: 'sep' }
  | { kind: 'head'; label: unknown }
export type PluginMenuAt = { x: number; y: number } | { anchor: HTMLElement; align?: 'start' | 'end'; side?: 'bottom' | 'top' }
export interface PluginMenuOptions { keepOpen?: boolean }
/** 调用 = 关;`update` = 换一份行(关了之后是空操作)。 */
export type PluginMenuHandle = (() => void) & { update(items: readonly PluginMenuEntry[]): void }

let current: (() => void) | null = null

/** 锚在元素上:菜单默认在元素下方 4px,`side: 'top'` 先试上方;放不下翻到另一侧。 */
export function anchorPoint(at: PluginMenuAt): { x: number; y: number; anchorTop?: number; prefer?: 'below' | 'above'; alignEnd?: boolean } {
  if (!('anchor' in at)) return at
  const r = at.anchor.getBoundingClientRect()
  return { x: at.align === 'end' ? r.right : r.left, y: r.bottom + 4, anchorTop: r.top - 4, prefer: at.side === 'top' ? 'above' : 'below', alignEnd: at.align === 'end' }
}

const Icon = ({ name }: { name?: string }) => {
  const G = vocabIcon(name)
  return G ? <G size={13} className="plugin-menu-ic" /> : <span className="plugin-menu-ic" aria-hidden />
}

/** 安卓原生抽屉:分隔与小节都切成分组(小节名 = 组标题)。 */
function toSheet(list: readonly PluginMenuEntry[], guard: (run: () => void) => void): SheetMenuSection[] {
  const out: SheetMenuSection[] = [{ items: [] }]
  list.forEach((it, i) => {
    if (it.kind === 'item') {
      const G = vocabIcon(it.icon)
      out[out.length - 1].items.push({ id: `i${i}`, label: pluginText(it.label), ...(G ? { icon: <G size={16} /> } : {}), ...(it.checked ? { checked: true } : {}),
        ...(it.danger ? { danger: true } : {}), ...(it.disabled ? { disabled: true } : {}), run: () => guard(() => it.run()) })
    } else out.push(it.kind === 'head' ? { title: pluginText(it.label), items: [] } : { items: [] })
  })
  return out.filter((s) => s.items.length)
}

export function openPluginContextMenu(
  at: PluginMenuAt, items: readonly PluginMenuEntry[], guard: (run: () => void) => void, onClosed?: () => void, opts: PluginMenuOptions = {},
): PluginMenuHandle {
  current?.()
  if (nativeSheetPresenter()) {
    const ctl = new AbortController()
    let open = true
    const close = (): void => { if (!open) return; open = false; if (current === close) current = null; ctl.abort(); onClosed?.() }
    current = close
    void runNativeSheetMenu({ sections: toSheet(items, guard) }, { signal: ctl.signal, onClose: () => { if (open) { open = false; if (current === close) current = null; onClosed?.() } } })
      .then((shown) => { if (!shown && open) { open = false; if (current === close) current = null; webMenu(at, items, guard, onClosed, opts) } })
    return Object.assign(close, { update: () => {} })
  }
  return webMenu(at, items, guard, onClosed, opts)
}

function webMenu(at: PluginMenuAt, items: readonly PluginMenuEntry[], guard: (run: () => void) => void, onClosed: (() => void) | undefined, opts: PluginMenuOptions): PluginMenuHandle {
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
  const onDown = (e: PointerEvent): void => {
    if (e.target instanceof Node && host.contains(e.target)) return
    // 点的是锚点按钮本身:关掉就好,别让按钮的 click 紧接着再开一份(「再点一下收起」)
    if ('anchor' in at && e.target instanceof Node && at.anchor.contains(e.target)) {
      const eat = (c: Event): void => c.stopImmediatePropagation()
      at.anchor.addEventListener('click', eat, { capture: true, once: true })
      window.setTimeout(() => at.anchor.removeEventListener('click', eat, { capture: true }), 800) // 按下后拖走了没有 click:别吞下一次
    }
    close()
  }
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', close)
  const p = anchorPoint(at)
  const paint = (list: readonly PluginMenuEntry[]): void => {
    const rows = list.filter((it): it is Extract<PluginMenuEntry, { kind: 'item' }> => it.kind === 'item')
    const anyIcon = rows.some((it) => vocabIcon(it.icon))
    const anyChecked = rows.some((it) => typeof it.checked === 'boolean')
    root.render(
      <OverlayAt className="ctx-menu ctx-menu-scroll plugin-menu" x={p.x} y={p.y} anchorTop={p.anchorTop} prefer={p.prefer} alignEnd={p.alignEnd}
        role="menu" onContextMenu={(e) => e.preventDefault()}>
        {list.map((it, i) => it.kind === 'sep' ? <div key={i} className="ctx-separator" role="separator" />
          : it.kind === 'head' ? <div key={i} className="ctx-head" role="presentation">{pluginText(it.label)}</div>
            : (
              <button key={i} type="button" role={typeof it.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem'} aria-checked={typeof it.checked === 'boolean' ? it.checked : undefined}
                className={it.danger ? 'danger' : undefined} disabled={it.disabled}
                onClick={() => { if (!opts.keepOpen) close(); guard(() => it.run()) }}>
                {anyIcon ? <Icon name={it.icon} /> : anyChecked ? <Check size={13} style={{ opacity: it.checked ? 1 : 0 }} /> : null}
                <span className="plugin-menu-label">{pluginText(it.label)}</span>
                {it.shortcut ? <kbd className="ctx-shortcut">{it.shortcut}</kbd> : null}
                {anyIcon && anyChecked ? <Check size={13} className="plugin-menu-check" style={{ opacity: it.checked ? 1 : 0 }} /> : null}
              </button>
            ))}
      </OverlayAt>,
    )
  }
  paint(items)
  current = close
  return Object.assign(close, { update: (next: readonly PluginMenuEntry[]) => { if (open) paint(next) } })
}
