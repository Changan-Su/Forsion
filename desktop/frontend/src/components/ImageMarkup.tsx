/**
 * 看图器的「标注修改」态(生图多张与标注改图方案 2B):圈 / 点 / 涂,每处一个编号、一句话,多处一次发。
 * 挂在看图器(ImageViewer)自己的根里,三端同一份;compact(手机 / 窄窗)时清单和输入在底部抽屉里。
 * 手势:拖动 = 画;按住空格拖动 = 平移;滚轮、触控板双指滚动、捏合 = 缩放(同看图器);触屏单指画、双指缩放移动。
 * 看图器的左右切图、点空白关闭、下拉关闭在这一态都停用 —— 标记在这里,误关就全丢。
 * 数据与发出去的正文见 imageMarkupModel.ts。方案页:docs/ToBeImproved/生图多张与标注改图方案_2026-11-23/index.html
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowUp, Brush, Circle, MapPin, Plus, Redo2, Undo2, X } from 'lucide-react'
import { registerMessages, translate as tr } from '../i18n'
import { MAX_MARKS, STROKE_WIDTH, emptyHistory, kindLabel, markCenter, record, redo as redoH, renumber, undo as undoH, type History, type Mark, type MarkKind } from './imageMarkupModel'
import './imageMarkup.css'

registerMessages({
  'markup.title': { zh: '标注修改', en: 'Mark up' },
  'markup.tool.ellipse': { zh: '圈选', en: 'Circle' },
  'markup.tool.pin': { zh: '点', en: 'Point' },
  'markup.tool.stroke': { zh: '涂抹', en: 'Brush' },
  'markup.undo': { zh: '撤销 (⌘Z)', en: 'Undo (⌘Z)' },
  'markup.redo': { zh: '重做 (⇧⌘Z)', en: 'Redo (⇧⌘Z)' },
  'markup.cancel': { zh: '取消', en: 'Cancel' },
  'markup.count': { zh: '{count} 处修改', en: '{count} changes' },
  'markup.none': { zh: '还没有标注', en: 'No marks yet' },
  'markup.addHint': { zh: '在图上圈一处或点一下，再加一条', en: 'Circle or tap the image to add another' },
  'markup.max': { zh: '最多 {count} 处', en: 'Up to {count} marks' },
  'markup.noText': { zh: '还没写这处要怎么改', en: 'No instruction yet' },
  'markup.writing': { zh: '正在写…', en: 'Writing…' },
  'markup.notePh': { zh: '这里要怎么改…', en: 'What should change here…' },
  'markup.noteFoot': { zh: '回车记下 · Esc 删掉这处', en: 'Enter to save · Esc to delete this mark' },
  'markup.noteFootEdit': { zh: '回车记下 · Esc 收起', en: 'Enter to save · Esc to close' },
  'markup.deleteMark': { zh: '删掉这处', en: 'Delete this mark' },
  'markup.overallPh': { zh: '整体要求（可选），例如：其余保持不变', en: 'Anything else? (optional) e.g. keep everything else the same' },
  'markup.send': { zh: '发送 {count} 处修改', en: 'Send {count} changes' },
  'markup.sending': { zh: '正在发送…', en: 'Sending…' },
  'markup.done': { zh: '完成', en: 'Done' },
  'markup.sendFailed': { zh: '没发出去，标注还在，可以再试一次', en: 'Could not send. Your marks are still here — try again.' },
  'markup.hint': { zh: '拖出椭圆 / 单击放点 / 拖动涂抹 · 按住空格拖动平移 · 滚轮缩放 · ⌘Z 撤销 · Esc 退出', en: 'Drag to circle / click to place a point / drag to paint · hold Space to pan · scroll to zoom · ⌘Z to undo · Esc to leave' },
  'markup.hintTouch': { zh: '单指画 · 双指缩放和移动', en: 'One finger to mark · two fingers to zoom and move' },
  'markup.collectHint': { zh: '标完点「完成」，回到全部图片和别的图一起发', en: 'Press Done to go back to all images and send them together' },
  'markup.discard': { zh: '放弃这些标注？', en: 'Discard these marks?' },
  'markup.keep': { zh: '继续标', en: 'Keep marking' },
  'markup.drop': { zh: '放弃', en: 'Discard' },
})

interface Props {
  src: string
  name: string
  /** 原图像素尺寸 */
  w: number
  h: number
  compact: boolean
  initial?: Mark[]
  /** send = 直接发出去(单张);collect = 标完交回给总览(多张一起改) */
  mode: 'send' | 'collect'
  onCancel: () => void
  onSubmit?: (marks: Mark[], overall: string) => Promise<boolean>
  onCollect?: (marks: Mark[]) => void
  /** 手机系统返回由看图器统一派发(它的返回处理器挂在下面):这一层开着时,看图器把返回交给这里。
   *  别在这里自己 pushMobileBack —— 从主图直进标注时子组件的 effect 先跑,看图器的「关闭」会压到它上面,返回一下整份标注就丢了 */
  backRef?: MutableRefObject<(() => void) | null>
}
interface View { s: number; tx: number; ty: number }
/** pid:落笔那根手指 / 鼠标;别的指针抬起不算这一笔结束 */
type Draft = { kind: MarkKind; x0: number; y0: number; pts: Array<[number, number]>; pid: number }

const PW = 280, GAP = 24, DOCK = 50, MAX_ZOOM = 6
const TOOLS: Array<{ k: MarkKind; icon: typeof Circle }> = [{ k: 'ellipse', icon: Circle }, { k: 'pin', icon: MapPin }, { k: 'stroke', icon: Brush }]

export function ImageMarkup({ src, name, w, h, compact, initial, mode, onCancel, onSubmit, onCollect, backRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const popInput = useRef<HTMLInputElement>(null)
  const [box, setBox] = useState({ W: 0, H: 0 })
  const [sheetH, setSheetH] = useState(0)
  const [marks, setMarks] = useState<Mark[]>(initial ?? [])
  const [hist, setHist] = useState<History>(emptyHistory)
  const [tool, setTool] = useState<MarkKind>('ellipse')
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pop, setPop] = useState<{ id: number; fresh: boolean; text: string } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [overall, setOverall] = useState('')
  const [space, setSpace] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => { setBox({ W: el.clientWidth, H: el.clientHeight }); setSheetH(sheetRef.current?.offsetHeight ?? 0) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (sheetRef.current) ro.observe(sheetRef.current)
    return () => ro.disconnect()
  }, [compact])

  // 图在哪、多大(舞台坐标,未缩放):桌面 = 左图右清单、下面一条输入;compact = 图在上、抽屉在下
  const geo = useMemo(() => {
    if (!box.W || !w || !h) return null
    if (compact) {
      const maxW = box.W - 16, maxH = Math.max(120, box.H - sheetH - 16)
      const d = Math.min(maxW / w, maxH / h, 2)
      const iw = w * d, ih = h * d
      return { d, iw, ih, x: (box.W - iw) / 2, y: Math.max(8, (box.H - sheetH - ih) / 2) }
    }
    const maxW = Math.max(160, box.W - PW - GAP - 96), maxH = Math.max(160, box.H - DOCK - 64)
    const d = Math.min(maxW / w, maxH / h, 2)
    const iw = w * d, ih = h * d
    return { d, iw, ih, x: (box.W - iw - GAP - PW) / 2, y: Math.max(8, (box.H - ih - DOCK - 40) / 2) }
  }, [box, sheetH, w, h, compact])

  /** 屏幕坐标 → 舞台坐标(除掉 body 的界面缩放) */
  const local = (cx: number, cy: number): [number, number] => {
    const el = bodyRef.current!
    const r = el.getBoundingClientRect()
    const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    return [(cx - r.left) / z, (cy - r.top) / z]
  }
  /** 舞台坐标 → 图上的归一坐标 */
  const toImg = (lx: number, ly: number): [number, number] => {
    if (!geo) return [0, 0]
    return [(lx - geo.x - view.tx) / (geo.iw * view.s), (ly - geo.y - view.ty) / (geo.ih * view.s)]
  }
  /** 图上的归一坐标 → 舞台坐标 */
  const toStage = (nx: number, ny: number): [number, number] => (geo ? [geo.x + view.tx + nx * geo.iw * view.s, geo.y + view.ty + ny * geo.ih * view.s] : [0, 0])

  /** 放大只在原图框里:平移不许把图拖出框(框外是右侧清单和输入条,图铺过去字会压在图上) */
  const clampV = useCallback((v: View): View => {
    if (!geo || v.s <= 1) return { s: 1, tx: 0, ty: 0 }
    return { s: v.s, tx: Math.min(0, Math.max(geo.iw * (1 - v.s), v.tx)), ty: Math.min(0, Math.max(geo.ih * (1 - v.s), v.ty)) }
  }, [geo])
  const zoomAt = useCallback((s: number, px: number, py: number) => {
    if (!geo) return
    setView((cur) => {
      const ns = Math.min(MAX_ZOOM, Math.max(1, s))
      if (ns <= 1.02) return { s: 1, tx: 0, ty: 0 }
      const ox = px - geo.x, oy = py - geo.y
      return clampV({ s: ns, tx: ox - (ox - cur.tx) * (ns / cur.s), ty: oy - (oy - cur.ty) * (ns / cur.s) })
    })
  }, [geo, clampV])

  // ── 标记的增删改(都过撤销栈) ──
  const change = (next: Mark[]): void => { setHist((hh) => record(hh, marks)); setMarks(renumber(next)) }
  const commitPop = (): void => {
    if (!pop) return
    const text = pop.text.trim()
    const cur = marks.find((m) => m.id === pop.id)
    if (cur && cur.text !== text) {
      // 刚落下的那处 + 它的第一句话 = 一步撤销(落下时已经记过)
      if (pop.fresh) setMarks(marks.map((m) => (m.id === pop.id ? { ...m, text } : m)))
      else change(marks.map((m) => (m.id === pop.id ? { ...m, text } : m)))
    }
    setPop(null)
  }
  const dropPop = (): void => {
    if (!pop) return
    if (pop.fresh) {
      // 刚落下就 Esc = 当没落过:连落下那一步一起撤掉,不留撤销记录
      setHist((hh) => ({ past: hh.past.slice(0, -1), future: hh.future }))
      setMarks((ms) => renumber(ms.filter((m) => m.id !== pop.id)))
    }
    setPop(null)
  }
  /** 删一处:正在写的那句先记进去(删的若不是它),浮层关掉 —— 重编号以后 pop.id 会指到别的标记 */
  const remove = (id: number): void => {
    const base = pop && pop.id !== id ? marks.map((m) => (m.id === pop.id ? { ...m, text: pop.text.trim() } : m)) : marks
    setPop(null)
    setHist((hh) => record(hh, base))
    setMarks(renumber(base.filter((m) => m.id !== id)))
  }
  const doUndo = (): void => { setPop(null); const r = undoH(hist, marks); if (r) { setHist(r.h); setMarks(r.marks) } }
  const doRedo = (): void => { setPop(null); const r = redoH(hist, marks); if (r) { setHist(r.h); setMarks(r.marks) } }
  const openPop = (m: Mark, fresh = false): void => setPop({ id: m.id, fresh, text: m.text })
  useEffect(() => { if (pop) popInput.current?.focus({ preventScroll: true }) }, [pop?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 收集模式里标记没动过就直接回去(进来时带着的那些不算「要放弃的」)
  const leave = (): void => { if (marks.length && (mode === 'send' || hist.past.length)) setConfirm(true); else onCancel() }
  const escape = (): void => {
    if (confirm) setConfirm(false)
    else if (pop) dropPop()
    else leave()
  }
  const escRef = useRef(escape)
  escRef.current = escape
  useEffect(() => {
    if (!backRef) return
    backRef.current = () => escRef.current()
    return () => { backRef.current = null }
  }, [backRef])
  // 焦点进这一层(Tab 只在这一层里转,见键盘那段)
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }) }, [])

  const submit = async (): Promise<void> => {
    if (busy) return
    const final = pop ? marks.map((m) => (m.id === pop.id ? { ...m, text: pop.text.trim() } : m)) : marks
    setPop(null)
    if (mode === 'collect') { onCollect?.(final); return }
    if (!final.length || !onSubmit) return
    setBusy(true)
    const ok = await onSubmit(final, overall).catch(() => false)
    setBusy(false) // 发成功时看图器会整个卸掉;失败留在原地,标记都在
    if (!ok) setMarks(final)
  }

  // ── 键盘(捕获相位:标注态的 Esc / ⌘Z / 空格不漏给底下的聊天;输入法组字时一律放行) ──
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return
    const t = e.target as HTMLElement | null
    // 只认这一层里的输入框:焦点若跑到底下的聊天输入框,回车不能当成这里的「发送」
    const typing = !!t && rootRef.current?.contains(t) === true && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const mod = e.metaKey || e.ctrlKey
    let hit = true
    if (busy) { e.preventDefault(); e.stopPropagation(); return } // 发送途中什么都不动(失败后标记原样回来)
    if (e.key === 'Tab') {
      // aria-modal 不会自己圈住焦点:Tab / ⇧Tab 只在这一层的按钮和输入框之间转
      const els = [...(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])]
      const i = els.indexOf(document.activeElement as HTMLElement)
      const n = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i < 0 || i === els.length - 1 ? 0 : i + 1)
      els[n]?.focus()
    } else if (e.key === 'Escape') {
      if (typing && t !== popInput.current) t?.blur()
      else escape()
    } else if (typing) {
      if (e.key === 'Enter' && t === popInput.current) commitPop()
      else if (e.key === 'Enter' && !e.shiftKey && marks.length) void submit()
      else hit = false
      e.stopPropagation() // 输入框里打的字(包括 0 - + 和方向键)不给看图器、也不给聊天
    } else if (mod && e.key.toLowerCase() === 'z') { if (e.shiftKey) doRedo(); else doUndo() }
    else if (e.key === ' ' && t?.tagName !== 'BUTTON') { if (!space) setSpace(true) } // 按钮上的空格照旧是「按下」
    else hit = false
    if (hit) { e.preventDefault(); e.stopPropagation() }
  }
  useEffect(() => {
    const down = (e: KeyboardEvent): void => keyRef.current(e)
    const up = (e: KeyboardEvent): void => { if (e.key === ' ') setSpace(false) }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true) }
  }, [])

  // 滚轮 / 触控板:缩放(ctrlKey = 捏合),横向滚动 = 平移
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as HTMLElement).closest('.imk-notes, .imk-sheet, .imk-pop')) return
      e.preventDefault()
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { setView((v) => (v.s > 1 ? clampV({ ...v, tx: v.tx - e.deltaX }) : v)); return }
      const [px, py] = local(e.clientX, e.clientY)
      zoomAt(view.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), px, py)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view.s, zoomAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 指针 ──
  const ptrs = useRef(new Map<number, [number, number]>())
  const pinch = useRef<{ d0: number; v0: View; ix: number; iy: number } | null>(null)
  const pan = useRef<{ x0: number; y0: number; v0: View } | null>(null)
  const raf = useRef(0)
  const pending = useRef<[number, number] | null>(null)
  const onDown = (e: ReactPointerEvent): void => {
    if ((e.target as HTMLElement).closest('button, input, .imk-notes, .imk-pop, .imk-sheet, .imk-dock, .imk-confirm')) return
    if (!geo || busy) return
    e.preventDefault()
    bodyRef.current?.setPointerCapture(e.pointerId)
    const [lx, ly] = local(e.clientX, e.clientY)
    ptrs.current.set(e.pointerId, [lx, ly])
    if (ptrs.current.size === 2) {
      // 第二根手指落下:放弃正在画的那笔,改成捏合
      setDraft(null)
      const [[ax, ay], [bx, by]] = [...ptrs.current.values()]
      const mx = (ax + bx) / 2, my = (ay + by) / 2
      pinch.current = { d0: Math.hypot(ax - bx, ay - by) || 1, v0: view, ix: (mx - geo.x - view.tx) / view.s, iy: (my - geo.y - view.ty) / view.s }
      return
    }
    if (pop) { commitPop(); return } // 写备注时点别处 = 记下,这一下不落新标记
    if (space || e.button === 1) { pan.current = { x0: lx, y0: ly, v0: view }; return }
    if (marks.length >= MAX_MARKS) return
    const [nx, ny] = toImg(lx, ly)
    if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return
    setDraft({ kind: tool, x0: nx, y0: ny, pts: [[nx, ny]], pid: e.pointerId })
  }
  const onMove = (e: ReactPointerEvent): void => {
    if (!ptrs.current.has(e.pointerId) || !geo) return
    const [lx, ly] = local(e.clientX, e.clientY)
    ptrs.current.set(e.pointerId, [lx, ly])
    if (pinch.current && ptrs.current.size >= 2) {
      const [[ax, ay], [bx, by]] = [...ptrs.current.values()]
      const p = pinch.current
      const s = Math.min(MAX_ZOOM, Math.max(1, p.v0.s * (Math.hypot(ax - bx, ay - by) / p.d0)))
      const mx = (ax + bx) / 2, my = (ay + by) / 2
      setView(s <= 1.02 ? { s: 1, tx: 0, ty: 0 } : clampV({ s, tx: mx - geo.x - p.ix * s, ty: my - geo.y - p.iy * s }))
      return
    }
    if (pan.current) { const p = pan.current; setView(clampV({ ...p.v0, tx: p.v0.tx + lx - p.x0, ty: p.v0.ty + ly - p.y0 })); return }
    if (!draft) return
    // 一帧合并一次:长笔画每次 pointermove 都重画整层 SVG 会掉帧
    pending.current = toImg(lx, ly)
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const pt = pending.current
      if (!pt) return
      setDraft((d) => (d ? { ...d, pts: d.kind === 'stroke' ? [...d.pts, pt] : [d.pts[0], pt] } : d))
    })
  }
  /** 系统打断的手势(来电、切走、丢了捕获):清掉,不落标记 */
  const onPtrCancel = (e: ReactPointerEvent): void => {
    ptrs.current.delete(e.pointerId)
    if (ptrs.current.size < 2) pinch.current = null
    if (!ptrs.current.size) pan.current = null
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0 }
    setDraft(null)
  }
  const onUp = (e: ReactPointerEvent): void => {
    if (!ptrs.current.has(e.pointerId)) return // 在清单 / 输入条上按下的那根手指(按下时就没收)
    ptrs.current.delete(e.pointerId)
    if (pinch.current) { if (ptrs.current.size < 2) pinch.current = null; return }
    if (pan.current) { pan.current = null; return }
    const d = draft
    if (d && d.pid !== e.pointerId) return // 不是落笔那根
    setDraft(null)
    if (!d || !geo) return
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0 }
    const [lx, ly] = local(e.clientX, e.clientY)
    const end = toImg(lx, ly)
    const pts = d.kind === 'stroke' ? [...d.pts, end] : [d.pts[0], end]
    const movedPx = Math.hypot((end[0] - d.x0) * geo.iw * view.s, (end[1] - d.y0) * geo.ih * view.s)
    let m: Omit<Mark, 'id' | 'text'>
    if (d.kind === 'pin' || (d.kind === 'ellipse' && movedPx < 10)) m = { kind: 'pin', x: d.x0, y: d.y0 }
    else if (d.kind === 'ellipse') {
      const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
      const x1 = clamp01(end[0]), y1 = clamp01(end[1])
      m = { kind: 'ellipse', cx: (d.x0 + x1) / 2, cy: (d.y0 + y1) / 2, rx: Math.max(0.015, Math.abs(x1 - d.x0) / 2), ry: Math.max(0.015, Math.abs(y1 - d.y0) / 2) }
    } else m = { kind: 'stroke', points: pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1), width: STROKE_WIDTH }
    const id = marks.length + 1
    const mark: Mark = { ...m, id, text: '' }
    setHist((hh) => record(hh, marks))
    setMarks([...marks, mark])
    openPop(mark, true)
  }

  // ── 画 ──
  const k = geo ? 1 / (geo.d * view.s) : 1 // 1 个屏幕像素 = k 个原图像素:标记的线宽 / 编号大小在屏幕上恒定
  const badge = (x: number, y: number, n: number, key: string) => (
    <g key={key}>
      <circle cx={x} cy={y} r={14 * k} fill="#fff" />
      <circle cx={x} cy={y} r={11.5 * k} className="imk-fill" />
      <text x={x} y={y} dy=".36em" textAnchor="middle" className="imk-num" fontSize={13 * k}>{n}</text>
    </g>
  )
  const drawMark = (m: Mark, hi: boolean, ghost = false) => {
    const sw = (hi ? 4 : 3) * k
    if (m.kind === 'ellipse') {
      const cx = (m.cx ?? 0) * w, cy = (m.cy ?? 0) * h, rx = (m.rx ?? 0) * w, ry = (m.ry ?? 0) * h
      return <g key={m.id} opacity={ghost ? 0.8 : 1}>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={sw + 3 * k} />
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" className="imk-stroke" strokeWidth={sw} />
        {!ghost && badge(cx + rx * 0.72, cy - ry * 0.72, m.id, 'b')}
      </g>
    }
    if (m.kind === 'pin') {
      // 贴着上沿时箭头朝上、编号放到点的下面(否则编号画出图外,发出去的副本也会裁掉)
      const x = (m.x ?? 0) * w, y = (m.y ?? 0) * h, f = y < 46 * k ? -1 : 1
      return <g key={m.id}>
        <path d={`M${x} ${y} l${-9 * k} ${-18 * k * f} h${18 * k} z`} fill="#fff" />
        <path d={`M${x} ${y - 2.5 * k * f} l${-6.5 * k} ${-14.5 * k * f} h${13 * k} z`} className="imk-fill" />
        <circle cx={x} cy={y} r={(hi ? 3.5 : 2.5) * k} fill="#fff" />
        {badge(x, y - (18 * k + 11.5 * k) * f, m.id, 'b')}
      </g>
    }
    const pts = m.points ?? []
    const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${(px * w).toFixed(1)} ${(py * h).toFixed(1)}`).join(' ') + (pts.length === 1 ? ' l0.1 0' : '')
    return <g key={m.id}>
      <path d={d} fill="none" className="imk-stroke" opacity={hi ? 0.55 : 0.42} strokeWidth={(m.width ?? STROKE_WIDTH) * w} strokeLinecap="round" strokeLinejoin="round" />
      {!ghost && pts[0] && badge(pts[0][0] * w, pts[0][1] * h, m.id, 'b')}
    </g>
  }
  const draftMark: Mark | null = draft ? (draft.kind === 'stroke'
    ? { id: 0, kind: 'stroke', text: '', points: draft.pts, width: STROKE_WIDTH }
    : draft.kind === 'ellipse' && draft.pts[1]
      ? { id: 0, kind: 'ellipse', text: '', cx: (draft.x0 + draft.pts[1][0]) / 2, cy: (draft.y0 + draft.pts[1][1]) / 2, rx: Math.abs(draft.pts[1][0] - draft.x0) / 2, ry: Math.abs(draft.pts[1][1] - draft.y0) / 2 }
      : null) : null

  // 写备注的浮层跟着那处标记(桌面);手机在抽屉里写
  const popMark = pop ? marks.find((m) => m.id === pop.id) : undefined
  let popPos: { left: number; top: number } | null = null
  if (popMark && geo && !compact) {
    const [cx, cy] = markCenter(popMark)
    const below = popMark.kind === 'ellipse' ? cy + (popMark.rx ? (popMark.ry ?? 0) : 0) : cy
    const [sx, sy] = toStage(cx, below)
    popPos = { left: Math.max(8, Math.min(box.W - 290, sx - 140)), top: sy + 14 > box.H - 90 ? Math.max(8, sy - 96) : sy + 14 }
  }

  const sendLabel = busy ? tr('markup.sending') : mode === 'collect' ? tr('markup.done') : tr('markup.send', { count: marks.length })
  const canSend = mode === 'collect' || (marks.length > 0 && !busy)
  const noteRow = (m: Mark) => (
    <div key={m.id} className={`imk-note${hover === m.id || pop?.id === m.id ? ' is-on' : ''}`}
      onPointerEnter={() => setHover(m.id)} onPointerLeave={() => setHover(null)} onClick={() => (pop?.id === m.id ? null : (commitPop(), openPop(m)))}>
      <span className="imk-badge">{m.id}</span>
      <span className="imk-note-body">
        {pop?.id === m.id && compact
          ? <input ref={popInput} className="imk-note-input" value={pop.text} placeholder={tr('markup.notePh')} onChange={(e) => setPop({ ...pop, text: e.target.value })} onClick={(e) => e.stopPropagation()} />
          : <span className={m.text ? '' : 'imk-faint'}>{m.text || (pop?.id === m.id ? tr('markup.writing') : tr('markup.noText'))}</span>}
        <small>{kindLabel(m.kind)}</small>
      </span>
      <button type="button" className="imk-del" title={tr('markup.deleteMark')} aria-label={tr('markup.deleteMark')} onClick={(e) => { e.stopPropagation(); remove(m.id) }}><X size={12} /></button>
    </div>
  )
  const notes = (
    <>
      <div className="imk-notes-head">{marks.length ? tr('markup.count', { count: marks.length }) : tr('markup.none')}</div>
      {marks.map(noteRow)}
      <div className="imk-note is-add"><Plus size={14} /><span>{marks.length >= MAX_MARKS ? tr('markup.max', { count: MAX_MARKS }) : tr('markup.addHint')}</span></div>
    </>
  )
  const dock = (
    <>
      {mode === 'send'
        ? <input className="imk-overall" value={overall} placeholder={tr('markup.overallPh')} onChange={(e) => setOverall(e.target.value)} />
        : <span className="imk-collect-hint">{tr('markup.collectHint')}</span>}
      <button type="button" className="imk-send" disabled={!canSend} onClick={() => void submit()}>{mode === 'send' && !busy && <ArrowUp size={15} />}{sendLabel}</button>
    </>
  )

  return (
    <div ref={rootRef} tabIndex={-1} className={`imk${compact ? ' is-compact' : ''}${busy ? ' is-busy' : ''}`} role="dialog" aria-modal="true" aria-label={`${tr('markup.title')} ${name}`}>
      <div className="iv-bar imk-bar">
        <div className="iv-title"><b>{tr('markup.title')}</b><span title={name}>{name}</span></div>
        <div className="imk-tools" role="toolbar">
          {TOOLS.map(({ k: kind, icon: Icon }) => (
            <button key={kind} type="button" className="imk-tool" aria-pressed={tool === kind} title={tr(`markup.tool.${kind}`)} onClick={() => setTool(kind)}>
              <Icon size={15} />{!compact && <span>{tr(`markup.tool.${kind}`)}</span>}
            </button>
          ))}
          <span className="imk-sep" />
          <button type="button" className="imk-tool" title={tr('markup.undo')} aria-label={tr('markup.undo')} disabled={!hist.past.length} onClick={doUndo}><Undo2 size={15} /></button>
          <button type="button" className="imk-tool" title={tr('markup.redo')} aria-label={tr('markup.redo')} disabled={!hist.future.length} onClick={doRedo}><Redo2 size={15} /></button>
        </div>
        <div className="iv-tools"><button type="button" className="imk-ghost" onClick={leave}>{tr('markup.cancel')}</button></div>
      </div>
      <div ref={bodyRef} className={`imk-body${space ? ' is-pan' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onPtrCancel} onLostPointerCapture={onPtrCancel}>
        {geo && (
          <div className={`imk-frame${view.s > 1 ? ' is-zoomed' : ''}`} style={{ left: geo.x, top: geo.y, width: geo.iw, height: geo.ih }}>
            <div className="imk-world" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
              <img src={src} alt={name} draggable={false} />
              <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
                {marks.map((m) => drawMark(m, hover === m.id || pop?.id === m.id))}
                {draftMark && drawMark(draftMark, false, true)}
              </svg>
            </div>
          </div>
        )}
        {geo && !compact && (
          <div className="imk-notes" style={{ left: geo.x + geo.iw + GAP, top: geo.y, width: PW, maxHeight: geo.ih }}>{notes}</div>
        )}
        {popPos && pop && (
          <div className="imk-pop" style={popPos} onPointerDown={(e) => e.stopPropagation()}>
            <div className="imk-pop-in">
              <span className="imk-badge">{pop.id}</span>
              <input ref={popInput} value={pop.text} placeholder={tr('markup.notePh')} onChange={(e) => setPop({ ...pop, text: e.target.value })} />
            </div>
            <div className="imk-pop-foot"><span>{tr(pop.fresh ? 'markup.noteFoot' : 'markup.noteFootEdit')}</span><span>{popMark && kindLabel(popMark.kind)}</span></div>
          </div>
        )}
        {geo && !compact && (
          <div className="imk-dock" style={{ left: geo.x, top: geo.y + geo.ih + 14, width: geo.iw + GAP + PW }}>{dock}</div>
        )}
        {geo && !compact && <div className="iv-hint imk-hint" style={{ top: geo.y + geo.ih + 14 + DOCK + 12 }}>{tr('markup.hint')}</div>}
        {compact && (
          <div ref={sheetRef} className="imk-sheet">
            <div className="imk-grab" />
            <div className="imk-hint-touch">{tr('markup.hintTouch')}</div>
            <div className="imk-sheet-list">{notes}</div>
            <div className="imk-dock is-sheet">{dock}</div>
          </div>
        )}
        {confirm && (
          <div className="imk-confirm" role="alertdialog" aria-label={tr('markup.discard')}>
            <p>{tr('markup.discard')}</p>
            <div className="imk-confirm-btns">
              <button type="button" className="imk-ghost" onClick={() => setConfirm(false)}>{tr('markup.keep')}</button>
              <button type="button" className="imk-send" onClick={() => { setConfirm(false); onCancel() }}>{tr('markup.drop')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
