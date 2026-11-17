/**
 * remark-math 的同款插件,只把 micromark 那层换成 micromark-extension-llm-math(MIT,micromark-extension-math 的分叉,
 * 借鉴 DeepSeek chat-demo ⑦):除了 $…$ / $$…$$,还直接认模型常写的 \(…\) 与 \[…\]。
 * 以前是渲染前用正则把 \( \[ 改写成 $ —— 会改坏代码块(未闭合的围栏、~~~ 围栏、缩进代码)和 \\( 转义,段落里跨行的 \[ 也认不出。
 * 现在由解析器按 CommonMark 规则认:代码里的原样、\\( 是字面的「\(」、流式时没闭合的公式先按普通文字显示。
 * 不用 README 里的 vite alias:那会连带改掉编辑器那边的 micromark-extension-math。
 *
 * ⚠️ 只用分叉的行内(text)那半;它的块级 \[(flow,字符码 92)有三处毛病(Codex 11-17 评审)——收尾判断先吞一个字符再看是不是 `]`
 *   (公式里一行以 `]` 结尾就被当成收尾,内容丢掉)、`\[x\] 后面还有字` 会把后面整段吞进公式、没闭合的 `\[` 流式时一路渲染成报错 ——
 *   换成自己的严格版 texMathFlow.ts:`\[`、`\]` 各自独占一行才算块公式,中间的列表 / 标题样的行都是公式内容。
 *   单行的 `\[x\]` 独占一段时由 promoteDisplayMath(markdownParse 解析后)升成块公式,和 $$ 块一样居中、带复制键。
 */
import { mathFromMarkdown, mathToMarkdown, type ToOptions } from 'mdast-util-math'
import { math } from 'micromark-extension-llm-math'
import { texMathFlow } from './texMathFlow'
import type { Processor } from 'unified'
import type { Paragraph, Parent, Root, RootContent } from 'mdast'

export default function remarkLlmMath(this: Processor, options?: Readonly<ToOptions> | null): undefined {
  const settings = options || {}
  const data = this.data() as Record<string, unknown[] | undefined>
  const ext = math(settings) as { flow?: Record<number, unknown> }
  if (ext.flow) ext.flow[92] = texMathFlow // 见文件头:块级 \[ 换成自己的严格版(texMathFlow.ts)
  ;(data.micromarkExtensions ||= []).push(ext)
  ;(data.fromMarkdownExtensions ||= []).push(mathFromMarkdown())
  ;(data.toMarkdownExtensions ||= []).push(mathToMarkdown(settings))
}

/** 段落里只有一个由 `\[` 起头的公式(前后只有空白)→ 换成块公式节点(形状同 mdast-util-math 的 math)。就地改树。 */
export function promoteDisplayMath(tree: Root, source: string): void {
  const visit = (parent: Parent): void => {
    parent.children.forEach((child, i) => {
      if (child.type === 'paragraph') {
        const node = displayOf(child, source)
        if (node) parent.children[i] = node as RootContent
        return
      }
      if ('children' in child) visit(child as Parent)
    })
  }
  visit(tree)
}

function displayOf(p: Paragraph, source: string): RootContent | null {
  const kids = p.children.filter((c) => !(c.type === 'text' && !c.value.trim()))
  const m = kids.length === 1 ? kids[0] : null
  if (!m || m.type !== 'inlineMath' || m.position?.start.offset === undefined) return null
  if (source.slice(m.position.start.offset, m.position.start.offset + 2) !== '\\[') return null
  const value = m.value.replace(/^\s*\n|\n\s*$/g, '')
  return {
    type: 'math', meta: null, value, position: p.position,
    data: { hName: 'pre', hChildren: [{ type: 'element', tagName: 'code', properties: { className: ['language-math', 'math-display'] }, children: [{ type: 'text', value }] }] },
  } as unknown as RootContent
}
