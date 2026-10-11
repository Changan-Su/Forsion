/**
 * 手机整屏列表的共用件(布局「二」,2026-10-09 用户选定):分类胶囊、日期分段、左滑一行出操作、一颗悬浮主按钮、
 * 下拉搜索、首次提示。会话列表(SidebarPane 的 timeline)与笔记列表共用。
 *
 * 只在「两级导航的列表层」用 —— 调用方拿 lcl 的 `useListFirst()` 当闸(原生底栏 × 竖屏 × 该 Space 有列表);
 * 桌面 / 网页 / 手机浏览器一行都不渲染,样式也全部挂在 `.mb-shell[data-list-first]` 之下(phoneList.css)。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Search } from 'lucide-react'
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

/** 手指落在别处时把开着的那一行收回。挂在列表滚动器的 onTouchStart 上(一处,不是每行一个监听)。 */
export function closeOtherSwipes(e: { target: EventTarget | null }): void {
  const keep = (e.target as Element | null)?.closest?.('.pl-swipe')
  for (const el of document.querySelectorAll<HTMLElement>('.pl-swipe')) if (el !== keep && el.scrollLeft > 0) el.scrollTo({ left: 0, behavior: 'smooth' })
}

/** 左滑露出操作。拖动、方向锁、惯性、吸附都是浏览器自己的横向滚动(scroll-snap),这里只管「点一下收回」。
 *  `actions` 为空就只渲染行本体。 */
export function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  if (!actions.length) return <>{children}</>
  const close = (): void => ref.current?.scrollTo({ left: 0, behavior: 'smooth' })
  return (
    <div
      className="pl-swipe" ref={ref}
      // 开着时点行本体 = 收回,不打开条目(capture:抢在行自己的 onClick 之前)
      onClickCapture={(e) => {
        if ((ref.current?.scrollLeft ?? 0) < 4 || (e.target as Element).closest('.pl-swipe-acts')) return
        e.preventDefault(); e.stopPropagation(); close()
      }}
    >
      {children}
      <div className="pl-swipe-acts">
        {actions.map((a) => (
          <button key={a.id} type="button" className={`pl-swipe-act${a.tone ? ` ${a.tone}` : ''}`} data-act={a.id} aria-label={a.label} title={a.label} onClick={(e) => { e.stopPropagation(); close(); a.run() }}>
            {a.icon}
          </button>
        ))}
      </div>
    </div>
  )
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
