/** 桌面主页的小组件(主页第四轮,11-02 定):左右栏(各 ≤3 张、256 宽)+ 中间下排 4 格 + 编辑态。
 *  三条轨道各占各的:外边 16 · 侧栏 256 · 中间固定 840 不缩,之间至少 32;按主页自己的宽度先收左栏、再收右栏,
 *  收起是一条 36 宽的图标条,点开浮出整张卡,不推中间。摆放见 homeWidgets.ts(别和本文件同名换大小写:mac 文件系统不分)。手机本轮不做。 */
import { useEffect, useRef, useState } from 'react'
import { Check, GripVertical, LayoutGrid, Minus, Plus, Sparkles } from 'lucide-react'
import { createDropIndicator, land } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { WidgetHost, useWidgetTitle } from '../components/WidgetHost'
import { panelToast } from '../components/PanelNotice'
import { listWidgets, useWidgetListGen, type WidgetListItem } from '../services/widgetClient'
import { useWidgetOwner } from '../components/WidgetHost'
import {
  STATUS_CARD, ROW_CELLS, RAIL_MAX, addCenterPart, isOnHome, moveCenterPart, moveOnHome, placeOnHome, readHomeLayout,
  removeCenterPart, removeFromHome, resizeRowCell, saveHomeLayout, type HomeLayout, type HomePart, type HomeSlot,
} from './homeWidgets'

registerMessages({
  'home.edit.hint': { zh: '拖动调整位置；Esc 退出', en: 'Drag to rearrange. Esc to exit' },
  'home.edit.done': { zh: '完成', en: 'Done' },
  'home.edit.add': { zh: '添加组件', en: 'Add' },
  'home.edit.remove': { zh: '从主页拿掉', en: 'Remove from Home' },
  'home.edit.width': { zh: '{n} 格', en: '{n} slot(s)' },
  'home.edit.drag': { zh: '拖动', en: 'Drag' },
  'home.edit.empty': { zh: '空位', en: 'Empty' },
  'home.edit.dropHere': { zh: '松手放在这里', en: 'Drop here' },
  'home.edit.full': { zh: '下排和右栏都满了', en: 'The row and side column are full' },
  'home.edit.rail.left': { zh: '左栏', en: 'Left' },
  'home.edit.rail.right': { zh: '右栏', en: 'Right' },
  'home.part.clock': { zh: '时钟', en: 'Clock' },
  'home.part.composer': { zh: '输入框', en: 'Chat box' },
  'home.part.dock': { zh: 'Space 坞', en: 'Space dock' },
  'home.part.row': { zh: '下排', en: 'Row' },
  'home.widget.status': { zh: '近况卡', en: 'Status cards' },
  'home.lib.added': { zh: '已放', en: 'Added' },
  'home.lib.builtin': { zh: '内置', en: 'Built-in' },
  'home.lib.ask': { zh: '让 Agent 做一个', en: 'Ask an agent to make one' },
  'home.lib.askDraft': { zh: '帮我做一个小组件：', en: 'Make me a widget: ' },
  'home.lib.hint': { zh: '点一下放进第一个空位（先下排后右栏）', en: 'Click to fill the first empty slot (row first, then the side column)' },
  'home.lib.partsHint': { zh: '拿掉的主页组件在这里，点一下放回', en: 'Removed Home parts wait here. Click one to put it back' },
  'home.lib.loadFailed': { zh: '小组件读不到：{msg}', en: "Couldn't read widgets: {msg}" },
  'home.lib.empty': { zh: '还没有小组件。在对话里让 Agent 做一个。', en: 'No widgets yet. Ask an agent in a chat.' },
})

// ── 三栏几何 ──
export const RAIL_W = 256, STRIP_W = 36, EDGE = 16, GAP = 32, CENTER_W = 840
export type RailMode = 'open' | 'strip' | 'hidden'
/** 主页宽(不含 Ribbon)→ 两栏的样子:≥1448 三栏;≥1228 先收左栏;≥1008 两栏都收;更窄只剩中间。 */
export function railModes(width: number): { left: RailMode; right: RailMode } {
  const strip = (open: boolean): RailMode => (open ? 'open' : width >= 1008 ? 'strip' : 'hidden')
  return { left: strip(width >= 1448), right: strip(width >= 1228) }
}
const reserve = (mode: RailMode, shown: boolean): number => (!shown ? 0 : mode === 'open' ? EDGE + RAIL_W + GAP : mode === 'strip' ? EDGE + STRIP_W + GAP : 0)
/** 中间那块的横向让位:居中放得下就居中;否则贴着有东西的那一栏留 32(空栏不占地方)。 */
export function centerShift(width: number, left: { mode: RailMode; shown: boolean }, right: { mode: RailMode; shown: boolean }): number {
  const nat = (width - CENTER_W) / 2
  const lo = reserve(left.mode, left.shown), hi = width - reserve(right.mode, right.shown) - CENTER_W
  if (lo > hi) return 0
  return Math.min(Math.max(nat, lo), hi) - nat
}

// ── 卡 ──
function WidgetCard({ id, editing, compact, onRemove, extra, grip }: { id: string; editing: boolean; compact?: boolean; onRemove: () => void; extra?: React.ReactNode; grip?: (e: React.PointerEvent) => void }): React.JSX.Element {
  const { title, owner } = useWidgetTitle(id)
  return (
    <section className={`hp-wcard${compact ? ' hp-wcard-compact' : ''}`} data-widget-id={id}>
      <header className="hp-wcard-h" onPointerDown={editing ? grip : undefined}>
        <LayoutGrid size={13} /><span className="hp-wcard-title">{title}</span>{owner && <span className="hp-wcard-owner">{owner}</span>}
        {editing && <EditCtrls onRemove={onRemove} extra={extra} />}
      </header>
      <div className="hp-wcard-body"><WidgetHost id={id} onRemove={onRemove} /></div>
    </section>
  )
}

function EditCtrls({ onRemove, extra }: { onRemove?: () => void; extra?: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <span className="hp-edit-ctrls">
      {extra}
      {onRemove && <button type="button" className="hp-edit-btn" aria-label={t('home.edit.remove')} title={t('home.edit.remove')} onClick={(e) => { e.stopPropagation(); onRemove() }}><Minus size={13} /></button>}
      <span className="hp-edit-grip" aria-hidden title={t('home.edit.drag')}><GripVertical size={13} /></span>
    </span>
  )
}

/** 主页组件(时钟 / 输入框 / 下排 / 坞)在编辑态的外框:淡框 + 「−」+ 把手;样子本身一个像素不动。 */
export function PartFrame({ part, editing, children, onRemove, onGrip }: { part: HomePart; editing: boolean; children: React.ReactNode; onRemove?: () => void; onGrip: (e: React.PointerEvent, part: HomePart) => void }): React.JSX.Element {
  if (!editing) return <>{children}</>
  return (
    <div className="hp-part-frame" data-home-part={part}>
      <div className="hp-part-tab" onPointerDown={(e) => onGrip(e, part)}><EditCtrls onRemove={onRemove} /></div>
      {/* 下排自己管:卡身不可点,删除 / 宽度 / 把手 / 落点照常 */}
      {part === 'row' ? children : <div className="hp-part-inert">{children}</div>}
    </div>
  )
}

// ── 侧栏 ──
export function HomeRail({ side, ids, mode, editing, onGrip }: { side: 'left' | 'right'; ids: string[]; mode: RailMode; editing: boolean; onGrip: (e: React.PointerEvent, id: string) => void }): React.JSX.Element | null {
  const { t } = useI18n()
  const [pop, setPop] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pop) return
    const off = (e: Event): void => { if (!ref.current?.contains(e.target as Node)) setPop(null) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setPop(null) } }
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', esc, true) }
  }, [pop])
  if (mode === 'hidden' || (!ids.length && !editing)) return null
  const remove = (id: string): void => saveHomeLayout(removeFromHome(readHomeLayout(), id))
  // 窄窗下进编辑态:收起的那栏临时展开成浮层,方便往里拖
  if (mode === 'strip' && !editing) {
    return (
      <div ref={ref} className={`hp-rail hp-strip hp-rail-${side}`}>
        {ids.map((id) => <StripIcon key={id} id={id} on={pop === id} onClick={() => setPop(pop === id ? null : id)} />)}
        {pop && <div className="hp-wpop"><WidgetCard id={pop} editing={false} onRemove={() => { setPop(null); remove(pop) }} /></div>}
      </div>
    )
  }
  return (
    <div className={`hp-rail hp-rail-${side}${mode === 'strip' ? ' hp-rail-overlay' : ''}`} data-home-area={side} aria-label={t(`home.edit.rail.${side}`)}>
      {ids.map((id, i) => (
        <div key={id} className="hp-slot" data-home-slot={`${side}:${i}`} data-home-id={id}>
          <WidgetCard id={id} editing={editing} onRemove={() => remove(id)} grip={(e) => onGrip(e, id)} />
        </div>
      ))}
      {editing && ids.length < RAIL_MAX && <div className="hp-slot hp-slot-empty" data-home-slot={`${side}:${ids.length}`}>{t('home.edit.empty')}</div>}
    </div>
  )
}

function StripIcon({ id, on, onClick }: { id: string; on: boolean; onClick: () => void }): React.JSX.Element {
  const { title } = useWidgetTitle(id)
  return <button type="button" className={`hp-strip-btn${on ? ' on' : ''}`} title={title} aria-label={title} aria-expanded={on} onClick={onClick}><LayoutGrid size={16} /></button>
}

// ── 下排 ──
export function HomeRow({ cells, editing, status, onGrip }: { cells: HomeLayout['row']; editing: boolean; status: React.ReactNode; onGrip: (e: React.PointerEvent, id: string) => void }): React.JSX.Element | null {
  const { t } = useI18n()
  const used = cells.reduce((s, c) => s + c.w, 0)
  if (!cells.length && !editing) return null
  // 没动过的老用户:下排就是近况卡那一排,DOM 和今天一模一样
  if (!editing && cells.length === 1 && cells[0].id === STATUS_CARD) return <>{status}</>
  const remove = (id: string): void => saveHomeLayout(removeFromHome(readHomeLayout(), id))
  return (
    <div className="hp-row" data-home-area="row">
      {cells.map((c, i) => (
        <div key={c.id} className="hp-slot hp-row-cell" style={{ gridColumn: `span ${c.w}` }} data-home-slot={`row:${i}`} data-home-id={c.id}>
          {c.id === STATUS_CARD
            ? <div className="hp-row-status">{editing && <div className="hp-row-status-tab" onPointerDown={(e) => onGrip(e, c.id)}><span className="hp-wcard-title">{t('home.widget.status')}</span><EditCtrls onRemove={() => remove(c.id)} /></div>}<div className={editing ? 'hp-part-inert' : undefined}>{status}</div></div>
            : <WidgetCard id={c.id} editing={editing} compact onRemove={() => remove(c.id)} grip={(e) => onGrip(e, c.id)}
                extra={<button type="button" className="hp-edit-btn hp-edit-w" onClick={(e) => { e.stopPropagation(); saveHomeLayout(resizeRowCell(readHomeLayout(), c.id)) }}>{t('home.edit.width', { n: c.w })}</button>} />}
        </div>
      ))}
      {editing && used < ROW_CELLS && <div className="hp-slot hp-slot-empty" style={{ gridColumn: `span ${ROW_CELLS - used}` }} data-home-slot={`row:${cells.length}`}>{t('home.edit.empty')}</div>}
    </div>
  )
}

// ── 拖动:卡在栏 / 下排之间挪,主页组件上下挪。落点提示走 LCL dropIndicator(DESIGN §6) ──
const DRAG_START_PX = 4
function track(e: React.PointerEvent, el: HTMLElement, onMove: (ev: PointerEvent) => void, onDrop: () => boolean, cleanup: () => void): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
  e.preventDefault()
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const x0 = e.clientX, y0 = e.clientY
  let lifted = false
  const move = (ev: PointerEvent): void => {
    if (!lifted) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return
      lifted = true
      el.classList.add('hp-lifted')
    }
    el.style.translate = `${(ev.clientX - x0) / z}px ${(ev.clientY - y0) / z}px`
    onMove(ev)
  }
  const end = (commit: boolean): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', esc, true)
    const r = el.getBoundingClientRect()
    el.classList.remove('hp-lifted')
    el.style.translate = ''
    cleanup()
    if (!lifted || !commit || !onDrop()) land(el, { x: r.left, y: r.top })
  }
  const up = (): void => end(true)
  const cancel = (): void => end(false)
  const esc = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false) } }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', esc, true)
}

/** 小组件起拖:落点 = 指针下的那一格(卡或空位),插在它的位置。放不下(栏满 / 下排格子不够)卡回原处。 */
export function dragWidget(e: React.PointerEvent, id: string, root: HTMLElement | null): void {
  const el = root?.querySelector<HTMLElement>(`[data-home-id="${CSS.escape(id)}"]`)
  if (!root || !el) return
  const ind = createDropIndicator({ host: root })
  let to: HomeSlot | null = null
  track(e, el, (ev) => {
    el.style.pointerEvents = 'none'
    const slot = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-home-slot]')
    el.style.pointerEvents = ''
    if (!slot || slot === el) { to = null; ind.hide(); return }
    const [area, index] = slot.dataset.homeSlot!.split(':') as [HomeSlot['area'], string]
    to = { area, index: Number(index) }
    const r = slot.getBoundingClientRect()
    ind.zone({ x: r.left, y: r.top, w: r.width, h: r.height }, { key: slot.dataset.homeSlot })
  }, () => {
    if (!to) return false
    const cur = readHomeLayout()
    const from = cur.row.findIndex((c) => c.id === id) >= 0 ? { area: 'row', index: cur.row.findIndex((c) => c.id === id) } : cur.left.includes(id) ? { area: 'left', index: cur.left.indexOf(id) } : { area: 'right', index: cur.right.indexOf(id) }
    const index = from.area === to.area && from.index < to.index ? to.index - 1 : to.index
    const next = moveOnHome(cur, id, { area: to.area, index })
    if (!next) return false
    saveHomeLayout(next)
    return true
  }, () => ind.destroy())
}

/** 主页组件上下挪:落点线画在指针下面那一个的上沿。 */
export function dragPart(e: React.PointerEvent, part: HomePart, root: HTMLElement | null): void {
  const el = root?.querySelector<HTMLElement>(`[data-home-part="${part}"]`)
  if (!root || !el) return
  const ind = createDropIndicator({ host: root })
  let before: HomePart | null | undefined
  track(e, el, (ev) => {
    const parts = [...root.querySelectorAll<HTMLElement>('[data-home-part]')].filter((p) => p !== el)
    const next = parts.find((p) => { const r = p.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2 })
    before = next ? (next.dataset.homePart as HomePart) : null
    const anchor = next ?? parts[parts.length - 1]
    if (!anchor) { ind.hide(); return }
    const r = anchor.getBoundingClientRect()
    ind.line({ x: r.left, y: next ? r.top - 8 : r.bottom + 6, w: r.width }, { key: String(before) })
  }, () => {
    if (before === undefined) return false
    saveHomeLayout(moveCenterPart(readHomeLayout(), part, before))
    return true
  }, () => ind.destroy())
}

// ── 收纳面板里的两个标签 ──
export function placeWidgetOnHome(id: string, t: (k: string) => string): void {
  const cur = readHomeLayout()
  if (isOnHome(cur, id)) return
  const next = placeOnHome(cur, id)
  if (!next) { panelToast(t('home.edit.full'), true); return }
  saveHomeLayout(next)
}

export function WidgetLibrary({ layout, onAsk }: { layout: HomeLayout; onAsk: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const gen = useWidgetListGen()
  const [items, setItems] = useState<WidgetListItem[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    listWidgets().then((w) => { if (alive) { setItems(w.filter((x) => x.entry === 'widget.json')); setError('') } }).catch((e) => { if (alive) setError(String(e instanceof Error ? e.message : e)) })
    return () => { alive = false }
  }, [gen])
  return (
    <div className="hp-lib">
      <div className="hp-lib-grid">
        <LibTile icon={<LayoutGrid size={18} />} name={t('home.widget.status')} sub={t('home.lib.builtin')} on={isOnHome(layout, STATUS_CARD)}
          onClick={() => { const next = moveOnHome(readHomeLayout(), STATUS_CARD, { area: 'row', index: 0 }); if (next) saveHomeLayout(next); else panelToast(t('home.edit.full'), true) }} />
        {(items ?? []).map((w) => <WidgetLibTile key={w.id} w={w} on={isOnHome(layout, w.id)} onClick={() => placeWidgetOnHome(w.id, t)} />)}
        <LibTile icon={<Sparkles size={18} />} name={t('home.lib.ask')} on={false} onClick={onAsk} />
      </div>
      {error && <div className="hp-lib-note">{t('home.lib.loadFailed', { msg: error })}</div>}
      {items && !items.length && !error && <div className="hp-lib-note">{t('home.lib.empty')}</div>}
    </div>
  )
}

function WidgetLibTile({ w, on, onClick }: { w: WidgetListItem; on: boolean; onClick: () => void }): React.JSX.Element {
  const owner = useWidgetOwner(w)
  return <LibTile icon={<LayoutGrid size={18} />} name={w.title || w.name} sub={owner} on={on} onClick={onClick} />
}

function LibTile({ icon, name, sub, on, onClick }: { icon: React.ReactNode; name: string; sub?: string; on: boolean; onClick: () => void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <button type="button" className={`hp-lib-tile${on ? ' on' : ''}`} aria-pressed={on} disabled={on} onClick={onClick}>
      <span className="hp-lib-icon">{icon}</span>
      <span className="hp-lib-name">{name}</span>
      <span className="hp-lib-sub">{on ? <><Check size={11} />{t('home.lib.added')}</> : sub}</span>
    </button>
  )
}

export function PartsLibrary({ layout }: { layout: HomeLayout }): React.JSX.Element {
  const { t } = useI18n()
  const parts: HomePart[] = ['clock', 'composer', 'dock']
  return (
    <div className="hp-lib">
      <div className="hp-lib-grid">
        {parts.map((p) => {
          const on = layout.center.includes(p)
          return <LibTile key={p} icon={on ? <Check size={18} /> : <Plus size={18} />} name={t(`home.part.${p}`)} on={on} onClick={() => saveHomeLayout(addCenterPart(readHomeLayout(), p))} />
        })}
      </div>
    </div>
  )
}

export const removePart = (part: HomePart): void => saveHomeLayout(removeCenterPart(readHomeLayout(), part))
