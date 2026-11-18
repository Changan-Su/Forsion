// 表格悬停层(2026-11-17,「页面编辑对齐 Notion」第 3 条,用户按方案拍板):
//  · 悬停表格:右缘 / 下缘出加号条(浅底实色、圆角 6、不画虚线),点一下在末尾加一列 / 一行,光标进新格;
//    右下角圆点按住拖 = 一次加多行多列(拖时两条加号条跟着伸长、标出 +N,松手一笔事务 = 一个撤销步;只加不减)。
//  · 悬停的那一行左缘、那一列上缘出把手:点开 = 现有表格菜单按轴过滤(tableMenu.tsx 的 TableAxisMenu),
//    按住拖 = 行 / 列换序(列的对齐存在格子上,跟着走;表头恒为首行 → 表头行只给菜单不给拖,正文行也拖不到表头上)。
//  · 粗指针(手机 / 平板)没有悬停:加号条常显在每张表的表尾和右侧(表下留出位置,不盖住下一段),
//    不出把手与圆点;长按单元格 = 系统 contextmenu → blockLayer 现成的整表块菜单(表格区锚在按住的那一格)。
//  · 画布模式不出(舞台自管手势,没在舞台上验过);只读不出。
// 存的永远是标准 GFM 表格(原语全在 blocks/markdown/tableEdit.ts)。
//
// 结构:全部是挂在 `.milkdown` 容器里的 `<button>` 浮层,不进 PM 的 DOM、不给 PM 节点加 class
// (DOMObserver 会把那当成内容改动)。按钮是刻意的:blockLayer 的框选 onMqDown 见 button 就让路。
// 手势一律 pointer 事件 + 位移阈值分「点 / 拖」,不用 HTML5 拖放 —— 那条通道归 blockLayer 的捕获期 dragover / drop 路由。
// 定位与把手栏同一套:overlayOrigin(包含块原点)+ visualScale(累计缩放)反补偿,110% 缩放与画布舞台都成立。
// 仪器:npm run check:tablehover(scripts/table-hover.check.cjs)。
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { isCoarsePointer } from '../../touch'
import { registerMessages, subscribeLocale, translate } from '../../i18n'
import { appendTableTr, dispatchTableOp, moveTableColTr, moveTableRowTr, tableCellPos, tableSize } from '../blocks/markdown/tableEdit'
import { closeTableAxisMenu, openTableAxisMenu, subscribeTableAxisMenu, tableAxisMenuState } from './tableMenu'
import './tableHover.css'

registerMessages({
  'tablehover.addRow': { zh: '添加一行', en: 'Add a row' },
  'tablehover.addCol': { zh: '添加一列', en: 'Add a column' },
  'tablehover.corner': { zh: '拖动一次添加多行多列', en: 'Drag to add rows and columns' },
  'tablehover.rowGrip': { zh: '点击打开菜单，拖动调整行的顺序', en: 'Click for options, drag to move the row' },
  'tablehover.colGrip': { zh: '点击打开菜单，拖动调整列的顺序', en: 'Click for options, drag to move the column' },
})

type Axis = 'row' | 'col'
type Box = { left: number; top: number; width: number; height: number }

/** 布局 px(反补偿缩放之前的口径)。 */
const BAR = 18 // 加号条粗细(细指针);与方案图 i3-new 同尺寸
const BAR_TOUCH = 24 // 粗指针:手指要点得到
const GAP = 6 // 条与表边的缝。表下为它让出的位置见 tableHover.css(BAR + GAP 改了那边一起改)
const GRIP_LONG = 22
const GRIP_SHORT = 14
const DRAG_SLOP = 4 // 把手:超过这么多才算拖,否则是点
const MAX_ADD_ROWS = 30 // 右下角一次拖出来的上限(手一滑拖出几百行没有意义)
const MAX_ADD_COLS = 12
/** 右下角横拖每加一列的步长上限(布局 px):表格恒为整栏宽,列宽动辄两三百 px,按列宽算要拖出窗外才加得到第二列。 */
const COL_STEP_MAX = 96

const PLUS = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
/** 六点把手:行把手 2×3 竖排,列把手转 90° 成 3×2(CSS 只转图形,不转按钮盒)。 */
const DOTS = '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1.15"/><circle cx="6" cy="2" r="1.15"/><circle cx="2" cy="6" r="1.15"/><circle cx="6" cy="6" r="1.15"/><circle cx="2" cy="10" r="1.15"/><circle cx="6" cy="10" r="1.15"/></svg>'

export interface TableHoverGeometry {
  /** 绝对定位浮层的包含块原点(视口 px)。blockLayer 的 overlayOrigin。 */
  origin: (el: HTMLElement) => { x: number; y: number }
  /** 编辑器根的累计视觉缩放(CSS zoom × 舞台 scale)。blockLayer 的 visualScale(view.dom)。 */
  scale: () => number
}

interface Bars { row: HTMLButtonElement; col: HTMLButtonElement }

export function installTableHover(view: EditorView, container: HTMLElement, root: HTMLElement, geo: TableHoverGeometry): { update(): void; destroy(): void } {
  const made: HTMLElement[] = []
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = `amx-tbl-ui ${cls}`
    if (html) e.innerHTML = html
    if (e instanceof HTMLButtonElement) { e.type = 'button'; e.tabIndex = -1 }
    else e.setAttribute('aria-hidden', 'true')
    container.append(e)
    made.push(e)
    return e
  }
  const makeBars = (): Bars => {
    const row = el('button', 'amx-tbl-add', `<span class="amx-tbl-add-glyph">${PLUS}</span><span class="amx-tbl-add-count"></span>`)
    const col = el('button', 'amx-tbl-add', `<span class="amx-tbl-add-glyph">${PLUS}</span><span class="amx-tbl-add-count"></span>`)
    row.dataset.axis = 'row'
    col.dataset.axis = 'col'
    return { row, col }
  }
  // 细指针:一组跟着悬停的表走;粗指针:每张表一组(touchPool)。
  const bars = makeBars()
  const corner = el('button', 'amx-tbl-corner')
  const rowGrip = el('button', 'amx-tbl-grip', DOTS)
  const colGrip = el('button', 'amx-tbl-grip', DOTS)
  rowGrip.dataset.axis = 'row'
  colGrip.dataset.axis = 'col'
  const band = el('div', 'amx-tbl-band')
  const dropLine = el('div', 'amx-tbl-drop')
  const touchPool: Bars[] = []

  const setTitles = (): void => {
    const pairs: [HTMLElement, string][] = [[corner, 'tablehover.corner'], [rowGrip, 'tablehover.rowGrip'], [colGrip, 'tablehover.colGrip']]
    for (const b of [bars, ...touchPool]) pairs.push([b.row, 'tablehover.addRow'], [b.col, 'tablehover.addCol'])
    for (const [e, k] of pairs) { e.title = translate(k); e.setAttribute('aria-label', e.title) }
  }
  setTitles()
  const offLocale = subscribeLocale(setTitles)

  const show = (e: HTMLElement, on: boolean): void => { if (on) e.dataset.show = ''; else delete e.dataset.show }
  const coarse = (): boolean => isCoarsePointer()
  /** 画布模式(卡片在舞台上、舞台自管按下 / 框选 / 平移)先不出这层:没在舞台上验过,宁可没有也不跟舞台抢手势。
   *  表格在画布卡里照旧能用右键 / ⠿ 的表格菜单增删行列。 */
  const inCanvas = (): boolean => root.classList.contains('amx-canvas')

  // ── 几何 ──────────────────────────────────────────────────────────────────
  /** 最近的滚动 / 裁剪容器右缘(视口 px):浮层横向不越过它。 */
  const edgeRight = (): number => {
    for (let p: HTMLElement | null = container; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.display === 'contents') continue // 文档模式的 .amx-stage 是 contents 盒:overflow 不生效、rect 恒为 0
      const ox = cs.overflowX
      const r = p.getBoundingClientRect()
      if (r.width > 0 && (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip')) return r.right - 4
    }
    return window.innerWidth - 4
  }
  /** 一批「元素 → 视口 rect」先全部量完再统一写(读写不交错,不逼出一轮又一轮的同步排版)。
   *  所有浮层同在 `.milkdown` 里,包含块原点只量一次。 */
  const writeAll = (items: [HTMLElement, Box][]): void => {
    if (!items.length) return
    const z = geo.scale() || 1
    const o = geo.origin(items[0][0])
    for (const [e, b] of items) {
      e.style.left = `${(b.left - o.x) / z}px`
      e.style.top = `${(b.top - o.y) / z}px`
      e.style.width = `${b.width / z}px`
      e.style.height = `${b.height / z}px`
    }
  }
  /** 编辑器里一张可编辑的表(不是嵌入别篇笔记的只读岛)。 */
  const ownTable = (t: Element | null): HTMLTableElement | null => {
    if (!(t instanceof HTMLTableElement) || !view.dom.contains(t)) return null
    const island = t.closest('[contenteditable="false"]')
    return island && island !== view.dom && view.dom.contains(island) ? null : t
  }
  /** <table> → 表节点位置;对不上(DOM 与文档不同步的一瞬)返回 null。 */
  const posOfTable = (t: HTMLTableElement): number | null => {
    const cell = t.querySelector('th, td')
    if (!cell) return null
    try {
      const $c = view.state.doc.resolve(view.posAtDOM(cell, 0))
      for (let d = $c.depth; d > 0; d--) {
        if ($c.node(d).type.spec.tableRole !== 'table') continue
        const pos = $c.before(d)
        return view.nodeDOM(pos) === t ? pos : null
      }
    } catch { /* 位置已失效 */ }
    return null
  }
  /** DOM 行数与表节点行数对得上才动手(GFM 没有合并格:第 i 个 <tr> = 第 i 行)。 */
  const rowsOf = (t: HTMLTableElement, pos: number): HTMLTableRowElement[] | null => {
    const size = tableSize(view.state.doc, pos)
    const rows = Array.from(t.rows)
    return size && rows.length === size.rows && rows[0]?.cells.length === size.cols ? rows : null
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────
  let cur: { table: HTMLTableElement; pos: number } | null = null
  let row = -1
  let col = -1
  /** 把手上悬停 / 按住时高亮那一行 / 列。 */
  let gripHover: Axis | null = null
  let hideTimer = 0
  let lastDoc: ProseNode = view.state.doc

  type GripDrag = { kind: 'grip'; axis: Axis; table: HTMLTableElement; pos: number; node: ProseNode; from: number; to: number; x: number; y: number; id: number; moved: boolean; grip: HTMLElement }
  type CornerDrag = { kind: 'corner'; table: HTMLTableElement; pos: number; node: ProseNode; x: number; y: number; id: number; rowH: number; colW: number; rows: number; cols: number }
  let drag: GripDrag | CornerDrag | null = null
  /** 拖完松手后浏览器照样补发一次 click:吞掉它,别把刚换完序的把手菜单又打开。 */
  let swallowClick = false

  const menuHere = (): { axis: Axis; index: number } | null => {
    const m = tableAxisMenuState()
    return m && m.view === view && cur && m.tablePos === cur.pos ? { axis: m.axis, index: m.index } : null
  }

  const hideFine = (): void => {
    for (const e of [bars.row, bars.col, corner, rowGrip, colGrip, band, dropLine]) show(e, false)
  }
  const hideNow = (): void => {
    window.clearTimeout(hideTimer)
    hideTimer = 0
    if (drag || menuHere()) return
    cur = null
    row = col = -1
    gripHover = null
    hideFine()
  }
  const scheduleHide = (): void => {
    if (hideTimer || !cur) return
    hideTimer = window.setTimeout(() => { hideTimer = 0; hideNow() }, 140)
  }
  const cancelHide = (): void => { window.clearTimeout(hideTimer); hideTimer = 0 }

  /** 细指针:按 cur / row / col / 拖动态把整组浮层摆好。读 rect,不写文档。 */
  const layout = (): void => {
    if (!cur || coarse() || inCanvas()) { hideFine(); return }
    if (!cur.table.isConnected) {
      const again = view.nodeDOM(cur.pos)
      const t = again instanceof HTMLTableElement ? ownTable(again) : null
      if (!t) { cur = null; hideFine(); return }
      cur.table = t
    }
    const rows = rowsOf(cur.table, cur.pos)
    if (!rows) { hideFine(); return }
    const z = geo.scale() || 1
    const tr = cur.table.getBoundingClientRect()
    const gap = GAP * z
    const bar = BAR * z
    const head = Array.from(rows[0].cells)
    // 先量后写:几何进 boxes、属性 / 文字进 later,量完一次写完(读写交错会逼出一轮轮同步排版)
    const boxes: [HTMLElement, Box][] = []
    const later: (() => void)[] = []
    const place = (e: HTMLElement, b: Box): void => { boxes.push([e, b]) }
    // 拖右下角:两条加号条伸长到「将要加出来的那几行 / 列」那么大,上面标 +N。
    // 横向不伸出滚动容器(否则拖的途中冒出横向滚动条):表格恒为整栏宽,加列本来也不会把表撑宽。
    const cd = drag?.kind === 'corner' ? drag : null
    const rowBarH = cd && cd.rows > 0 ? Math.max(bar, cd.rows * cd.rowH) : bar
    const colBarW = cd && cd.cols > 0 ? Math.max(bar, Math.min(cd.cols * cd.colW, edgeRight() - (tr.right + gap))) : bar
    place(bars.row, { left: tr.left, top: tr.bottom + gap, width: tr.width, height: rowBarH })
    place(bars.col, { left: tr.right + gap, top: tr.top, width: colBarW, height: tr.height })
    // 圆点在两条交汇那一格;拖着时跟着伸到新的右下角
    place(corner, { left: tr.right + gap + colBarW - bar, top: tr.bottom + gap + rowBarH - bar, width: bar, height: bar })
    const count = (b: HTMLElement, n: number): void => {
      const c = b.querySelector('.amx-tbl-add-count')
      if (c) c.textContent = n > 0 ? `+${n}` : ''
      if (n > 0) b.dataset.active = ''
      else delete b.dataset.active
    }
    later.push(() => {
      count(bars.row, cd?.rows ?? 0)
      count(bars.col, cd?.cols ?? 0)
      if (cd) corner.dataset.active = ''
      else delete corner.dataset.active
    })
    const gd = drag?.kind === 'grip' ? drag : null
    const m = menuHere()
    // 菜单开着 / 正在拖:把手与高亮钉在那一行 / 列上,不跟指针跑
    const rIdx = gd?.axis === 'row' ? gd.from : m?.axis === 'row' ? m.index : row
    const cIdx = gd?.axis === 'col' ? gd.from : m?.axis === 'col' ? m.index : col
    const showRowGrip = rIdx >= 0 && rIdx < rows.length && !(gd?.axis === 'col') && !(m?.axis === 'col') && !cd
    const showColGrip = cIdx >= 0 && cIdx < head.length && !(gd?.axis === 'row') && !(m?.axis === 'row') && !cd
    if (showRowGrip) {
      const r = rows[rIdx].getBoundingClientRect()
      place(rowGrip, { left: tr.left - (GRIP_SHORT * z) / 2, top: r.top + (r.height - GRIP_LONG * z) / 2, width: GRIP_SHORT * z, height: GRIP_LONG * z })
      later.push(() => {
        rowGrip.dataset.index = String(rIdx)
        if (rIdx === 0) rowGrip.dataset.fixed = '' // 表头行:只给菜单,不给拖
        else delete rowGrip.dataset.fixed
      })
    }
    if (showColGrip) {
      const c = head[cIdx].getBoundingClientRect()
      place(colGrip, { left: c.left + (c.width - GRIP_LONG * z) / 2, top: tr.top - (GRIP_SHORT * z) / 2, width: GRIP_LONG * z, height: GRIP_SHORT * z })
      later.push(() => { colGrip.dataset.index = String(cIdx) })
    }
    const active = (axis: Axis): boolean => gd?.axis === axis || m?.axis === axis || gripHover === axis
    later.push(() => {
      for (const [g, axis] of [[rowGrip, 'row'], [colGrip, 'col']] as const) {
        if (active(axis)) g.dataset.active = ''
        else delete g.dataset.active
      }
    })
    // 高亮:悬停把手 / 菜单开着 / 拖着时盖住那一行 / 列
    const bandAxis: Axis | null = gd ? gd.axis : m ? m.axis : gripHover
    const bandIdx = bandAxis === 'row' ? rIdx : cIdx
    if (bandAxis && bandIdx >= 0) {
      if (bandAxis === 'row' && rows[bandIdx]) {
        const r = rows[bandIdx].getBoundingClientRect()
        place(band, { left: tr.left, top: r.top, width: tr.width, height: r.height })
      } else if (bandAxis === 'col' && head[bandIdx]) {
        const c = head[bandIdx].getBoundingClientRect()
        place(band, { left: c.left, top: tr.top, width: c.width, height: tr.height })
      }
      later.push(() => {
        if (gd?.moved) band.dataset.drag = ''
        else delete band.dataset.drag
      })
    }
    // 换序的落点线:画在将要插入的缝上(到 = 在第 k 行 / 列之前;k = 末尾即最后一条之后)
    let dropShown = false
    if (gd?.moved && gd.to !== gd.from) {
      const thick = 2 * z
      if (gd.axis === 'row') {
        const k = gd.to > gd.from ? gd.to + 1 : gd.to
        const y = k >= rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : rows[k].getBoundingClientRect().top
        place(dropLine, { left: tr.left, top: y - thick / 2, width: tr.width, height: thick })
      } else {
        const k = gd.to > gd.from ? gd.to + 1 : gd.to
        const x = k >= head.length ? head[head.length - 1].getBoundingClientRect().right : head[k].getBoundingClientRect().left
        place(dropLine, { left: x - thick / 2, top: tr.top, width: thick, height: tr.height })
      }
      dropShown = true
    }
    writeAll(boxes)
    for (const f of later) f()
    const editing = !gd // 拖把手时加号条让开
    show(bars.row, editing)
    show(bars.col, editing)
    show(corner, editing)
    show(rowGrip, showRowGrip)
    show(colGrip, showColGrip)
    show(band, !!bandAxis && bandIdx >= 0 && !cd)
    show(dropLine, dropShown)
  }

  // ── 粗指针:每张表常显加号条 ────────────────────────────────────────────────
  let touchRaf = 0
  const layoutTouch = (): void => {
    touchRaf = 0
    const tables = coarse() && view.editable && !inCanvas()
      ? Array.from(view.dom.querySelectorAll('table')).map((t) => ownTable(t)).filter((t): t is HTMLTableElement => !!t)
      : []
    while (touchPool.length < tables.length) {
      const b = makeBars()
      b.row.dataset.touch = ''
      b.col.dataset.touch = ''
      wireBar(b)
      touchPool.push(b)
      setTitles()
    }
    const z = geo.scale() || 1
    const rects = tables.map((t) => t.getBoundingClientRect())
    const boxes: [HTMLElement, Box][] = []
    touchPool.forEach((b, i) => {
      const r = rects[i]
      show(b.row, !!r)
      show(b.col, !!r)
      if (!r) return
      b.row.dataset.table = b.col.dataset.table = String(i)
      boxes.push([b.row, { left: r.left, top: r.bottom + GAP * z, width: r.width, height: BAR_TOUCH * z }])
      // 右侧那条落在页边距里(手机内距 24px):贴近表边、比底下那条窄一点,不出屏
      boxes.push([b.col, { left: r.right + 2 * z, top: r.top, width: (BAR_TOUCH - 4) * z, height: r.height }])
    })
    writeAll(boxes)
  }
  const scheduleTouch = (): void => { if (!touchRaf) touchRaf = requestAnimationFrame(layoutTouch) }

  // ── 指针:悬停 ────────────────────────────────────────────────────────────
  const owned = (t: EventTarget | null): boolean => t instanceof Element && made.some((e) => e === t || e.contains(t))
  /** 指针还在表的「悬停圈」里(表 + 左侧把手栏 + 上方把手栏 + 右 / 下加号条):穿过表与条之间的缝不收。 */
  const near = (t: HTMLTableElement, x: number, y: number): boolean => {
    const r = t.getBoundingClientRect()
    const z = geo.scale() || 1
    const out = (GAP + BAR + 6) * z
    return x >= r.left - 14 * z && x <= r.right + out && y >= r.top - 12 * z && y <= r.bottom + out
  }
  const onMove = (e: PointerEvent): void => {
    if (drag || coarse() || e.pointerType === 'touch') return
    if (!view.editable || view.dom.dataset.dragging === 'true' || inCanvas()) { hideNow(); return }
    if (e.buttons) return // 拖选文字途中不换目标
    if (owned(e.target)) { cancelHide(); return }
    let t = ownTable(e.target instanceof Element ? e.target.closest('table') : null)
    if (!t && cur && near(cur.table, e.clientX, e.clientY)) t = cur.table
    if (!t) { scheduleHide(); return }
    cancelHide()
    if (!cur || cur.table !== t) {
      const pos = posOfTable(t)
      if (pos == null) { hideNow(); return }
      cur = { table: t, pos }
      row = col = -1
    }
    if (menuHere()) { layout(); return }
    const rows = rowsOf(t, cur.pos)
    if (!rows) { hideNow(); return }
    // 只在指针落在表的纵向 / 横向范围内时换行 / 列:在左侧把手栏上下移动换行、在上方把手栏左右移动换列
    const tr = t.getBoundingClientRect()
    if (e.clientY >= tr.top && e.clientY <= tr.bottom) {
      const i = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY < b.bottom })
      if (i >= 0) row = i
    }
    if (e.clientX >= tr.left && e.clientX <= tr.right) {
      const i = Array.from(rows[0].cells).findIndex((c) => { const b = c.getBoundingClientRect(); return e.clientX >= b.left && e.clientX < b.right })
      if (i >= 0) col = i
    }
    layout()
  }
  const onLeave = (): void => { if (!drag) scheduleHide() }
  const onScroll = (): void => {
    // 粗指针的常显条挂在 `.milkdown` 里、随内容一起滚,滚动不用重排(手机上每帧量一遍是白花的样式重算)
    if (coarse()) return
    if (!drag && !menuHere()) hideNow()
    else layout()
  }
  const onResize = (): void => { if (coarse()) scheduleTouch(); else onScroll() }

  // ── 加号条 ───────────────────────────────────────────────────────────────
  const keepFocus = (e: Event): void => e.preventDefault() // 按下不把焦点从编辑器抢走,也不起原生拖选
  const focusEditor = (): void => { if (!coarse()) view.focus() }
  const append = (pos: number | null, rows: number, cols: number, caret?: 'row' | 'col'): void => {
    if (pos == null || !view.editable) return
    const tr = appendTableTr(view.state, pos, rows, cols, caret)
    if (!tr) return
    dispatchTableOp(view, tr)
    focusEditor()
  }
  const touchTablePos = (b: HTMLElement): number | null => {
    const i = Number(b.dataset.table)
    const tables = Array.from(view.dom.querySelectorAll('table')).map((t) => ownTable(t)).filter((t): t is HTMLTableElement => !!t)
    const t = tables[i]
    return t ? posOfTable(t) : null
  }
  const onBarClick = (e: MouseEvent): void => {
    const b = e.currentTarget as HTMLElement
    e.stopPropagation()
    const pos = b.dataset.touch != null ? touchTablePos(b) : cur?.pos ?? null
    if (b.dataset.axis === 'row') append(pos, 1, 0, 'row')
    else append(pos, 0, 1, 'col')
  }
  const wireBar = (b: Bars): void => {
    for (const x of [b.row, b.col]) {
      x.addEventListener('pointerdown', keepFocus)
      x.addEventListener('click', onBarClick)
    }
  }
  wireBar(bars)

  // ── 拖:右下角 / 把手 ─────────────────────────────────────────────────────
  const endDrag = (): void => {
    window.removeEventListener('pointermove', onDragMove, true)
    window.removeEventListener('pointerup', onDragUp, true)
    window.removeEventListener('pointercancel', onDragCancel, true)
    window.removeEventListener('keydown', onDragKey, true)
    window.removeEventListener('blur', cancelDrag)
    const d = drag
    drag = null
    if (d) {
      const host = d.kind === 'corner' ? corner : d.grip
      try { if (host.hasPointerCapture(d.id)) host.releasePointerCapture(d.id) } catch { /* 已脱离 */ }
    }
    root.classList.remove('amx-tbl-dragging')
    layout()
  }
  const cancelDrag = (): void => { if (drag) endDrag() }
  const stillSame = (d: { pos: number; node: ProseNode }): boolean => {
    try { return view.editable && view.state.doc.nodeAt(d.pos) === d.node } catch { return false }
  }
  const beginDrag = (d: GripDrag | CornerDrag, host: HTMLElement): void => {
    drag = d
    try { host.setPointerCapture(d.id) } catch { /* 台架合成事件 */ }
    window.addEventListener('pointermove', onDragMove, { capture: true, passive: false })
    window.addEventListener('pointerup', onDragUp, true)
    window.addEventListener('pointercancel', onDragCancel, true)
    window.addEventListener('keydown', onDragKey, true)
    window.addEventListener('blur', cancelDrag)
  }
  const onDragMove = (e: PointerEvent): void => {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    if (!stillSame(d)) { cancelDrag(); return }
    e.preventDefault()
    if (d.kind === 'corner') {
      d.rows = Math.max(0, Math.min(MAX_ADD_ROWS, Math.round((e.clientY - d.y) / d.rowH)))
      d.cols = Math.max(0, Math.min(MAX_ADD_COLS, Math.round((e.clientX - d.x) / d.colW)))
      layout()
      return
    }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return
      if (d.axis === 'row' && d.from === 0) return // 表头行不搬
      d.moved = true
      root.classList.add('amx-tbl-dragging')
      closeTableAxisMenu()
    }
    const rows = rowsOf(d.table, d.pos)
    if (!rows) { cancelDrag(); return }
    if (d.axis === 'row') {
      // 插入缝 k ∈ [1, 行数]:指针越过某正文行的中线就算到了它后面。表头之上不收。
      let k = 1
      for (let i = 1; i < rows.length; i++) { const b = rows[i].getBoundingClientRect(); if (e.clientY > b.top + b.height / 2) k = i + 1 }
      d.to = k > d.from ? k - 1 : k
    } else {
      const head = Array.from(rows[0].cells)
      let k = 0
      for (let i = 0; i < head.length; i++) { const b = head[i].getBoundingClientRect(); if (e.clientX > b.left + b.width / 2) k = i + 1 }
      d.to = k > d.from ? k - 1 : k
    }
    layout()
  }
  const onDragUp = (e: PointerEvent): void => {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    const ok = stillSame(d)
    if (d.kind === 'corner') {
      const { pos, rows, cols } = d
      endDrag()
      if (ok && rows + cols > 0) append(pos, rows, cols)
      return
    }
    const { moved, axis, pos, from, to } = d
    endDrag()
    if (!moved) return // 点:交给随后的 click 开菜单
    swallowClick = true
    window.setTimeout(() => { swallowClick = false }, 0)
    if (!ok || from === to) return
    const tr = axis === 'row' ? moveTableRowTr(view.state, pos, from, to) : moveTableColTr(view.state, pos, from, to)
    if (!tr) return
    dispatchTableOp(view, tr)
    // 把手跟着被搬的那一行 / 列走
    if (axis === 'row') row = to
    else col = to
    layout()
    focusEditor()
  }
  const onDragCancel = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) cancelDrag() }
  const onDragKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !drag) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (drag.kind === 'grip') swallowClick = true
    cancelDrag()
    window.setTimeout(() => { swallowClick = false }, 0)
  }

  corner.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    if (e.button !== 0 || !cur || drag || !view.editable) return
    const rows = rowsOf(cur.table, cur.pos)
    const node = view.state.doc.nodeAt(cur.pos)
    if (!rows || !node) return
    const body = rows.slice(1)
    const rowH = (body.length ? body : rows).reduce((s, r) => s + r.getBoundingClientRect().height, 0) / (body.length || rows.length)
    const z = geo.scale() || 1
    const colW = Math.min(cur.table.getBoundingClientRect().width / Math.max(1, rows[0].cells.length), COL_STEP_MAX * z)
    beginDrag({ kind: 'corner', table: cur.table, pos: cur.pos, node, x: e.clientX, y: e.clientY, id: e.pointerId, rowH: Math.max(12, rowH), colW: Math.max(24, colW), rows: 0, cols: 0 }, corner)
    layout()
  })

  const gripIndex = (g: HTMLElement): number => Number(g.dataset.index ?? -1)
  // 菜单开在把手正下方:行菜单不盖住被指着的那一行(高亮还看得见),列菜单从列首往下
  const openMenu = (g: HTMLElement, axis: Axis, keyboard: boolean): void => {
    if (!cur || !view.editable) return
    const index = gripIndex(g)
    const cellPos = axis === 'row' ? tableCellPos(view.state.doc, cur.pos, index, 0) : tableCellPos(view.state.doc, cur.pos, 0, index)
    if (cellPos == null) return
    const r = g.getBoundingClientRect()
    openTableAxisMenu({ view, x: r.left, y: r.bottom + 4, tablePos: cur.pos, cellPos, axis, index, keyboard })
  }
  for (const [g, axis] of [[rowGrip, 'row'], [colGrip, 'col']] as const) {
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      if (e.button !== 0 || !cur || drag || !view.editable) return
      const node = view.state.doc.nodeAt(cur.pos)
      const from = gripIndex(g)
      if (!node || from < 0) return
      beginDrag({ kind: 'grip', axis, table: cur.table, pos: cur.pos, node, from, to: from, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, grip: g }, g)
    })
    g.addEventListener('click', (e) => {
      e.stopPropagation()
      if (swallowClick) { swallowClick = false; return }
      const m = menuHere()
      if (m && m.axis === axis && m.index === gripIndex(g)) { closeTableAxisMenu(); return } // 再点一下 = 收起
      openMenu(g, axis, e.detail === 0)
    })
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openMenu(g, axis, false)
    })
    g.addEventListener('pointerenter', () => { gripHover = axis; layout() })
    g.addEventListener('pointerleave', () => { if (gripHover === axis) { gripHover = null; layout() } })
  }

  // 菜单开 / 关:把手与高亮要钉住 / 放开
  const offMenu = subscribeTableAxisMenu(() => { if (cur) layout() })

  root.addEventListener('pointermove', onMove, { passive: true })
  root.addEventListener('pointerleave', onLeave)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', onResize)
  // 粗指针:表的位置随排版变(图片加载、折叠、改字号),量编辑器根的尺寸变化
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (coarse()) scheduleTouch() }) : null
  ro?.observe(view.dom)
  let mql: MediaQueryList | null = null
  try { mql = window.matchMedia('(pointer: coarse)') } catch { /* 无 matchMedia 的环境 */ }
  const onPointerKind = (): void => { hideNow(); scheduleTouch() }
  mql?.addEventListener?.('change', onPointerKind)
  scheduleTouch()

  return {
    /** PM 每次更新后调。⚠️ 绝不许抛:异常从 updatePluginViews 逃出会打断 keydown 处理链(见 blockLayer update 的长注)。 */
    update(): void {
      try {
        if (!view.editable) {
          cancelDrag()
          const m = tableAxisMenuState()
          if (m && m.view === view) closeTableAxisMenu()
          hideNow()
          hideFine()
          scheduleTouch()
          return
        }
        const docChanged = view.state.doc !== lastDoc
        if (docChanged) {
          lastDoc = view.state.doc
          if (drag && !stillSame(drag)) cancelDrag()
          const m = tableAxisMenuState()
          if (m && m.view === view) closeTableAxisMenu() // 锚格位置可能已挪走:收起,不留一份指错格子的菜单
          if (cur) {
            const t = cur.table.isConnected ? cur.table : (view.nodeDOM(cur.pos) as HTMLElement | null)
            const pos = t instanceof HTMLTableElement ? posOfTable(t) : null
            if (pos == null || !(t instanceof HTMLTableElement)) hideNow()
            else { cur = { table: t, pos }; layout() }
          }
        }
        if (docChanged && coarse()) scheduleTouch() // 只动选区不重排;排版变化(图片、折叠)由 ResizeObserver 接
      } catch {
        try { hideFine() } catch { /* 不抛 */ }
      }
    },
    destroy(): void {
      cancelDrag()
      window.clearTimeout(hideTimer)
      cancelAnimationFrame(touchRaf)
      const m = tableAxisMenuState()
      if (m && m.view === view) closeTableAxisMenu()
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      mql?.removeEventListener?.('change', onPointerKind)
      offMenu()
      offLocale()
      for (const e of made) e.remove()
    },
  }
}
