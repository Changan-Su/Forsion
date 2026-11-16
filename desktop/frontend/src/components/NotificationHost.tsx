/** 右上角通知堆叠宿主(升级自旧 .toast-wrap):framer-motion 右侧滑入/滑出 + layout 补位动画,
 *  鼠标悬停暂停计时(触屏 / 手写笔不暂停),error 常驻手动关。位置钉在右栏图标条(36px dockview 标签条)之下;
 *  仅主窗 Root 挂载(DetachedRoot/MiniRoot 沿旧决策不挂 app 级浮层)。
 *  手机(`phone`,MobileRoot 挂载)且窗口窄于 640:改成状态栏下面的一条横幅,一次一条(store 的 banner 模式)。
 *  有原生外壳登记的 presenter(Android)就交给原生层画 —— 网页里的卡盖不到原生胶囊和第二层的实心顶栏;
 *  没有(网页版手机)就自己在网页顶栏的位置画同样的横幅。宽 ≥ 640(Pad、横屏)照桌面放右上角。 */
import { useEffect, useRef, useSyncExternalStore, type MutableRefObject } from 'react'
import { AnimatePresence, animate, motion, useMotionValue } from 'framer-motion'
import { X, Check, Info, AlertTriangle, AlertCircle } from 'lucide-react'
import { useNotifications, type AppNotification, type NotifyLevel } from '../stores/notificationStore'
import { bannerFlungAway, bannerPayload, useNativeBannerPresenter, type NativeBannerPresenter } from '../stores/notificationBanner'
import { useSpaceStore } from '@lcl/engine'
import { installUserGestureTracking } from '@lcl/engine/userGesture'
import { useI18n } from '../i18n'
import { motion as motionTokens } from '../theme/motionTokens'

// 级别用小图标(带级别色)传达,替代旧的左侧竖条高亮 —— 卡片本体保持与整体一致的中性风。
const LEVEL_ICON: Record<NotifyLevel, typeof Info> = { info: Info, success: Check, warning: AlertTriangle, error: AlertCircle }
// 走查续八 8.2 / 8.5 A:进 180ms 从贴着的边 6px 滑进 + 淡入,出 160ms 加速往来的方向退(同 base.css --toast-enter / exit-duration 那一套)。
// 桌面的卡从右沿进出,手机横幅从上沿进出,同一对时长与曲线。
const ENTER_S = 0.18
const EXIT_S = 0.16

/** 手机断点:和手机插件判「是不是手机」用的是同一条线(窄于 640)。 */
const PHONE_QUERY = '(max-width: 639px)'
function subscribeNarrow(fn: () => void): () => void {
  try {
    const mq = window.matchMedia(PHONE_QUERY)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  } catch { return () => {} }
}
function narrowNow(): boolean {
  try { return window.matchMedia(PHONE_QUERY).matches } catch { return false }
}

export function NotificationHost({ phone = false }: { phone?: boolean }) {
  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false)
  const banner = phone && narrow
  const presenter = useNativeBannerPresenter()
  const setBanner = useNotifications((s) => s.setBanner)
  useEffect(() => { setBanner(banner) }, [banner, setBanner])
  useEffect(() => {
    if (!banner) return
    // 手机节流认「用户手势里弹出的带按钮的卡」(撤销一类)不受节流:盯着页面上的真实点按 / 按键(@lcl/engine/userGesture)
    const untrack = installUserGestureTracking()
    // 在后台不上横幅、不开冷却;回到前台接着出(store 的 visibilityChanged)
    const onVisibility = (): void => useNotifications.getState().visibilityChanged()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { untrack(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [banner])
  if (banner && presenter) return <NativeBanner presenter={presenter} />
  if (banner) return <PhoneBanner />
  return <NotificationStack />
}

/** 原生横幅:屏上这一条(换语言时文案跟着换)交给原生层;卸下 / 屏上没了就让它收起。 */
function NativeBanner({ presenter }: { presenter: NativeBannerPresenter }) {
  const n = useNotifications((s) => s.items[0])
  const { t, locale } = useI18n()
  useEffect(() => {
    presenter(n ? bannerPayload(n, { dismiss: t('ntf.dismiss'), hint: t('ntf.banner.hint') }) : null)
  }, [n, presenter, t, locale])
  useEffect(() => () => presenter(null), [presenter])
  return null
}

/** 网页版手机的横幅:同尺寸、同停留、同手势(点正文 = 动作,上滑过 24px 或一甩 / 点 × = 收起)。 */
function PhoneBanner() {
  const n = useNotifications((s) => s.items[0])
  // 收起那一刻往上推了多少:退场从那里接着往上走(AnimatePresence 的 custom 在退场时才读)
  const lift = useRef(0)
  return (
    <div className="ntf-banner-wrap" aria-live="polite">
      <AnimatePresence initial={false} custom={lift}>
        {n && <BannerCard key={n.id} n={n} lift={lift} />}
      </AnimatePresence>
    </div>
  )
}

const bannerVariants = {
  enter: { y: -6, opacity: 0 },
  shown: { y: 0, opacity: 1, transition: { duration: ENTER_S, ease: motionTokens.bezier('surface') } },
  gone: (lift: MutableRefObject<number>) => ({ y: lift.current - 16, opacity: 0, transition: { duration: EXIT_S, ease: motionTokens.bezier('exit') } }),
}

function BannerCard({ n, lift }: { n: AppNotification; lift: MutableRefObject<number> }) {
  const { t } = useI18n()
  const activate = useNotifications((s) => s.activate)
  const dismiss = useNotifications((s) => s.dismiss)
  const y = useMotionValue(0)
  // 手指按下的位置,是否已经拖起来,最近两次采样(松手时按它们算速度,一甩就收)
  const drag = useRef<{ id: number; y0: number; moved: boolean; prevY: number; prevAt: number; lastY: number; lastAt: number } | null>(null)
  const dragged = useRef(false) // 刚拖过:松手补发的 click 不算点正文
  useEffect(() => { lift.current = 0 }, [lift])
  const Icon = LEVEL_ICON[n.level]
  const source = [n.sourceLabel, n.title].filter(Boolean).join(' · ')
  const close = (): void => dismiss(n.id, 'user')
  return (
    <motion.div
      className={`ntf-banner ntf-${n.level}`}
      data-ntf-id={n.id}
      custom={lift}
      variants={bannerVariants}
      initial="enter"
      animate="shown"
      exit="gone"
      style={{ y }}
      onPointerDown={(e) => {
        dragged.current = false
        if (e.pointerType === 'mouse' && e.button !== 0) return
        if ((e.target as Element).closest?.('button')) return // 按钮和 × 自己处理
        drag.current = { id: e.pointerId, y0: e.clientY, moved: false, prevY: e.clientY, prevAt: e.timeStamp, lastY: e.clientY, lastAt: e.timeStamp }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成事件 / 旧浏览器 */ }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        d.prevY = d.lastY; d.prevAt = d.lastAt; d.lastY = e.clientY; d.lastAt = e.timeStamp
        if (Math.abs(e.clientY - d.y0) > 6) d.moved = true
        if (d.moved) y.set(Math.min(0, e.clientY - d.y0)) // 只跟往上;往下不拉(不做下拉展开)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (!d || d.id !== e.pointerId || !d.moved) return
        dragged.current = true
        const dy = y.get()
        const dt = e.timeStamp - d.prevAt
        const v = dt > 0 ? (e.clientY - d.prevY) / dt : 0 // px/ms,往上为负
        if (bannerFlungAway(dy, v)) { lift.current = dy; close() }
        else void animate(y, 0, { duration: ENTER_S, ease: motionTokens.bezier('surface') })
      }}
      onPointerCancel={() => {
        drag.current = null
        void animate(y, 0, { duration: ENTER_S, ease: motionTokens.bezier('surface') })
      }}
      onClick={(e) => {
        if (dragged.current) { dragged.current = false; return }
        if ((e.target as Element).closest?.('button')) return
        if (n.action) activate(n.id) // 点正文 = 点按钮
      }}
    >
      <Icon size={15} className="ntf-icon" aria-hidden />
      <div className="ntf-banner-body">
        {source && <div className="ntf-banner-source">{source}</div>}
        <div className="ntf-banner-text">{n.text}</div>
      </div>
      {n.action && (
        <button className="ntf-action ntf-banner-action" onClick={() => activate(n.id)}>{n.action.label}</button>
      )}
      <button className="ntf-close ntf-banner-close" onClick={close} aria-label={t('ntf.dismiss')} title={t('ntf.banner.hint')}>
        <X size={14} />
      </button>
    </motion.div>
  )
}

/** 桌面 / Pad:右上角的堆叠。 */
function NotificationStack() {
  const { t } = useI18n()
  const items = useNotifications((s) => s.items)
  const queued = useNotifications((s) => s.queue.length)
  const pause = useNotifications((s) => s.pause)
  const resume = useNotifications((s) => s.resume)
  const dismiss = useNotifications((s) => s.dismiss)
  const activate = useNotifications((s) => s.activate)
  const paused = useNotifications((s) => s.paused)
  const inCalendar = useSpaceStore((s) => s.activeSpaceId === 'calendar')
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onHidden = (): void => { if (document.visibilityState === 'hidden') resume() }
    window.addEventListener('blur', resume)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('blur', resume)
      document.removeEventListener('visibilitychange', onHidden)
      resume()
    }
  }, [resume])
  // 悬停暂停的收尾:点了卡片上的「撤销」/ ×,卡片在指针下被移走 —— Chromium 不给这种情况补 mouseleave,
  // paused 就一直挂着,之后所有通知都不再自己消失(check:layoutreset J 实测抓到)。暂停期间指针一出通知区、
  // 或已没有卡片,就恢复计时。
  useEffect(() => {
    if (!paused) return
    if (!items.length) { resume(); return }
    const onMove = (e: PointerEvent): void => {
      if (!wrapRef.current || !(e.target instanceof Node) || !wrapRef.current.contains(e.target)) resume()
    }
    document.addEventListener('pointermove', onMove, true)
    return () => document.removeEventListener('pointermove', onMove, true)
  }, [paused, items.length, resume])
  return (
    // 只有鼠标悬停才暂停:触屏 / 手写笔点一下卡片,浏览器会在抬手后补发兼容的 mouseover/mouseenter,却没有配对的离开
    // (安卓真壳实测:点过一张卡片后,几张卡片一直挂在屏上盖住页面)。离开也只认鼠标:触屏笔记本上鼠标停在卡片上时
    // 用手指点一下,手指抬起的 pointerleave 不该解除鼠标的暂停。暂停只由鼠标挂上,鼠标的离开 + 上面的兜底足够解除。
    <div
      ref={wrapRef}
      className={`ntf-wrap${inCalendar ? ' ntf-wrap-calendar' : ''}`}
      aria-live="polite"
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') pause() }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') resume() }}
    >
      {/* popLayout:退场卡片立即让出布局位,下方卡片经 layout 补位。进 180ms 从右沿 6px 滑进 + 淡入,
          出 160ms 淡出 + 右移 16px;layout 只补位置不补尺寸 —— 以前补尺寸,退场卡被弹出流后宽度塌成内容最小宽,
          看到的是一边滑一边被横向压扁。anchorX="right":弹出流后贴着右沿(左沿会随通知区变窄而右移)。
          减少动态效果时由根上的 MotionConfig 去掉位移、只留淡入淡出。 */}
      <AnimatePresence initial={false} mode="popLayout" anchorX="right">
        {items.map((n) => (
          <motion.div
            key={n.id}
            layout="position"
            initial={{ x: 6, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={n.settle ? { opacity: 0, transition: { duration: motionTokens.s('base') } } : { x: 16, opacity: 0, transition: { duration: EXIT_S, ease: motionTokens.bezier('exit') } }}
            transition={{ duration: ENTER_S, ease: motionTokens.bezier('surface') }}
            className={`ntf ntf-${n.level}`}
          >
            {(() => { const I = LEVEL_ICON[n.level]; return <I size={15} className="ntf-icon" /> })()}
            <div className="ntf-body">
              {(n.sourceLabel || n.title) && (
                <div className="ntf-title">{[n.sourceLabel, n.title].filter(Boolean).join(' · ')}</div>
              )}
              <div className="ntf-text">
                {n.text}
                {n.count > 1 && <span className="ntf-count">×{n.count}</span>}
              </div>
              {n.action && (
                <button className="ntf-action" onClick={() => activate(n.id)}>
                  {n.action.label}
                </button>
              )}
            </div>
            <button className="ntf-close" onClick={() => dismiss(n.id, 'user')} aria-label={t('ntf.dismiss')}>
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      {queued > 0 && <div className="ntf-more">+{queued}</div>}
    </div>
  )
}
