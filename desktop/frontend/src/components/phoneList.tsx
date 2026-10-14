/**
 * 手机整屏列表的共用件(布局「二」,2026-10-09 用户选定):分类胶囊、日期分段、左滑一行出操作、一颗悬浮主按钮、
 * 下拉搜索、首次提示。会话列表(SidebarPane 的 timeline)与笔记列表共用。
 *
 * 只在「两级导航的列表层」用 —— 调用方拿 lcl 的 `useListFirst()` 当闸(原生底栏 × 竖屏 × 该 Space 有列表);
 * 桌面 / 网页 / 手机浏览器一行都不渲染,样式也全部挂在 `.mb-shell[data-list-first]` 之下(phoneList.css)。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Search } from 'lucide-react'
import { SPRING_ROW, reducedMotion, springEasing } from '@lcl/engine'
import { registerMessages, translate, useI18n } from '../i18n'
import './phoneList.css'

registerMessages({
  'phonelist.sec.pinned': { zh: '置顶', en: 'Pinned' },
  'phonelist.sec.today': { zh: '今天', en: 'Today' },
  'phonelist.sec.yesterday': { zh: '昨天', en: 'Yesterday' },
  'phonelist.sec.week': { zh: '这一周', en: 'This week' },
  'phonelist.sec.earlier': { zh: '更早', en: 'Earlier' },
  'phonelist.hint.ok': { zh: '知道了', en: 'Got it' },
  'phonelist.pull.idle': { zh: '下拉搜索', en: 'Pull down to search' },
  'phonelist.pull.armed': { zh: '松开搜索', en: 'Release to search' },
})

export type ListBucket = 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier'

/** 一个时刻落在哪一段(按本地日历日;从没活动过 = 0 → 更早)。 */
export function dayBucket(at: number, now = Date.now()): Exclude<ListBucket, 'pinned'> {
  if (!at) return 'earlier'
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  if (at >= day.getTime()) return 'today'
  day.setDate(day.getDate() - 1) // 经 Date 退一天:夏令时那天不是 24 小时
  if (at >= day.getTime()) return 'yesterday'
  day.setDate(day.getDate() - 5)
  return at >= day.getTime() ? 'week' : 'earlier'
}

/** 给排好序的条目插分段头:`bucketOf` 相邻两条不同就起一段。 */
export function withSections<T>(items: readonly T[], bucketOf: (item: T) => ListBucket): Array<{ section: ListBucket } | { item: T }> {
  const out: Array<{ section: ListBucket } | { item: T }> = []
  let last: ListBucket | null = null
  for (const item of items) {
    const b = bucketOf(item)
    if (b !== last) { out.push({ section: b }); last = b }
    out.push({ item })
  }
  return out
}

export function ListSection({ bucket }: { bucket: ListBucket }) {
  return <div className="pl-sec" role="heading" aria-level={3} data-section={bucket}>{translate(`phonelist.sec.${bucket}`)}</div>
}

/** 分类胶囊:点一下切换。`data-filter` 是台架锚。 */
export function ListChips<T extends string>({ label, items, value, onChange }: {
  label: string; items: ReadonlyArray<{ id: T; label: string }>; value: T; onChange(id: T): void
}) {
  return (
    <div className="pl-chips" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" data-filter={it.id} aria-selected={value === it.id} className={value === it.id ? 'on' : undefined} onClick={() => onChange(it.id)}>{it.label}</button>
      ))}
    </div>
  )
}

/** 悬浮主按钮:点 = 这一页最常用的那个新建;长按(Android WebView 的 contextmenu,自带触感)= 其余的新建。 */
export function ListFab({ label, icon, onClick, onMenu }: { label: string; icon: ReactNode; onClick(): void; onMenu?(at: { x: number; y: number }): void }) {
  return (
    <button
      type="button" className="pl-fab" data-act="list-fab" aria-label={label} onClick={onClick}
      onContextMenu={onMenu && ((e) => {
        e.preventDefault(); e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onMenu({ x: r.left, y: r.top })
      })}
    >{icon}</button>
  )
}

/** `label` 不画出来(用户 2026-10-10:滑出来的图标不要带文字):它是读屏标签。所以图标自己要说得清 ——
 *  成对的动作(置顶 / 取消置顶、收藏 / 取消收藏)各用各的图标。 */
export interface SwipeAction { id: string; label: string; icon: ReactNode; tone?: 'accent' | 'danger'; run(): void }

/** 每一行的控制器(挂在 .pl-swipe 上;手指落在别处时要能从外面收回它)。 */
const swipes = new WeakMap<HTMLElement, { close(): void; justDragged(): boolean }>()
/** 窗口尺寸变一次加一:各行量过的缩放比例 / 按钮宽度以此作废(一个监听,不是每行一个)。 */
let sizeEpoch = 0
if (typeof window !== 'undefined') window.addEventListener('resize', () => { sizeEpoch += 1 })

/** 手指落在别处时把开着的那一行收回。挂在列表滚动器的 onTouchStart 上(一处,不是每行一个监听)。 */
export function closeOtherSwipes(e: { target: EventTarget | null }): void {
  const keep = (e.target as Element | null)?.closest?.('.pl-swipe')
  for (const el of document.querySelectorAll<HTMLElement>('.pl-swipe[data-open]')) if (el !== keep) swipes.get(el)?.close()
}

/** 左滑露出操作。`actions` 为空就只渲染行本体。
 *  拖动跟手(横向位移,touch-action: pan-y 把纵向留给列表滚动),松手按手指的速度接一条带一点回弹的弹簧(spring.ts)——
 *  2026-10-14 之前是浏览器的横向滚动 + scroll-snap:吸附那一下是 Chromium 固定的缓动,不管手指多快,用户说「线性、
 *  没有原生那种灵动感」。点别处 / 点行本体收回走同一条弹簧。 */
export function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const any = actions.length > 0
  useEffect(() => (any && ref.current ? wireSwipe(ref.current) : undefined), [any])
  if (!any) return <>{children}</>
  const close = (): void => { if (ref.current) swipes.get(ref.current)?.close() }
  return (
    <div
      className="pl-swipe" ref={ref}
      // 开着时点行本体 = 收回,不打开条目;刚拖完松手的那一下也不算点(capture:抢在行自己的 onClick 之前)
      onClickCapture={(e) => {
        const el = ref.current
        if (!el) return
        // the click a mouse on the phone sends after a drag (no pointerdown of its own) is the drag's end: swallow it,
        // leave the tray as the release put it. A real tap starts with a pointerdown, which clears this.
        if (swipes.get(el)?.justDragged()) { e.preventDefault(); e.stopPropagation(); return }
        if ((e.target as Element).closest('.pl-swipe-acts') || !el.hasAttribute('data-open')) return
        e.preventDefault(); e.stopPropagation(); close()
      }}
    >
      <div className="pl-swipe-track">
        {children}
        <div className="pl-swipe-acts">
          {actions.map((a) => (
            <button key={a.id} type="button" className={`pl-swipe-act${a.tone ? ` ${a.tone}` : ''}`} data-act={a.id} aria-label={a.label} title={a.label} onClick={(e) => { e.stopPropagation(); close(); a.run() }}>
              {a.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const GIVE = 10

/** 一行的手势。位移以行自己的 CSS px 记(列表在 .mb-drawer-body 里还放大一档,指针的视口坐标要除以这一档)。 */
function wireSwipe(el: HTMLElement): () => void {
  const track = el.firstElementChild as HTMLElement
  const acts = track.lastElementChild as HTMLElement
  let x = 0 // ≤ 0;-acts 宽 = 全开
  let dragged = false // 拖完松手、还没有新的按下
  /** 量一次就记住(认下拖拽那一刻再量会强制一次样式 + 布局,正压在起手那一帧);窗口尺寸或按钮个数变了才重量。 */
  let size: { k: number; w: number; epoch: number; n: number } | null = null
  const measure = (): { k: number; w: number } => {
    if (!size || size.epoch !== sizeEpoch || size.n !== acts.childElementCount) {
      size = { k: el.getBoundingClientRect().width / el.offsetWidth || 1, w: acts.offsetWidth, epoch: sizeEpoch, n: acts.childElementCount }
    }
    return size
  }
  type Grip = { id: number; x0: number; y0: number; from: number; k: number; w: number; on: boolean | null; trail: Array<[number, number]> }
  let g: Grip | null = null
  const put = (v: number): void => { x = v; track.style.transform = v ? `translateX(${v.toFixed(2)}px)` : '' }
  /** 正在弹的那一下停在哪(接住它,而不是跳回它的终点)。 */
  const now = (): number => {
    const m = getComputedStyle(track).transform
    return m && m !== 'none' ? new DOMMatrixReadOnly(m).m41 : 0
  }
  /** 去 `to`,初速 `v`(行内 px / ms)。冲过头最多再走 GIVE px(软墙),甩得再快也不会把那排钮甩出一大截空白。 */
  const settle = (to: number, v: number): void => {
    el.toggleAttribute('data-open', to !== 0)
    track.style.willChange = ''
    const span = to - x
    const s = Math.abs(span) < 0.5 ? null : springEasing((v * 1000) / span, SPRING_ROW, { give: GIVE / Math.abs(span) })
    track.style.transition = s ? `transform ${s.ms}ms ${s.easing}` : Math.abs(span) < 0.5 || reducedMotion() ? '' : 'transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)'
    put(to)
  }
  const ours = (): boolean => el.matches('.mb-shell[data-list-first] .pl-swipe')
  const down = (e: PointerEvent): void => {
    dragged = false
    if (g || !e.isPrimary || e.button > 0 || !ours()) return
    const at = track.style.transition ? now() : x
    track.style.transition = ''
    put(at)
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: at, k: 1, w: 0, on: null, trail: [[e.timeStamp, at]] }
  }
  const move = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id) return
    if (g.on === null) {
      const dx = e.clientX - g.x0
      const dy = e.clientY - g.y0
      if (Math.hypot(dx, dy) < 8) return
      // 纵向 = 列表的(浏览器接着就会发 pointercancel);合着的行往右拉 = 不是我们的
      g.on = Math.abs(dx) > Math.abs(dy) && !(g.from === 0 && dx > 0)
      if (!g.on) { if (g.from !== 0) settle(0, 0); g = null; return } // 开着的那行,列表一滚就收回(同原生列表)
      ;({ k: g.k, w: g.w } = measure())
      try { el.setPointerCapture(e.pointerId) } catch { /* 指针已经没了 */ }
      // 内联而不是挂属性:属性一变,带它的选择器要把整行子树的样式重算一遍(起手那帧 78 个元素)
      track.style.willChange = 'transform'
      closeOtherSwipes({ target: el })
    }
    let v = g.from + (e.clientX - g.x0) / g.k
    // 拉过头有阻力:全开之外每多拉 1px 只走 0.3px,合着时往右也一样
    if (v < -g.w) v = -g.w + (v + g.w) * 0.3
    else if (v > 0) v *= 0.3
    put(v)
    g.trail.push([e.timeStamp, v])
    while (g.trail.length > 2 && e.timeStamp - g.trail[0][0] > 100) g.trail.shift()
  }
  const up = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id) return
    const was = g
    g = null
    if (!was.on) {
      // a touch that never became a drag: it may have caught a spring halfway (down froze it) — let it finish; one the
      // browser took for the list's scroll closes the row (as a scroll does)
      if (x !== 0 || el.hasAttribute('data-open')) {
        const to = e.type === 'pointercancel' || !el.hasAttribute('data-open') ? 0 : -measure().w
        if (Math.abs(x - to) > 0.5) settle(to, 0)
      }
      return
    }
    dragged = true
    const [t1, x1] = was.trail[was.trail.length - 1]
    const [t0, x0] = was.trail[0]
    // 停住再抬手不算甩
    const v = e.type === 'pointercancel' || e.timeStamp - t1 > 80 || t1 <= t0 ? 0 : (x1 - x0) / (t1 - t0)
    const open = v < -0.3 ? true : v > 0.3 ? false : x < -was.w / 2
    settle(open ? -was.w : 0, v)
  }
  // 弹完就摘掉过渡:之后按下这一行(点进会话)不必再读一次计算样式去接住它
  const ended = (e: TransitionEvent): void => { if (e.target === track) track.style.transition = '' }
  track.addEventListener('transitionend', ended)
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  swipes.set(el, {
    close: () => { if (!g && (x !== 0 || el.hasAttribute('data-open'))) { x = track.style.transition ? now() : x; settle(0, 0) } },
    justDragged: () => { const was = dragged; dragged = false; return was },
  })
  return () => {
    track.removeEventListener('transitionend', ended)
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    swipes.delete(el)
  }
}

const PULL = 84 // 手指走过这么多(视口 px)算拉到位

/** 列表已经在顶上还往下拉 = 搜索(与右上角搜索钮同一个动作)。拉到位松手才触发,手势被系统拿走(touchcancel:
 *  下拉通知栏、边缘返回)不算松手;滚动器的首个子节点放 <PullHint />。 */
export function usePullToSearch(ref: RefObject<HTMLElement | null>, run: (() => void) | undefined): void {
  const runRef = useRef(run)
  runRef.current = run
  const on = !!run
  useEffect(() => {
    const el = ref.current
    if (!el || !on) return
    let y0 = -1
    let pulled = 0
    const set = (v: number): void => {
      pulled = v
      if (v) el.style.setProperty('--pl-pull', v.toFixed(3)); else el.style.removeProperty('--pl-pull')
      el.toggleAttribute('data-pull-armed', v >= 1)
    }
    const start = (e: TouchEvent): void => { y0 = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : -1 }
    const move = (e: TouchEvent): void => {
      if (y0 < 0) return
      if (el.scrollTop > 0) { y0 = -1; set(0); return }
      set(Math.max(0, Math.min(1.25, (e.touches[0].clientY - y0) / PULL)))
    }
    const cancel = (): void => { y0 = -1; set(0) }
    const end = (): void => { const go = pulled >= 1; cancel(); if (go) runRef.current?.() }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', cancel)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', cancel)
      set(0)
    }
  }, [ref, on])
}

export function PullHint() {
  const { t } = useI18n()
  return (
    <div className="pl-pull" aria-hidden="true">
      <span className="pl-pull-pill"><Search /><span className="pl-pull-idle">{t('phonelist.pull.idle')}</span><span className="pl-pull-armed">{t('phonelist.pull.armed')}</span></span>
    </div>
  )
}

/** 首次提示:手势用过才知道,所以每个列表说一次,点「知道了」后不再出现(记在本机)。 */
export function ListHint({ id, children }: { id: string; children: ReactNode }) {
  const { t } = useI18n()
  const key = `forsion_phone_list_hint_${id}`
  const [show, setShow] = useState(() => { try { return !localStorage.getItem(key) } catch { return false } })
  if (!show) return null
  return (
    <div className="pl-hint" role="note" data-hint={id}>
      <span>{children}</span>
      <button type="button" onClick={() => { try { localStorage.setItem(key, '1') } catch { /* 记不住就这一次会话内不再显示 */ } setShow(false) }}>{t('phonelist.hint.ok')}</button>
    </div>
  )
}
