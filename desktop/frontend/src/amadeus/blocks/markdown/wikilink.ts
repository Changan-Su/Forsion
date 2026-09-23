// [[Page Name]] 实况双链(与公式实况预览 mathLivePreview.ts 同款的逐行显隐):
//  · 光标**不在**该行 → 隐藏 [[ ]] 源码,就地渲染成异色双链;点渲染出的链接 → 跳转目标笔记。
//  · 光标**回到**该行 → 整行露出字面 [[note]] 源码可编辑;此时点它**不跳转**(普通文本 / 只定位光标)。
// 链接始终是 .md 里的字面文本(零 schema、零序列化改动,round-trip、Obsidian 可读)。
// 图片嵌入 `![[pic.png|200]]` 是“难源码编辑块”:点一下选中整体并保留渲染(独占段落提升为
// paragraph NodeSelection,行内图片选精确文本范围),加选中环与右缘缩放把手;光标经过不露源码,
// 只有悬停右上角 `</>` 显式打开。复制事件另补桌面原生附件 flavor,外部 App 能直接粘文件。
import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { WIKILINK_RE, linkTarget } from '@amadeus-shared/links'
import { isPdfLinkInner, parseMediaLinkInner } from '@amadeus-shared/pdfLink'
import { toAssetUrl } from '@amadeus-shared/assets'
import { buildBlockString } from './mathLivePreview'
import { attachSourceButton } from './sourceToggle'
import { attachResizeHandle } from '../../lib/imageResize'
import { armImageDrag } from './imageDrag'

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

interface WikiState { focus: boolean; sourceFrom: number | null }
const wikiKey = new PluginKey<WikiState>('amadeus-wikilink-live')

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
  const sourceFrom = wikiKey.getState(state)?.sourceFrom ?? null
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
      const from = cs + spFrom
      const to = cs + spTo
      // 图片「被整段选中」(点一下图片就是这个选区)→ 保持渲染并进选中态,不让位给源码。
      const standalone = !!img && spFrom === 0 && spTo === s.length
      const picked = !!img && focus && (
        (selFrom === from && selTo === to) ||
        (standalone && state.selection instanceof NodeSelection && selFrom === pos && selTo === pos + node.nodeSize)
      )
      const onActiveLine = lineFrom !== -1 && spFrom < lineTo && spTo > lineFrom
      // 普通双链仍是「光标进入即源码」;图片是难源码编辑块,只有 `</>` 显式开门。
      if ((!img && onActiveLine) || (img && onActiveLine && sourceFrom === from)) continue
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
              // ⚠️ 位置戳在 DOM 上:选中态由插件的 view.update 就地同步(见 syncPicked),
              // **绝不能**把 picked 写进装饰 key —— 那样一点击就换一份 DOM,后果见下面 key 处的注释。
              wrap.dataset.srcFrom = String(from)
              wrap.dataset.srcTo = String(to)
              const el = document.createElement('img')
              el.className = 'wiki-inline-img'
              el.src = img.url
              el.alt = img.name
              if (img.width) el.style.width = `${img.width}px`
              wrap.appendChild(el)
              // 单击 = 选中这段源码。双击**不**在这里拦 —— 用户 2026-08-28 拍板「双击 = 看大图」,
              // 交给 UnifiedPage 的灯箱;源码入口只有悬停的 `</>` 一个。
              // preventDefault + stopPropagation 缺一不可:前者拦浏览器落焦点,后者拦 PM 自己的
              // 按坐标定位 / 双击选词 —— 任何一条漏了,图片都会当场让位给源码。
              // 例外:独占一段的图片在统一编辑器里可以按住直接拖走整块,那次按下不能 preventDefault
              // (否则原生拖拽起不来),选中也挪到 click(见 imageDrag.ts)。
              const select = (): void => {
                const tr = standalone
                  ? view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos))
                  : view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))
                view.dispatch(tr)
                view.focus()
              }
              wrap.addEventListener('mousedown', (e) => {
                if (e.button !== 0 || (e.target as HTMLElement).closest('.amx-img-resize, .amx-src-btn')) return
                e.stopPropagation()
                if (armImageDrag(view, wrap, e, select)) return
                e.preventDefault()
                select()
              })
              attachSourceButton(wrap, view, () => {
                const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(from + 1, view.state.doc.content.size)))
                tr.setMeta(wikiKey, { sourceFrom: from })
                view.dispatch(tr)
                view.focus()
              }) // 悬停 `</>` → 显式进入 `![[…]]` 源码
              return wrap
            },
            // ⚠️ key **不带**选中位:同 key 的 widget DOM 会被 PM 复用,带上 picked 就等于
            // 「点一下换一份 DOM」,而 Chromium 的第二次 mousedown 会因此把 target 派给幸存的
            // 公共祖先 `<p>`(实测 elementFromPoint 同样返回 P)—— 于是 wrap 上的 preventDefault
            // 轮不到执行,原生「选词」把选区撑过块边界、图片当场让位给源码,双击看大图一起落空。
            // 选中态改由 syncPicked 在 view.update 里就地打/摘属性,DOM 全程同一个节点。
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
      // 保留 subpath 的白名单:PDF 页码 `#page=` / 媒体时刻 `#t=`。**这是笔记正文里唯一保留
      // subpath 的地方** —— linkTarget 会把 `#…` 砍掉,不改这行时间戳就静默蒸发(看起来一切
      // 正常,只是永远从 0 秒开始)。
      const openArg = isPdfLinkInner(m[1]) || parseMediaLinkInner(m[1]) ? m[1] : target
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

/** 把「哪张图正被整段选中」同步到已有的 widget DOM 上(打 data-selected + 挂缩放把手)。
 *  刻意不走「换 key 重建」那条:重建会让浏览器把紧随的第二次 mousedown 派给 `<p>`,
 *  双击就此失灵(长注释见 buildDecorations 里 key 那一处)。 */
const handles = new WeakMap<HTMLElement, () => void>()
const marked = new WeakMap<EditorView, HTMLElement>()
function syncPicked(view: EditorView): void {
  const { from, to } = view.state.selection
  const focus = wikiKey.getState(view.state)?.focus ?? false
  const prev = marked.get(view) ?? null
  // 独占段图片选中的是外层 paragraph NodeSelection(分栏/拖拽/Tab 子树都以块为单位);
  // 行内图片仍精确选源码区间。两档最后都映射回同一枚 widget。
  let pickFrom = from
  let pickTo = to
  if (view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === 'paragraph') {
    pickFrom = from + 1
    pickTo = to - 1
  }
  const want = focus && pickFrom !== pickTo
    ? view.dom.querySelector<HTMLElement>(`.wiki-inline-img-wrap[data-src-from="${pickFrom}"][data-src-to="${pickTo}"]`)
    : null
  if (prev === want) return
  if (prev) {
    delete prev.dataset.selected
    handles.get(prev)?.()
    handles.delete(prev)
  }
  if (want) {
    want.dataset.selected = ''
    const img = want.querySelector('img')
    if (img && view.editable) {
      handles.set(want, attachResizeHandle(want, img, (w) => {
        const name = (view.state.doc.textBetween(pickFrom, pickTo).match(/^!\[\[([^\]\n|]+)/) ?? [])[1]
        if (!name) return
        const next = `![[${name}|${w}]]`
        const tr = view.state.tr.insertText(next, pickFrom, pickTo)
        if (view.state.selection instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, from))
        else tr.setSelection(TextSelection.create(tr.doc, pickFrom, pickFrom + next.length))
        view.dispatch(tr)
      }))
    }
  }
  if (want) marked.set(view, want)
  else marked.delete(view)
}

/** ↑↓ 进入一条独占段双链时,浏览器会因为源码被 display:none 而把整段跳过去。
 *  在相邻文本块边界精确接住这一种形状,把光标送进 `[[…]]`;图片不在此列。 */
function adjacentPlainWiki(view: EditorView, dir: 'up' | 'down'): number | null {
  const sel = view.state.selection
  if (!(sel instanceof TextSelection) || !sel.empty || !sel.$head.parent.isTextblock) return null
  try {
    const caret = view.coordsAtPos(sel.head)
    const edge = view.coordsAtPos(dir === 'up' ? sel.$head.start() : sel.$head.end())
    if (Math.abs(caret.top - edge.top) > Math.max(2, caret.bottom - caret.top)) return null
  } catch {
    if (dir === 'up' ? sel.$head.parentOffset !== 0 : sel.$head.parentOffset !== sel.$head.parent.content.size) return null
  }
  const blocks: Array<{ pos: number; size: number; sourceFrom: number | null }> = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const s = buildBlockString(node)
    let sourceFrom: number | null = null
    WIKILINK_RE.lastIndex = 0
    const m = WIKILINK_RE.exec(s)
    if (m && m.index === 0 && m[0].length === s.length) sourceFrom = pos + 1
    blocks.push({ pos, size: node.nodeSize, sourceFrom })
    return false
  })
  const cur = blocks.findIndex((b) => sel.head > b.pos && sel.head < b.pos + b.size)
  const target = blocks[cur + (dir === 'up' ? -1 : 1)]
  return target?.sourceFrom == null ? null : target.sourceFrom + 2
}

export function wikilinkPlugin(
  onOpen: (name: string) => void,
  isResolved: (name: string) => boolean = () => true,
  iconOf?: (name: string) => string | undefined,
) {
  return $prose(
    () =>
      new Plugin<WikiState>({
        key: wikiKey,
        // 选中态就地同步:widget 的 DOM 全程不换(见 key 处的注释),所以「选中环 + 缩放把手」
        // 只能在这里按当前选区打/摘。位置从 dataset 读 —— 位置一变 key 就变、DOM 本来就会重建。
        view: () => ({ update: syncPicked }),
        state: {
          init: () => ({ focus: false, sourceFrom: null }),
          apply: (tr, value) => {
            const m = tr.getMeta(wikiKey) as { focus?: boolean; sourceFrom?: number } | undefined
            let sourceFrom = value.sourceFrom
            if (sourceFrom != null && tr.docChanged) sourceFrom = tr.mapping.map(sourceFrom)
            if (m && typeof m.sourceFrom === 'number') sourceFrom = m.sourceFrom
            else if (sourceFrom != null && tr.selectionSet) {
              const node = tr.doc.nodeAt(Math.max(0, sourceFrom - 1))
              const nodeFrom = Math.max(0, sourceFrom - 1)
              if (!node || tr.selection.to <= nodeFrom || tr.selection.from >= nodeFrom + node.nodeSize) sourceFrom = null
            }
            return {
              focus: m && typeof m.focus === 'boolean' ? m.focus : value.focus,
              sourceFrom,
            }
          },
        },
        props: {
          // 失焦 → 全部渲染成链接;聚焦 → 仅光标所在行露源码(每个 Amadeus 块是独立编辑器)。
          handleDOMEvents: {
            focus: (view) => { if (!wikiKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(wikiKey, { focus: true })); return false },
            blur: (view) => { if (wikiKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(wikiKey, { focus: false })); return false },
          },
          handleKeyDown: (view, event) => {
            if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
            const pos = adjacentPlainWiki(view, event.key === 'ArrowUp' ? 'up' : 'down')
            if (pos == null) return false
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView())
            return true
          },
          decorations: (state) => buildDecorations(state, onOpen, isResolved, iconOf),
        },
      }),
  )
}
