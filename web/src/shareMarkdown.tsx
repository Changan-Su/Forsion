/**
 * 公开分享页的 markdown 级兜底渲染(react-markdown,GFM+math+highlight)。
 * 2026-09-07 起正文主路径是生产 UnifiedPage(readOnly,见 shareViewer);这份只接**进不了 v4 统一实例**的文件:
 * v3 标记文件里升级被拒的(mindmap / dashboard 键)与未来 schema —— 保真上限 = markdown 级。
 * wiki 语法轻转换:![[img]] → 公开资产 URL;[[链接]] → 范围内可点、范围外降级为样式化文本;.db 嵌入 → 只读表格。
 */
import React, { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ShareDbEmbed } from './shareDb'

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

/** 剥 frontmatter + wiki 语法轻转换(嵌入图→md 图;不可渲染的构件→纯 markdown 占位,不依赖 rehype-raw)。 */
export function preprocess(raw: string, opts: { assetUrl: (ref: string) => string; pageHref: (name: string) => string | null }): string {
  // 口径与 compiler/split.ts 对齐:空 fm 合法、收尾栅栏独占一行、认 CRLF。只认 LF 的老写法在
  // CRLF 源文上整块剥不掉 —— 分享页会把 frontmatter 当正文公开(画布笔记连坐标/连线一起露)。
  let s = raw.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '')
  // Amadeus 块锚点标记(<!-- a <id> -->,见 compiler/markers.ts BLOCK_MARKER_RE):仅用于存储切块,
  // 读者不该看到。react-markdown 无 rehype-raw 会把这些 HTML 注释漏成可见文本,故在此整行剥除。
  s = s.replace(/^[ \t]*<!--\s*\/?a\s+[A-Za-z0-9_-]+\s*-->[ \t]*(?:\r?\n|$)/gm, '')
  s = s.replace(/!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, ref: string, _alias?: string) => {
    const r = ref.trim()
    if (IMG_EXT.test(r)) return `![](${opts.assetUrl(r)})`
    if (/\.db$/i.test(r)) return `\n\n\`\`\`forsion-db\n${r}\n\`\`\`\n\n` // 占位 fence → dbComponents 覆写渲染只读多维表
    return `\`嵌入:${r}\``
  })
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target.split('/').pop() ?? target).trim()
    const href = opts.pageHref(target.trim())
    return href ? `[${label}](${href})` : `*${label}*`
  })
  return s
}

export function ShareMarkdown({ base, current, pages, content }: {
  /** 公开分享 API 基址(…/public/shares/<token>)。 */
  base: string
  current: string
  /** 分享范围内的页面清单(vault 相对路径),[[链接]] 按它解析。 */
  pages: string[]
  content: string
}): React.ReactElement {
  const md = useMemo(() => preprocess(content, {
    assetUrl: (ref) => `${base}/asset?ref=${encodeURIComponent(ref)}&page=${encodeURIComponent(current)}`,
    pageHref: (target) => {
      const t = target.toLowerCase()
      const hit = pages.find((p) => p.toLowerCase() === `${t}.md` || p.toLowerCase() === t)
        ?? pages.find((p) => (p.split('/').pop() ?? '').toLowerCase().replace(/\.md$/, '') === t)
      return hit ? `#${encodeURIComponent(hit)}` : null
    },
  }), [content, current, pages, base])

  // ![[x.db]] 占位 fence(language-forsion-db)→ 只读多维表;经 hast node 识别语言,pre 去壳让表格块级呈现。
  const dbComponents: Components = useMemo(() => ({
    code({ className, children }) {
      if (/\blanguage-forsion-db\b/.test(className ?? '')) {
        const ref = (Array.isArray(children) ? children.join('') : String(children ?? '')).trim()
        return <ShareDbEmbed base={base} page={current} dbRef={ref} />
      }
      return <code className={className}>{children}</code>
    },
    pre({ node, children }) {
      const codeNode = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown } }> } | undefined)
        ?.children?.find((n) => n.tagName === 'code')
      const cls = codeNode?.properties?.className
      const isDb = Array.isArray(cls) ? cls.includes('language-forsion-db') : String(cls ?? '').includes('language-forsion-db')
      return isDb ? <>{children}</> : <pre>{children}</pre>
    },
  }), [base, current])

  return (
    <div className="shv-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, plainText: ['forsion-db'] }], rehypeKatex]}
        components={dbComponents}
      >
        {md}
      </ReactMarkdown>
    </div>
  )
}
