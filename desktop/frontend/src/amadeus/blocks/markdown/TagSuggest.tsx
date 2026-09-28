// `#` 标签补全(评审 2026-09-27 L-14 编辑器侧):正文里打 `#项`,列出库里已有的标签(按使用次数)供选。
// 与 `[[` / `@` 同一形态:查询串驻留文档,面板只在捕获阶段拦导航键(↑↓/Enter/Tab/Esc),字母照常落进编辑器。
// 选中 = 把 `#` 后面的查询串换成完整标签 + 一个空格(行首 `#tag` 的落盘转义由 tagEscape.ts 还原,R-25)。
import { useEffect, useLayoutEffect, useState } from 'react'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { OverlayAt } from '../../lib/clampMenu'
import { fuzzyScore } from '../../lib/fuzzy'
import { amadeus } from '../../api'
import type { TagCount } from '@amadeus-shared/ipc'
import { closeOnBlur, inCode, type SuggestReport } from './wikiAutocomplete'

/** 光标前紧挨着的 `#查询`(`#` 在行首或空白后;查询非空、不是纯数字)。 */
const TAG_BEFORE_CARET = /(?:^|\s)#([\p{L}\p{N}_/-]+)$/u

/**
 * `#` 触发插件。只在**这次事务改了文档**(= 用户在打字)时弹 —— 单纯把光标挪到已有 `#tag` 末尾就弹的话,
 * 面板吃掉 ↑↓,光标困死在这一行(`[[` 那边的 arrow-trap 教训)。查询必须非空:行首孤零零一个 `#` 后面接空格是
 * 标题语法,不许被面板劫持 Enter。代码块 / 行内代码里恒字面(同 L-03)。
 */
export function tagSuggestPlugin(report: SuggestReport) {
  return $prose(
    () =>
      new Plugin({
        props: closeOnBlur(report),
        view: () => ({
          update(view, prevState) {
            if (!view.hasFocus()) return report(null, true)
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock || $head.parent.type.spec.code) return report(null)
            if (!prevState || prevState.doc.eq(view.state.doc)) return report(null)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const m = TAG_BEFORE_CARET.exec(before)
            if (!m || /^[0-9/]+$/.test(m[1])) return report(null)
            const after = $head.parent.textBetween($head.parentOffset, $head.parent.content.size, undefined, '￼')
            if (/^[\p{L}\p{N}_/-]/u.test(after)) return report(null) // 在词中间改字,不是在写新标签
            const hashAt = $head.parentOffset - m[1].length - 1
            if (inCode(view.state, $head.start() + hashAt, selection.head)) return report(null)
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(selection.head)
            } catch {
              return report(null)
            }
            report({ query: m[1], from: $head.start() + hashAt + 1, to: selection.head, left: coords.left, top: coords.bottom, anchorTop: coords.top })
          },
        }),
      }),
  )
}

// 库内标签表的会话缓存:面板每次挂载先显示上一次的表(零等待),再异步刷新。
let cache: TagCount[] = []

/** 候选排序(纯函数,单测钉):模糊命中优先,同分按使用次数;与查询完全相同的也保留(回车 = 补空格收尾)。 */
export function rankTags(tags: TagCount[], query: string, limit = 8): TagCount[] {
  const scored: Array<{ t: TagCount; s: number }> = []
  for (const t of tags) {
    const s = fuzzyScore(query, t.tag)
    if (s !== null) scored.push({ t, s })
  }
  scored.sort((a, b) => b.s - a.s || b.t.count - a.t.count)
  return scored.slice(0, limit).map((x) => x.t)
}

interface Props {
  query: string
  left: number
  top: number
  anchorTop?: number
  /** 参数 = 完整标签名(不含 `#`)。 */
  onPick: (tag: string) => void
  onClose: () => void
  /** 宿主编辑器是否持焦;不持焦时一个键都不拦(L-04 同款)。 */
  editorFocused?: () => boolean
}

export function TagSuggest({ query, left, top, anchorTop, onPick, onClose, editorFocused }: Props) {
  const [tags, setTags] = useState<TagCount[]>(cache)
  const [active, setActive] = useState(0)
  useEffect(() => {
    let live = true
    void amadeus?.listTags?.().then((list) => {
      cache = list
      if (live) setTags(list)
    }).catch(() => {})
    return () => { live = false }
  }, [])
  useEffect(() => { setActive(0) }, [query])
  const results = rankTags(tags, query)
  const total = results.length

  // useLayoutEffect:见 WikiSuggest 同处注释(被动 effect 的 cleanup 晚于 DOM 移除,窗口里的 Enter 会被过期面板吞掉)。
  useLayoutEffect(() => {
    if (total === 0) return // 看不见的面板一个键都不许拦
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return // 输入法组字放行(L-08 同款)
      if (editorFocused && !editorFocused()) return
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        setActive((a) => Math.min(a + 1, total - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation()
        const hit = results[active]
        if (hit) onPick(hit.tag)
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (total === 0) return null
  const reveal = (i: number) => (i === active ? (el: HTMLButtonElement | null) => el?.scrollIntoView({ block: 'nearest' }) : undefined)
  return (
    <OverlayAt className="wiki-suggest tag-suggest" x={left} y={top} anchorTop={anchorTop} role="menu" onMouseDown={(e) => e.preventDefault()}>
      {results.map((t, i) => (
        <button
          key={t.tag}
          className="wiki-item"
          data-active={i === active || undefined}
          ref={reveal(i)}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(t.tag)
          }}
          role="menuitem"
        >
          <span className="wiki-item-name">#{t.tag}</span>
          <span className="wiki-item-hint">{t.count}</span>
        </button>
      ))}
    </OverlayAt>
  )
}
