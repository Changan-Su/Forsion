/** 双链 hover 预览(Obsidian 页面预览式):悬停正文 [[链接]] 400ms 弹只读渲染浮卡,
 *  移入浮卡可停留滚动,离开即关。事件委托吃编辑器 wikilink 部件(.wikilink[data-wiki]);
 *  未解析链接与文件引用([[xxx.db]] 等)不预览。挂载于 AmadeusOverlays,三端共享。 */
import { useEffect, useRef, useState } from 'react'
import { resolvePageName } from '@amadeus-shared/links'
import type { LoadedPage } from '@amadeus-shared/compiler/types'
import { amadeus } from '../api'
import { usePageStore } from '../store/pageStore'
import { isFileRef } from '../lib/vaultFiles'
import { PlainMarkdownEditor } from '../blocks/markdown/MarkdownBlock'
import { OverlayAt } from '../lib/clampMenu'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'wikihover.emptyNote': { zh: '(空笔记)', en: '(Empty note)' },
})

const SHOW_DELAY = 400
const MAX_CHARS = 2500
const CARD_W = 380 // 与 .amx-hoverprev 的 width/max-height 同步
const CARD_H = 300

/** 按 2D 布局顺序拼接块内容(预览只要前一段,截断即可)。 */
function clipContent(p: LoadedPage): string {
  const parts: string[] = []
  let total = 0
  for (const row of p.manifest.root.children) {
    for (const col of row.columns) {
      for (const ref of col.children) {
        const c = p.blocks[ref.ref]?.content ?? ''
        if (!c.trim()) continue
        parts.push(c)
        total += c.length
        if (total > MAX_CHARS) return `${parts.join('\n\n').slice(0, MAX_CHARS)}\n\n…`
      }
    }
  }
  return parts.join('\n\n') || translate('wikihover.emptyNote')
}

export function WikiHoverPreview() {
  const [show, setShow] = useState<{ name: string; path: string; x: number; y: number } | null>(null)
  const [md, setMd] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const overCard = useRef(false)

  useEffect(() => {
    const clearTimer = (): void => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    const onOver = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      const el = t.closest?.('.wikilink[data-wiki]') as HTMLElement | null
      if (!el || el.classList.contains('wikilink-unresolved')) return
      const name = el.getAttribute('data-wiki') ?? ''
      if (!name || isFileRef(name)) return
      const st = usePageStore.getState()
      const path = resolvePageName(name, st.pages, st.activePage ?? undefined)
      if (!path) return
      clearTimer()
      const r = el.getBoundingClientRect()
      timer.current = window.setTimeout(() => {
        // ⚠️ 贴底必须**翻转到链接上方**,不能只往上夹:夹完卡片会盖住链接本身 → 盖住指针 →
        // 链接 mouseleave 关卡 → 指针又落回链接 → 再弹……无限闪烁(聊天气泡的引用条天然
        // 在屏幕底部,一挂就中;编辑器里链接多在中部,这坑藏了很久)。
        const below = r.bottom + 8
        const y = below + CARD_H <= window.innerHeight - 8 ? below : Math.max(8, r.top - 8 - CARD_H)
        setShow({ name, path, x: Math.min(r.left, window.innerWidth - CARD_W - 16), y })
      }, SHOW_DELAY)
      const cancel = (): void => {
        el.removeEventListener('mouseleave', cancel)
        clearTimer()
        // 给指针 150ms 进入浮卡;没进就关
        window.setTimeout(() => {
          if (!overCard.current) setShow(null)
        }, 150)
      }
      el.addEventListener('mouseleave', cancel)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShow(null)
    }
    window.addEventListener('mouseover', onOver)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mouseover', onOver)
      window.removeEventListener('keydown', onKey)
      clearTimer()
    }
  }, [])

  useEffect(() => {
    if (!show) {
      setMd(null)
      return
    }
    let live = true
    void amadeus
      .readPage(show.path)
      .then((p) => {
        if (live) setMd(clipContent(p))
      })
      .catch(() => {
        if (live) setMd(null)
      })
    return () => {
      live = false
    }
  }, [show])

  if (!show || md === null) return null
  return (
    <OverlayAt
      className="amx-hoverprev"
      x={show.x}
      y={show.y}
      onMouseEnter={() => {
        overCard.current = true
      }}
      onMouseLeave={() => {
        overCard.current = false
        setShow(null)
      }}
    >
      <div className="amx-hoverprev-title" title={show.path}>{show.name.split('|')[0]}</div>
      <div className="amx-hoverprev-body am-app">
        {/* key 换页重建编辑器实例;readOnly 纯渲染 */}
        <PlainMarkdownEditor key={show.path} initial={md} onChange={() => {}} readOnly />
      </div>
    </OverlayAt>
  )
}
