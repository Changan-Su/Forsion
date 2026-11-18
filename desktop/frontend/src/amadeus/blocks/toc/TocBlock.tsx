/**
 * 页内目录块(Notion 的 /目录):笔记里一个 ```toc 代码块,渲染成本页标题的列表,点一条平滑滚到那个标题并闪一下。
 *
 * 落盘形态与选项见 `@amadeus-shared/tocBlock`(Obsidian Dynamic Table of Contents 的写法)。挂在嵌入层(unified/embedLayer.tsx)里,
 * 和按钮块一样是「难源码编辑块」:光标经过不露源码,悬停右上角 `</>` 才露。
 *
 * 跟着别处的标题变:嵌入层的 widget 只在**本块文字**变了才重渲染,所以这里自己订阅文档变化(source.subscribe),
 * 每帧最多重算一次,标题列表(级别 + 文字)没变就不 setState —— 正文里打字不动目录的 DOM。
 *
 * 条目是 `<a href="#标题">` 不是 <button>:阅读模式拿编辑器 DOM 的快照渲染,快照会删掉所有 button(readingSnapshot),
 * 而 `#标题` 的链接在阅读面上照样能点(officialNoteRenderer → openLink 的 `#` 分支按标题文字跳)。
 */
import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { parseTocRange, type TocRange } from '@amadeus-shared/tocBlock'
import { registerMessages, useI18n } from '../../../i18n'
import { docHeadings, type UnifiedHeading } from '../../unified/outline'
import { glideBlockToTop } from '../../unified/revealScroll'
import './toc.css'

registerMessages({
  'tocblock.label': { zh: '目录', en: 'Table of contents' },
  'tocblock.empty': { zh: '加几个标题就会出现在这里', en: "Add headings and they'll show up here" },
})

/** 宿主(嵌入层)交给目录块的那一面:读当前文档、订阅文档变化、按位置取标题 DOM、落地后闪一下。 */
export interface TocDocSource {
  /** 编辑器还没就绪 / 已拆 = null(当「不知道」,不画「没有标题」)。 */
  doc(): ProseNode | null
  subscribe(onChange: () => void): () => void
  nodeDom(pos: number): Node | null
  flash?(rect: DOMRect): void
}

interface TocEntry { level: number; text: string }

/** 本块范围内的标题(文档顺序;空标题不算,与大纲同口径)。 */
export function tocHeadings(doc: ProseNode, range: TocRange): UnifiedHeading[] {
  return docHeadings(doc).filter((h) => h.level >= range.min && h.level <= range.max)
}

const sameEntries = (a: TocEntry[], b: TocEntry[]): boolean =>
  a.length === b.length && a.every((x, i) => x.level === b[i].level && x.text === b[i].text)

const swallow = (e: MouseEvent): void => {
  e.preventDefault()
  e.stopPropagation()
}

export function TocBlock({ src, source }: { src: string; source: TocDocSource }): ReactElement {
  const { t } = useI18n()
  const { min, max } = parseTocRange(src)
  const read = (): TocEntry[] | null => {
    const doc = source.doc()
    return doc ? tocHeadings(doc, { min, max }).map(({ level, text }) => ({ level, text })) : null
  }
  const [items, setItems] = useState<TocEntry[] | null>(read)
  useEffect(() => {
    let frame = 0
    const run = (): void => {
      frame = 0
      const next = read()
      setItems((prev) => (prev && next && sameEntries(prev, next) ? prev : next))
    }
    run() // 范围改了 / 挂上之后补一次(初值可能是在编辑器视图就绪前算的)
    const off = source.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(run)
    })
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read 只依赖 source / min / max
  }, [source, min, max])

  /** 点击时现取一遍(列表是上一帧算的,期间可能增删了标题):先按序号,级别文字对不上就退回按文字找第一条;都不成就不动。 */
  const jump = (index: number): void => {
    const want = items?.[index]
    const doc = source.doc()
    if (!want || !doc) return
    const now = tocHeadings(doc, { min, max })
    const hit = now[index]?.text === want.text && now[index].level === want.level ? now[index] : now.find((h) => h.text === want.text)
    if (!hit) return
    const el = source.nodeDom(hit.pos)
    if (!(el instanceof HTMLElement)) return
    glideBlockToTop(el, () => source.flash?.(el.getBoundingClientRect()))
  }

  // data-lcl-toc-ignore:浮动目录按 DOM 变化重扫标题,这块自己的重渲染跟它无关。
  if (!items) return <nav className="amx-toc" aria-label={t('tocblock.label')} data-lcl-toc-ignore />
  if (!items.length) {
    return (
      <nav className="amx-toc" aria-label={t('tocblock.label')} data-lcl-toc-ignore>
        <div className="amx-toc-empty">{t('tocblock.empty')}</div>
      </nav>
    )
  }
  const base = Math.min(...items.map((it) => it.level))
  return (
    <nav className="amx-toc" aria-label={t('tocblock.label')} data-lcl-toc-ignore>
      {items.map((it, i) => (
        <a
          key={i}
          className="amx-toc-item"
          href={`#${encodeURIComponent(it.text)}`}
          draggable={false}
          data-level={it.level}
          style={{ '--toc-depth': it.level - base } as CSSProperties}
          // mousedown 吞掉:否则 ProseMirror 先按坐标改选区 / 抢焦点(同 `</>` 键);中键也不许当链接开新窗。
          onMouseDown={swallow}
          onAuxClick={swallow}
          onClick={(e) => {
            swallow(e)
            jump(i)
          }}
        >
          <span className="amx-toc-text">{it.text}</span>
        </a>
      ))}
    </nav>
  )
}
