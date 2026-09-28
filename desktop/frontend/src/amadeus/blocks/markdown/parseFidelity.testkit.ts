// 测试夹具(只给 *.test.ts 用,不进产品):按 MarkdownBlock 里 MilkdownInner 的装配顺序起一个**真** Milkdown,
// 走「磁盘 md → 解析 → PM 文档 → 序列化 → normalizeSerializedMd」这条与落盘同源的链。
// 为什么不测纯函数:D-06 / R-01 / D-12 的病灶都在 preset 的 remark 链里(插件顺序、schema 的 parse/serialize 两侧),
// 纸面看不见;装配顺序抄生产,顺序一错这里就会红。
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { commonmarkWithIndent } from './paragraphIndent'
import { gfmWithAnchoredRules } from './anchoredMarkRules'
import { structuralIndentRemark } from './structuralIndent'
import { cjkFriendlyRemark } from './cjkFriendly'
import { attentionSerializer } from './attentionFlanking'
import { blankLineRemark, softBreakRemark } from './softBreak'
import { calloutTitleRemark } from './callout'
import { normalizeSerializedMd, serializeUnified } from './MarkdownBlock'

export interface Booted {
  view: EditorView
  /** 当前文档按落盘口径序列化(含 normalizeSerializedMd)。 */
  md(): string
  /** v4 整篇落盘口径(D-18:未编辑的顶层块逐字回填,见 ./verbatim)。 */
  saved(): string
  /** 用同一条解析链解析一段 md(粘贴 / 回灌 / 切换文件走的也是 parserCtx)。 */
  parse(md: string): PMNode
  /** 宿主 serializerCtx 的**原始**输出(不经 normalizeSerializedMd):切块 / 剪贴板那条路径自己再规范化。 */
  serialize(node: PMNode): string
  destroy(): Promise<void>
}

/** v3 = 旧 PageView 宿主(mindmap / dashboard)那一套:softBreakRemark 代替 blankLineRemark(MarkdownBlock 的 `unified ? … : …`)。 */
export async function bootEditor(initial: string, opts: { v3?: boolean } = {}): Promise<Booted> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  // ponytail: milkdown 的 Timer(@milkdown/ctx timer.ts)每个起 3s setTimeout 后从不 clearTimeout,到点还裸调 removeEventListener;
  // 测试文件跑完、happy-dom 拆掉全局后才响就是「unhandled error: removeEventListener is not defined」→ 全量绿仍退出码 1。
  // create() 期间起的定时器全记下来,destroy 时一并清(见 parseFidelity.testkit.test)。上游修了就删这段。
  const timers: unknown[] = [] // DOM 与 node 的 setTimeout 声明返回类型不同(number / Timeout),运行时 clearTimeout 两种都认
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    const id = realSetTimeout(fn, ms, ...args)
    timers.push(id)
    return id
  }) as typeof setTimeout
  let ed: Editor
  try {
    ed = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initial)
      })
      .use(commonmarkWithIndent)
      .use(gfmWithAnchoredRules)
      .use(structuralIndentRemark)
      .use(cjkFriendlyRemark)
      .use(attentionSerializer)
      .use(opts.v3 ? softBreakRemark : blankLineRemark)
      .use(calloutTitleRemark)
      .create()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  const view = ed.action((ctx) => ctx.get(editorViewCtx))
  return {
    view,
    md: () => ed.action((ctx) => normalizeSerializedMd(ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))),
    saved: () => ed.action((ctx) => serializeUnified(ctx, ctx.get(editorViewCtx).state.doc)),
    parse: (md) => ed.action((ctx) => ctx.get(parserCtx)(md)) as PMNode,
    serialize: (node) => ed.action((ctx) => ctx.get(serializerCtx)(node)),
    destroy: async () => { await ed.destroy(); for (const t of timers) realClearTimeout(t as number); root.remove() },
  }
}

/** 打开 → 原样存盘(不编辑)。逐字保真 = 返回值 === 输入。 */
export async function roundTrip(md: string, opts: { v3?: boolean } = {}): Promise<string> {
  const b = await bootEditor(md, opts)
  try { return b.md() } finally { await b.destroy() }
}
