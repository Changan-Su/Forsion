// Callout 渲染:blockquote 首行以 `[!type]`(可带 +/- 折叠符)开头 → Obsidian 式着色标注。
// 纯 ProseMirror 装饰(不改 schema、不动序列化)→ .md 落盘仍是原生 Obsidian callout 语法,零迁移。
// token 保持可编辑、只样式化成徽章(Obsidian 编辑态同款诚实);
// 折叠([!x]-)已实现:收起只留首行,chevron 切换 = 改写 token 里的 +/- 字符(状态即 md,跨端一致)。

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type Selection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { ResolvedPos, Node as PMNode } from '@milkdown/kit/prose/model'

/**
 * 落盘前把 callout 令牌的 `\[` 还原成 `[`。
 *
 * remark 序列化会把行首的 `[` 转义成 `\[`(防被读成链接引用),于是 `> [!note]- 标题` 落盘成
 * `> \[!note]- 标题`:Amadeus 自己读回来没问题(`\[` 解析后还是 `[`),但 **Obsidian 不认**,
 * 而「Obsidian 里原生可折叠」正是选这套落盘格式的全部理由。
 *
 * ⚠️ 为什么不走 toMarkdownExtensions 的 handlers.text:Milkdown 自己也注册了一个 text handler,
 * 且排在所有 remark 扩展之后 —— 后者恒胜,我们的永远不会被调用(2026-07-29 真浏览器取证:
 * 换成 paragraph handler 能进,text 进不去)。故沿用本文件既有的「落盘前去转义」路子
 * (同 unescapeWikiOutsideFences / unescapeMathSource)。
 *
 * 只认**引用行行首**的令牌,普通段落里的 `\[` 一概不动 —— 那里的转义是必要的。
 */
export const unescapeCalloutToken = (md: string): string =>
  md.replace(/^((?:[ \t]*>[ \t]?)+)\\\[!/gm, '$1[!')

// ⚠️ 这条正则**漏过 `]`**(`\[!([a-zA-Z]+)([+-])?`),于是 `[!note]- 标题` 里 `note` 之后遇到 `]` 直接不匹配
// —— callout 整个功能从来没生效过(2026-07-29 真浏览器取证:blockquote 的 class 恒为空)。
// 顺手放宽尾部:标题紧跟在 `-` 后面(`[!fold]-标题`)也认,Obsidian 同样接受;而且 contenteditable
// 会把行尾那个空格吃掉,不放宽的话「敲 `>` 生成令牌 → 一打字就不是 callout 了」。
const CALLOUT_RE = /^\[!([a-zA-Z]+)\]([+-])?/

// 令牌之后才是标题;标题自己还能带块级前缀:`## ` → 按 H2 排版,`- ` → 项目符号。
// 纯装饰(落盘仍是 Obsidian 的单行 callout,折叠跨端不坏),故 `##` 不进 schema、不变成真 heading 节点。
const TITLE_MARK_RE = /^(#{1,6}|[-*+]) /

/** blockquote 是不是 callout;是则给出类型/折叠符/首段/标题前缀。marker: '+' | '-' | undefined */
function calloutOf(node: PMNode) {
  if (node.type.name !== 'blockquote') return null
  const first = node.firstChild
  const m = first && first.isTextblock ? CALLOUT_RE.exec(first.textContent) : null
  if (!m || !first) return null
  // 令牌与标题之间那个空格跟着令牌一起藏,否则隐藏后标题左边凭空空一格
  const gap = first.textContent[m[0].length] === ' ' ? 1 : 0
  const mk = TITLE_MARK_RE.exec(first.textContent.slice(m[0].length + gap))
  return {
    type: m[1].toLowerCase(),
    marker: m[2] as '+' | '-' | undefined,
    token: m[0],
    hideLen: m[0].length + gap, // 隐藏范围(含那个空格)比徽章范围长
    first,
    mark: mk
      ? { at: m[0].length + gap, len: mk[0].length, cls: mk[1][0] === '#' ? `h${mk[1].length}` : 'bullet' }
      : null,
  }
}

/**
 * 某个位置所在的 callout(往上找最近的 blockquote 祖先)。
 * headEnd = 首段(标题行)末尾;markerPos = `]` 后那个 +/- 字符的位置。
 */
function calloutAt($pos: ResolvedPos) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name !== 'blockquote') continue
    const c = calloutOf(node)
    if (!c) return null
    const bqStart = $pos.start(d) // blockquote 内容起点
    return {
      marker: c.marker,
      collapsed: c.marker === '-',
      bqPos: $pos.before(d), // blockquote 本身那一位(源码态就以它为身份)
      bqStart,
      afterBq: $pos.after(d), // blockquote 之后那一位
      headEnd: bqStart + 1 + c.first.content.size,
      inHead: $pos.pos < bqStart + c.first.nodeSize,
      markerPos: bqStart + 1 + c.type.length + 3,
      /** 标题行里被藏起来的语法段(令牌、`## `/`- ` 前缀),文档绝对位 */
      hidden: [
        [bqStart + 1, bqStart + 1 + c.hideLen] as [number, number],
        ...(c.mark ? [[bqStart + 1 + c.mark.at, bqStart + 1 + c.mark.at + c.mark.len] as [number, number]] : []),
      ],
    }
  }
  return null
}

const collapsedCalloutAt = ($pos: ResolvedPos) => {
  const c = calloutAt($pos)
  return c && c.collapsed ? c : null
}

/** 切折叠 = 改写 token 里的 +/- 字符(状态即 md,Obsidian 同语义、跨端一致) */
function toggleFold(view: EditorView, c: { marker?: string; collapsed: boolean; markerPos: number }) {
  const tr = view.state.tr
  view.dispatch(
    c.marker
      ? tr.insertText(c.collapsed ? '+' : '-', c.markerPos, c.markerPos + 1)
      : tr.insertText('-', c.markerPos, c.markerPos),
  )
}

/**
 * 「哪个 callout 正处在源码态」——存它的 blockquote 位置,随文档编辑映射。
 *
 * ⚠️ 不能改回「光标在标题行就露源码」那套(2026-07-31 两次实报):ProseMirror 的 selection 失焦后
 * **原地不动**,点过一次就永远露着;而折叠态的光标守卫又会主动把光标送进/送离标题行,于是
 * 从没点过的块也会自己把 `[!note]-` 亮出来。露不露**只由双击决定**,与光标位置无关。
 *
 * 交互契约(用户 2026-07-31 拍板):
 *   · 标题行**整行单击** = 切折叠(不放光标)
 *   · **双击** = 露源码(第一下顺带切了一次折叠,刻意不抵消)
 *   · **本块失焦** = 收回源码态(每个 Amadeus 块是独立编辑器,点别的块即失焦)
 *   · 键盘走进标题行**不露**,方向键把藏起来的语法段整段跳过
 */
// export:统一实例 spike(amadeus/unified)需要在「光标离开 callout」时代为清 srcAt ——
// 每块一实例时代「本块失焦=收回」靠编辑器 blur,单实例里点别的段落不再触发 blur。
export const calloutKey = new PluginKey<{ srcAt: number | null }>('amadeus-callout-src')

/** 语法字符藏着时,方向键把它当一个整体跳过 —— 否则光标停在看不见的字里,打字位置发玄。 */
function skipHidden(state: EditorState, next: number, dir: 1 | -1): number | null {
  const size = state.doc.content.size
  if (next < 0 || next > size) return null
  const $n = state.doc.resolve(next)
  const c = calloutAt($n)
  if (!c || calloutKey.getState(state)?.srcAt === c.bqPos) return null // 源码态:语法字符看得见,别跳
  for (const [a, b] of c.hidden) if (next > a && next < b) return dir > 0 ? b : a
  return null
}

export function calloutPlugin() {
  return $prose(
    () =>
      new Plugin<{ srcAt: number | null }>({
        key: calloutKey,
        state: {
          init: () => ({ srcAt: null }),
          apply: (tr, value) => {
            const m = tr.getMeta(calloutKey) as { srcAt?: number | null } | undefined
            if (m && 'srcAt' in m) return { srcAt: m.srcAt ?? null }
            // 没有显式改动就跟着文档编辑漂(在源码态里打字,位置会前后挪)
            return value.srcAt === null ? value : { srcAt: tr.mapping.map(value.srcAt) }
          },
        },
        /**
         * 折叠区 = 光标不可达区。内容只是高度归零,骗得过眼睛骗不过 ProseMirror:光标照样能落进去
         * (点标题行文字右侧的空白、折叠时光标本来就在内容里、方向键、加载时自动聚焦),
         * 于是「打字打进虚空」。一条守卫收口所有入口。
         *
         * ⚠️ 送到折叠块**之后**,不是停在标题行 —— 停标题行会让语法字符(`[!note]-`)平白亮起来,
         * 而用户从没把光标放进去过(2026-07-31 实报)。往下走进折叠区时,块后本来也正是想去的落点。
         * ⚠️ 只管空光标 —— 跨隐藏区的选区(Meta+A 全选删除)是合法的,别破坏。
         */
        appendTransaction(_trs, _old, state) {
          const sel = state.selection
          if (!sel.empty) return null
          const c = collapsedCalloutAt(sel.$from)
          if (!c || c.inHead) return null
          const outside = (s: Selection): boolean => s.from < c.bqStart || s.from >= c.afterBq
          const fwd = TextSelection.near(state.doc.resolve(Math.min(c.afterBq, state.doc.content.size)), 1)
          if (outside(fwd)) return state.tr.setSelection(fwd)
          const back = TextSelection.near(state.doc.resolve(Math.max(c.bqStart - 1, 0)), -1)
          if (outside(back)) return state.tr.setSelection(back)
          // 整篇文档就这一个折叠 callout,前后都无处可去 → 只能停在标题行末(此时露出语法字符是诚实的)。
          return state.tr.setSelection(TextSelection.create(state.doc, c.headEnd))
        },
        props: {
          // 本块失焦 → 退出源码态(每个 Amadeus 块是独立编辑器,点别的块即失焦)。
          handleDOMEvents: {
            blur: (view) => {
              if (calloutKey.getState(view.state)?.srcAt !== null)
                view.dispatch(view.state.tr.setMeta(calloutKey, { srcAt: null }))
              return false
            },
          },
          handleKeyDown(view, event) {
            // 语法字符藏着时,←/→ 把它整段跳过(否则光标停在看不见的字里)
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.shiftKey) {
              const sel = view.state.selection
              if (sel.empty) {
                const dir = event.key === 'ArrowRight' ? 1 : -1
                const to = skipHidden(view.state, sel.from + dir, dir)
                if (to !== null) {
                  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)))
                  return true
                }
              }
              return false
            }
            /** 折叠态按 Enter:新段落会被藏起来(光标进虚空),故先展开再让默认换行照常走。 */
            if (event.key !== 'Enter' || event.isComposing) return false
            const c = collapsedCalloutAt(view.state.selection.$from)
            if (!c) return false
            // '-' → '+' 等长替换:光标位置不受映射影响,后续 keymap 拿到的就是展开后的 state。
            view.dispatch(view.state.tr.insertText('+', c.markerPos, c.markerPos + 1))
            return false
          },
          /** 标题行**整行单击** = 切折叠(不放光标)。源码态里例外:那时候单击照常放光标,否则没法定位。 */
          handleClick(view, pos) {
            const c = calloutAt(view.state.doc.resolve(pos))
            if (!c || !c.inHead) return false
            if (calloutKey.getState(view.state)?.srcAt === c.bqPos) return false
            toggleFold(view, c)
            return true
          },
          /** 标题行**双击** = 露出源码。第一下顺带切了一次折叠,刻意不抵消(用户拍板)。 */
          handleDoubleClick(view, pos) {
            const c = calloutAt(view.state.doc.resolve(pos))
            if (!c || !c.inHead) return false
            view.dispatch(view.state.tr.setMeta(calloutKey, { srcAt: c.bqPos }))
            return false // 让 ProseMirror 照常选中双击处的词
          },
          decorations(state: EditorState) {
            const decos: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'blockquote') return true
              const c = calloutOf(node)
              if (c) {
                const { type, marker, token, hideLen, mark } = c
                const collapsed = marker === '-'
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: `callout callout-${type}${collapsed ? ' callout-collapsed' : ''}`,
                    'data-callout': type,
                  }),
                )
                // [!type](+/-) 徽章(token 已含折叠符):blockquote 开(+1)+ 首段开(+1)= 文本起点 pos+2。
                decos.push(Decoration.inline(pos + 2, pos + 2 + token.length, { class: 'callout-token' }))
                // 标题排版(`## ` → H2 …)挂在首段上,**恒定**:随光标进出改字号会让整行跳一下。
                const headStart = pos + 1
                const headEnd = headStart + c.first.nodeSize
                if (mark) decos.push(Decoration.node(headStart, headEnd, { class: `callout-title-${mark.cls}` }))
                // 语法字符(令牌 + 标题前缀)只在**双击进了源码态**时露出,与光标位置无关。
                // ⚠️ 别改回「光标在标题行就露」,原因见 calloutKey 处的注释(两次实报都栽在那上面)。
                const inSrcMode = calloutKey.getState(state)?.srcAt === pos
                if (!inSrcMode) {
                  decos.push(Decoration.inline(pos + 2, pos + 2 + hideLen, { class: 'callout-syntax' }))
                  if (mark)
                    decos.push(
                      Decoration.inline(pos + 2 + mark.at, pos + 2 + mark.at + mark.len, {
                        class: `callout-syntax callout-syntax-${mark.cls}`,
                      }),
                    )
                }
                // 折叠 chevron:改写 token 的 +/- 字符 → 状态进 md(Obsidian 同语义)。
                // ']' 之后的位置 = pos+2 + '[!' + type + ']'。
                const markerPos = pos + 2 + type.length + 3
                // chevron 紧跟标题**文字**之后(Obsidian 同款,标题多长它就跟到哪)。
                // ⚠️ 是首段内容末尾(pos+2+content.size),不是 headEnd —— 后者在段落之外,
                // widget 会掉到标题行下面去。也别挂到 token 之后:那里随 `+`/`-` 增删左右抖。
                const chevronAt = pos + 2 + c.first.content.size
                decos.push(
                  Decoration.widget(
                    chevronAt,
                    (view) => {
                      const b = document.createElement('button')
                      // ⚠️ 类名不能叫 callout-fold —— 那是 `[!fold]` 类型加在 blockquote 上的类,
                      // 同名会让「chevron 旋转 90°」的规则命中整个引用块。
                      b.className = `callout-chevron${collapsed ? ' collapsed' : ''}`
                      b.title = collapsed ? '展开' : '折叠'
                      b.textContent = '›'
                      b.contentEditable = 'false'
                      b.addEventListener('mousedown', (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      })
                      b.addEventListener('click', () => toggleFold(view, { marker, collapsed, markerPos }))
                      return b
                    },
                    // key 带位置/折叠符位置/折叠态:三者任一变就重建。⚠️ markerPos 必须进 key ——
                    // 改类型名(`[!note]`→`[!tip]`)时 pos 与 collapsed 都不变,漏了它闭包里的
                    // markerPos 会过期,点箭头就写错字符。
                    { side: 1, ignoreSelection: true, stopEvent: () => true, key: `cf${pos}:${markerPos}:${collapsed ? 1 : 0}` },
                  ),
                )
              }
              return false // 不深入 blockquote 内部(嵌套引用不重复标)
            })
            return decos.length ? DecorationSet.create(state.doc, decos) : null
          },
        },
      }),
  )
}
