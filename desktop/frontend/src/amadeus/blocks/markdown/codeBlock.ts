/** 代码块增强(AFFiNE 对标):lowlight(highlight.js common,37 语言)语法高亮装饰
 *  + 悬停工具条(语言选择 / 复制 / 折行,NodeView 挂在 <code> 之外)。配色复用 base.css 既有 .hljs-* 主题 token。
 *  语言即 fence info(```py)= code_block 节点 attrs.language,改语言 = setNodeMarkup(落盘 md 原生);
 *  折行是会话视图态(不进 md),位置经事务映射保持贴同一块。
 *  高亮装饰住在**插件 state** 里增量维护(评审 P-03):v4 整篇一个实例,旧写法「每次 state 更新全量重跑 lowlight」
 *  在 10 个 40 行代码块的笔记里每按一次方向键都要 ~9ms。现在纯选区事务原样复用;改文档时先映射旧集合,
 *  只重算被改动碰到的代码块(见 remapDecos)。 */
import { $prose } from '@milkdown/kit/utils'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view'
import { currentLocale, registerMessages, translate } from '../../../i18n'
import { isShellLang, runInTerminal, stripPrompt } from '../../../builtins/runCommand'
import { parseButtonBlock } from '../button/format'
import { codeAutoPairBackspace, codeAutoPairInput } from './codeAutoPair'
import { CODE_LANGUAGES, highlightCode, isPlainCodeLanguage, type CodeHighlight } from './codeHighlight'
export { codeHighlightRuns } from './codeHighlight'

/** 工具条文案。⚠️ 按钮字面**必须短**(和中文的两字一样):工具条绝对定位盖在代码块右上,
 *  英文写长了(实测 "Line numbers"/"Collapse" 一套 375px)会盖住短代码块的水平中心,点进去
 *  落到 select 上而不是代码里 —— e2e T42「代码块 Tab → 行首两空格」就是这么红的。完整说明放 title。 */
registerMessages({
  'amxcode.langTitle': { zh: '语言', en: 'Language' },
  'amxcode.auto': { zh: '自动', en: 'Auto' },
  'amxcode.autoDetected': { zh: '自动 · {language}', en: 'Auto · {language}' },
  'amxcode.plainText': { zh: '纯文本', en: 'Plain text' },
  'amxcode.copy': { zh: '复制', en: 'Copy' },
  'amxcode.copyTitle': { zh: '复制代码', en: 'Copy code' },
  'amxcode.copied': { zh: '已复制', en: 'Copied' },
  'amxcode.run': { zh: '运行', en: 'Run' },
  'amxcode.runTitle': { zh: '在内置终端运行（底部面板）', en: 'Run in the built-in terminal (bottom panel)' },
  'amxcode.wrap': { zh: '折行', en: 'Wrap' },
  'amxcode.wrapTitle': { zh: '切换自动折行（视图态，不改内容）', en: 'Toggle line wrap (view only, does not change content)' },
  'amxcode.linenoOff': { zh: '取消行号', en: 'Hide numbers' },
  'amxcode.lineno': { zh: '行号', en: 'Numbers' },
  'amxcode.linenoDisabled': { zh: '折行开着时不显示行号（软换行无独立行号）', en: 'Line numbers are unavailable while wrapping is on (soft-wrapped lines have no number of their own)' },
  'amxcode.linenoTitle': { zh: '切换行号（视图态，不改内容）', en: 'Toggle line numbers (view only, does not change content)' },
  'amxcode.expand': { zh: '展开', en: 'Unfold' },
  'amxcode.collapse': { zh: '折叠', en: 'Fold' },
  'amxcode.collapseTitle': { zh: '折叠代码块（限高 8 行，视图态）', en: 'Fold the code block (8-line limit, view only)' },
})

/** PM 节点不可变：装饰与 NodeView 共用一次识别；选区/块外输入不再识别未改的块。 */
const highlights = new WeakMap<ProseNode, CodeHighlight>()
function nodeHighlight(node: ProseNode): CodeHighlight {
  let result = highlights.get(node)
  if (!result) {
    result = highlightCode(node.textContent, String(node.attrs.language ?? ''))
    highlights.set(node, result)
  }
  return result
}

const codeKey = new PluginKey<CodeUi>('amx-code-block')

/** 三个视图开关都是**会话态**:切页/重开即复位。AFFiNE 那边是持久化块属性(code-model.ts),
 *  我们不往纯 md 里加 amadeus_* 键,这是刻意的偏差。decos = 当前文档的高亮 + 块级 class(增量维护)。 */
interface CodeUi {
  wrapped: Set<number>
  lineno: Set<number>
  collapsed: Set<number>
  decos: DecorationSet
}

/** 一个代码块的全部装饰:块级 class(折行 / 行号 / 折叠)+ lowlight 的逐 token class。 */
function blockDecos(node: ProseNode, pos: number, ui: Omit<CodeUi, 'decos'>): Decoration[] {
  const isWrap = ui.wrapped.has(pos)
  const isNo = ui.lineno.has(pos) && !isWrap // 折行时行号必然错位(软换行没有自己的号),互斥
  const isCollapsed = ui.collapsed.has(pos)
  const out = [Decoration.node(pos, pos + node.nodeSize, {
    class: `amx-code${isWrap ? ' amx-code-wrap' : ''}${isNo ? ' amx-code-lineno' : ''}${isCollapsed ? ' amx-code-collapsed' : ''}`,
    ...(isNo ? { 'data-lines': String(node.textContent.split('\n').length) } : {}),
  })]
  for (const t of nodeHighlight(node).ranges) out.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: t.cls }))
  return out
}

function allDecos(doc: ProseNode, ui: Omit<CodeUi, 'decos'>): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true
    decos.push(...blockDecos(node, pos, ui))
    return false
  })
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty
}

/** 改文档的事务:映射旧集合,只重算被改动碰到的代码块。
 *  「碰到」= 每一步的改动区间(映射到最终文档)两侧各放宽 1 —— 块边界上的合并 / 拆分也算碰到。
 *  被碰到的**非代码**文本块也要清一遍:代码块转成段落(setBlockType)时,块级装饰随边界被删而掉,
 *  但逐 token 的 inline 装饰会跟着文字映射进新段落,不清就是一段普通文字挂着高亮色。
 *  ⚠️ 删的时候只删**完全落在该块之内**的装饰:DecorationSet.find 会把恰好在边界上结束的相邻代码块的
 *  块级装饰也捞出来,照单全删就把邻居的 `amx-code` 弄丢了。 */
function remapDecos(prev: DecorationSet, tr: Transaction, ui: Omit<CodeUi, 'decos'>): DecorationSet {
  let set = prev.map(tr.mapping, tr.doc)
  const size = tr.doc.content.size
  const code = new Map<number, ProseNode>()
  const text: Array<[number, number]> = []
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1)
    map.forEach((_os, _oe, ns, ne) => {
      const from = Math.max(0, rest.map(ns, -1) - 1)
      const to = Math.min(size, rest.map(ne, 1) + 1)
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'code_block') { code.set(pos, node); return false }
        if (node.isTextblock) { text.push([pos, pos + node.nodeSize]); return false }
        return true
      })
    })
  })
  const inside = (from: number, to: number): Decoration[] => set.find(from, to).filter((d) => d.from >= from && d.to <= to)
  for (const [from, to] of text) {
    const stale = inside(from, to)
    if (stale.length) set = set.remove(stale)
  }
  for (const [pos, node] of code) {
    const end = pos + node.nodeSize
    set = set.remove(inside(pos, end)).add(tr.doc, blockDecos(node, pos, ui))
  }
  return set
}
/** 语言选择的「最近使用」:同一次会话里选过的语言排到列表最前(AFFiNE 同款手感)。 */
const recentLangs: string[] = []

/** 悬停工具条(语言 / 复制 / 折行 / 行号 / 折叠 / 运行)。nodeAt = 代码块节点当前的文档位置。 */
function buildToolbar(view: EditorView, nodeAt: () => number | null, lang: string, detected: string, isWrap: boolean, isNo: boolean, isCollapsed: boolean): HTMLDivElement {
  const bar = document.createElement('div')
  bar.className = 'amx-code-tools'
  bar.contentEditable = 'false'
  // 语言选择
  const sel = document.createElement('select')
  sel.className = 'amx-code-lang'
  sel.title = detected ? translate('amxcode.autoDetected', { language: detected }) : translate('amxcode.langTitle')
  const opt0 = document.createElement('option')
  opt0.value = ''
  const label = detected === 'javascript' ? 'JS' : detected === 'typescript' ? 'TS' : detected
  opt0.textContent = detected ? translate('amxcode.autoDetected', { language: label }) : translate('amxcode.auto')
  sel.appendChild(opt0)
  const plain = document.createElement('option')
  plain.value = isPlainCodeLanguage(lang) ? lang : 'plaintext'
  plain.textContent = translate('amxcode.plainText')
  sel.appendChild(plain)
  const known = CODE_LANGUAGES.includes(lang) || !lang || isPlainCodeLanguage(lang)
  // 最近用过的排最前(会话内),其余保持原序 —— AFFiNE 选中即 unshift 的同款手感。
  const ordered = [...recentLangs.filter((l) => CODE_LANGUAGES.includes(l)), ...CODE_LANGUAGES.filter((l) => !recentLangs.includes(l))]
  for (const l of known ? ordered : [lang, ...ordered]) {
    const o = document.createElement('option')
    o.value = l
    o.textContent = l
    sel.appendChild(o)
  }
  sel.value = lang
  sel.addEventListener('change', () => {
    const at = nodeAt()
    if (sel.value) {
      const i = recentLangs.indexOf(sel.value)
      if (i >= 0) recentLangs.splice(i, 1)
      recentLangs.unshift(sel.value)
    }
    if (at === null) return
    const n = view.state.doc.nodeAt(at)
    if (n?.type.name === 'code_block') {
      view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...n.attrs, language: sel.value }))
    }
  })
  // 复制
  const copy = document.createElement('button')
  copy.className = 'amx-code-btn'
  copy.textContent = translate('amxcode.copy')
  copy.title = translate('amxcode.copyTitle')
  copy.addEventListener('click', () => {
    const at = nodeAt()
    const n = at === null ? null : view.state.doc.nodeAt(at)
    if (!n) return
    void navigator.clipboard.writeText(n.textContent).then(() => {
      copy.textContent = translate('amxcode.copied')
      setTimeout(() => { copy.textContent = translate('amxcode.copy') }, 1200)
    })
  })
  // 折行
  const wrap = document.createElement('button')
  wrap.className = `amx-code-btn${isWrap ? ' on' : ''}`
  wrap.textContent = translate('amxcode.wrap')
  wrap.title = translate('amxcode.wrapTitle')
  wrap.addEventListener('click', () => {
    const at = nodeAt()
    if (at !== null) view.dispatch(view.state.tr.setMeta(codeKey, { toggle: at }))
  })
  // 行号(与折行互斥:软换行没有自己的号,开着折行时行号必然错位)
  const nums = document.createElement('button')
  nums.className = `amx-code-btn${isNo ? ' on' : ''}`
  nums.textContent = isNo ? translate('amxcode.linenoOff') : translate('amxcode.lineno')
  nums.title = isWrap ? translate('amxcode.linenoDisabled') : translate('amxcode.linenoTitle')
  nums.disabled = isWrap
  nums.addEventListener('click', () => {
    const at = nodeAt()
    if (at !== null) view.dispatch(view.state.tr.setMeta(codeKey, { toggle: at, which: 'lineno' }))
  })
  // 折叠(限高 8 行 + 底部渐隐,AFFiNE 同款)
  const fold = document.createElement('button')
  fold.className = `amx-code-btn${isCollapsed ? ' on' : ''}`
  fold.textContent = isCollapsed ? translate('amxcode.expand') : translate('amxcode.collapse')
  fold.title = translate('amxcode.collapseTitle')
  fold.addEventListener('click', () => {
    const at = nodeAt()
    if (at !== null) view.dispatch(view.state.tr.setMeta(codeKey, { toggle: at, which: 'collapse' }))
  })
  bar.append(sel, copy, wrap, nums, fold)
  // 运行(仅 shell fence 且桌面端有 PTY;笔记里没有会话,只跑不回传)
  if (isShellLang(lang) && window.tangu?.pty) {
    const run = document.createElement('button')
    run.className = 'amx-code-btn'
    run.textContent = translate('amxcode.run')
    run.title = translate('amxcode.runTitle')
    run.addEventListener('click', () => {
      const at = nodeAt()
      const n = at === null ? null : view.state.doc.nodeAt(at)
      const cmd = n ? stripPrompt(n.textContent) : ''
      if (cmd) runInTerminal(cmd)
    })
    bar.append(run)
  }
  return bar
}

/** 代码块 NodeView(R-04):工具条与行号栏挂在 contentDOM(<code>)**之外**,<code> 里只有代码。
 *  此前两者是 pos+1 的 side:-1 widget,落在 <code> 里文字之前;首个关键字一被高亮包进 span,
 *  DOM 选区停在 CODE@2(span 之后的元素边界),Chrome 下一个字却插到 span **前面** ——
 *  空代码块打 `const a` 得到 ` aconst`。最小实验:只去工具条、或只去高亮,乱序都消失;
 *  病根是「contentDOM 里夹着非内容节点」,所以把它们请出 contentDOM,而不是去矫正选区。
 *  外层 Decoration.node 的 class(amx-code / -wrap / -lineno / -collapsed)PM 照常贴在 this.dom 上。 */
class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private bar: HTMLDivElement | null = null
  private nums: HTMLSpanElement | null = null
  private barSig = ''

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly onDestroy: () => void,
  ) {
    this.dom = document.createElement('pre')
    this.dom.spellcheck = false // 代码不做拼写检查(G4-07):<code> 继承它,整篇开关管不到这里
    this.contentDOM = document.createElement('code')
    this.dom.appendChild(this.contentDOM)
    this.sync()
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.sync()
    return true
  }

  /** 按节点 + 插件视图态(折行/行号/折叠,会话态)+ 界面语言刷新工具条与行号;签名不变不碰 DOM,
   *  语言下拉开着时不会被重建打断。插件 view.update 每个事务都调一次(视图态切换不一定改到节点)。 */
  sync(): void {
    const lang = String((this.node.attrs as { language?: string }).language ?? '').trim()
    const detected = !lang ? nodeHighlight(this.node).language : ''
    if (lang) this.dom.setAttribute('data-language', lang)
    else this.dom.removeAttribute('data-language')
    if (detected) this.dom.setAttribute('data-detected-language', detected)
    else this.dom.removeAttribute('data-detected-language')
    const pos = this.getPos()
    const ui = codeKey.getState(this.view.state)
    const isWrap = pos != null && !!ui?.wrapped.has(pos)
    const isNo = pos != null && !!ui?.lineno.has(pos) && !isWrap // 折行时软换行没有自己的号,互斥
    const isCollapsed = pos != null && !!ui?.collapsed.has(pos)
    // 有效的按钮块(```forsion-button + 合法 JSON)由嵌入层渲染成按钮,不给代码块工具条(R-14):工具条压在按钮上,
    // 语言下拉一改(改成 javascript 后列表里再没有 forsion-button)按钮就变回 JSON、改不回来。JSON 坏了的仍是
    // 普通代码块(R-13 的回落),工具条照给 —— 那时它就是一段代码。签名带上这一位:改源码修好 / 改坏时当场切换。
    const button = lang === 'forsion-button' && !!parseButtonBlock('```forsion-button\n' + this.node.textContent + '\n```')
    const sig = button ? 'button' : `${lang}:${detected}:${isWrap ? 1 : 0}:${isNo ? 1 : 0}:${isCollapsed ? 1 : 0}:${currentLocale()}`
    if (sig !== this.barSig) {
      if (button) {
        this.bar?.remove()
        this.bar = null
      } else {
        const bar = buildToolbar(this.view, () => this.getPos() ?? null, lang, detected, isWrap, isNo, isCollapsed)
        if (this.bar) this.bar.replaceWith(bar)
        else this.dom.insertBefore(bar, this.contentDOM)
        this.bar = bar
      }
      this.barSig = sig
    }
    if (isNo) {
      // ⚠️ code_block 是**一个** <pre>,行不是元素 —— CSS 计数器没有可计的东西。自己画一列,与代码
      //    同字体同行高(pre 内部,直接继承),绝对定位在左槽。
      const lines = this.node.textContent.split('\n').length
      const text = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n')
      if (!this.nums) {
        this.nums = document.createElement('span')
        this.nums.className = 'amx-code-nums'
        this.nums.contentEditable = 'false'
        this.dom.insertBefore(this.nums, this.contentDOM)
      }
      if (this.nums.textContent !== text) this.nums.textContent = text
    } else if (this.nums) {
      this.nums.remove()
      this.nums = null
    }
  }

  /** 工具条/行号栏里的变化(「已复制」换字、按钮态)不是文档变化,别让 PM 重读这一块。 */
  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === 'selection') return false
    return !this.contentDOM.contains(m.target)
  }

  /** 工具条上的点按/选择自己处理(原 widget 的 stopEvent 同口径);<code> 与 <pre> 本身仍交给 PM。 */
  stopEvent(e: Event): boolean {
    const t = e.target as Node | null
    return !!t && t !== this.dom && this.dom.contains(t) && !this.contentDOM.contains(t)
  }

  destroy(): void {
    this.onDestroy()
  }
}

export function codeBlockPlugin() {
  return $prose(() => {
    const views = new Set<CodeBlockView>()
    return new Plugin({
      key: codeKey,
      view: () => ({ update: () => { for (const v of views) v.sync() } }),
      state: {
        init: (_config, state) => {
          const ui = { wrapped: new Set<number>(), lineno: new Set<number>(), collapsed: new Set<number>() }
          return { ...ui, decos: allDecos(state.doc, ui) }
        },
        apply(tr, v) {
          // 纯选区 / 不相干的 meta:原样复用(同一个对象 —— PM 比 DecorationSet 身份,零重绘)。
          if (!tr.docChanged && !tr.getMeta(codeKey)) return v
          const wrapped = new Set([...v.wrapped].map((p) => tr.mapping.map(p)))
          const lineno = new Set([...v.lineno].map((p) => tr.mapping.map(p)))
          const collapsed = new Set([...v.collapsed].map((p) => tr.mapping.map(p)))
          const meta = tr.getMeta(codeKey) as { toggle?: number; which?: 'wrap' | 'lineno' | 'collapse' } | undefined
          if (meta?.toggle != null) {
            const set = meta.which === 'lineno' ? lineno : meta.which === 'collapse' ? collapsed : wrapped
            if (set.has(meta.toggle)) set.delete(meta.toggle)
            else set.add(meta.toggle)
          }
          const ui = { wrapped, lineno, collapsed }
          // 视图态开关(折行 / 行号 / 折叠)很少按,全量重建最稳;其余改文档的事务走增量映射。
          const decos = meta?.toggle != null ? allDecos(tr.doc, ui) : remapDecos(v.decos, tr, ui)
          return { ...ui, decos }
        },
      },
      props: {
        nodeViews: {
          code_block: (node, view, getPos) => {
            let cv!: CodeBlockView
            cv = new CodeBlockView(node, view, getPos, () => views.delete(cv))
            views.add(cv)
            return cv
          },
        },
        decorations(state) {
          return codeKey.getState(state)?.decos ?? DecorationSet.empty
        },
        // 括号 / 引号自动配对(R-27,本机开关,见 codeAutoPair.ts)。
        handleTextInput: (view, from, to, text) => codeAutoPairInput(view, from, to, text),
        handleKeyDown: (view, event) =>
          event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.isComposing
            ? codeAutoPairBackspace(view) : false,
      },
    })
  })
}
