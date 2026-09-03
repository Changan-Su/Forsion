/** 浮动目录(移植自 Forsion-AI-Studio client/components/ChatTOC.tsx,改 Tailwind → LCL token CSS)。
 *  贴正文左侧悬浮:默认竖向刻度条(每条一道,长度编码层级),hover 展开为列表;
 *  IntersectionObserver 高亮当前段,点击平滑跳转。
 *  扫 [data-toc-msg-role="user"](用户提问轮次=level 0)+ h1/h2/h3[data-toc-level](助手标题,Markdown anchorPrefix 产出),
 *  按文档顺序排好——这样即便回复没有 markdown 标题,多轮对话也有目录(对齐右栏 ChatToc)。 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'ftoc.label': { zh: '目录', en: 'Table of contents' },
})

interface TocItem { id: string; level: number; text: string }

export function FloatingToc({ scrollContainerRef, scanTrigger }: {
  scrollContainerRef: RefObject<HTMLElement | null>
  scanTrigger?: number
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<TocItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<number | null>(null)

  const scan = useCallback(() => {
    const root = scrollContainerRef.current
    if (!root) return
    const nodes = root.querySelectorAll<HTMLElement>('[data-toc-msg-role="user"], h1[data-toc-level], h2[data-toc-level], h3[data-toc-level]')
    const list: TocItem[] = []
    nodes.forEach((n) => {
      if (!n.id) return
      if (n.dataset.tocMsgRole === 'user') {
        const text = (n.dataset.tocTitle || n.textContent || '').trim()
        if (text) list.push({ id: n.id, level: 0, text }) // 用户提问轮次
      } else if (n.dataset.tocLevel) {
        const text = (n.textContent || '').trim()
        if (text) list.push({ id: n.id, level: Number(n.dataset.tocLevel) || 1, text }) // 助手标题
      }
    })
    setItems((prev) => (prev.length === list.length && prev.every((p, i) => p.id === list[i].id && p.text === list[i].text)) ? prev : list)
  }, [scrollContainerRef])

  useEffect(() => {
    scan()
    const root = scrollContainerRef.current
    if (!root) return
    let raf = 0
    const obs = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(scan) })
    obs.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { cancelAnimationFrame(raf); obs.disconnect() }
  }, [scan, scrollContainerRef, scanTrigger])

  // 当前段高亮:负的底部 rootMargin 偏向视口上方的标题(更贴近「正在读」的直觉)。
  useEffect(() => {
    const root = scrollContainerRef.current
    if (!root || items.length === 0) return
    const visible = new Set<string>()
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id) })
      const next = items.find((i) => visible.has(i.id))
      if (next) setActiveId(next.id)
    }, { root, rootMargin: '0px 0px -60% 0px', threshold: 0 })
    items.forEach((i) => { try { const el = root.querySelector(`#${CSS.escape(i.id)}`); if (el) obs.observe(el) } catch { /* CSS.escape 不可用则跳过 */ } })
    return () => obs.disconnect()
  }, [items, scrollContainerRef])

  const jumpTo = useCallback((id: string) => {
    const root = scrollContainerRef.current
    if (!root) return
    let el: HTMLElement | null = null
    try { el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) } catch { return }
    if (!el) return
    // heading 嵌在多层定位祖先里,offsetTop 单算不准 → 逐级累加到滚动容器。
    let top = 0
    let cur: HTMLElement | null = el
    while (cur && cur !== root) { top += cur.offsetTop; cur = cur.offsetParent as HTMLElement | null }
    root.scrollTo({ top: top - 24, behavior: 'smooth' })
  }, [scrollContainerRef])

  const enter = (): void => { if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null } setHovered(true) }
  const leave = (): void => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setHovered(false), 150) }

  if (items.length < 2) return null

  return (
    <div className={`t2-ftoc${hovered ? ' open' : ''}`} onMouseEnter={enter} onMouseLeave={leave} aria-label={t('ftoc.label')}>
      {items.map((it) => {
        const isActive = activeId === it.id
        // level 0=用户轮次(最长/最左),1/2/3=助手标题逐级缩进、刻度渐短。
        const barLen = (it.level === 0 ? 18 : it.level === 1 ? 14 : it.level === 2 ? 11 : 8) + (isActive ? 6 : 0)
        return (
          <button
            key={it.id}
            type="button"
            className={`t2-ftoc-item${isActive ? ' active' : ''}${it.level === 0 ? ' turn' : ''}`}
            onClick={() => jumpTo(it.id)}
            title={it.text}
            style={{ paddingLeft: hovered ? 8 + it.level * 10 : 0 }}
          >
            <span
              className="t2-ftoc-bar"
              style={{ transform: hovered ? 'translateX(0) scaleX(1)' : `translateX(${it.level * 3}px) scaleX(${barLen / 4})` }}
            />
            <span className="t2-ftoc-text">{it.text}</span>
          </button>
        )
      })}
    </div>
  )
}
