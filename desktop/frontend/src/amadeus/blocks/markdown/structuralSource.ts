// Markdown 结构前缀的实况源码层（Obsidian live preview 语义）。
//
// heading/list/task/quote 在 ProseMirror 里是节点类型/属性，`### `、`- [ ] ` 等字符解析后并
// 不存在于文档，默认只能把它们当一个原子装饰。这里用真实 input 承载源码字符：
//  · 标题的 `# ` 只在光标编辑该标题行时显示，从正文行首向左即可进入并逐字符编辑；
//  · 列表/待办/引用只在用户从正文行首主动向左进入时显示，避免与原生 marker 重叠；
//  · ← / 行首 Backspace 可以进入，input 内按原生字符规则移动、删除；
//  · 保留完整且带尾随空格的合法语法 → 离开后继续渲染；
//  · 删坏语法 → 脱掉结构外壳，把剩余字符写回普通段落。
// 这样既不把源码伪造进 PM 文档导致序列化双份，也保留了逐字符编辑能力。
import { $prose } from '@milkdown/kit/utils'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { applyTrigger, triggerFromStructuralPrefix } from './blockTriggers'

interface StructuralSourceState {
  /** 正在逐字符编辑的结构前缀位置；null = 正常渲染态。 */
  openAt: number | null
}

const key = new PluginKey<StructuralSourceState>('amadeus-structural-source')

interface PrefixInfo {
  source: string
  widgetPos: number
  decorateFrom: number
  decorateTo: number
  kind: 'heading' | 'list' | 'task' | 'quote'
}

function headingInfo(node: ProseNode, pos: number): PrefixInfo {
  const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1))
  return {
    source: `${'#'.repeat(level)} `,
    widgetPos: pos + 1,
    decorateFrom: pos,
    decorateTo: pos + node.nodeSize,
    kind: 'heading',
  }
}

function depthOf($pos: ResolvedPos, name: string): number | null {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === name) return d
  return null
}

function prefixInfo(state: EditorState): PrefixInfo | null {
  if (!state.selection.empty) return null
  const $from = state.selection.$from
  if (!$from.parent.isTextblock) return null
  const widgetPos = $from.start()

  if ($from.parent.type.name === 'heading') {
    return headingInfo($from.parent, $from.before())
  }

  const liDepth = depthOf($from, 'list_item')
  if (liDepth !== null) {
    const li = $from.node(liDepth)
    // Markdown 的列表标记只属于 list_item 的第一个段落；子段落/嵌套块不能再画一份。
    // 但位于 list_item 后续块里的引用仍要继续向下命中 quote，不能在这里提前 return。
    if (li.firstChild === $from.parent) {
      const listDepth = liDepth - 1
      const list = $from.node(listDepth)
      const checked = li.attrs.checked
      let source = '- '
      let kind: PrefixInfo['kind'] = 'list'
      if (checked != null) {
        source = checked ? '- [x] ' : '- [ ] '
        kind = 'task'
      } else if (list.type.name === 'ordered_list') {
        const index = $from.index(listDepth)
        source = `${(Number(list.attrs.order) || 1) + index}. `
      }
      const from = $from.before(liDepth)
      return { source, widgetPos, decorateFrom: from, decorateTo: from + li.nodeSize, kind }
    }
  }

  const quoteDepth = depthOf($from, 'blockquote')
  if (quoteDepth !== null) {
    const quote = $from.node(quoteDepth)
    const from = $from.before(quoteDepth)
    return { source: '> ', widgetPos, decorateFrom: from, decorateTo: from + quote.nodeSize, kind: 'quote' }
  }
  return null
}

function activeHeadingInfo(state: EditorState): PrefixInfo | null {
  const { $from, $to } = state.selection
  if ($from.parent.type.name !== 'heading' || $to.parent.type.name !== 'heading') return null
  // 跨标题范围选区不属于“正在编辑某一行”，不能随便挑首行露一枚井号。
  if ($from.before() !== $to.before()) return null
  return headingInfo($from.parent, $from.before())
}

function refreshDecorations(view: EditorView): void {
  if (!view.dom.isConnected) return
  view.dispatch(view.state.tr.setMeta(key, { refresh: true }))
}

function selectPrefixOwner(view: EditorView, info: PrefixInfo): boolean {
  const node = view.state.doc.nodeAt(info.decorateFrom)
  if (!node || !node.isTextblock || info.widgetPos !== info.decorateFrom + 1) return false
  const { selection } = view.state
  if (selection.empty && selection.from === info.widgetPos) return true
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, info.widgetPos)))
  return true
}

function sizePrefixInput(input: HTMLInputElement): void {
  input.style.setProperty('--amx-prefix-ch', String(Math.max(2, input.value.length + 0.4)))
}

/** 标题井号数量一旦仍是合法的 `#{1,6} `，就原地实时切级，同时保住 input 焦点和字符落点。 */
function applyLiveHeadingPrefix(view: EditorView, input: HTMLInputElement, info: PrefixInfo): boolean {
  const trig = triggerFromStructuralPrefix(input.value)
  if (info.kind !== 'heading' || trig?.kind !== 'heading') return false
  if (input.value === (input.dataset.original ?? '')) return true

  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  // setBlockType 会刷新 decorations。先闩住旧 DOM 的 blur，避免它在被替换时用旧 original 再提交一次。
  input.dataset.committed = '1'
  if (!selectPrefixOwner(view, info) || !applyTrigger(view, trig, null)) {
    input.value = input.dataset.original ?? info.source
    sizePrefixInput(input)
    input.dataset.committed = '0'
    return true
  }

  const live = view.dom.querySelector<HTMLInputElement>(
    `.amx-struct-prefix[data-structural-prefix="heading"][data-widget-pos="${info.widgetPos}"]`,
  ) ?? input
  live.value = input.value
  live.dataset.original = input.value
  live.dataset.committed = '0'
  sizePrefixInput(live)
  live.focus({ preventScroll: true })
  live.setSelectionRange(Math.min(start, live.value.length), Math.min(end, live.value.length))
  return true
}

function insertLiteralPrefix(view: EditorView, source: string): boolean {
  // 先用既有转换引擎脱掉标题/列表/引用外壳，再把“删剩的源码”写回普通文本行。
  if (!applyTrigger(view, { kind: 'text' }, null)) return false
  const { $from } = view.state.selection
  if (!$from.parent.isTextblock) return false
  const at = $from.start()
  const tr = view.state.tr.insertText(source, at)
  tr.setSelection(TextSelection.create(tr.doc, at + source.length))
  view.dispatch(tr.scrollIntoView())
  return true
}

function commitPrefix(view: EditorView, input: HTMLInputElement, refocus: boolean): void {
  if (input.dataset.committed === '1') return
  input.dataset.committed = '1'
  const source = input.value
  const original = input.dataset.original ?? ''
  let literalSelection = false
  if (source !== original) {
    const trig = triggerFromStructuralPrefix(source)
    if (trig) applyTrigger(view, trig, null)
    else literalSelection = insertLiteralPrefix(view, source)
  }
  // 转换完成 / 离开 input 后立刻回到渲染态。不能把“编辑器仍有焦点”当作源码打开条件，
  // 否则刚输入 `- ` 的空列表会隐藏圆点，input 还会把自绘光标从正文起点挤开。
  view.dispatch(view.state.tr.setMeta(key, { openAt: null }))
  if (refocus) {
    view.focus()
    const { $from } = view.state.selection
    // 非法前缀已经作为字面文本写回，insertLiteralPrefix 把选区放在剩余字符之后；不能再
    // 无条件拉回行首，否则第一下退格虽显示 `-`，第二下仍删不到它，方向键也像被卡住。
    if (!literalSelection && $from.parent.isTextblock) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.start())).scrollIntoView())
    }
  }
}

function prefixInput(view: EditorView, info: PrefixInfo): HTMLInputElement {
  const input = document.createElement('input')
  input.className = 'amx-struct-prefix'
  input.type = 'text'
  input.value = info.source
  input.dataset.original = info.source
  input.dataset.structuralPrefix = info.kind
  input.dataset.widgetPos = String(info.widgetPos)
  input.setAttribute('aria-label', 'Markdown 标记')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocapitalize', 'off')
  input.spellcheck = false
  sizePrefixInput(input)
  // Decoration key 不变时 PM 会复用同一枚 input DOM。上一次提交留下的闩锁必须在下次进入时
  // 清掉，否则“原样退出 → 再进来修改”的第二次提交会被误判成重复 blur 而静默丢失。
  input.addEventListener('focus', () => {
    input.dataset.committed = '0'
    // PM 自己的选区不会穿过 widget 自动跟来，因此先同步到所属标题，后续实时改级/退出结构
    // 才不会误改上一次停留的块。
    selectPrefixOwner(view, info)
  })

  const commitIfInvalid = (event?: InputEvent): void => {
    if (event?.isComposing) return
    if (applyLiveHeadingPrefix(view, input, info)) return
    // 尾随空格就是渲染边界。它一被删掉，当前结构必须马上脱壳并把剩余源码写回正文，
    // 不能等 blur/Enter；否则 input 会在空列表里吞掉之后所有 Backspace/方向键。
    if (!triggerFromStructuralPrefix(input.value)) commitPrefix(view, input, true)
  }
  input.addEventListener('input', (event) => commitIfInvalid(event as InputEvent))
  input.addEventListener('compositionend', () => commitIfInvalid())

  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      input.value = input.dataset.original ?? info.source
      sizePrefixInput(input)
      commitPrefix(view, input, true)
      return
    }
    if (event.key === 'Enter' || (event.key === 'ArrowRight' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length)) {
      event.preventDefault()
      commitPrefix(view, input, true)
    }
  })
  input.addEventListener('blur', () => {
    commitPrefix(view, input, false)
    // input blur 到编辑器外时，PM 自己不会再收到第二次 blur；等 activeElement 稳定后刷新，
    // 让“仅当前编辑行显示”立即收回。若 commitPrefix 把焦点送回 PM，build 会自然保留。
    queueMicrotask(() => refreshDecorations(view))
  })
  return input
}

function build(state: EditorState, view: EditorView): DecorationSet {
  const decos: Decoration[] = []
  // 标题只在这一个 EditorView 正被编辑、且选区落在某一条标题内时露源码。焦点进入前缀 input
  // 后 view.hasFocus() 会变 false，所以还要接受“activeElement 是本 view 的后代”；从 PM 切到
  // input 的一瞬间 Chromium 会短暂把 activeElement 置为 body，openAt 负责跨过这道焦点缝隙。
  const openAt = key.getState(state)?.openAt
  const active = view.hasFocus() || view.dom.contains(document.activeElement)
  const selectedHeading = activeHeadingInfo(state)
  const heading = selectedHeading && (active || openAt === selectedHeading.widgetPos) ? selectedHeading : null
  if (heading) {
    const info = heading
    decos.push(Decoration.widget(info.widgetPos, () => prefixInput(view, info), {
      side: -1,
      // 同一标题只改 level 时复用 input DOM，才能在实时 H3→H2 的事务后保住焦点与 selectionStart。
      key: `struct:${info.widgetPos}:${info.kind}`,
      ignoreSelection: true,
      stopEvent: () => true,
    }))
  }

  if (openAt != null) {
    const info = prefixInfo(state)
    // 标题 widget 由当前编辑行决定，openAt 只负责临时展开其余结构，不能再画第二枚井号。
    if (info && info.kind !== 'heading' && info.widgetPos === openAt) {
      const node = state.doc.nodeAt(info.decorateFrom) as ProseNode | null
      if (node) {
        decos.push(
          Decoration.node(info.decorateFrom, info.decorateTo, {
            class: `amx-struct-source-open amx-struct-source-${info.kind}`,
          }),
          Decoration.widget(info.widgetPos, () => prefixInput(view, info), {
            side: -1,
            key: `struct:${info.widgetPos}:${info.kind}`,
            ignoreSelection: true,
            stopEvent: () => true,
          }),
        )
      }
    }
  }
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

/** 从正文行首进入结构标记；Backspace 入口可顺手删掉最后一个字符（通常是渲染边界空格）。 */
export function focusStructuralPrefix(view: EditorView, deleteLast = false): boolean {
  if (!view.state.selection.empty || view.state.selection.$from.parentOffset !== 0) return false
  const info = prefixInfo(view.state)
  if (!info) return false
  // 显式 openAt 既负责展开列表等结构，也保护标题 input 跨过 PM→input 的短暂焦点缝隙。
  view.dispatch(view.state.tr.setMeta(key, { openAt: info.widgetPos }))
  const input = view.dom.querySelector<HTMLInputElement>(
    `.amx-struct-prefix[data-structural-prefix="${info.kind}"][data-widget-pos="${info.widgetPos}"]`,
  )
  if (!input) {
    view.dispatch(view.state.tr.setMeta(key, { openAt: null }))
    return false
  }
  input.focus({ preventScroll: true })
  const at = input.value.length
  input.setSelectionRange(at, at)
  if (deleteLast && at > 0) {
    input.setRangeText('', at - 1, at, 'end')
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
  }
  return true
}

export function structuralSourcePlugin() {
  return $prose(
    () => {
      let viewRef: EditorView | null = null
      return new Plugin<StructuralSourceState>({
        key,
        view: (view) => {
          viewRef = view
          return { destroy: () => { if (viewRef === view) viewRef = null } }
        },
        state: {
          init: () => ({ openAt: null }),
          apply: (tr, value) => {
            const meta = tr.getMeta(key) as { openAt?: number | null } | undefined
            if (meta && Object.prototype.hasOwnProperty.call(meta, 'openAt')) {
              return { openAt: meta.openAt ?? null }
            }
            return value.openAt == null ? value : { openAt: tr.mapping.map(value.openAt) }
          },
        },
        props: {
          decorations: (state) => viewRef ? build(state, viewRef) : DecorationSet.empty,
          handleDOMEvents: {
            // 焦点状态不是 EditorState 的一部分；补一笔无文档事务让 decorations 在进入/离开
            // 编辑器时重新求值。blur 延后一微任务，才能区分“去前缀 input”与“真的离开本行”。
            focus: (view) => {
              queueMicrotask(() => refreshDecorations(view))
              return false
            },
            blur: (view) => {
              queueMicrotask(() => refreshDecorations(view))
              return false
            },
          },
        },
      })
    },
  )
}
