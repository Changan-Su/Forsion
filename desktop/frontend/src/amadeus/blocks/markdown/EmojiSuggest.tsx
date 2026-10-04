// `:emoji:` 短代码补全(评审 I-21):正文里打 `:sm`,列出 emoji 候选(数据 = 页面图标选择器那张表 lib/emoji);
// 选中 = 把 `:查询` 整段换成 emoji 字符本身。与 `#` 标签补全(./TagSuggest)同一形态、同一套守卫:
// 查询驻留文档,面板只在捕获阶段拦导航键,字母照常落进编辑器;看不见的面板一个键都不拦(补全面板键盘陷阱那两条)。
import { useEffect, useLayoutEffect, useState } from 'react'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { OverlayAt } from '../../lib/clampMenu'
import { searchEmojiItems } from '../../lib/emoji'
import { closeOnBlur, inCode, type SuggestReport } from './wikiAutocomplete'

/** 光标前紧挨着的 `:查询`。冒号前不许是 ASCII 字母数字 / `_` / `:` —— 挡掉 `10:30`、`http:`、`key:value`、
 *  `std::vector`、`@…T14:30`,汉字后的 `你好:smile` 照弹;冒号后至少 2 个 **ASCII** 字母:半角冒号的中文句子
 *  (`备注:说明`)不许被面板劫持回车。 */
export const EMOJI_BEFORE_CARET = /(?:^|[^A-Za-z0-9_:])(:([A-Za-z]{2,30}))$/

/**
 * `:` 触发插件。只在**这次事务改了文档**(= 用户在打字)时弹(arrow-trap 教训,同 `#`);输入法组字中不弹
 * (拼音还在候选窗里,`:` 后面那串字母不是查询);代码块 / 行内代码里恒字面(同 L-03);在词中间改字不弹。
 */
export function emojiSuggestPlugin(report: SuggestReport) {
  return $prose(
    () =>
      new Plugin({
        props: closeOnBlur(report),
        view: () => ({
          update(view, prevState) {
            if (!view.hasFocus()) return report(null, true)
            if (view.composing) return report(null)
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock || $head.parent.type.spec.code) return report(null)
            if (!prevState || prevState.doc.eq(view.state.doc)) return report(null)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const m = EMOJI_BEFORE_CARET.exec(before)
            if (!m) return report(null)
            const after = $head.parent.textBetween($head.parentOffset, $head.parent.content.size, undefined, '￼')
            if (/^[A-Za-z0-9_]/.test(after)) return report(null)
            const colonAt = $head.parentOffset - m[1].length
            if (inCode(view.state, $head.start() + colonAt, selection.head)) return report(null)
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(selection.head)
            } catch {
              return report(null)
            }
            report({ query: m[2], from: $head.start() + colonAt + 1, to: selection.head, left: coords.left, top: coords.bottom, anchorTop: coords.top })
          },
        }),
      }),
  )
}

interface Props {
  query: string
  left: number
  top: number
  anchorTop?: number
  /** 参数 = emoji 字符本身。 */
  onPick: (emoji: string) => void
  onClose: () => void
  /** 宿主编辑器是否持焦;不持焦时一个键都不拦(L-04 同款)。 */
  editorFocused?: () => boolean
}

export function EmojiSuggest({ query, left, top, anchorTop, onPick, onClose, editorFocused }: Props) {
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [query])
  const results = searchEmojiItems(query).slice(0, 8)
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
        if (hit) onPick(hit.emoji)
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
    <OverlayAt className="wiki-suggest emoji-suggest" x={left} y={top} anchorTop={anchorTop} role="menu" onMouseDown={(e) => e.preventDefault()}>
      {results.map((r, i) => (
        <button
          key={r.emoji}
          className="wiki-item"
          data-active={i === active || undefined}
          ref={reveal(i)}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(r.emoji)
          }}
          role="menuitem"
        >
          <span className="emoji-suggest-char">{r.emoji}</span>
          <span className="wiki-item-name">{r.name}</span>
        </button>
      ))}
    </OverlayAt>
  )
}
