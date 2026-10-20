/** 笔记的拼写检查(评审 G4-07)。
 *
 *  此前:可视模式整篇恒开拼写检查(Chromium 缺省),代码块、行内代码、公式源码里的标识符 / 命令名满屏红波浪线;
 *  源码模式的 textarea 却恒关 —— 两种编辑模式口径相反,设置里也没有开关。
 *  现在:①一个本机开关(设置 → 笔记,缺省开),可视正文、标题框、源码 textarea 都跟它走;②代码类内容恒不查 ——
 *  代码块在 NodeView 的 `<pre>` 上关(codeBlock.ts),行内代码与公式源码由本插件打 `spellcheck=false` 装饰。
 *  源码模式是一整块 textarea,分不出哪段是代码:只能整体跟开关(Obsidian 源码模式同样整篇查)。
 *  Electron 认 DOM 的 spellcheck 属性(macOS 走系统拼写服务),主进程不用配合;更正建议走系统右键菜单(G4-08)。 */
import { useSyncExternalStore } from 'react'
import { $prose } from '@milkdown/kit/utils'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state'
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@milkdown/kit/prose/transform'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { buildBlockString, scanMath } from './mathLivePreview'
import { registerMessages } from '../../../i18n'

registerMessages({
  'settings.notes.spellcheckLabel': { zh: '拼写检查', en: 'Spell check' },
  'settings.notes.spellcheckHint': {
    zh: '在笔记正文、标题和源码模式里标出拼写错误。代码块、行内代码和公式始终不检查。',
    en: 'Underline misspellings in note text, titles, and source mode. Code blocks, inline code, and formulas are never checked.',
  },
})

const PREF_KEY = 'amadeus.notes.spellcheck'
const PREF_EVENT = 'amadeus:notes-spellcheck'

/** 缺省开;只把显式的 `0` 当关(老用户无需迁移)。 */
export function notesSpellcheckEnabled(): boolean {
  try { return localStorage.getItem(PREF_KEY) !== '0' } catch { return true }
}

export function setNotesSpellcheckEnabled(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? '1' : '0') } catch { /* 私有模式:本次会话照样切 */ }
  // 设置页与编辑器同窗:`storage` 事件只跨窗口发,自己广播一枚,开着的编辑器当场跟上。
  try { window.dispatchEvent(new Event(PREF_EVENT)) } catch { /* 非浏览器环境 */ }
}

export function onNotesSpellcheckChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent): void => { if (!e.key || e.key === PREF_KEY) fn() }
  window.addEventListener(PREF_EVENT, fn)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PREF_EVENT, fn)
    window.removeEventListener('storage', onStorage)
  }
}

/** React 侧读开关(标题框 / 源码 textarea / 设置页),切换即重渲。 */
export function useNotesSpellcheck(): boolean {
  return useSyncExternalStore(onNotesSpellcheckChange, notesSpellcheckEnabled, () => true)
}

const OFF = { spellcheck: 'false' }

/** 行内代码与公式源码的「不查」装饰。代码块整块跳过(它的 `<pre>` 已关,里面的 `$` 也不是公式)。
 *  公式跨度与实况预览同一份认法(buildBlockString + scanMath:代码文本已抹成空格,不会把代码里的 `$` 认成公式)。 */
function codeDecosIn(doc: ProseNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false
    const start = pos + 1
    node.forEach((child, offset) => {
      if (child.isText && child.marks.some((m) => m.type.spec.code || m.type.name === 'inlineCode')) {
        decos.push(Decoration.inline(start + offset, start + offset + child.nodeSize, OFF))
      }
    })
    if (node.textContent.includes('$')) {
      for (const sp of scanMath(buildBlockString(node))) decos.push(Decoration.inline(start + sp.from, start + sp.to, OFF))
    }
    return false
  })
  return decos
}

export function codeRanges(doc: ProseNode): DecorationSet {
  const decos = codeDecosIn(doc, 0, doc.content.size)
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty
}

/** 文档改了:旧装饰按 mapping 挪过来,只重扫改动落在的顶层块。整篇重扫 + 重建装饰集在 3000 块的笔记里每打一个字约 6ms(10-16 实测)。
 *  只认打字 / 删改文字(ReplaceStep)和加 / 去标记(不挪位置、StepMap 是空的,范围取步骤自己的 from/to),别的步骤整篇重建。 */
export function updateCodeRanges(tr: Transaction, old: DecorationSet): DecorationSet {
  const doc = tr.doc
  // 包进 / 移出引用、列表这类结构性步骤(ReplaceAroundStep 等)整篇重建:映射过去的装饰会叠出重复、删不干净
  if (!tr.steps.every((st) => st instanceof ReplaceStep || st instanceof AddMarkStep || st instanceof RemoveMarkStep)) return codeRanges(doc)
  const dirty: Array<[number, number]> = []
  for (let i = 0; i < tr.steps.length; i++) {
    const rest = tr.mapping.slice(i + 1)
    const before = dirty.length
    tr.mapping.maps[i].forEach((_oldFrom, _oldTo, from, to) => { dirty.push([rest.map(from, -1), rest.map(to, 1)]) })
    if (dirty.length > before) continue
    const st = tr.steps[i] as unknown as { from: number; to: number } // 加 / 去标记不挪位置,StepMap 是空的
    dirty.push([rest.map(st.from, -1), rest.map(st.to, 1)])
  }
  let set = old.map(tr.mapping, doc)
  for (const [from, to] of dirty) {
    const $a = doc.resolve(Math.min(from, doc.content.size))
    const $b = doc.resolve(Math.min(to, doc.content.size))
    const a = $a.depth ? $a.before(1) : $a.pos
    const b = $b.depth ? $b.after(1) : $b.pos
    set = set.remove(set.find(a, b)).add(doc, codeDecosIn(doc, a, b))
  }
  return set
}

const spellKey = new PluginKey<DecorationSet>('amadeus-spellcheck')

export const spellcheckPlugin = $prose(() => new Plugin<DecorationSet>({
  key: spellKey,
  state: {
    init: (_, state) => codeRanges(state.doc),
    // 只在文档变了时重扫(纯选区事务零成本,perf:codeblock 那条护栏不受影响)。
    apply: (tr, old) => (tr.docChanged ? updateCodeRanges(tr, old) : old),
  },
  props: {
    decorations: (state) => spellKey.getState(state),
    // 根上的开关:子节点继承,代码类装饰 / 代码块 `<pre>` 的 false 压过它。
    attributes: () => ({ spellcheck: notesSpellcheckEnabled() ? 'true' : 'false' }),
  },
  // 设置页切开关:按现有 state 重算一次 attributes(与 UnifiedPage 缩进档位同一手法,不发空事务)。
  view: (view) => ({ destroy: onNotesSpellcheckChange(() => view.updateState(view.state)) }),
}))
