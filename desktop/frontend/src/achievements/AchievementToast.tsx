/**
 * 成就达成 toast:窗口中下方(chat 输入框上方)——不滑入,在原位柔和闪光中「凝聚显形」
 * (轻微过曝+模糊→快速清晰),停留后淡出并轻微失焦。单 keyframes 走完全生命周期,无位移无弹跳。
 * 队列串行播放;出队双保险 = animationend + 3.6s timeout(最小化节流兜底),shiftToast 幂等。
 */
import React, { useEffect } from 'react'
import { Trophy } from 'lucide-react'
import { useI18n } from '../i18n'
import { findAchievement, useAchievements } from './store'
import './achievements.css'

export function AchievementToast(): React.ReactElement | null {
  const id = useAchievements((s) => s.queue[0])
  const shiftToast = useAchievements((s) => s.shiftToast)
  const { t } = useI18n()

  useEffect(() => {
    if (!id) return
    const timer = setTimeout(() => shiftToast(id), 3600)
    return () => clearTimeout(timer)
  }, [id, shiftToast])

  if (!id) return null
  const hit = findAchievement(id)
  if (!hit) return null // 未知 id(如插件已禁用):timeout 兜底出队
  const Icon = hit.a.icon || Trophy

  return (
    <div key={id} className="ach-toast" role="status"
      onAnimationEnd={(e) => { if (e.animationName === 'ach-toast-life') shiftToast(id) }}>
      <Icon />
      <div className="ach-toast-text">
        <div className="ach-toast-sub">{t('achievements.unlocked')}</div>
        <div className="ach-toast-title">{hit.a.title || t(`achievements.a.${hit.a.id}.title`)}</div>
      </div>
    </div>
  )
}
