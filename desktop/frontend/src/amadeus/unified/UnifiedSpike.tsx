// ── v4 统一实例 spike(spec §9 step 1,2026-08-13)──────────────────────────────
// 证明目标:整篇一个 Milkdown/ProseMirror 实例能扛住三个最难子系统 ——
//   ① 外部回灌 × 打字互斥:回灌 = 同实例内的事务(不再销毁重建编辑器,输入法/防抖不死),
//      押后语义沿用 typingGuard(组合中/静默窗内不动手);
//   ② callout 折叠:calloutPlugin **原样整只带入**;唯一语义修正 = 「本块失焦收回源码态」
//      在单实例下改为「光标离开该 callout 收回」(srcAtExitPlugin,只收不露,不触碰
//      「光标在标题行就露」那条栽过两次的雷);
//   ③ 键位:不拦 Enter/Shift+Enter → PM 原生 = Notion 语义(Enter 分段/Shift+Enter 硬换行),
//      且**不挂 softBreakRemark** = 标准 markdown 分段落盘(spec §3.4)。
// 刻意不含:slash 菜单/wikilink/嵌入 widget/分栏/拖把手/保存管线 —— spike 只回答架构问题。
// 仪器:node scripts/e2e-editor.cjs --check=unified-spike
import { useEffect, type ReactElement } from 'react'
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { $prose } from '@milkdown/kit/utils'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { bgSchema, colorSchema, inlineHtmlMarksRemark, underlineSchema } from '../blocks/markdown/marks'
import { calloutKey, calloutPlugin, unescapeCalloutToken } from '../blocks/markdown/callout'
import { taskCheckboxPlugin } from '../blocks/markdown/taskList'
import { awaitTypingQuiet, installTypingGuard } from '../store/typingGuard'

// ── 探针(Playwright 断言面)────────────────────────────────────────────────────
interface RoundTrip {
  out: string
  parasIn: number
  breaksIn: number
  parasOut: number
  breaksOut: number
}
interface UnifiedProbe {
  /** 编辑器最近一次序列化出的 md(已过 unescapeCalloutToken,与落盘形态一致)。 */
  md: string
  /** SpikeInner 真实挂载次数(effect 计数,StrictMode 双渲染不虚计)。回灌后必须仍是 1。 */
  mounts: number
  reconciled: number
  reconcilePending: boolean
  /** 外部回灌:等打字静默后,以**事务**整文替换(绝不重挂实例),光标就近保留。 */
  reconcile(md: string): Promise<void>
  /** §3.4 编码证据探针:md → doc → md → doc,数段落/硬换行的存活。 */
  breakRoundTrip(md: string): RoundTrip | null
}
const probe: UnifiedProbe = {
  md: '',
  mounts: 0,
  reconciled: 0,
  reconcilePending: false,
  reconcile: async () => {},
  breakRoundTrip: () => null,
}
;(window as unknown as { __unified: UnifiedProbe }).__unified = probe

// ── 单实例下的 srcAt 收回规则 ─────────────────────────────────────────────────
// 已知接受的边角:单击**另一个** callout 的标题行 = 切折叠但不放光标(handleClick 契约),
// 选区没动 → 前一个的源码态保持点亮,直到光标真正移动。只收不露,安全侧。
const exitKey = new PluginKey('unified-callout-src-exit')
const srcAtExitPlugin = () =>
  $prose(
    () =>
      new Plugin({
        key: exitKey,
        appendTransaction(trs, _old, state) {
          if (!trs.some((tr) => tr.selectionSet)) return null
          const src = calloutKey.getState(state)?.srcAt
          if (src == null) return null
          const node = state.doc.nodeAt(src)
          const from = state.selection.from
          const inside = node != null && from > src && from < src + node.nodeSize
          return inside ? null : state.tr.setMeta(calloutKey, { srcAt: null })
        },
      }),
  )

function countDoc(doc: ProseNode): { paras: number; breaks: number } {
  let paras = 0
  let breaks = 0
  doc.descendants((n) => {
    if (n.type.name === 'paragraph') paras++
    if (n.type.name === 'hardbreak') breaks++
    return true
  })
  return { paras, breaks }
}

function SpikeInner({ initial }: { initial: string }): ReactElement {
  const [, getInstance] = useInstance()

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initial)
        ctx.get(listenerCtx).markdownUpdated((_c, md) => {
          probe.md = unescapeCalloutToken(md)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(inlineHtmlMarksRemark)
      .use(underlineSchema)
      .use(colorSchema)
      .use(bgSchema)
      .use(history)
      .use(listener)
      .use(taskCheckboxPlugin())
      .use(calloutPlugin())
      .use(srcAtExitPlugin()),
  )

  useEffect(() => {
    installTypingGuard(document)
    probe.mounts += 1
    probe.md = initial
  }, [initial])

  useEffect(() => {
    probe.reconcile = async (nextMd: string) => {
      probe.reconcilePending = true
      try {
        await awaitTypingQuiet()
        getInstance()?.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const doc = ctx.get(parserCtx)(nextMd)
          if (!doc) return
          const { state } = view
          const selFrom = state.selection.from
          let tr = state.tr.replaceWith(0, state.doc.content.size, doc.content)
          // 光标就近保留(spike 级:整文替换+位置钳制;生产要位置映射的最小差异事务)。
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(selFrom, tr.doc.content.size))))
          view.dispatch(tr)
          probe.reconciled += 1
        })
      } finally {
        probe.reconcilePending = false
      }
    }
    probe.breakRoundTrip = (mdIn: string) => {
      let res: RoundTrip | null = null
      getInstance()?.action((ctx) => {
        const parse = ctx.get(parserCtx)
        const serialize = ctx.get(serializerCtx)
        const docA = parse(mdIn)
        if (!docA) return
        const out = serialize(docA)
        const docB = parse(out)
        if (!docB) return
        const a = countDoc(docA)
        const b = countDoc(docB)
        res = { out, parasIn: a.paras, breaksIn: a.breaks, parasOut: b.paras, breaksOut: b.breaks }
      })
      return res
    }
  }, [getInstance])

  return <Milkdown />
}

const DEFAULT_SEED = [
  '# 演示标题',
  '',
  '第一段甲。',
  '',
  '第二段乙。',
  '',
  '> [!note]+ 折叠标题',
  '> 内容一',
  '> 内容二',
  '',
  '第三段丙。',
  '',
].join('\n')

export function UnifiedSpikeHarness(): ReactElement {
  const seed = new URLSearchParams(location.search).get('useed') ?? DEFAULT_SEED
  return (
    <div className="amadeus-root am-app unified-spike" style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <MilkdownProvider>
        <SpikeInner initial={seed} />
      </MilkdownProvider>
    </div>
  )
}
