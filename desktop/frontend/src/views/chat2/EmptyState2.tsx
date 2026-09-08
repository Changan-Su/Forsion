/** 空状态(新视觉):Forsion 品牌整图(奶油瓦片+神树,同启动加载页;明暗双版)+ 诗句 + 副标。 */
import { BrandLogo } from '../../components/BrandLogo'
import { useLayoutEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import './chat2.css'

export function EmptyState2({ title, subtitle, compact = false }: { title?: string; subtitle?: string; compact?: boolean }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const empty = ref.current
    const col = empty?.parentElement
    if (!empty || !col?.classList.contains('t2-chat-col')) return
    const composer = col.querySelector<HTMLElement>(':scope > .composer-anchor')
    if (!composer) return
    const place = (): void => {
      empty.style.bottom = 'auto'
      // offset/client 尺寸与 CSS top 同为局部 px,端级 zoom 不会把预留高度再乘一次。
      const available = Math.max(0, col.clientHeight - composer.offsetHeight - 40)
      const densities = available < 100 ? ['minimal'] : available < 200 ? ['compact', 'minimal'] : ['full', 'compact', 'minimal']
      let height = 0
      for (const density of densities) {
        empty.dataset.density = density
        height = empty.offsetHeight
        if (height <= available) break
      }
      empty.style.visibility = height > available ? 'hidden' : ''
      empty.style.top = `${Math.max(16, Math.min((col.clientHeight - height) / 2, 16 + available - height))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(col)
    observer.observe(composer)
    observer.observe(empty)
    return () => observer.disconnect()
  }, [])
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
