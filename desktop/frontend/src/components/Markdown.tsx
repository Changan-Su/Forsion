/**
 * Markdown 渲染(react-markdown + GFM + highlight.js;代码块带复制按钮)。
 * 高亮配色在 base.css 用主题 token 写(.hljs-*),不引第三方主题 CSS。
 */
import React, { useContext, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
// 模型最爱写 `**注意：**后面`(CJK 标点贴闭合定界符),CommonMark 判不成立、显示字面 `**`。
// 只换解析、不落盘;须排在 remarkGfm 之后(删除线那个要压过 gfm 的 `~`)。理由同 amadeus/blocks/markdown/cjkFriendly.ts。
// 直接引包而不引那个模块:那边带 @milkdown/kit,聊天气泡在主 chunk,别把 milkdown 拖进来。
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import remarkMath from 'remark-math'
import { common, createLowlight } from 'lowlight'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Copy, Check, Play, ImageOff } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { isShellLang, runInTerminal, stripPrompt, type RunResult } from '../builtins/runCommand'
import { normalizeMath } from '../services/mathNormalize'
import { remarkWiki } from './wikiChat'
import { ChatWebLink, ChatWikiLink } from './ChatWikiLink'
import { ChatLinkWithCard } from './ChatLinkCard'
import { ChatEmbed, type EmbedCtx } from './ChatEmbed'
import { whenNear } from '../lib/nearViewport'

/** 网页链接的悬停预览卡(ChatLinkCard)。⚠️ 缺省关、只由聊天回答开:本组件还给市场 README / 收件箱 / 更新日志渲第三方文本,
 *  那里的链接不该一悬停就让引擎去问 GitHub。 */
const LinkCardContext = React.createContext(false)

/** 代码块细表头(语言 + 复制,走查续六 6.2 A)。⚠️ 缺省关、只由聊天回答开:别处的代码块各有自己的底色,表头的样式只写在 .t2-content 里。 */
const CodeHeadContext = React.createContext(false)

registerMessages({
  'code.copy': { zh: '复制', en: 'Copy' },
  'code.copied': { zh: '已复制', en: 'Copied' },
  'code.plainText': { zh: '文本', en: 'Text' },
  'md.imageBroken': { zh: '图片无法显示 · {alt}', en: 'Image unavailable · {alt}' },
})
/** 表头上的语言名:常见几种写全称,其余照 fence 原样。 */
const LANG_NAMES: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  py: 'Python', python: 'Python', sh: 'Shell', bash: 'Shell', zsh: 'Shell', shell: 'Shell', json: 'JSON',
  html: 'HTML', css: 'CSS', md: 'Markdown', markdown: 'Markdown', yaml: 'YAML', yml: 'YAML', sql: 'SQL',
}

// [[双链]] 经 remarkWiki 变成 #wiki= 链接,在这里拦下渲染;http(s) 走网页引用条(Desk 内置浏览器
// + 链接文字当引语定位;聊天回答里另带悬停预览卡);其余(mailto/相对/锚点)维持默认 <a>。
const WikiAnchor = ({ href, children, node: _node, ...rest }: any) => {
  const cards = useContext(LinkCardContext)
  if (typeof href === 'string' && href.startsWith('#wiki=')) return <ChatWikiLink inner={decodeURIComponent(href.slice(6))} />
  if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
    return cards ? <ChatLinkWithCard href={href} {...rest}>{children}</ChatLinkWithCard> : <ChatWebLink href={href} {...rest}>{children}</ChatWebLink>
  }
  return <a href={href} {...rest}>{children}</a>
}

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

/** fence 语言来自 <code> 上的 `language-xxx` 类(remark-rehype 照 info string 写的;不猜语言)。 */
function fenceLang(node: unknown): string | undefined {
  const code = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown } }> } | undefined)
    ?.children?.find((n) => n.tagName === 'code')
  const cls = code?.properties?.className
  const list = Array.isArray(cls) ? cls.map(String) : String(cls ?? '').split(/\s+/)
  return list.find((c) => c.startsWith('language-'))?.slice(9)
}

const lowlight = createLowlight(common)
type HastText = { type: 'text'; value: string }
type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] }
const hastText = (n: HastNode | undefined): string => n?.type === 'text' ? (n as HastText).value : (n?.children ?? []).map(hastText).join('')

/** 语法高亮等到代码块离视口一屏以内才做(长会话一打开不用把每个代码块都高亮一遍,高亮出的几十个 span 也晚点进 DOM)。
 *  高亮前是同字体同行高的原文,高亮只换颜色、不改排版,所以不会跳;做过一次就不撤。认不得的语言 / 没写语言照旧不高亮。 */
function useHighlighted(preRef: React.RefObject<HTMLPreElement | null>, node: unknown): React.ReactNode | null {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = preRef.current
    if (near || !el) return
    return whenNear(el, () => setNear(true))
  }, [near, preRef])
  const lang = fenceLang(node)
  const text = near && lang && lowlight.registered(lang) ? hastText((node as HastNode | undefined)?.children?.find((n) => n.tagName === 'code')) : null
  return useMemo(() => (text == null || !lang ? null
    : <code className={`hljs language-${lang}`}>{toJsxRuntime(lowlight.highlight(lang, text) as never, { Fragment, jsx, jsxs })}</code>), [lang, text])
}

const CodeBlock: React.FC<React.HTMLAttributes<HTMLPreElement> & { node?: unknown }> = ({ children, node, ...props }) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const preRef = React.useRef<HTMLPreElement>(null)
  const highlighted = useHighlighted(preRef, node)
  const runCtx = useContext(RunContext)
  const lang = fenceLang(node)
  // Run 键靠 window.tangu.pty 门控:web/移动端没有 PTY,自然不露。
  const runnable = runCtx?.allowRun !== false && isShellLang(lang) && !!window.tangu?.pty
  // 表头只给「有语言或超过 3 行」且不止两行的块;一两行的命令仍是角上的图标键(pre 右边留出位置,不压字)。
  const lines = hastText((node as HastNode | undefined)?.children?.find((n) => n.tagName === 'code')).replace(/\n$/, '').split('\n').length
  const head = useContext(CodeHeadContext) && lines > 2 && (!!lang || lines > 3)
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
  if (head) {
    return (
      <div className="code-box" data-code-head="">
        <div className="code-head">
          <span className="code-head-lang">{lang ? LANG_NAMES[lang.toLowerCase()] ?? lang : t('code.plainText')}</span>
          <span className="code-head-acts">
            {runnable && <button type="button" className="code-head-btn" onClick={run} title={t('terminal.runTitle')} aria-label={t('terminal.runTitle')} data-testid="code-run"><Play size={13} /></button>}
            <button type="button" className="code-head-btn" onClick={copy} title={t('common.copyCode')}>
              {copied ? <Check size={13} /> : <Copy size={13} />}{t(copied ? 'code.copied' : 'code.copy')}
            </button>
          </span>
        </div>
        <pre ref={preRef} {...props}>{highlighted ?? children}</pre>
      </div>
    )
  }
  return (
    <div className="code-box" data-run={runnable || undefined} style={{ position: 'relative' }}>
      <pre ref={preRef} {...props}>{highlighted ?? children}</pre>
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

/** 图片打不开:换成一块说明(走查续六 6.7),不留浏览器的破图标。alt 是用户内容,不翻;点它试着用系统浏览器开原地址。 */
const MdImage = ({ node: _node, src, alt, ...rest }: any) => {
  const { t } = useI18n()
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  if (!broken) return <img src={src} alt={alt} {...rest} onError={() => setBroken(true)} />
  const open = typeof src === 'string' && /^https?:\/\//i.test(src)
    // 外面包着链接(README 徽章之类)时只开图片地址这一下,别再冒泡给外层链接
    ? (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); void (window.tangu?.openExternal?.(src) ?? window.open(src, '_blank', 'noopener')) }
    : undefined
  return (
    <button type="button" className="md-img-broken" title={typeof src === 'string' ? src : undefined} onClick={open} disabled={!open}>
      <ImageOff size={18} /><span>{t('md.imageBroken', { alt: alt || '' })}</span>
    </button>
  )
}

/** 手机上宽表格在自己的框里横向滑(chat2.css 末尾):一行放得下的格子不折行,放不下的照常折 ——
 *  CSS 数不了字,这里把后一种标出来(约 13 个汉字宽:汉字算 1,其余算半个多一点)。别处没有样式认这个标记。 */
const cellEm = (n: any): number => n?.type === 'text'
  ? [...String(n.value)].reduce((w, c) => w + (c > '\u2e7f' ? 1 : 0.55), 0)
  : (n?.children || []).reduce((w: number, c: any) => w + cellEm(c), 0)
const tableCell = (Tag: 'td' | 'th') => ({ node, ...rest }: any) => <Tag data-long={cellEm(node) > 13 || undefined} {...rest} />
const Td = tableCell('td')
const Th = tableCell('th')

/**
 * anchorPrefix:传入时给 h1/h2/h3 渲染稳定 id(`${anchorPrefix}-${第n个标题}`)+ data-toc-level,
 * 供右侧「目录」扫描跳转。不传则零影响(记忆/日志面板等普通渲染)。
 */
export const Markdown: React.FC<{ content: string; anchorPrefix?: string; /** shell 代码块「运行」的回传与工作目录(聊天消息给;缺省=只跑不回传)。 */ run?: { onRun?: (r: RunResult) => void; cwd?: string }; /** 只读文档可隐藏运行入口，仍保留复制代码。 */ allowRun?: boolean; /** 开内联嵌入(独占一段的 `![[…]]`);缺省关,见 EmbedContext。 */ embeds?: EmbedCtx; /** 网页链接悬停出预览卡;缺省关,见 LinkCardContext。 */ linkCards?: boolean; /** 代码块细表头;缺省关,见 CodeHeadContext。 */ codeHead?: boolean }> = React.memo(
  ({ content, anchorPrefix, run, allowRun = true, embeds, linkCards = false, codeHead = false }) => {
    const components: Record<string, any> = { pre: CodeBlock, a: WikiAnchor, p: Para, td: Td, th: Th, img: MdImage }
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
          <LinkCardContext.Provider value={linkCards}>
          <CodeHeadContext.Provider value={codeHead}>
            <ReactMarkdown
              remarkPlugins={[remarkMath, remarkGfm, remarkCjkFriendly, remarkCjkFriendlyStrikethrough, remarkWiki]}
              rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
              components={components}
            >
              {normalizeMath(content)}
            </ReactMarkdown>
          </CodeHeadContext.Provider>
          </LinkCardContext.Provider>
        </EmbedContext.Provider>
      </RunContext.Provider>
    )
  },
)
