/**
 * 成就达成 toast(chat 输入框上方,固定 340px):以「系列共用徽章」为核心的三段式动画——
 * ① 坠落:徽章带纵向光轨+拉伸模糊从上方快速坠落,在中点减速停下并从轻微倾斜转正;
 * ② 解锁:落点扩出圆形外圈,中心短促闪光+径向光晕+四颗星点;
 * ③ 展开:闪光收敛后徽章左移为信息条锚点,信息条从徽章后方向右遮罩揭示(非淡入),
 *    两级文字依次上移显现;终态=圆徽+横条,只留外圈余辉与两颗静止星点,整体轻微失焦淡出。
 * 全程单时间轴(所有元素共用 4.6s,keyframes 百分比对齐),无弹簧无整卡弹出。
 * 出队双保险 = wrapper animationend + 5.2s timeout(最小化节流/reduced-motion 兜底),幂等。
 */
import React, { useEffect, useState } from 'react'
import { Trophy } from 'lucide-react'
import { useI18n } from '../i18n'
import { medalTier, seriesPoints } from './definitions'
import { findAchievement, useAchievements } from './store'
import './achievements.css'

/** `onOpen` 由挂载点(Root / MobileRoot)注入 —— achievements/ 是零反向依赖的核心模块,
 *  不能在这里 import appStore 去调 openAchievements。不传 = 不长点击层,保持旧的纯展示 toast。 */
export function AchievementToast({ onOpen }: { onOpen?: () => void } = {}): React.ReactElement | null {
  const id = useAchievements((s) => s.queue[0])
  const claimed = useAchievements((s) => s.claimed)
  const shiftToast = useAchievements((s) => s.shiftToast)
  const { t } = useI18n()
  /** 鼠标停在 toast 上 / 键盘聚焦时冻住出队 —— 否则「伸手去点的过程中它自己没了」,
   *  这一下会落到下面的界面上(点开某个 Space 之类)。CSS 那边同步 animation-play-state: paused。 */
  const [held, setHeld] = useState(false)

  useEffect(() => { setHeld(false) }, [id]) // 换了一条 toast 就解冻,别把上一条的悬停状态带过来

  useEffect(() => {
    if (!id || held) return
    const timer = setTimeout(() => shiftToast(id), 5200)
    return () => clearTimeout(timer)
  }, [id, held, shiftToast])

  if (!id) return null
  const hit = findAchievement(id)
  if (!hit) return null // 未知 id(如插件已禁用):timeout 兜底出队
  const tier = medalTier(hit.series, seriesPoints(hit.series, claimed))
  const Icon = hit.series.icon || Trophy // 系列共用徽章 = 系列图标 + 当前等级色

  return (
    <div key={id} className="ach-toast" data-tier={tier ?? 'off'} role="status"
      onAnimationEnd={(e) => { if (e.animationName === 'ach-t-wrap') shiftToast(id) }}>
      {/* 点击整条打开成就面板。浮层本体是 pointer-events:none(不挡下面的输入区),只让这一层可点;
          靠 css 的 z-index:2 盖在徽章/信息条之上,且它是 <button> 而非 onClick div,键盘与读屏都拿得到。 */}
      {onOpen && (
        <button type="button" className="ach-toast-hit" aria-label={t('achievements.title')}
          onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
          onClick={() => { onOpen(); shiftToast(id) }} />
      )}
      <div className="ach-toast-body">
        <div className="ach-toast-sub">{t('achievements.unlocked')}</div>
        <div className="ach-toast-title">{hit.a.title || t(`achievements.a.${hit.a.id}.title`)}</div>
      </div>
      <div className="ach-toast-badge">
        <Icon />
        <i className="ach-toast-ring" />
        <i className="ach-toast-flash" />
        <i className="ach-toast-glow" />
        <i className="ach-toast-spark s1" />
        <i className="ach-toast-spark s2" />
        <i className="ach-toast-spark s3" />
        <i className="ach-toast-spark s4" />
      </div>
    </div>
  )
}
