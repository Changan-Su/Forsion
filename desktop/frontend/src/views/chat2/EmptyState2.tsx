/** 空状态(新视觉):Forsion 品牌整图(奶油瓦片+神树,同启动加载页;明暗双版)+ 诗句 + 副标。
 *  center(10-25,freshLayout.ts):对话列空着时连同输入区整块居中;按下发送那一刻输入区落回底部、空状态与输入区上方那几条淡出,
 *  没发出去就留在底部、空状态淡回来。rise:从有消息的会话点「新对话」进来 —— 输入区从底部升到中间,空状态到位后再淡入。 */
import { BrandLogo } from '../../components/BrandLogo'
import { useLayoutEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import { DROP_EASE, DROP_MS, FRESH_GAP, FRESH_MIN_TOP, freshPlacement, onSend, reducedMotion } from './freshLayout'
import './chat2.css'
import '../../tangu/messages' // Tangu 自己的文案片段(核心插件化 2c)

const SETTLE_MS = 250 // 居中时那一块因内容变高变矮(开场建议晚到、窗口缩放)而挪位:--duration-slow
const SETTLE_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)' // --ease-out
const FADE_MS = 150

export function EmptyState2({ title, subtitle, compact = false, center = false, rise = false }: { title?: string; subtitle?: string; compact?: boolean; center?: boolean; rise?: boolean }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const riseRef = useRef(rise) // 只认挂载那一刻
  useLayoutEffect(() => {
    const empty = ref.current
    const col = empty?.parentElement
    if (!empty || !col?.classList.contains('t2-chat-col')) return
    const composer = col.querySelector<HTMLElement>(':scope > .composer-anchor')
    if (!composer) return
    const still = reducedMotion()
    let mode: 'center' | 'bottom' = center ? 'center' : 'bottom'
    let lift = 0
    let lastTop: number | null = null
    let fades: Animation[] = []
    let motion: Animation | null = null // 升起 / 挪位那段(落底那段不记:卸载时它该接着跑完)
    let leaving = false
    const rising = center && riseRef.current && !still
    riseRef.current = false

    // 输入区往上抬多少写在 translate 上(不改它在流里的位置,落底 = 动画回 0);动画只在过渡期间,停下后以内联值为准。
    const setLift = (next: number, how: 'none' | 'drop' | 'settle'): void => {
      if (next === lift) return
      const from = lift
      lift = next
      composer.style.translate = next ? `0 ${-next}px` : ''
      motion?.cancel()
      motion = null
      if (how === 'none' || still || typeof composer.animate !== 'function') return
      const a = composer.animate([{ translate: `0 ${-from}px` }, { translate: `0 ${-next}px` }], how === 'drop'
        ? { duration: DROP_MS, easing: DROP_EASE }
        : { duration: SETTLE_MS, easing: SETTLE_EASE })
      if (how !== 'drop') motion = a
    }
    const place = (): void => {
      empty.style.bottom = 'auto'
      // offset/client 尺寸与 CSS top 同为局部 px,端级 zoom 不会把预留高度再乘一次。
      const anchorH = composer.offsetHeight
      const available = mode === 'center'
        ? Math.max(0, col.clientHeight - anchorH - FRESH_GAP - FRESH_MIN_TOP * 2)
        : Math.max(0, col.clientHeight - anchorH - 40)
      const densities = available < 100 ? ['minimal'] : available < 200 ? ['compact', 'minimal'] : ['full', 'compact', 'minimal']
      let height = 0
      for (const density of densities) {
        empty.dataset.density = density
        height = empty.offsetHeight
        if (height <= available) break
      }
      const hidden = height > available
      empty.style.visibility = hidden ? 'hidden' : ''
      let top: number
      if (mode === 'center') {
        const p = freshPlacement(col.clientHeight, hidden ? 0 : height, composer.offsetTop, anchorH)
        top = p.emptyTop
        setLift(p.lift, lastTop === null ? (rising ? 'drop' : 'none') : 'settle')
      } else {
        top = Math.max(16, Math.min((col.clientHeight - height) / 2, 16 + available - height))
      }
      if (lastTop !== null && Math.abs(lastTop - top) >= 1 && !still && mode === 'center' && typeof empty.animate === 'function') {
        empty.animate([{ translate: `0 ${lastTop - top}px` }, { translate: '0 0' }], { duration: SETTLE_MS, easing: SETTLE_EASE })
      }
      empty.style.top = `${top}px`
      lastTop = top
    }
    if (rising) {
      // 到位之后再淡入(输入区要先升上来,别和它交叠)
      empty.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, delay: DROP_MS - 40, easing: SETTLE_EASE, fill: 'backwards' })
    }
    place()

    // 空状态 + 输入区上方 / 下方那几条:落底时淡出,没发出去再淡回来
    const fadeTargets = (): HTMLElement[] => [empty, ...composer.querySelectorAll<HTMLElement>(':scope > .newchat-pickers, :scope > .newchat-projectbar, :scope > .t2-starters')]
    const fadeOut = (): void => {
      leaving = true
      fades = fadeTargets().map((el) => (still || typeof el.animate !== 'function')
        ? (el.style.opacity = '0', null)
        : el.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 -6px' }], { duration: FADE_MS, easing: SETTLE_EASE, fill: 'forwards' }))
        .filter((a): a is Animation => !!a)
    }
    const fadeBack = (): void => {
      leaving = false
      for (const a of fades) a.reverse()
      fades = []
      for (const el of fadeTargets()) el.style.opacity = ''
    }
    const off = onSend((d) => {
      if (!d.ta || d.ta.closest('.t2-chat-col') !== col) return
      if (d.phase === 'press' && mode === 'center') {
        mode = 'bottom'
        fadeOut()
        setLift(0, 'drop')
      } else if (d.phase === 'drop' && leaving) {
        // 没发出去:输入区已经在底部就留在底部(来回跳更难受),空状态按贴底的排法淡回来
        fadeBack()
        lastTop = null
        place()
      }
    })

    const observer = new ResizeObserver(place)
    observer.observe(col)
    observer.observe(composer)
    observer.observe(empty)
    return () => {
      observer.disconnect()
      off()
      motion?.cancel() // 升到一半就换走了:别让它带着输入区在消息上面接着往上飘
      for (const a of fades) a.cancel()
      for (const el of composer.querySelectorAll<HTMLElement>(':scope > *')) el.style.opacity = ''
      // 卸载 = 第一条消息上屏了(落底动画若还在跑,它跑在输入区自己身上,接着跑完)/ 换走了:不留抬升
      if (lift) composer.style.translate = ''
    }
  }, [center])
  return (
    <div className="t2-empty" ref={ref}>
      {compact ? title : <>
        <div className="t2-empty-mark"><BrandLogo size={64} /></div>
        <div className="t2-empty-title">{title || t('chat.emptyTitle')}</div>
        <div className="t2-empty-sub">{subtitle || t('chat.emptyHint')}</div>
      </>}
    </div>
  )
}
