/**
 * Markdown 渲染(react-markdown + GFM + highlight.js;代码块带复制按钮)。
 * 高亮配色在 base.css 用主题 token 写(.hljs-*),不引第三方主题 CSS。
 */
import React, { useContext, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
// 模型最爱写 `**注意：**后面`(CJK 标点贴闭合定界符),CommonMark 判不成立、显示字面 `**`。
// 只换解析、不落盘;须排在 remarkGfm 之后(删除线那个要压过 gfm 的 `~`)。理由同 amadeus/blocks/markdown/cjkFriendly.ts。
// 直接引包而不引那个模块:那边带 @milkdown/kit,聊天气泡在主 chunk,别把 milkdown 拖进来。
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Copy, Check, Play } from 'lucide-react'
import { useI18n } from '../i18n'
import { isShellLang, runInTerminal, stripPrompt, type RunResult } from '../builtins/runCommand'
import { normalizeMath } from '../services/mathNormalize'
import { remarkWiki } from './wikiChat'
import { ChatWebLink, ChatWikiLink } from './ChatWikiLink'
import { ChatEmbed, type EmbedCtx } from './ChatEmbed'

// [[双链]] 经 remarkWiki 变成 #wiki= 链接,在这里拦下渲染;http(s) 走网页引用条(Desk 内置浏览器
// + 链接文字当引语定位);其余(mailto/相对/锚点)维持默认 <a>。
const WikiAnchor = ({ href, children, node: _node, ...rest }: any) =>
  typeof href === 'string' && href.startsWith('#wiki=') ? (
    <ChatWikiLink inner={decodeURIComponent(href.slice(6))} />
  ) : typeof href === 'string' && /^https?:\/\//i.test(href) ? (
    <ChatWebLink href={href} {...rest}>{children}</ChatWebLink>
  ) : (
    <a href={href} {...rest}>{children}</a>
  )

/** 代码块「运行」的回传口:聊天消息给 onRun(把结果作为用户消息发回会话);别处(工作区文件预览等)不给 = 只跑不回传。 */
const RunContext = React.createContext<{ onRun?: (r: RunResult) => void; cwd?: string; allowRun: boolean } | undefined>(undefined)

/** 嵌入段(remarkWiki 挂的 data-embeds)的开关。⚠️ 缺省关、只由聊天的助手消息开:本组件还给市场 / 更新日志 /
 *  收件箱等十几处渲远端或第三方文本,那里的 `![[/Users/x/.ssh/id_rsa]]` 绝不能触发读盘。 */
const EmbedContext = React.createContext<EmbedCtx | undefined>(undefined)

const Para = ({ node, children, 'data-embeds': _embeds, ...rest }: any) => {
  const ctx = useContext(EmbedContext)
  const raw = node?.properties?.dataEmbeds
  if (!ctx || typeof raw !== 'string') return <p {...rest}>{children}</p>
  const { inners, tail } = JSON.parse(raw) as { inners: string[]; tail: string }
  return (
    <div className="t2-embeds">
      {inners.map((inner, i) => <ChatEmbed key={`${i}:${inner}`} inner={inner} ctx={ctx} />)}
      {tail && <span className="t2-embeds-tail">{tail}</span>}
    </div>
  )
}

/** fence 语言来自 rehype-highlight 落在 <code> 上的 `language-xxx` 类(detect:false,所以只可能是 info string)。 */
function fenceLang(node: unknown): string | undefined {
  const code = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown } }> } | undefined)
    ?.children?.find((n) => n.tagName === 'code')
  const cls = code?.properties?.className
  const list = Array.isArray(cls) ? cls.map(String) : String(cls ?? '').split(/\s+/)
  return list.find((c) => c.startsWith('language-'))?.slice(9)
}

const CodeBlock: React.FC<React.HTMLAttributes<HTMLPreElement> & { node?: unknown }> = ({ children, node, ...props }) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const preRef = React.useRef<HTMLPreElement>(null)
  const runCtx = useContext(RunContext)
  // Run 键靠 window.tangu.pty 门控:web/移动端没有 PTY,自然不露。
  const runnable = runCtx?.allowRun !== false && isShellLang(fenceLang(node)) && !!window.tangu?.pty
  const copy = () => {
    const text = preRef.current?.innerText ?? ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const run = () => {
    const cmd = stripPrompt(preRef.current?.innerText ?? '')
    if (cmd) runInTerminal(cmd, { cwd: runCtx?.cwd, onExit: runCtx?.onRun })
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre ref={preRef} {...props}>{children}</pre>
      {runnable && (
        <button
          className="icon-btn"
          onClick={run}
          title={t('terminal.runTitle')}
          data-testid="code-run"
          style={{ position: 'absolute', top: 6, right: 34, width: 24, height: 24 }}
        >
          <Play size={13} />
        </button>
      )}
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
export const Markdown: React.FC<{ content: string; anchorPrefix?: string; /** shell 代码块「运行」的回传与工作目录(聊天消息给;缺省=只跑不回传)。 */ run?: { onRun?: (r: RunResult) => void; cwd?: string }; /** 只读文档可隐藏运行入口，仍保留复制代码。 */ allowRun?: boolean; /** 开内联嵌入(独占一段的 `![[…]]`);缺省关,见 EmbedContext。 */ embeds?: EmbedCtx }> = React.memo(
  ({ content, anchorPrefix, run, allowRun = true, embeds }) => {
    const components: Record<string, any> = { pre: CodeBlock, a: WikiAnchor, p: Para }
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
      <RunContext.Provider value={{ ...run, allowRun }}>
        <EmbedContext.Provider value={embeds}>
          <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm, remarkCjkFriendly, remarkCjkFriendlyStrikethrough, remarkWiki]}
            rehypePlugins={[[rehypeKatex, { throwOnError: false }], [rehypeHighlight, { ignoreMissing: true, detect: false }]]}
            components={components}
          >
            {normalizeMath(content)}
          </ReactMarkdown>
        </EmbedContext.Provider>
      </RunContext.Provider>
    )
  },
)
