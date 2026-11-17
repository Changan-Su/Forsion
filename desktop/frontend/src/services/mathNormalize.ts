/**
 * 把 LLM 常输出的 \(…\) / \[…\] 定界符改成 $…$ / $$…$$ —— 插进笔记时用(笔记编辑器只认 $ 系)。
 * 聊天渲染不再经过这里:解析器(components/remarkLlmMath)直接认 \( \[。
 *
 * 认哪些由同一个解析器说了算(11-17 起,借鉴 DeepSeek chat-demo ⑦):先解析,只改解析器认成公式、且源文确实以 \( / \[ 开头的
 * 那几段的定界符,公式内容和所在的列表 / 引用前缀原样不动。以前的正则会改坏代码块(未闭合围栏、~~~、缩进代码)和 \\( 转义。
 */
import { parseMarkdown } from '../components/markdownParse'

type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }

export function normalizeMath(src: string): string {
  if (!src.includes('\\(') && !src.includes('\\[')) return src // 快路径:绝大多数文本零成本
  const edits: Array<{ at: number; len: number; text: string }> = []
  const walk = (n: Node): void => {
    if ((n.type === 'inlineMath' || n.type === 'math') && n.position) {
      const a = n.position.start.offset, b = n.position.end.offset
      if (a !== undefined && b !== undefined) {
        const open = src.slice(a, a + 2), close = src.slice(b - 2, b)
        const pair = open === '\\(' && close === '\\)' ? '$' : open === '\\[' && close === '\\]' ? '$$' : ''
        if (pair && b - a >= 4) edits.push({ at: a, len: 2, text: pair }, { at: b - 2, len: 2, text: pair })
      }
    }
    for (const c of n.children || []) walk(c)
  }
  walk(parseMarkdown(src) as unknown as Node)
  let out = src
  for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len)
  return out
}
