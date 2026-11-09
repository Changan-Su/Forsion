/** 从收纳面板把瓷砖直接拖进主页(11-08 方案 B「原地淡出」,方案页 docs/ToBeImproved/主页小组件拖放方案_2026-11-08/,仓根)。
 *  按住瓷砖动 4px 才算拖,不动 = 现在的「点一下放进第一个空位」。拿起那一刻面板和遮罩原地淡出、主页进编辑态;
 *  松手放进去 = 面板不回来、停在编辑态;放不下 / 取消 = 影子飞回瓷砖、面板淡回原处。满了就放不了(11-08 用户定),不做「放在卡上换下」。
 *  判定照 Dashboard #378:只按抬起时量下的格子矩形命中(主页从面板后面回来那一下停稳前每步重量,停稳后冻结),
 *  不用 elementFromPoint,悬停时别的卡不挪。落点走 LCL dropIndicator,松手走 land()。 */
import { createDropIndicator, land, landWhenMoved, LAND_MS, reducedMotion, zoomOf } from '@lcl/engine'
import { registerMessages } from '../i18n'
import { panelToast } from '../components/PanelNotice'
import { motion } from '../theme/motionTokens'
import {
  RAIL_MAX, ROW_CELLS, STATUS_CARD, addCenterPart, isOnHome, moveCenterPart, moveOnHome, readHomeLayout, removeCenterPart, removeFromHome, saveHomeLayout,
  type HomeLayout, type HomePart,
} from './homeWidgets'

registerMessages({
  'home.drop.full.left': { zh: '左栏满了 · 最多 3 张', en: 'Left column is full · 3 max' },
  'home.drop.full.right': { zh: '右栏满了 · 最多 3 张', en: 'Right column is full · 3 max' },
  'home.drop.rowStatus': { zh: '下排被近况卡占满了（4 格）', en: 'The row is taken by Status cards (4 slots)' },
  'home.drop.rowFull': { zh: '下排 4 格满了', en: 'All 4 row slots are taken' },
  'home.drop.statusBusy': { zh: '近况卡要占满下排 4 格：先拿掉下排的卡', en: 'Status cards need all 4 row slots. Remove the row cards first' },
  'home.drop.statusRail': { zh: '近况卡只能放下排（占满 4 格）', en: 'Status cards only go in the row (all 4 slots)' },
  'home.drop.partCenter': { zh: '时钟和 Space 坞只放中间这一列', en: 'Clock and Space dock stay in the middle column' },
  'home.drop.hintSides': { zh: '放到左右两栏或下排', en: 'Drop it in a side column or the row' },
  'home.drop.folds.left': { zh: '窗口不够宽：点完成后，左栏收成图标条', en: 'Narrow window: after Done, the left column folds into icons' },
  'home.drop.folds.right': { zh: '窗口不够宽：点完成后，右栏收成图标条', en: 'Narrow window: after Done, the right column folds into icons' },
  'home.drop.added.left': { zh: '已放到左栏', en: 'Added to the left column' },
  'home.drop.added.right': { zh: '已放到右栏', en: 'Added to the right column' },
  'home.drop.added.row': { zh: '已放到下排', en: 'Added to the row' },
  'home.drop.addedPart': { zh: '已放回中列：{name}', en: 'Put {name} back' },
  'home.drop.undo': { zh: '撤销', en: 'Undo' },
})

/** 拖的是哪一样:小组件(两栏 / 下排)或拿掉过的主页组件(时钟 / Space 坞,只回中列)。 */
export type LibItem = { kind: 'widget'; id: string } | { kind: 'part'; part: HomePart; name: string }

// ── 判定(纯函数,homeLibraryDrag.test.ts 钉着) ──
export interface Box { x: number; y: number; w: number; h: number }
export interface HomeGeometry {
  rails: Partial<Record<'left' | 'right', { r: Box; slots: { id: string; r: Box; empty: boolean }[] }>>
  row: { r: Box; gap: number; cells: { id: string; r: Box; empty: boolean }[] } | null
  stack: Box | null
  parts: { part: HomePart; r: Box }[]
  /** 视口 px / CSS px(body 的界面缩放,用户 dev 110%):偏移量写的是 CSS px,比较前乘上它。 */
  zoom: number
}
export type DropMark = { shape: 'zone'; r: Box } | { shape: 'line'; axis: 'h' | 'v'; r: Box }
export type DropHit =
  | { type: 'rail'; side: 'left' | 'right'; index: number; key: string; mark: DropMark; note?: string }
  | { type: 'row'; index: number; w: 1 | 2 | 4; key: string; mark: DropMark }
  | { type: 'part'; before: HomePart | null; key: string; mark: DropMark }
  /** 放不下:小签说原因、影子半透明、不画落点;松手 = 取消。 */
  | { type: 'no'; key: string; note: string }
  /** 中列只接主页组件:小组件到这儿只指路,不算放不下(不变灰);松手 = 取消。 */
  | { type: 'hint'; key: string; note: string }

const right = (r: Box): number => r.x + r.w
const bottom = (r: Box): number => r.y + r.h
const inside = (r: Box, x: number, y: number, pad = 0): boolean => x >= r.x - pad && x <= right(r) + pad && y >= r.y - pad && y <= bottom(r) + pad

/** 指针 (x, y)(视口 px)落在哪:`folds[side]` = 放进这一栏后点「完成」它会收成图标条(悬停时提前说)。 */
export function hitLibraryDrop(g: HomeGeometry, l: HomeLayout, item: LibItem, x: number, y: number, folds: { left: boolean; right: boolean } = { left: false, right: false }): DropHit | null {
  const Z = g.zoom || 1
  if (item.kind === 'part') {
    const s = g.stack
    if (s && g.parts.length && x >= s.x - 24 * Z && x <= right(s) + 24 * Z && y >= s.y - 40 * Z && y <= bottom(s) + 40 * Z) {
      const i = g.parts.findIndex((p) => y < p.r.y + p.r.h / 2)
      const next = i < 0 ? null : g.parts[i]
      const prev = i < 0 ? g.parts[g.parts.length - 1] : i > 0 ? g.parts[i - 1] : null
      const ly = next && prev ? (bottom(prev.r) + next.r.y) / 2 : next ? next.r.y - 11 * Z : bottom(prev!.r) + 11 * Z
      return { type: 'part', before: next?.part ?? null, key: `part:${next?.part ?? 'end'}`, mark: { shape: 'line', axis: 'h', r: { x: s.x, y: ly - 1.5 * Z, w: s.w, h: 0 } } }
    }
    for (const side of ['left', 'right'] as const) {
      const rail = g.rails[side]
      if (rail && inside(rail.r, x, y, 12 * Z)) return { type: 'no', key: `no:part:${side}`, note: 'home.drop.partCenter' }
    }
    return null
  }
  const id = item.id
  for (const side of ['left', 'right'] as const) {
    const rail = g.rails[side]
    if (!rail || !inside(rail.r, x, y, 16 * Z)) continue
    if (id === STATUS_CARD) return { type: 'no', key: `no:status:${side}`, note: 'home.drop.statusRail' }
    if (l[side].length >= RAIL_MAX) return { type: 'no', key: `no:full:${side}`, note: side === 'left' ? 'home.drop.full.left' : 'home.drop.full.right' }
    const cards = rail.slots.filter((s) => !s.empty)
    const empty = rail.slots.find((s) => s.empty)
    const index = cards.filter((c) => y > c.r.y + c.r.h / 2).length
    const note = folds[side] ? (side === 'left' ? 'home.drop.folds.left' : 'home.drop.folds.right') : undefined
    if (index === cards.length && empty) return { type: 'rail', side, index, key: `${side}:${index}`, mark: { shape: 'zone', r: empty.r }, note }
    const ly = index === 0 ? cards[0].r.y - 6 * Z : index === cards.length ? bottom(cards[index - 1].r) + 6 * Z : (bottom(cards[index - 1].r) + cards[index].r.y) / 2
    return { type: 'rail', side, index, key: `${side}:${index}`, mark: { shape: 'line', axis: 'h', r: { x: rail.r.x, y: ly - 1.5 * Z, w: rail.r.w, h: 0 } }, note }
  }
  const row = g.row
  if (row && inside(row.r, x, y, 12 * Z)) {
    const used = l.row.reduce((s, c) => s + c.w, 0)
    const cells = row.cells.filter((c) => !c.empty)
    const empty = row.cells.find((c) => c.empty)
    if (id === STATUS_CARD) {
      if (l.row.length || !empty) return { type: 'no', key: 'no:status:row', note: 'home.drop.statusBusy' }
      return { type: 'row', index: 0, w: 4, key: 'row:0', mark: { shape: 'zone', r: empty.r } }
    }
    const free = ROW_CELLS - used
    if (free <= 0) return { type: 'no', key: 'no:row', note: l.row.some((c) => c.id === STATUS_CARD) ? 'home.drop.rowStatus' : 'home.drop.rowFull' }
    const w = free >= 2 ? 2 : 1
    const index = cells.filter((c) => x > c.r.x + c.r.w / 2).length
    if (index === cells.length && empty) {
      const cw = (row.r.w - (ROW_CELLS - 1) * row.gap) / ROW_CELLS
      return { type: 'row', index, w, key: `row:${index}`, mark: { shape: 'zone', r: { x: empty.r.x, y: empty.r.y, w: w * cw + (w - 1) * row.gap, h: empty.r.h } } }
    }
    const lx = index === 0 ? cells[0].r.x - row.gap / 2 : index === cells.length ? right(cells[index - 1].r) + row.gap / 2 : (right(cells[index - 1].r) + cells[index].r.x) / 2
    return { type: 'row', index, w, key: `row:${index}`, mark: { shape: 'line', axis: 'v', r: { x: lx - 1 * Z, y: row.r.y, w: 0, h: row.r.h } } }
  }
  if (g.parts.some((p) => p.part !== 'row' && inside(p.r, x, y))) return { type: 'hint', key: 'hint:center', note: 'home.drop.hintSides' }
  return null
}

/** 判定结果 → 新摆放(放不下回 null)。 */
export function applyLibraryDrop(l: HomeLayout, item: LibItem, hit: DropHit): HomeLayout | null {
  if (item.kind === 'part') return hit.type === 'part' && !l.center.includes(item.part) ? moveCenterPart(addCenterPart(l, item.part), item.part, hit.before) : null
  if (isOnHome(l, item.id)) return null
  if (hit.type === 'rail') return moveOnHome(l, item.id, { area: hit.side, index: hit.index })
  if (hit.type === 'row') return moveOnHome(l, item.id, { area: 'row', index: hit.index }, hit.w)
  return null
}

// ── 量格子(DOM) ──
const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
export function measureHome(root: HTMLElement): HomeGeometry {
  const g: HomeGeometry = { rails: {}, row: null, stack: null, parts: [], zoom: zoomOf(root) || 1 }
  for (const side of ['left', 'right'] as const) {
    const el = root.querySelector<HTMLElement>(`.hp-rail-${side}[data-home-area]`)
    if (!el || !el.getClientRects().length) continue
    g.rails[side] = {
      r: box(el),
      slots: [...el.querySelectorAll<HTMLElement>(':scope > [data-home-slot]')].map((s) => ({ id: s.dataset.homeId ?? '', r: box(s), empty: s.classList.contains('hp-slot-empty') })),
    }
  }
  const row = root.querySelector<HTMLElement>('.hp-row[data-home-area="row"]')
  if (row && row.getClientRects().length) {
    g.row = {
      r: box(row),
      gap: (Number.parseFloat(getComputedStyle(row).columnGap) || 10) * g.zoom,
      cells: [...row.querySelectorAll<HTMLElement>(':scope > [data-home-slot]')].map((c) => ({ id: c.dataset.homeId ?? '', r: box(c), empty: c.classList.contains('hp-slot-empty') })),
    }
  }
  const stack = root.querySelector<HTMLElement>('.hp-stack')
  if (stack) {
    g.stack = box(stack)
    g.parts = [...stack.querySelectorAll<HTMLElement>(':scope > [data-home-part]')].map((p) => ({ part: p.dataset.homePart as HomePart, r: box(p) }))
  }
  return g
}

// ── 撤销:撤的是「放进来」这一下 = 把它从主页拿掉(之后又挪过也照样对) ──
let lastDrop: LibItem | null = null
function undoItem(item: LibItem): boolean {
  const cur = readHomeLayout()
  if (item.kind === 'part') {
    if (!cur.center.includes(item.part)) return false
    saveHomeLayout(removeCenterPart(cur, item.part))
  } else {
    if (!isOnHome(cur, item.id)) return false
    saveHomeLayout(removeFromHome(cur, item.id))
  }
  if (lastDrop === item) lastDrop = null
  return true
}
/** 编辑态里的 ⌘Z:撤最近一次从收纳拖进来的那一下。没有可撤的回 false(按键照常往下走)。 */
export function undoLibraryDrop(): boolean {
  const item = lastDrop
  lastDrop = null
  return !!item && undoItem(item)
}
export const forgetLibraryDrop = (): void => { lastDrop = null }

// ── 拖 ──
const DRAG_START_PX = 4
/** 主页从面板后面回来(中列 scale 回 1、两栏浮现、编辑态的空位长出来)那一下停稳之前,每步都重量格子。 */
const SETTLE_MS = 320
const ICON_NO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>'
const ICON_INFO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'

export interface LibraryDragHost {
  root: HTMLElement
  t: (key: string, params?: Record<string, string | number>) => string
  /** 抬起:面板原地淡出、主页进编辑态。 */
  onLift: () => void
  /** 放进去了:面板收起、停在编辑态。 */
  onPlaced: () => void
  /** 取消 / 放不下:面板淡回原处,编辑态回到拿起之前。 */
  onCancel: () => void
  /** 放进这一栏之后点「完成」,它会不会收成图标条(悬停时提前说);按主页自己的宽度算,和 HomepageView 同一套 railModes。 */
  folds?: (l: HomeLayout) => { left: boolean; right: boolean }
}

let active = false
/** 瓷砖上的 pointerdown。没动够 4px 就松手 = 什么都不做,交给瓷砖自己的 click(点一下放第一个空位)。 */
export function startLibraryDrag(e: React.PointerEvent<HTMLElement>, item: LibItem, host: LibraryDragHost): void {
  const tile = e.currentTarget
  if (active || e.button !== 0 || (tile as HTMLButtonElement).disabled) return
  e.preventDefault() // 不起文字选区;click 照常来
  const { root, t } = host
  const x0 = e.clientX, y0 = e.clientY
  const home = tile.getBoundingClientRect()
  const grab = { x: x0 - home.left, y: y0 - home.top }
  let lifted = false
  let ghost: HTMLElement | null = null
  let note: HTMLElement | null = null
  let noteKey: string | null = null
  let ind: ReturnType<typeof createDropIndicator> | null = null
  let geo: HomeGeometry | null = null
  let settleAt = 0
  let settleTimer = 0
  let last = { x: x0, y: y0 }
  let buttons = 1
  let hit: DropHit | null = null
  active = true

  const z = (): number => zoomOf(document.body) || 1
  const placeGhost = (): void => {
    if (!ghost) return
    const k = z()
    ghost.style.translate = `${(last.x - grab.x) / k}px ${(last.y - grab.y) / k}px`
    if (note?.classList.contains('on')) {
      const r = ghost.getBoundingClientRect()
      note.style.translate = `${(r.left + r.width / 2) / k}px ${(r.bottom + 8 * k) / k}px`
    }
  }
  const showNote = (text: string | undefined, kind: 'no' | 'info', key: string): void => {
    if (!note) return
    if (!text) { noteKey = null; note.classList.remove('on'); return }
    if (noteKey !== key) {
      noteKey = key
      note.dataset.kind = kind
      note.innerHTML = `${kind === 'no' ? ICON_NO : ICON_INFO}<span></span>`
      note.querySelector('span')!.textContent = t(text)
    }
    note.classList.add('on')
  }
  const judge = (): void => {
    if (!geo) return
    const l = readHomeLayout()
    hit = hitLibraryDrop(geo, l, item, last.x, last.y, host.folds?.(l))
    const no = hit?.type === 'no'
    ghost?.classList.toggle('is-no', no)
    document.body.classList.toggle('hp-lib-nodrop', no)
    if (hit && 'mark' in hit) {
      const m = hit.mark
      if (m.shape === 'zone') ind?.zone(m.r, { key: hit.key })
      else ind?.line(m.r, { key: hit.key, axis: m.axis })
    } else ind?.hide()
    const text = hit && 'note' in hit ? hit.note : undefined
    showNote(text, no ? 'no' : 'info', hit?.key ?? '')
    placeGhost()
  }
  const lift = (): void => {
    lifted = true
    lastDrop = null
    const k = z()
    ghost = tile.cloneNode(true) as HTMLElement
    ghost.removeAttribute('disabled')
    ghost.removeAttribute('aria-pressed')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.classList.add('hp-lib-ghost')
    ghost.style.width = `${home.width / k}px`
    ghost.style.height = `${home.height / k}px`
    note = document.createElement('div')
    note.className = 'hp-lib-note-pill'
    note.setAttribute('role', 'status')
    document.body.append(ghost, note)
    if (!reducedMotion()) ghost.animate([{ scale: '1' }, { scale: '1.04' }], { duration: motion.ms('instant'), easing: motion.css('surface') })
    tile.classList.add('is-source')
    document.body.classList.add('hp-lib-dragging')
    ind = createDropIndicator({ host: root, className: 'hp-drop-ind' })
    host.onLift()
    settleAt = performance.now() + SETTLE_MS
    settleTimer = window.setTimeout(() => { if (active) { geo = measureHome(root); judge() } }, SETTLE_MS + 20)
    geo = measureHome(root)
    judge()
  }
  const move = (ev: PointerEvent): void => {
    last = { x: ev.clientX, y: ev.clientY }
    buttons = ev.buttons
    if (!lifted) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return
      lift()
      return
    }
    if (performance.now() < settleAt) geo = measureHome(root)
    judge()
  }
  const finish = (): void => {
    active = false
    window.clearTimeout(settleTimer)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', esc, true)
    window.removeEventListener('blur', cancel)
    ind?.destroy()
    note?.remove()
    document.body.classList.remove('hp-lib-dragging', 'hp-lib-nodrop')
  }
  /** 拖过之后松手,浏览器会在指针下补一次 click(落在主页上 = 收起面板、落在瓷砖上 = 再放一张):吞掉这一下。 */
  const swallowClick = (): void => {
    const eat = (ev: MouseEvent): void => { ev.preventDefault(); ev.stopPropagation() }
    window.addEventListener('click', eat, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', eat, true), 0)
  }
  const flyBack = (): void => {
    host.onCancel()
    const g = ghost
    if (!g) return
    g.classList.remove('is-no')
    const done = (): void => { g.remove(); tile.classList.remove('is-source') }
    if (reducedMotion()) { done(); return }
    const k = z()
    const to = tile.getBoundingClientRect()
    g.animate([{ translate: g.style.translate }, { translate: `${to.left / k}px ${to.top / k}px` }], { duration: motion.ms('slow'), easing: motion.css('surface'), fill: 'forwards' })
      .finished.then(done, done)
  }
  const place = (): boolean => {
    if (!hit || (hit.type !== 'rail' && hit.type !== 'row' && hit.type !== 'part')) return false
    const cur = readHomeLayout()
    const next = applyLibraryDrop(cur, item, hit)
    if (!next) return false
    const g = ghost!
    const from = g.getBoundingClientRect()
    const flip = snapshot(root)
    const find = (): HTMLElement | null => item.kind === 'part'
      ? root.querySelector<HTMLElement>(`.hp-stack > [data-home-part="${item.part}"]`)
      : root.querySelector<HTMLElement>(`[data-home-id="${CSS.escape(item.id)}"]`)
    // 新卡从松手处滑进(LCL land),被挤开的卡和空位同一段时长滑到新位置(只挪不缩)
    landWhenMoved(find, { x: from.left, y: from.top }, { onMoved: (el) => { replay(root, flip, el); land(el, { x: from.left, y: from.top }) } })
    saveHomeLayout(next)
    lastDrop = item
    const where = item.kind === 'part' ? t('home.drop.addedPart', { name: item.name })
      : t(hit.type === 'row' ? 'home.drop.added.row' : hit.type === 'rail' && hit.side === 'left' ? 'home.drop.added.left' : 'home.drop.added.right')
    panelToast(where, false, { action: { label: t('home.drop.undo'), run: () => { undoItem(item) } } })
    tile.classList.remove('is-source')
    if (reducedMotion()) g.remove()
    else g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motion.ms('instant'), easing: motion.css('exit'), fill: 'forwards' }).finished.then(() => g.remove(), () => g.remove())
    host.onPlaced()
    return true
  }
  const up = (): void => {
    finish()
    if (!lifted) return
    swallowClick()
    if (!place()) flyBack()
  }
  const cancel = (): void => {
    finish()
    if (lifted) flyBack()
  }
  const esc = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    cancel()
    // Esc 取消时手往往还按着:之后松手补发的 click 会落在淡回来的遮罩上,把面板收掉。等那一下松手再吞;
    // 松手发生在窗口外(收不到)的话,下一次按下就作罢,不吃别人的 click。
    if (lifted && buttons & 1) {
      const release = (): void => { window.removeEventListener('pointerdown', drop, true); swallowClick() }
      const drop = (): void => window.removeEventListener('pointerup', release, true)
      window.addEventListener('pointerup', release, { capture: true, once: true })
      window.addEventListener('pointerdown', drop, { capture: true, once: true })
    }
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', esc, true)
  window.addEventListener('blur', cancel)
}

// ── 落位动画 ──
type Snap = Map<string, DOMRect>
const keyOf = (el: HTMLElement): string | null => el.dataset.homeId
  ?? (el.dataset.homePart ? `part:${el.dataset.homePart}` : el.classList.contains('hp-slot-empty') ? `empty:${el.dataset.homeSlot?.split(':')[0]}` : null)
const movers = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-home-slot], .hp-stack > [data-home-part]')]
function snapshot(root: HTMLElement): Snap {
  const m: Snap = new Map()
  for (const el of movers(root)) { const k = keyOf(el); if (k) m.set(k, el.getBoundingClientRect()) }
  return m
}
function replay(root: HTMLElement, before: Snap, skip: HTMLElement): void {
  if (reducedMotion()) return
  for (const el of movers(root)) {
    if (el === skip) continue
    const k = keyOf(el)
    const a = k ? before.get(k) : null
    if (!a) continue
    const b = el.getBoundingClientRect(), z = zoomOf(el) || 1
    const dx = (a.left - b.left) / z, dy = (a.top - b.top) / z
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: LAND_MS, easing: motion.css('surface') })
  }
}
