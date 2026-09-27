// 测试夹具(只给 *.test.ts 用,不进产品):按 MarkdownBlock 里 MilkdownInner 的装配顺序起一个**真** Milkdown,
// 走「磁盘 md → 解析 → PM 文档 → 序列化 → normalizeSerializedMd」这条与落盘同源的链。
// 为什么不测纯函数:D-06 / R-01 / D-12 的病灶都在 preset 的 remark 链里(插件顺序、schema 的 parse/serialize 两侧),
// 纸面看不见;装配顺序抄生产,顺序一错这里就会红。
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { gfm } from '@milkdown/kit/preset/gfm'
import { commonmarkWithIndent } from './paragraphIndent'
import { structuralIndentRemark } from './structuralIndent'
import { cjkFriendlyRemark } from './cjkFriendly'
import { attentionSerializer } from './attentionFlanking'
import { blankLineRemark } from './softBreak'
import { calloutTitleRemark } from './callout'
import { normalizeSerializedMd } from './MarkdownBlock'

export interface Booted {
  view: EditorView
  /** 当前文档按落盘口径序列化(含 normalizeSerializedMd)。 */
  md(): string
  /** 用同一条解析链解析一段 md(粘贴 / 回灌 / 切换文件走的也是 parserCtx)。 */
  parse(md: string): PMNode
  destroy(): Promise<void>
}

export async function bootEditor(initial: string): Promise<Booted> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const ed = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, initial)
    })
    .use(commonmarkWithIndent)
    .use(gfm)
    .use(structuralIndentRemark)
    .use(cjkFriendlyRemark)
    .use(attentionSerializer)
    .use(blankLineRemark)
    .use(calloutTitleRemark)
    .create()
  const view = ed.action((ctx) => ctx.get(editorViewCtx))
  return {
    view,
    md: () => ed.action((ctx) => normalizeSerializedMd(ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))),
    parse: (md) => ed.action((ctx) => ctx.get(parserCtx)(md)) as PMNode,
    destroy: async () => { await ed.destroy(); root.remove() },
  }
}

/** 打开 → 原样存盘(不编辑)。逐字保真 = 返回值 === 输入。 */
export async function roundTrip(md: string): Promise<string> {
  const b = await bootEditor(md)
  try { return b.md() } finally { await b.destroy() }
}
