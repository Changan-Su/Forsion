/** v4 统一实例的大纲派生:从 ProseMirror doc 里取标题。
 *
 *  ⚠️ 刻意**不**走「读正文文本按行扫 `^#{1,6}`」那条路:围栏代码块里的 `# 注释` 会被算成标题,
 *  于是文本序号与 DOM 里真实的 <h1..h6> 序号对不上 —— 点大纲跳到错的地方。从 doc 里走一遍则
 *  与渲染结果同源,天然对齐(跳转也用同一次遍历产出的 pos)。 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

export interface UnifiedHeading {
  level: number
  text: string
  /** doc 内位置,给跳转用。 */
  pos: number
}

/** 遍历 doc 收标题(标题内部不再下钻)。空标题不进大纲,与 v3 的行扫同口径。 */
export function docHeadings(doc: ProseNode): UnifiedHeading[] {
  const out: UnifiedHeading[] = []
  doc.descendants((n: ProseNode, pos: number) => {
    if (n.type.name !== 'heading') return true
    const raw = Number((n.attrs as { level?: unknown } | undefined)?.level)
    const level = Number.isFinite(raw) ? Math.min(6, Math.max(1, raw)) : 1
    const text = n.textContent.trim()
    if (text) out.push({ level, text, pos })
    return false
  })
  return out
}
