// 插件贡献的编辑器扩展(ctx.registerEditorExtension,2026-08-15)。
//
// 为什么单开一个叶子模块而不是塞进 pluginStore:pluginStore → blockSurface → BlockHost →
// MarkdownBlock 是一条既有的 import 链,MarkdownBlock 再回头 import pluginStore 就成环了。
// 这里零依赖 store,写入方(pluginStore)与读取方(MarkdownBlock)各自单向依赖它。
//
// 为什么把 ProseMirror 递给插件:外置插件是 `new Function('ctx', code)` 求值的裸 setup 体,
// **没有 import** —— 自己造不出 `new Plugin({...})`。宿主把自己在用的那一份库递进去,
// 与 Obsidian 把 CodeMirror 递给插件同一招(instanceof / PluginKey 查找都对得上)。

import { editorStateCtx, editorViewCtx, EditorViewReady, prosePluginsCtx, SchemaReady } from '@milkdown/kit/core'
import { Plugin, PluginKey, Selection, TextSelection, NodeSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Slice, Fragment } from '@milkdown/kit/prose/model'
import { keymap } from '@milkdown/kit/prose/keymap'
import { InputRule, inputRules } from '@milkdown/kit/prose/inputrules'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import type { EditorExtensionContext, EditorExtensionFactory, EditorExtensionOptions, PmToolkit } from './types'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'edext.failed': {
    zh: '插件「{name}」的编辑器扩展出错，已停用这部分功能。笔记内容不受影响。',
    en: 'The editor extension from plugin "{name}" failed and was turned off. Your notes are unaffected.',
  },
})

const PM: PmToolkit = {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  NodeSelection,
  Decoration,
  DecorationSet,
  Slice,
  Fragment,
  keymap,
  InputRule,
  inputRules,
}

type Bucket = 'high' | 'normal'
interface Entry {
  pluginId: string
  factory: EditorExtensionFactory
  /** 插件展示名(提示用;宿主给,缺省用 id)。 */
  name?: () => string
  /** 已隔离(评审 G1-07):它的 state.init / 插件视图抛过错 —— 本次注册从此不再装进任何编辑器,直到插件重载(新注册)。 */
  faulted?: boolean
}

/** 两个桶:high 排在宿主全部插件之前(能抢 Tab 这类已被占用的键),normal 排在之后。
 *  各自一个注入点(见 MarkdownBlock 的 `.use()` 链首尾),顺序才是确定的 —— 靠「谁先 push 进
 *  prosePluginsCtx」来定优先级是碰运气,milkdown 的插件是并发 await SchemaReady 的。 */
const registry: Record<Bucket, Entry[]> = { high: [], normal: [] }
let gen = 0
const listeners = new Set<() => void>()

function bump(): void {
  gen++
  for (const l of Array.from(listeners)) {
    try { l() } catch (e) { console.error('[amadeus] editor-extension listener failed', e) }
  }
}

export function addEditorExtension(pluginId: string, factory: EditorExtensionFactory, opts?: EditorExtensionOptions, name?: () => string): void {
  if (typeof factory !== 'function') {
    console.warn(`[plugin:${pluginId}] registerEditorExtension 需要一个函数`)
    return
  }
  registry[opts?.priority === 'high' ? 'high' : 'normal'].push({ pluginId, factory, name })
  bump()
}

/** 活着的注册(隔离掉的不算)。 */
const liveEntries = (bucket: Bucket): Entry[] => registry[bucket].filter((e) => !e.faulted)

/** 隔离一条注册(评审 G1-07):一次提示点名是哪个插件,然后让所有编辑器原地重配把它摘掉。
 *  重配推到微任务:这里可能正跑在某次 EditorState.create / reconfigure 的 init 里,当场重入会在旧状态上再配一遍。 */
function quarantine(e: Entry, err: unknown): void {
  if (e.faulted) return
  e.faulted = true
  console.error(`[amadeus] 插件 ${e.pluginId} 的编辑器扩展抛错,已停用这份扩展`, err)
  const name = (() => { try { return e.name?.() || e.pluginId } catch { return e.pluginId } })()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('amadeus:toast', {
      detail: { level: 'error', dedupeKey: `amx-edext:${e.pluginId}`, text: translate('edext.failed', { name }) },
    }))
  }
  queueMicrotask(bump)
}

/** 隔离 state.init 与插件视图(评审 G1-07)。
 *  - init 抛错:此前 EditorState.create 整个失败 → **所有笔记正文空白**、零提示。现在这份扩展的这个插件拿 undefined 当状态
 *    建起来,随即隔离、重配摘掉;在被摘掉之前它的 apply 原样传值(它已经废了,不再跑它的代码)。
 *    ⚠️ 这**不是**给 apply 做隔离:健康插件的 apply 照旧不包(吞掉状态迁移的异常 = 放任状态损坏,既定决策)。
 *  - spec.view 抛错:此前 PM 建插件视图的循环当场中断,排在它后面的宿主插件视图(块把手、大纲、insertMarkdown 依赖的
 *    视图登记)全都没建 → 编辑器「半死」。现在给它一个空视图、隔离;视图的 update / destroy 抛错同样隔离。 */
function guardLifecycle(p: Plugin, e: Entry): Plugin {
  const spec = p.spec as { state?: { init: (...a: unknown[]) => unknown; apply: (...a: unknown[]) => unknown }; view?: (view: EditorView) => { update?: (...a: unknown[]) => void; destroy?: () => void } }
  const field = spec.state
  if (field && typeof field.init === 'function' && typeof field.apply === 'function') {
    const init = field.init
    const apply = field.apply
    let dead = false
    field.init = function (this: unknown, ...a: unknown[]) {
      try {
        return init.apply(this, a)
      } catch (err) {
        dead = true
        quarantine(e, err)
        return undefined
      }
    }
    field.apply = function (this: unknown, ...a: unknown[]) {
      return dead ? a[1] : apply.apply(this, a)
    }
  }
  const view = spec.view
  if (typeof view === 'function') {
    spec.view = function (this: unknown, ev: EditorView) {
      let pv: { update?: (...a: unknown[]) => void; destroy?: () => void } | undefined
      try {
        pv = view.call(this, ev)
      } catch (err) {
        quarantine(e, err)
        return {}
      }
      if (!pv) return {}
      const inner = pv
      return {
        update: inner.update ? (...a: unknown[]) => {
          try { inner.update!.apply(inner, a) } catch (err) { quarantine(e, err) }
        } : undefined,
        destroy: inner.destroy ? () => {
          try { inner.destroy!.call(inner) } catch (err) { console.error(`[amadeus] 插件 ${e.pluginId} 的编辑器扩展视图 destroy 抛错(已隔离)`, err) }
        } : undefined,
      }
    }
  }
  return p
}

/** 插件停用/重载时整体摘除(与其余 contribution 切片同一条 teardown 纪律)。 */
export function clearEditorExtensions(pluginId: string): void {
  let hit = false
  for (const b of ['high', 'normal'] as const) {
    const next = registry[b].filter((e) => e.pluginId !== pluginId)
    if (next.length !== registry[b].length) { registry[b] = next; hit = true }
  }
  if (hit) bump()
}

/** 注册表代次:变了说明扩展集合变了。已建好的编辑器**原地重配**跟上(见 pluginEditorExtensions 的 reconfigure),
 *  不再整实例重建(评审 G1-06)。 */
export function editorExtensionGen(): number {
  return gen
}

export function subscribeEditorExtensions(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 把第三方插件的 props 处理器包一层 try/catch。
 *
 *  只包 `props`(handleKeyDown / handleTextInput / decorations 这些**每次按键都跑第三方代码**的热路径):
 *  那里抛一次就是整个编辑器不可用。**刻意不包 `state.apply`** —— 状态迁移吞了异常等于放任状态损坏,
 *  比当场炸掉更难查。props 是 Plugin 构造时由 bindProps 绑好的对象,原地换掉即可(this 已绑,包装层
 *  调的是绑过的函数)。 */
function guardProps(p: Plugin, tag: string): Plugin {
  const props = p.props as unknown as Record<string, unknown>
  if (!props) return p
  for (const k of Object.keys(props)) {
    const fn = props[k]
    if (typeof fn !== 'function') continue
    const orig = fn as (...a: unknown[]) => unknown
    props[k] = (...a: unknown[]): unknown => {
      try {
        return orig(...a)
      } catch (e) {
        console.error(`[amadeus] ${tag} 的编辑器扩展在 props.${k} 抛错(已隔离)`, e)
        return undefined // handleX → falsy = 未处理;decorations → 本轮无装饰
      }
    }
  }
  return p
}

/** 一条注册 → 它这次造出来的 PM 插件(工厂抛错 / 返回非数组 = 空,编辑器照常建起来)。 */
function buildEntry(e: Entry, context: EditorExtensionContext): Plugin[] {
  const made: Plugin[] = []
  try {
    const out = e.factory(PM, context)
    if (Array.isArray(out)) {
      for (const p of out) if (p instanceof Plugin) made.push(guardLifecycle(guardProps(p, `插件 ${e.pluginId}`), e))
    }
  } catch (err) {
    // 工厂本身抛错只废掉这一份扩展,编辑器照常建起来。
    console.error(`[amadeus] 插件 ${e.pluginId} 的 registerEditorExtension 工厂抛错(已跳过)`, err)
  }
  return made
}

/** 一个 MilkdownPlugin 装下全部插件贡献 —— `$prose` 一次只收一个 ProseMirror 插件,
 *  而工厂返回的是数组且个数事先不知道,所以照它的写法自己来一份(等 SchemaReady → 推进
 *  prosePluginsCtx → 卸载时按引用摘掉)。工厂**每个编辑器实例调一次**:一篇 v3 笔记是很多个
 *  小编辑器,各拿各的插件实例,免得插件把每编辑器状态挂在共享的 Plugin 对象上。
 *
 *  插件启停 / 重载(评审 G1-06):**原地重配**(`state.reconfigure`),不重建编辑器。此前注册表代次挂在
 *  useEditor 的 deps 与 UnifiedPage 的 key 上 → 整实例 destroy + create:焦点、撤销栈、最近 ~200ms 的输入
 *  (listener 防抖窗里的字)全丢,输入法组字中重建还把没上屏的拼音写进盘。Obsidian 同理用 Compartment 就地重配。
 *  - 顺序:本桶在插件序列里的位置由一个空的**锚插件**钉住(建编辑器时与扩展一起推进去),重配时新扩展插在锚后面 ——
 *    high 仍在宿主全部插件之前,normal 仍在 Milkdown 的状态跟踪 / 输入规则 / 基础 keymap 之前(按键优先级不变)。
 *  - 只重建**变了的**注册:别的插件那份扩展的插件实例(连同它的插件状态)原样保留。
 *  - 组字中推迟到 compositionend(换插件表会重建全部插件视图,不在输入法组字中间动)。
 *  - Milkdown 自己记着的 editorStateCtx / prosePluginsCtx 一并换成新的(它的状态跟踪只在 apply 时更新)。
 *  - 插件表一变 PM 会重建**全部**插件视图,Milkdown 的视图容器插件会把编辑器 DOM 摘下再挂回 → 原来有焦点就还回去。 */
export function pluginEditorExtensions(bucket: Bucket = 'normal', context: EditorExtensionContext = { pagePath: () => undefined }): MilkdownPlugin {
  const plugin = (ctx: Ctx) => async () => {
    await ctx.wait(SchemaReady)
    let built = new Map<Entry, Plugin[]>()
    for (const e of liveEntries(bucket)) built.set(e, buildEntry(e, context))
    const flat = (m: Map<Entry, Plugin[]>): Plugin[] => [...m.values()].flat()
    const anchor = new Plugin({})
    // high 桶插到最前(它的注入点在 `.use()` 链首,此刻 ps 基本是空的,但前插语义保证
    // 后续宿主插件一律排在它后面);normal 桶追加在尾部。
    ctx.update(prosePluginsCtx, (ps) => (bucket === 'high' ? [anchor, ...flat(built), ...ps] : [...ps, anchor, ...flat(built)]))
    let disposed = false
    let waitingCompose = false
    const reconfigure = (): void => {
      if (disposed || waitingCompose) return
      let view: EditorView | undefined
      try { view = ctx.get(editorViewCtx) } catch { view = undefined }
      if (!view?.state || view.isDestroyed) {
        // 编辑器视图还没建好(建编辑器的中途注册表变了):建好了再对一次账。
        void ctx.wait(EditorViewReady).then(() => { if (!disposed) reconfigure() }, () => {})
        return
      }
      const v = view
      if (v.composing) {
        waitingCompose = true
        const done = (): void => {
          v.dom.removeEventListener('compositionend', done)
          waitingCompose = false
          setTimeout(reconfigure, 0) // compositionend 之后 PM 还要把组字结果落进 state
        }
        v.dom.addEventListener('compositionend', done)
        return
      }
      const entries = liveEntries(bucket)
      const same = entries.length === built.size && entries.every((e) => built.has(e))
      if (same) return
      const next = new Map<Entry, Plugin[]>()
      for (const e of entries) next.set(e, built.get(e) ?? buildEntry(e, context))
      const old = flat(built)
      const plugins = v.state.plugins.filter((p) => !old.includes(p))
      const at = plugins.indexOf(anchor)
      if (at < 0) return
      plugins.splice(at + 1, 0, ...flat(next))
      const hadFocus = v.hasFocus()
      const state = v.state.reconfigure({ plugins })
      built = next
      v.updateState(state)
      ctx.set(editorStateCtx, state)
      ctx.set(prosePluginsCtx, [...state.plugins])
      if (hadFocus && !v.hasFocus()) v.focus()
      // Milkdown 的 listener 在插件视图 destroy 时 cancel 了它 200ms 的防抖:刚打的字(或刚上屏的组字结果)
      // 还没交给宿主的 onChange 就被吞了。补一笔零步骤事务(只设 storedMarks)重新挂上防抖 —— 它按「上次交出去的 doc」
      // 比对,真有没交出去的改动才触发;没有就什么都不发。零步骤 = 不进撤销栈。
      v.dispatch(v.state.tr.setStoredMarks(v.state.storedMarks))
    }
    const off = subscribeEditorExtensions(reconfigure)
    return () => {
      disposed = true
      off()
      const mine = [anchor, ...flat(built)]
      ctx.update(prosePluginsCtx, (ps) => ps.filter((x) => !mine.includes(x as Plugin)))
    }
  }
  return plugin as MilkdownPlugin
}
