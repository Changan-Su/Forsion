/**
 * 长提问折叠(10-17,借鉴 Claude 第二轮 C2):用户气泡正文高过 300px 就收起,只露 300px,底部七档渐隐;
 * 气泡里左下一行「展开全文 · 共 N 行」,点它或点淡出那一截都展开,展开后变「收起」。
 * 只改显示:复制 / 编辑 / 发给模型的都是全文(都拿 msg.content,不经过这里)。展开状态不记,重开会话一律收起。
 * 搜索跳到这条时由 ChatView 调 expandUserFold,测量还未送达时也能展开。
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
const EXPAND_EVENT = 'forsion:expand-user-fold'

/** Search can arrive before ResizeObserver has decided whether to show the fold button. */
export function expandUserFold(message: Element): void {
  message.querySelector('.t2-user-fold')?.dispatchEvent(new Event(EXPAND_EVENT))
}

export function UserFold({ lines, children }: { lines: number; children: ReactNode }) {
  const { t } = useI18n()
  const inner = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    // Observe the inner natural height: reading offsetHeight in every message's layout
    // effect forces the newly mounted chat to lay out before its scroll position is set.
    // ResizeObserver supplies the already-computed size, including fonts/width changes.
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setTall(Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height) > FOLD_PX + FOLD_SLACK)
    })
    const fold = el.parentElement!
    const expand = (): void => setOpen(true)
    fold.addEventListener(EXPAND_EVENT, expand)
    ro.observe(el)
    return () => { ro.disconnect(); fold.removeEventListener(EXPAND_EVENT, expand) }
  }, [])
  const folded = tall && !open
  const toggle = (): void => {
    setOpen(!open)
    // 收起时气泡顶可能已在视口上方:把它拉回来,别让人对着下一条消息发懵
    if (open) requestAnimationFrame(() => inner.current?.closest('.t2-userwrap')?.scrollIntoView({ block: 'nearest' }))
  }
  return (
    <>
      <div className="t2-user-fold" data-folded={folded || undefined}
        style={tall === null && !open ? { maxHeight: FOLD_PX + FOLD_SLACK, overflow: 'hidden' } : undefined}>
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
