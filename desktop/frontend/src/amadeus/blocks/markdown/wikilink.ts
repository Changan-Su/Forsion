// [[Page Name]] 实况双链(与公式实况预览 mathLivePreview.ts 同款的逐行显隐):
//  · 光标**不在**该行 → 隐藏 [[ ]] 源码,就地渲染成异色双链;点渲染出的链接 → 跳转目标笔记。
//  · 光标**回到**该行 → 整行露出字面 [[note]] 源码可编辑;此时点它**不跳转**(普通文本 / 只定位光标)。
// 链接始终是 .md 里的字面文本(零 schema、零序列化改动,round-trip、Obsidian 可读)。
// 图片嵌入 `![[pic.png|200]]` 是“难源码编辑块”:点一下选中整体并保留渲染(独占段落提升为
// paragraph NodeSelection,行内图片选精确文本范围),加选中环与右缘缩放把手;光标经过不露源码,
// 只有悬停右上角 `</>` 显式打开。复制事件另补桌面原生附件 flavor,外部 App 能直接粘文件。
import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { WIKILINK_RE, linkTarget } from '@amadeus-shared/links'
import { isPdfLinkInner, parseBlockSubpath, parseMediaLinkInner, splitLinkInner } from '@amadeus-shared/pdfLink'
import { toAssetUrl } from '@amadeus-shared/assets'
import { buildBlockString } from './mathLivePreview'
import { attachSourceButton } from './sourceToggle'
import { attachResizeHandle } from '../../lib/imageResize'
import { armImageDrag } from './imageDrag'

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
/** 与 prosemirror-keymap / unified/keyboard 判「Mod 是 Cmd 还是 Ctrl」同一口径;mac 上 Ctrl+点击是右键手势。 */
export const IS_MAC_PLATFORM = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** 打开双链的回调:newTab = ⌘/Ctrl+点击、中键(L-11),或「在新标签页打开光标处链接」命令。 */
export type WikiOpen = (name: string, opts?: { newTab?: boolean }) => void

/** `![[pic.png|200]]` 的图片形态(前面必须紧挨着 `!`);不是图片嵌入 → null。 */
function imageEmbed(inner: string, bang: boolean): { url: string; width?: number; name: string } | null {
  if (!bang) return null
  const [rawPath, size] = inner.split('|')
  const p = rawPath.trim()
  if (!IMG_EXT_RE.test(p)) return null
  const w = size?.trim()
  return { url: toAssetUrl(p), width: w && /^\d+$/.test(w) ? Number(w) : undefined, name: p }
}

/** 点击 / 「打开光标处链接」交给 openWikiLink 的那一串(两处同源,L-20)。要保留的 subpath:PDF 页码 `#page=` /
 *  媒体时刻 `#t=` 原样交(据此跳页 / 起播);笔记锚点交「笔记#锚点」(别名剥掉),openWikiLink 拆开后打开并定位。
 *  linkTarget 会把 `#…` 砍掉 —— 不走这里就是锚点静默蒸发(打开的永远是文首 / 0 秒)。 */
export function wikiOpenArg(inner: string): string {
  if (isPdfLinkInner(inner) || parseMediaLinkInner(inner)) return inner
  const split = splitLinkInner(inner)
  return split?.subpath ? `${split.target}#${split.subpath}` : linkTarget(inner)
}

/** 文本块里块内偏移 offset 处的 `[[…]]`(光标在里面或贴着两端)→ 它的 openWikiLink 参数;图片嵌入不算链接。
 *  代码块 / 行内代码里的不算(buildBlockString 把行内代码抹成空格,代码块由调用方挡)。 */
export function wikiOpenArgAt(block: ProseNode, offset: number): string | null {
  const s = buildBlockString(block)
  if (s.indexOf('[[') === -1) return null
  let edge: string | null = null
  WIKILINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(s))) {
    const from = m.index
    const to = m.index + m[0].length
    if (offset < from || offset > to) continue
    if (imageEmbed(m[1], from > 0 && s[from - 1] === '!')) continue
    if (offset > from && offset < to) return wikiOpenArg(m[1])
    edge ??= wikiOpenArg(m[1])
  }
  return edge
}

interface WikiState { focus: boolean; sourceFrom: number | null }
const wikiKey = new PluginKey<WikiState>('amadeus-wikilink-live')

/** [[Name|alias]] → 显示 alias;[[Name]] → 原样内文(仅去两端 [[ ]])。
 *  笔记内锚点(评审 L-05,口径同聊天引用条 ChatWikiLink):[[笔记#标题]] → 「笔记 › 标题」,
 *  [[笔记#^块]] → 「笔记 › ^块」,嵌套链 [[笔记#H1#H2]] 逐段用 › 连;本页锚点 [[#标题]] 只显示锚点本身。
 *  anchor = 调用方已判定这是笔记锚点(PDF 页码 / 媒体时刻等别的 `#` 形态不走这条,维持原样)。 */
function displayLabel(inner: string, anchor: { target: string; subpath: string } | null): string {
  const bar = inner.indexOf('|')
  if (bar !== -1) {
    const alias = inner.slice(bar + 1).trim()
    if (alias) return alias
  }
  if (anchor) {
    const tail = parseBlockSubpath(anchor.subpath) ? anchor.subpath : anchor.subpath.split('#').map((x) => x.trim()).filter(Boolean).join(' › ')
    return anchor.target ? `${anchor.target} › ${tail}` : tail
  }
  const l = (bar === -1 ? inner : inner.slice(bar + 1)).trim()
  return l || inner.trim()
}

function buildDecorations(
  state: EditorState,
  onOpen: WikiOpen,
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
    // 只有选区两端都在本块时才按所在行露源码。跨块拖字经过双链时要保留渲染体,
    // 否则被选中的链接突然变回 [[源码]],与其它已渲染内容的选区反馈不一致。
    let lineFrom = -1
    let lineTo = -1
    if (focus && selFrom >= cs && selTo <= cs + node.content.size) {
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
        const len = spTo - spFrom
        decos.push(Decoration.inline(from, to, { class: 'wikilink-src-hidden' }))
        decos.push(
          Decoration.widget(
            from,
            (view, getPos) => {
              // 包一层 span:`<img>` 是空元素,挂不了「查看源码」按钮(按钮须是子节点才好定位)。
              const wrap = document.createElement('span')
              wrap.className = 'wiki-inline-img-wrap'
              wrap.contentEditable = 'false'
              // ⚠️ 位置戳在 DOM 上:选中态由插件的 view.update 就地同步(见 syncPicked),
              // **绝不能**把 picked 写进装饰 key —— 那样一点击就换一份 DOM,后果见下面 key 处的注释。
              // key 也不带位置(P-04):同一份 DOM 会跨位置复用,戳记由 syncPicked 按 getPos 每次事务刷新。
              stampSrc(wrap, getPos, len)
              /** 本 widget 此刻的源码区间(复用后 from/to 已过期,一律现算)。 */
              const span = (): { from: number; to: number } | null => {
                const at = getPos()
                return at == null ? null : { from: at, to: at + len }
              }
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
                const at = span()
                if (!at) return
                const tr = standalone
                  ? view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.from - 1)) // 独占一段:widget 在段首,段落 = at-1
                  : view.state.tr.setSelection(TextSelection.create(view.state.doc, at.from, at.to))
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
                const at = span()
                if (!at) return
                const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(at.from + 1, view.state.doc.content.size)))
                tr.setMeta(wikiKey, { sourceFrom: at.from })
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
            // key 也不带位置(P-04):带 from 的话上方打一个字,下游每张图都换 DOM、重新加载;standalone 进 key ——
            // 它决定点击选段落还是选源码,闭包里捕获的是构建那一刻的值。
            { side: -1, ignoreSelection: true, key: `i:${standalone ? 1 : 0}:${m![0]}` },
          ),
        )
        continue
      }
      const target = linkTarget(m[1])
      const fileAnchor = isPdfLinkInner(m[1]) || !!parseMediaLinkInner(m[1])
      // 笔记内锚点(评审 L-05):`[[笔记#标题]]` / `[[笔记#^块]]` / `[[#标题]]`。空笔记名 = 本页,恒算已解析
      // (此前 linkTarget 给空串 → isResolved('') 为假 → 本页锚点一律画成虚线坏链,点了也没反应)。
      const split = fileAnchor ? null : splitLinkInner(m[1])
      const anchor = split?.subpath ? { target: split.target, subpath: split.subpath } : null
      const label = displayLabel(m[1], anchor)
      const ok = anchor && !anchor.target ? true : isResolved(target)
      const emoji = ok && target ? iconOf?.(target) : undefined // 目标笔记的 emoji 图标,渲染在链接文字前
      // 点击要交给 openWikiLink 的串(m 是循环变量,须逐条捕获,勿在闭包里读 m;口径见 wikiOpenArg,与键盘跟随同源)。
      const openArg = wikiOpenArg(m[1])
      decos.push(Decoration.inline(from, to, { class: 'wikilink-src-hidden' }))
      decos.push(
        Decoration.widget(
          from,
          (_view, getPos) => {
            const el = document.createElement('span')
            el.className = ok ? 'wikilink' : 'wikilink wikilink-unresolved' // 未解析 → 黯淡虚线,点击询问创建
            el.setAttribute('role', 'link') // 读屏认得是链接(L-20;键盘跟随走 Alt+Enter,不给 tabindex —— 焦点留在正文里)
            el.setAttribute('data-wiki', target)
            stampSrc(el, getPos, spTo - spFrom)
            if (emoji) {
              const ic = document.createElement('span')
              ic.className = 'wikilink-emoji' // inline-block 逃逸下划线传播(text-decoration 子元素关不掉)
              ic.textContent = emoji
              el.append(ic, label)
            } else el.textContent = label
            // 按键分流(L-11):只有无修饰键的左键原地跳转;⌘/Ctrl+左键、中键 → 新标签页;
            // 右键(含 mac 的 Ctrl+点击)不跳转 —— 同样 preventDefault(不落光标,免得这一行当场露出 `[[源码]]`),
            // contextmenu 照常冒出系统菜单(下面拦住块层,见 contextmenu 那条)。Shift / Alt+左键放行给编辑器(扩选 / 落光标)。
            el.addEventListener('mousedown', (e) => {
              const ctxGesture = e.button === 2 || (IS_MAC_PLATFORM && e.button === 0 && e.ctrlKey)
              if (ctxGesture) { e.preventDefault(); return }
              if (e.button === 1) { e.preventDefault(); onOpen(openArg, { newTab: true }); return }
              if (e.button !== 0 || e.shiftKey || e.altKey) return
              e.preventDefault() // 不落光标、不进编辑态 → 直接跳转
              onOpen(openArg, (IS_MAC_PLATFORM ? e.metaKey : e.ctrlKey) ? { newTab: true } : undefined)
            })
            // 正文文字上右键 = 系统菜单(W2 右键规则):部件 DOM 带 contenteditable=false(PM 给 widget 加的),
            // 块层的右键分类会把它当「非文字块件」弹块菜单 —— 在这里止住冒泡,系统菜单照出(不 preventDefault)。
            el.addEventListener('contextmenu', (e) => e.stopPropagation())
            return el
          },
          // key 带解析态与 emoji:同 key 的 widget DOM 会被 ProseMirror 复用,状态翻转必须换 key 才会重建。
          // ⚠️ key **不带位置**(评审 P-04):带 from 的话在上方打一个字,下游 240 条双链每键整批重建。
          //    闭包里只留与位置无关的东西(openArg / label);位置戳由 stampSrc + syncPicked 现算。
          { side: -1, ignoreSelection: true, key: `w:${m[0]}:${ok ? 1 : 0}:${emoji ?? ''}` },
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
/** widget DOM → 取自己当前位置的函数 + 源码长度。key 不带位置,DOM 会跨位置复用(P-04),
 *  所以 data-src-from/to 不能在构建时定死:syncPicked 每次事务先按它刷新,再拿来比选区。 */
const srcOf = new WeakMap<HTMLElement, { getPos: () => number | undefined; len: number }>()
function stampSrc(el: HTMLElement, getPos: () => number | undefined, len: number): void {
  srcOf.set(el, { getPos, len })
  const at = getPos()
  if (at == null) return
  el.dataset.srcFrom = String(at)
  el.dataset.srcTo = String(at + len)
}
function syncPicked(view: EditorView): void {
  const { from, to } = view.state.selection
  const focus = wikiKey.getState(view.state)?.focus ?? false
  for (const el of view.dom.querySelectorAll<HTMLElement>('.wikilink[data-src-from], .wiki-inline-img-wrap[data-src-from]')) {
    const s = srcOf.get(el)
    if (s) stampSrc(el, s.getPos, s.len)
  }
  // widget 的源码段被 display:none 藏住,浏览器原生 ::selection 涂不到渲染后的链接/图片。
  // 就地标记相交的 widget,只给它本身反馈,不把所在段落整块染色。
  for (const el of view.dom.querySelectorAll<HTMLElement>('.wikilink[data-src-from], .wiki-inline-img-wrap[data-src-from]')) {
    const start = Number(el.dataset.srcFrom)
    const end = Number(el.dataset.srcTo)
    if (from !== to && from < end && to > start) el.dataset.rangeSelected = ''
    else delete el.dataset.rangeSelected
  }
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
  onOpen: WikiOpen,
  isResolved: (name: string) => boolean = () => true,
  iconOf?: (name: string) => string | undefined,
) {
  return $prose(
    () =>
      new Plugin<WikiState>({
        key: wikiKey,
        // 选中态就地同步:widget 的 DOM 全程不换(见 key 处的注释),所以「选中环 + 缩放把手」
        // 只能在这里按当前选区打/摘。位置从 dataset 读 —— key 不带位置,DOM 跨位置复用,dataset 由 syncPicked 先刷新。
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
