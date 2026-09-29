/** 正文里的生成式 AI(评审 G3-07,拍板 #13)的编辑器侧:目标区间插件 + 上下文 + 写入。
 *
 *  流程:入口(工具栏「AI ▾」/ `/ai` / 空行按空格)→ 记下目标区间(本插件,随编辑映射、画 `am-ai-target` 淡底)
 *  → InlineAiPanel 调 `readTangu().complete`(引擎 POST /agent/inline)流式出结果 → **先进预览**,用户点
 *  替换 / 插入下方 / 插入 才写:结果按 markdown 经编辑器自己的 parser 解析,一个事务落进文档(普通用户编辑,
 *  进撤销栈,走现有防抖 + CAS 保存);丢弃 = 文档一个字不动。磁盘上只有纯 md,面板与目标淡底都不落盘。
 *
 *  空行按空格唤起:缺省**关**(拍板 #13),开关存本机(aiSpaceTrigger)。只在「空的普通段落」里生效,
 *  列表 / 引用 / callout 里的空行照旧插空格;输入法组字中一律放行(PM 自己也在组字时不调 handleKeyDown,
 *  这里再守一道 isComposing / keyCode 229 / view.composing)。 */
import { $prose } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Slice, type Fragment, type Node as ProseNode } from '@milkdown/kit/prose/model'

export interface AiTarget {
  from: number
  to: number
  /** 请求那一刻目标里的文字(给插件 run / 翻译方向判断用)。 */
  text: string
  /** 请求那一刻目标的**结构指纹**(节点、属性、marks、文字;Codex 复核 P1):替换前比对,生成期间用户改了
   *  链接地址 / 图片 / 加粗之类(可见文字没变)也算改过,不整段盖掉,改为插入下方。 */
  sig: string
}

/** 目标片段的结构指纹:Slice 内容的 JSON(类型 / attrs / marks / text),去掉由插件回填、会自己变的标题 id
 *  (与 reconcileDiff 的 DERIVED_ATTRS 同口径)。 */
export function targetSig(doc: ProseNode, from: number, to: number): string {
  return JSON.stringify(doc.slice(from, to).content.toJSON() ?? [], (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as { type?: unknown }).type === 'heading' && (v as { attrs?: Record<string, unknown> }).attrs) {
      const { id: _id, ...attrs } = (v as { attrs: Record<string, unknown> }).attrs
      return { ...(v as object), attrs }
    }
    return v
  })
}
type Meta = { set: AiTarget } | { clear: true }
export const inlineAiKey = new PluginKey<AiTarget | null>('amInlineAi')

/** 空的「普通」段落:父节点是文档 / 分栏格 / 画布卡片(列表项、引用、callout 里的空行不算)。 */
function onEmptyPlainParagraph(view: EditorView): boolean {
  const sel = view.state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return false
  const $from = sel.$from
  if ($from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) return false
  const host = $from.depth >= 1 ? $from.node($from.depth - 1).type.name : ''
  return host === 'doc' || host === 'amadeusColumnCell' || host === 'amadeusCanvasCard'
}

export function inlineAiPlugin(opts: {
  /** 空行空格唤起开关(现读,设置改了即时生效)。 */
  spaceTrigger: () => boolean
  onSpace: (view: EditorView) => void
}): Plugin<AiTarget | null> {
  return new Plugin<AiTarget | null>({
    key: inlineAiKey,
    state: {
      init: () => null,
      apply(tr, cur) {
        const meta = tr.getMeta(inlineAiKey) as Meta | undefined
        if (meta && 'clear' in meta) return null
        if (meta && 'set' in meta) return meta.set
        if (!cur || !tr.docChanged) return cur
        const from = tr.mapping.map(cur.from, 1)
        return { ...cur, from, to: Math.max(from, tr.mapping.map(cur.to, -1)) }
      },
    },
    props: {
      decorations(state) {
        const t = inlineAiKey.getState(state)
        if (!t || t.to <= t.from) return null
        return DecorationSet.create(state.doc, [Decoration.inline(t.from, Math.min(t.to, state.doc.content.size), { class: 'am-ai-target' })])
      },
      handleKeyDown(view, e) {
        if (e.key !== ' ' || e.isComposing || e.keyCode === 229 || view.composing) return false
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
        if (!opts.spaceTrigger() || !onEmptyPlainParagraph(view)) return false
        opts.onSpace(view)
        return true
      },
    },
  })
}

/** Milkdown 包装(UnifiedPage 的 editorPlugins 用;回调经 ref 现读,编辑器只建一次)。 */
export function createInlineAi(opts: { spaceTrigger: () => boolean; onSpace: { current: (view: EditorView) => void } }): MilkdownPlugin[] {
  return [$prose(() => inlineAiPlugin({ spaceTrigger: opts.spaceTrigger, onSpace: (view) => opts.onSpace.current(view) }))].flat()
}

/** 记下目标区间(selection 模式 = 选区;cursor 模式 = 光标处的一个点)。选区同时收成目标末尾的光标:
 *  否则选区工具栏会随下一次视图更新又浮出来压在面板上,原生选区底色也盖住 `am-ai-target` 淡底。 */
export function setAiTarget(view: EditorView, from: number, to: number): AiTarget {
  const target = { from, to, text: view.state.doc.textBetween(from, to, '\n', ''), sig: targetSig(view.state.doc, from, to) }
  const tr = view.state.tr.setMeta(inlineAiKey, { set: target } satisfies Meta)
  if (to > from) tr.setSelection(TextSelection.create(tr.doc, to))
  view.dispatch(tr)
  return target
}
/** 收起(丢弃):选区模式把原选区还给用户(同 Notion 的 Discard),文档不动。 */
export function clearAiTarget(view: EditorView): void {
  const t = inlineAiKey.getState(view.state)
  if (!t) return
  const tr = view.state.tr.setMeta(inlineAiKey, { clear: true } satisfies Meta)
  if (t.to > t.from && t.to <= tr.doc.content.size) {
    try { tr.setSelection(TextSelection.create(tr.doc, t.from, t.to)) } catch { /* 区间已不是合法文字位:留在原处 */ }
  }
  view.dispatch(tr)
}
export function aiTargetOf(view: EditorView): AiTarget | null {
  return inlineAiKey.getState(view.state) ?? null
}

/** 目标前后的正文(上下文,不改写)。按字符截:前文取末尾一段、后文取开头一段。 */
export function aiContextOf(doc: ProseNode, from: number, to: number): { before: string; after: string } {
  const size = doc.content.size
  const before = doc.textBetween(Math.max(0, from - 8000), from, '\n', '').slice(-2000)
  const after = doc.textBetween(to, Math.min(size, to + 4000), '\n', '').slice(0, 1000)
  return { before, after }
}

/** 选区语言粗判:汉字占比高 → 译成英文,否则译成简体中文(工具栏只有一个「翻译」)。 */
export function translateTargetOf(text: string): string {
  const letters = text.replace(/[\s\p{P}\p{S}\d]/gu, '')
  if (!letters) return 'English'
  const cjk = (letters.match(/[぀-ヿ㐀-鿿豈-﫿]/g) || []).length
  return cjk / letters.length > 0.3 ? 'English' : 'Chinese (Simplified)'
}

export type AiApply = 'replace' | 'below' | 'insert'

/** 位置所在的「块」:往上找到父节点是文档 / 分栏格的那一层(与 UnifiedPage.insertMd 的光标插入同一口径)。 */
function blockAt(doc: ProseNode, pos: number): { from: number; to: number; blank: boolean } | null {
  const $p = doc.resolve(pos)
  let d = $p.depth
  while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($p.node(d - 1).type.name)) d--
  if (d < 1) return null
  return { from: $p.before(d), to: $p.after(d), blank: $p.node(d).textContent.trim() === '' }
}

/** 把预览确认后的结果写进文档:一个事务,普通用户编辑(进撤销栈)。返回实际用的写法;写不进去 = null。
 *  - replace:换掉目标区间。单个文本块的结果按行内内容并进原段落(不劈段);多块走 replaceRange 自己补结构。
 *    目标在生成期间被用户改过(结构指纹对不上:文字、链接地址、图片、marks 任一变了)→ 不盖掉,改为插入下方。
 *  - below:插在目标所在块之后。
 *  - insert(光标模式):光标所在块是空行 → 替换这个空行;否则插在它之后。 */
export function applyAiResult(view: EditorView, target: AiTarget, content: Fragment, how: AiApply): AiApply | null {
  if (!content.childCount) return null
  const { doc } = view.state
  const size = doc.content.size
  const from = Math.min(target.from, size)
  const to = Math.min(Math.max(target.to, from), size)
  let mode: AiApply = how
  if (mode === 'replace' && targetSig(doc, from, to) !== target.sig) mode = 'below'
  let tr = view.state.tr
  let end: number
  if (mode === 'replace') {
    const inline = content.childCount === 1 && !!content.firstChild?.isTextblock && doc.resolve(from).sameParent(doc.resolve(to))
    tr = tr.replaceRange(from, to, inline ? new Slice(content, 1, 1) : new Slice(content, 0, 0))
    end = tr.mapping.map(to, 1)
  } else {
    const b = blockAt(doc, mode === 'below' ? to : from)
    if (!b) return null
    if (mode === 'insert' && b.blank) {
      tr = tr.replaceWith(b.from, b.to, content)
      end = b.from + content.size
    } else {
      tr = tr.insert(b.to, content)
      end = b.to + content.size
    }
  }
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1))
  view.dispatch(tr.setMeta(inlineAiKey, { clear: true } satisfies Meta).scrollIntoView())
  return mode
}
