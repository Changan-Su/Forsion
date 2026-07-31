// [[Page Name]] 实况双链(与公式实况预览 mathLivePreview.ts 同款的逐行显隐):
//  · 光标**不在**该行 → 隐藏 [[ ]] 源码,就地渲染成异色双链;点渲染出的链接 → 跳转目标笔记。
//  · 光标**回到**该行 → 整行露出字面 [[note]] 源码可编辑;此时点它**不跳转**(普通文本 / 只定位光标)。
// 链接始终是 .md 里的字面文本(零 schema、零序列化改动,round-trip、Obsidian 可读)。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { WIKILINK_RE, linkTarget } from '@amadeus-shared/links'
import { isPdfLinkInner } from '@amadeus-shared/pdfLink'
import { toAssetUrl } from '@amadeus-shared/assets'
import { buildBlockString } from './mathLivePreview'
import { attachSourceButton } from './sourceToggle'

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

/** `![[pic.png|200]]` 的图片形态(前面必须紧挨着 `!`);不是图片嵌入 → null。 */
function imageEmbed(inner: string, bang: boolean): { url: string; width?: number; name: string } | null {
  if (!bang) return null
  const [rawPath, size] = inner.split('|')
  const p = rawPath.trim()
  if (!IMG_EXT_RE.test(p)) return null
  const w = size?.trim()
  return { url: toAssetUrl(p), width: w && /^\d+$/.test(w) ? Number(w) : undefined, name: p }
}

const wikiKey = new PluginKey<{ focus: boolean }>('amadeus-wikilink-live')

/** [[Name|alias]] → 显示 alias;[[Name#heading]] / [[Name]] → 显示原样内文(仅去两端 [[ ]])。 */
function displayLabel(inner: string): string {
  const bar = inner.indexOf('|')
  const l = (bar === -1 ? inner : inner.slice(bar + 1)).trim()
  return l || inner.trim()
}

function buildDecorations(
  state: EditorState,
  onOpen: (name: string) => void,
  isResolved: (name: string) => boolean,
  iconOf?: (name: string) => string | undefined,
): DecorationSet {
  const focus = wikiKey.getState(state)?.focus ?? false
  const decos: Decoration[] = []
  const selFrom = state.selection.from
  const selTo = state.selection.to
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false // 代码块内不渲染双链
    const cs = pos + 1
    const s = buildBlockString(node) // offset i ↔ 文档位 cs+i;内联 code 抹成空格、硬换行→'\n'(与公式共用)
    if (s.indexOf('[[') === -1) return false
    // 聚焦且选区落在本块 → 算光标所在「行」区间(以 '\n' 为界),该行双链露源码、其余行照常渲染。
    let lineFrom = -1
    let lineTo = -1
    if (focus && selFrom <= cs + node.content.size && selTo >= cs) {
      const a = Math.max(0, Math.min(s.length, selFrom - cs))
      const b = Math.max(0, Math.min(s.length, selTo - cs))
      lineFrom = s.lastIndexOf('\n', a - 1) + 1
      const nl = s.indexOf('\n', b)
      lineTo = nl === -1 ? s.length : nl
    }
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(s))) {
      // `![[pic.png]]`(行内图片嵌入):把 `!` 一起圈进来。整块只有它一条时走块级 embed 渲染
      // (BlockHost),这里管的是**混在文字里**那种 —— 此前只当普通双链渲染,图片压根不显示,
      // 用户只好把每张图单独放一个块(实报)。
      const bang = m.index > 0 && s[m.index - 1] === '!'
      const img = imageEmbed(m[1], bang)
      const spFrom = img ? m.index - 1 : m.index
      const spTo = m.index + m[0].length
      const onActiveLine = lineFrom !== -1 && spFrom < lineTo && spTo > lineFrom
      if (onActiveLine) continue // 本行 → 露源码可编辑,不渲染、点它不跳转
      const from = cs + spFrom
      const to = cs + spTo
      if (img) {
        decos.push(Decoration.inline(from, to, { class: 'wikilink-src-hidden' }))
        decos.push(
          Decoration.widget(
            from,
            (view) => {
              // 包一层 span:`<img>` 是空元素,挂不了「查看源码」按钮(按钮须是子节点才好定位)。
              const wrap = document.createElement('span')
              wrap.className = 'wiki-inline-img-wrap'
              wrap.contentEditable = 'false'
              const el = document.createElement('img')
              el.className = 'wiki-inline-img'
              el.src = img.url
              el.alt = img.name
              if (img.width) el.style.width = `${img.width}px`
              wrap.appendChild(el)
              attachSourceButton(wrap, view, from) // 悬停 `</>` → 光标进 `![[…]]` 源码
              return wrap
            },
            { side: -1, ignoreSelection: true, key: `i${from}:${m![0]}` },
          ),
        )
        continue
      }
      const target = linkTarget(m[1])
      const label = displayLabel(m[1])
      const ok = isResolved(target)
      const emoji = ok ? iconOf?.(target) : undefined // 目标笔记的 emoji 图标,渲染在链接文字前
      // PDF 链接点击要保留 #page= 子路径(openWikiLink 据此跳页);m 是循环变量,须逐条捕获(勿在闭包里读 m)。
      const openArg = isPdfLinkInner(m[1]) ? m[1] : target
      decos.push(Decoration.inline(from, to, { class: 'wikilink-src-hidden' }))
      decos.push(
        Decoration.widget(
          from,
          () => {
            const el = document.createElement('span')
            el.className = ok ? 'wikilink' : 'wikilink wikilink-unresolved' // 未解析 → 黯淡虚线,点击询问创建
            el.setAttribute('data-wiki', target)
            if (emoji) {
              const ic = document.createElement('span')
              ic.className = 'wikilink-emoji' // inline-block 逃逸下划线传播(text-decoration 子元素关不掉)
              ic.textContent = emoji
              el.append(ic, label)
            } else el.textContent = label
            el.addEventListener('mousedown', (e) => {
              e.preventDefault() // 不落光标、不进编辑态 → 直接跳转
              onOpen(openArg)
            })
            return el
          },
          // key 带解析态与 emoji:同 key 的 widget DOM 会被 ProseMirror 复用,状态翻转必须换 key 才会重建。
          { side: -1, ignoreSelection: true, key: `w${from}:${m[0]}:${ok ? 1 : 0}:${emoji ?? ''}` },
        ),
      )
    }
    return false // 不深入内联
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

export function wikilinkPlugin(
  onOpen: (name: string) => void,
  isResolved: (name: string) => boolean = () => true,
  iconOf?: (name: string) => string | undefined,
) {
  return $prose(
    () =>
      new Plugin<{ focus: boolean }>({
        key: wikiKey,
        state: {
          init: () => ({ focus: false }),
          apply: (tr, value) => {
            const m = tr.getMeta(wikiKey) as { focus?: boolean } | undefined
            return m && typeof m.focus === 'boolean' ? { focus: m.focus } : value
          },
        },
        props: {
          // 失焦 → 全部渲染成链接;聚焦 → 仅光标所在行露源码(每个 Amadeus 块是独立编辑器)。
          handleDOMEvents: {
            focus: (view) => { if (!wikiKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(wikiKey, { focus: true })); return false },
            blur: (view) => { if (wikiKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(wikiKey, { focus: false })); return false },
          },
          decorations: (state) => buildDecorations(state, onOpen, isResolved, iconOf),
        },
      }),
  )
}
