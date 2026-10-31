/** 右上角通知堆叠宿主(升级自旧 .toast-wrap):framer-motion 右侧滑入/滑出 + layout 补位动画,
 *  hover 暂停计时,error 常驻手动关。位置钉在右栏图标条(36px dockview 标签条)之下;
 *  仅主窗 Root 挂载(DetachedRoot/MiniRoot 沿旧决策不挂 app 级浮层)。 */
import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Check, Info, AlertTriangle, AlertCircle } from 'lucide-react'
import { useNotifications, type NotifyLevel } from '../stores/notificationStore'
import { useSpaceStore } from '@lcl/engine'

// 级别用小图标(带级别色)传达,替代旧的左侧竖条高亮 —— 卡片本体保持与整体一致的中性风。
const LEVEL_ICON: Record<NotifyLevel, typeof Info> = { info: Info, success: Check, warning: AlertTriangle, error: AlertCircle }

export function NotificationHost() {
  const items = useNotifications((s) => s.items)
  const queued = useNotifications((s) => s.queue.length)
  const pause = useNotifications((s) => s.pause)
  const resume = useNotifications((s) => s.resume)
  const dismiss = useNotifications((s) => s.dismiss)
  const paused = useNotifications((s) => s.paused)
  const inCalendar = useSpaceStore((s) => s.activeSpaceId === 'calendar')
  const wrapRef = useRef<HTMLDivElement>(null)
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
    <div ref={wrapRef} className={`ntf-wrap${inCalendar ? ' ntf-wrap-calendar' : ''}`} aria-live="polite" onMouseEnter={pause} onMouseLeave={resume}>
      {/* popLayout:退场卡片立即让出布局位,下方卡片经 layout 补位。走查续八 8.2 / 8.5 A:进 180ms 从右沿 6px 滑进 + 淡入,
          出 160ms 淡出 + 右移 16px(同 base.css --toast-enter / exit-duration 那一套);layout 只补位置不补尺寸 ——
          以前补尺寸,退场卡被弹出流后宽度塌成内容最小宽,看到的是一边滑一边被横向压扁。anchorX="right":弹出流后贴着
          右沿(左沿会随通知区变窄而右移)。减少动态效果时由根上的 MotionConfig 去掉位移、只留淡入淡出。 */}
      <AnimatePresence initial={false} mode="popLayout" anchorX="right">
        {items.map((n) => (
          <motion.div
            key={n.id}
            layout="position"
            initial={{ x: 6, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 16, opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
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
                <button
                  className="ntf-action"
                  onClick={() => {
                    try { n.action?.run() } catch { /* 插件 action 抛错不砸宿主 */ }
                    dismiss(n.id)
                  }}
                >
                  {n.action.label}
                </button>
              )}
            </div>
            <button className="ntf-close" onClick={() => dismiss(n.id)} aria-label="dismiss">
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      {queued > 0 && <div className="ntf-more">+{queued}</div>}
    </div>
  )
}
