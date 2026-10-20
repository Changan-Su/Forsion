/**
 * 长提问折叠(10-17,借鉴 Claude 第二轮 C2):用户气泡正文高过 300px 就收起,只露 300px,底部七档渐隐;
 * 气泡里左下一行「展开全文 · 共 N 行」,点它或点淡出那一截都展开,展开后变「收起」。
 * 只改显示:复制 / 编辑 / 发给模型的都是全文(都拿 msg.content,不经过这里)。展开状态不记,重开会话一律收起。
 * 搜索跳到这条时由 ChatView 点开(.t2-user-more[aria-expanded=false])。
 * 方案页:docs/ToBeImproved/借鉴Claude设计系统方案_2026-10-17/round2.html
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'chat.fold.more': { zh: '展开全文 · 共 {n} 行', en: 'Show all · {n} lines' },
  'chat.fold.less': { zh: '收起', en: 'Show less' },
})

export const FOLD_PX = 300
/** 只藏一两行不值得折:超出约三行(14px × 1.6)才收 */
export const FOLD_SLACK = 66

export function UserFold({ lines, children }: { lines: number; children: ReactNode }) {
  const { t } = useI18n()
  const inner = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    // 量里层的自然高度:外层收起后高度定在 300,内容变了(字体到位、列宽变了)外层量不出来
    const measure = (): void => setTall(el.offsetHeight > FOLD_PX + FOLD_SLACK)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const folded = tall && !open
  const toggle = (): void => {
    setOpen(!open)
    // 收起时气泡顶可能已在视口上方:把它拉回来,别让人对着下一条消息发懵
    if (open) requestAnimationFrame(() => inner.current?.closest('.t2-userwrap')?.scrollIntoView({ block: 'nearest' }))
  }
  return (
    <>
      <div className="t2-user-fold" data-folded={folded || undefined}>
        <div ref={inner}>{children}</div>
        {folded && <span className="t2-user-fold-hit" aria-hidden onClick={() => setOpen(true)} />}
      </div>
      {tall && (
        <button type="button" className="t2-user-more" aria-expanded={open} onClick={toggle}>
          {open ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
          {open ? t('chat.fold.less') : t('chat.fold.more', { n: lines })}
        </button>
      )}
    </>
  )
}
