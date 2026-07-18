/**
 * P3 公开分享 viewer(/share/<token>):无鉴权轻量独立页,不加载主应用。
 * 渲染 = react-markdown(GFM+math+highlight)直出;wiki 语法做轻转换:
 *   ![[img]] → 公开资产 URL;[[链接]] → 子树内可点、树外降级为样式化文本;.db 嵌入 → 提示 chip。
 * ponytail: 保真上限 = markdown 级(数据库/块嵌入不渲染);要全保真等 P4 只读编辑器模式。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { getApiBase } from './webShim'

interface ShareMeta { mode: 'page' | 'subtree'; path: string; title: string }
interface ShareTree { root: string; pages: string[]; folders: string[] }

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; }
.shv { min-height: 100vh; display: flex; background: #faf9f7; color: #2a2a2e; font: 15px/1.75 -apple-system, "PingFang SC", "Segoe UI", Roboto, sans-serif; }
.shv a { color: #4c6ef5; text-decoration: none; }
.shv a:hover { text-decoration: underline; }
.shv-side { width: 240px; flex-shrink: 0; border-right: 1px solid rgba(127,127,127,.18); padding: 20px 10px; overflow-y: auto; position: sticky; top: 0; height: 100vh; }
.shv-side button { display: block; width: 100%; text-align: left; padding: 5px 10px; border: 0; background: none; border-radius: 8px; font: 13px/1.5 inherit; color: inherit; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shv-side button:hover { background: rgba(127,127,127,.1); }
.shv-side button.on { background: rgba(76,110,245,.12); color: #4c6ef5; }
.shv-side .dir { opacity: .55; font-size: 11.5px; margin: 10px 10px 2px; text-transform: none; }
.shv-main { flex: 1; min-width: 0; padding: 48px 24px 96px; }
.shv-doc { max-width: 760px; margin: 0 auto; }
.shv-doc h1.shv-title { font-size: 30px; line-height: 1.3; margin: 0 0 24px; }
.shv-doc pre { background: rgba(127,127,127,.09); padding: 12px 14px; border-radius: 10px; overflow-x: auto; font-size: 13px; }
.shv-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
.shv-doc img { max-width: 100%; border-radius: 8px; }
.shv-doc blockquote { margin: 0; padding: 2px 16px; border-left: 3px solid rgba(127,127,127,.35); opacity: .9; }
.shv-doc table { border-collapse: collapse; display: block; overflow-x: auto; }
.shv-doc th, .shv-doc td { border: 1px solid rgba(127,127,127,.25); padding: 5px 10px; font-size: 14px; }
.shv-wik { color: #4c6ef5; opacity: .75; border-bottom: 1px dashed currentColor; }
.shv-chip { display: inline-block; padding: 1px 10px; border-radius: 999px; background: rgba(127,127,127,.12); font-size: 12.5px; opacity: .8; }
.shv-foot { margin-top: 64px; padding-top: 16px; border-top: 1px solid rgba(127,127,127,.15); font-size: 12px; opacity: .55; }
.shv-center { margin: auto; text-align: center; padding: 48px; }
@media (prefers-color-scheme: dark) {
  .shv { background: #1d1d21; color: #d7d7dc; }
  .shv a, .shv-side button.on, .shv-wik { color: #8ea4f8; }
  .shv-side button.on { background: rgba(142,164,248,.14); }
}
@media (max-width: 720px) { .shv { flex-direction: column; } .shv-side { width: auto; height: auto; position: static; border-right: 0; border-bottom: 1px solid rgba(127,127,127,.18); } }
`

/** 剥 frontmatter + wiki 语法轻转换(嵌入图→md 图;不可渲染的构件→纯 markdown 占位,不依赖 rehype-raw)。 */
function preprocess(raw: string, opts: { assetUrl: (ref: string) => string; pageHref: (name: string) => string | null }): string {
  let s = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
  // Amadeus 块锚点标记(<!-- a <id> -->,见 compiler/markers.ts BLOCK_MARKER_RE):仅用于存储切块,
  // 读者不该看到。react-markdown 无 rehype-raw 会把这些 HTML 注释漏成可见文本,故在此整行剥除。
  s = s.replace(/^[ \t]*<!--\s*a\s+[A-Za-z0-9_]+\s*-->[ \t]*(?:\r?\n|$)/gm, '')
  s = s.replace(/!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, ref: string, _alias?: string) => {
    const r = ref.trim()
    if (IMG_EXT.test(r)) return `![](${opts.assetUrl(r)})`
    if (/\.db$/i.test(r)) return `\`📊 ${r.replace(/\.db$/i, '')}(数据库,在 Forsion 中查看)\``
    return `\`嵌入:${r}\``
  })
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target.split('/').pop() ?? target).trim()
    const href = opts.pageHref(target.trim())
    return href ? `[${label}](${href})` : `*${label}*`
  })
  return s
}

function ShareApp({ token }: { token: string }): React.ReactElement {
  const api = getApiBase()
  const base = `${api}/amadeus/public/shares/${encodeURIComponent(token)}`
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [tree, setTree] = useState<ShareTree | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const r = await fetch(base)
      if (!r.ok) { setErr(r.status === 429 ? '访问过于频繁,稍后再试' : '分享不存在或已撤销'); return }
      const m = (await r.json()) as ShareMeta
      setMeta(m)
      if (m.mode === 'subtree') {
        const tr = await fetch(`${base}/tree`)
        if (tr.ok) {
          const t = (await tr.json()) as ShareTree
          setTree(t)
          const first = location.hash.slice(1) ? decodeURIComponent(location.hash.slice(1)) : t.pages[0]
          setCurrent(first ?? null)
          return
        }
      }
      setCurrent(m.path)
    })().catch(() => setErr('加载失败'))
  }, [base])

  useEffect(() => {
    if (!current) return
    void (async () => {
      const r = await fetch(`${base}/file?path=${encodeURIComponent(current)}`)
      if (!r.ok) { setErr('页面不存在或不在分享范围内'); return }
      const f = (await r.json()) as { content: string; title: string }
      setErr(null)
      setContent(f.content)
      document.title = `${f.title} · Forsion`
    })().catch(() => setErr('加载失败'))
  }, [base, current])

  const md = useMemo(() => {
    if (!current) return ''
    return preprocess(content, {
      assetUrl: (ref) => `${base}/asset?ref=${encodeURIComponent(ref)}&page=${encodeURIComponent(current)}`,
      pageHref: (target) => {
        if (!tree) return null
        const t = target.toLowerCase()
        const hit = tree.pages.find((p) => p.toLowerCase() === `${t}.md` || p.toLowerCase() === t)
          ?? tree.pages.find((p) => (p.split('/').pop() ?? '').toLowerCase().replace(/\.md$/, '') === t)
        return hit ? `#${encodeURIComponent(hit)}` : null
      },
    })
  }, [content, current, tree, base])

  useEffect(() => {
    const onHash = (): void => {
      const p = decodeURIComponent(location.hash.slice(1))
      if (p) setCurrent(p)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (err && !meta) return <div className="shv"><div className="shv-center">{err}</div></div>

  const stripRoot = (p: string): string => (tree && p.startsWith(`${tree.root}/`) ? p.slice(tree.root.length + 1) : p)
  const title = current ? (current.split('/').pop() ?? '').replace(/\.md$/i, '') : meta?.title ?? ''

  return (
    <div className="shv">
      {tree && (
        <nav className="shv-side">
          {tree.pages.map((p) => (
            <button key={p} className={p === current ? 'on' : ''} onClick={() => { location.hash = encodeURIComponent(p); setCurrent(p) }}>
              {stripRoot(p).replace(/\.md$/i, '')}
            </button>
          ))}
        </nav>
      )}
      <main className="shv-main">
        <article className="shv-doc">
          <h1 className="shv-title">{title}</h1>
          {err ? <p>{err}</p> : (
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeHighlight, rehypeKatex]}>
              {md}
            </ReactMarkdown>
          )}
          <footer className="shv-foot">由 Forsion 云端笔记分享 · 只读</footer>
        </article>
      </main>
    </div>
  )
}

export function mountSharePage(token: string): void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  const el = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
  createRoot(el).render(<ShareApp token={token} />)
}
