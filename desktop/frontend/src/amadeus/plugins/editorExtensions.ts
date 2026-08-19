// 插件贡献的编辑器扩展(ctx.registerEditorExtension,2026-08-15)。
//
// 为什么单开一个叶子模块而不是塞进 pluginStore:pluginStore → blockSurface → BlockHost →
// MarkdownBlock 是一条既有的 import 链,MarkdownBlock 再回头 import pluginStore 就成环了。
// 这里零依赖 store,写入方(pluginStore)与读取方(MarkdownBlock)各自单向依赖它。
//
// 为什么把 ProseMirror 递给插件:外置插件是 `new Function('ctx', code)` 求值的裸 setup 体,
// **没有 import** —— 自己造不出 `new Plugin({...})`。宿主把自己在用的那一份库递进去,
// 与 Obsidian 把 CodeMirror 递给插件同一招(instanceof / PluginKey 查找都对得上)。

import { prosePluginsCtx, SchemaReady } from '@milkdown/kit/core'
import { Plugin, PluginKey, Selection, TextSelection, NodeSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { Slice, Fragment } from '@milkdown/kit/prose/model'
import { keymap } from '@milkdown/kit/prose/keymap'
import { InputRule, inputRules } from '@milkdown/kit/prose/inputrules'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import type { EditorExtensionFactory, EditorExtensionOptions, PmToolkit } from './types'

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
interface Entry { pluginId: string; factory: EditorExtensionFactory }

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

export function addEditorExtension(pluginId: string, factory: EditorExtensionFactory, opts?: EditorExtensionOptions): void {
  if (typeof factory !== 'function') {
    console.warn(`[plugin:${pluginId}] registerEditorExtension 需要一个函数`)
    return
  }
  registry[opts?.priority === 'high' ? 'high' : 'normal'].push({ pluginId, factory })
  bump()
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

/** 注册表代次:变了说明扩展集合变了,已建好的编辑器必须重建才能跟上(见 MarkdownBlock 的 useEditor deps)。 */
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

/** 一个 MilkdownPlugin 装下全部插件贡献 —— `$prose` 一次只收一个 ProseMirror 插件,
 *  而工厂返回的是数组且个数事先不知道,所以照它的写法自己来一份(等 SchemaReady → 推进
 *  prosePluginsCtx → 卸载时按引用摘掉)。工厂**每个编辑器实例调一次**:一篇 v3 笔记是很多个
 *  小编辑器,各拿各的插件实例,免得插件把每编辑器状态挂在共享的 Plugin 对象上。 */
export function pluginEditorExtensions(bucket: Bucket = 'normal'): MilkdownPlugin {
  const plugin = (ctx: Ctx) => async () => {
    await ctx.wait(SchemaReady)
    const made: Plugin[] = []
    for (const { pluginId, factory } of registry[bucket]) {
      try {
        const out = factory(PM)
        if (Array.isArray(out)) {
          for (const p of out) if (p instanceof Plugin) made.push(guardProps(p, `插件 ${pluginId}`))
        }
      } catch (e) {
        // 工厂本身抛错只废掉这一份扩展,编辑器照常建起来。
        console.error(`[amadeus] 插件 ${pluginId} 的 registerEditorExtension 工厂抛错(已跳过)`, e)
      }
    }
    if (!made.length) return () => {}
    // high 桶插到最前(它的注入点在 `.use()` 链首,此刻 ps 基本是空的,但 unshift 语义保证
    // 后续宿主插件一律排在它后面);normal 桶追加在尾部。
    ctx.update(prosePluginsCtx, (ps) => (bucket === 'high' ? [...made, ...ps] : [...ps, ...made]))
    return () => {
      ctx.update(prosePluginsCtx, (ps) => ps.filter((x) => !made.includes(x as Plugin)))
    }
  }
  return plugin as MilkdownPlugin
}
