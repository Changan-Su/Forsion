/**
 * Markdown 渲染(react-markdown + GFM + highlight.js;代码块带复制按钮)。
 * 高亮配色在 base.css 用主题 token 写(.hljs-*),不引第三方主题 CSS。
 */
import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Copy, Check } from 'lucide-react'
import { useI18n } from '../i18n'
import { normalizeMath } from '../services/mathNormalize'

const CodeBlock: React.FC<React.HTMLAttributes<HTMLPreElement>> = ({ children, ...props }) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const preRef = React.useRef<HTMLPreElement>(null)
  const copy = () => {
    const text = preRef.current?.innerText ?? ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre ref={preRef} {...props}>{children}</pre>
      <button
        className="icon-btn"
        onClick={copy}
        title={t('common.copyCode')}
        style={{ position: 'absolute', top: 6, right: 6, width: 24, height: 24 }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

/**
 * anchorPrefix:传入时给 h1/h2/h3 渲染稳定 id(`${anchorPrefix}-${第n个标题}`)+ data-toc-level,
 * 供右侧「目录」扫描跳转。不传则零影响(记忆/日志面板等普通渲染)。
 */
export const Markdown: React.FC<{ content: string; anchorPrefix?: string }> = React.memo(
  ({ content, anchorPrefix }) => {
    const components: Record<string, any> = { pre: CodeBlock }
    if (anchorPrefix) {
      const counter = { i: 0 }
      const heading = (level: 1 | 2 | 3) => {
        const Tag = `h${level}` as 'h1' | 'h2' | 'h3'
        return ({ children, node, ...rest }: any) => (
          <Tag id={`${anchorPrefix}-${counter.i++}`} data-toc-level={String(level)} {...rest}>
            {children}
          </Tag>
        )
      }
      components.h1 = heading(1)
      components.h2 = heading(2)
      components.h3 = heading(3)
    }
    return (
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { ignoreMissing: true, detect: false }]]}
        components={components}
      >
        {normalizeMath(content)}
      </ReactMarkdown>
    )
  },
)
