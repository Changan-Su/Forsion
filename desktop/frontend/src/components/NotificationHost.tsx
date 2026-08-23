/** 右上角通知堆叠宿主(升级自旧 .toast-wrap):framer-motion 右侧滑入/滑出 + layout 补位动画,
 *  hover 暂停计时,error 常驻手动关。位置钉在右栏图标条(36px dockview 标签条)之下;
 *  仅主窗 Root 挂载(DetachedRoot/MiniRoot 沿旧决策不挂 app 级浮层)。 */
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
  const inCalendar = useSpaceStore((s) => s.activeSpaceId === 'calendar')
  return (
    <div className={`ntf-wrap${inCalendar ? ' ntf-wrap-calendar' : ''}`} aria-live="polite" onMouseEnter={pause} onMouseLeave={resume}>
      {/* popLayout:退场卡片立即让出布局位,下方卡片经 layout 弹簧同步上移补位(toast 堆叠标准配方)。 */}
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((n) => (
          <motion.div
            key={n.id}
            layout
            initial={{ x: '112%', opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '112%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 480, damping: 40, mass: 0.85 }}
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
