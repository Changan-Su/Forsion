/**
 * remark-math 的同款插件,只把 micromark 那层换成 micromark-extension-llm-math(MIT,micromark-extension-math 的分叉,
 * 借鉴 DeepSeek chat-demo ⑦):除了 $…$ / $$…$$,还直接认模型常写的 \(…\) 与 \[…\]。
 * 以前是渲染前用正则把 \( \[ 改写成 $ —— 会改坏代码块(未闭合的围栏、~~~ 围栏、缩进代码)和 \\( 转义,段落里跨行的 \[ 也认不出。
 * 现在由解析器按 CommonMark 规则认:代码里的原样、\\( 是字面的「\(」、流式时没闭合的公式先按普通文字显示。
 * 不用 README 里的 vite alias:那会连带改掉编辑器那边的 micromark-extension-math。
 */
import { mathFromMarkdown, mathToMarkdown, type ToOptions } from 'mdast-util-math'
import { math } from 'micromark-extension-llm-math'
import type { Processor } from 'unified'

export default function remarkLlmMath(this: Processor, options?: Readonly<ToOptions> | null): undefined {
  const settings = options || {}
  const data = this.data() as Record<string, unknown[] | undefined>
  ;(data.micromarkExtensions ||= []).push(math(settings))
  ;(data.fromMarkdownExtensions ||= []).push(mathFromMarkdown())
  ;(data.toMarkdownExtensions ||= []).push(mathToMarkdown(settings))
}
