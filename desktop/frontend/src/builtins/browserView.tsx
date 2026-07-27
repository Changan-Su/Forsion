/**
 * 内置浏览器视图(builtin:browser):一个 tab = 一个 <webview>。
 *
 * 刻意不自造多标签/书签/历史 —— LCL 工作台本身就是标签系统,再开一个就是标签套标签。
 * guest 的安全边界在主进程(will-attach-webview 剥 preload/nodeIntegration + 独立会话分区拒权限),
 * 这里只管导航 UI。
 *
 * ponytail: src 只在挂载时设一次,之后导航一律走 loadURL()——把 src 绑进 React state 会让每次
 * 重渲染都重新加载整页。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { BROWSER_PARTITION } from '../../../shared/browser'
import { useI18n } from '../i18n'

/** 起始页:不联网、不追踪,纯提示。 */
export const HOME_URL = 'about:blank'

/** 地址栏输入 → 真实 URL。有 scheme 直接用;像域名的补协议;其余当搜索词。
 *  ⚠️scheme 判定必须带 `//`:裸 `[a-z]+:` 会把 `localhost:3001/api` 当成 scheme 为 "localhost" 的 URL。 */
export function normalizeAddress(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s // http(s)://、file://…
  if (/^(about|data|blob|mailto|view-source|chrome|devtools):/i.test(s)) return s // 无 // 的既有 scheme
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)
  const looksLikeHost = !/\s/.test(s) && (isLocal || /\.[a-z]{2,}/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s))
  if (looksLikeHost) return (isLocal ? 'http://' : 'https://') + s // 本机服务基本都是 http,别逼它走 TLS
  return 'https://www.bing.com/search?q=' + encodeURIComponent(s)
}

/** tab 上的兜底短标题:网页取主机名,file: 取文件名,取不出就原样。 */
export function shortTitle(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || url)
    return u.hostname || url
  } catch { return url }
}

/** 用到的 <webview> 方法子集(electron 的 WebviewTag 类型不在渲染层 tsconfig 里)。 */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
}

// 'webview' 不是标准 HTML 标签:一行 cast 拿到类型,免去全局 JSX.IntrinsicElements 增补。
// HtmlPreview 也用它(预览必须是**顶层文档**,跨源子框架被 Chromium 硬禁 file picker)。
export const Webview = 'webview' as unknown as React.FC<
  React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement>; src?: string; partition?: string; allowpopups?: string }
>

const bar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
  borderBottom: 'var(--border-width, 1px) solid var(--border)', background: 'var(--bg-card, var(--bg))',
}

export const BrowserView: React.FC<ViewProps> = ({ leaf, params }) => {
  const { t } = useI18n()
  const initial = useRef(typeof params.url === 'string' && params.url ? params.url : HOME_URL)
  const ref = useRef<WebviewEl | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [addr, setAddr] = useState(initial.current === HOME_URL ? '' : initial.current)
  const [url, setUrl] = useState(initial.current)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [err, setErr] = useState<string | null>(null)

  // 导航落点回写 leaf:标题进 tab、url 进 params(随布局持久化 → 重启回到同一页)。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void => setNav({ back: el.canGoBack(), forward: el.canGoForward() })
    const onNavigate = (e: Event): void => {
      const next = (e as Event & { url?: string }).url || el.getURL()
      setUrl(next)
      setAddr(next === HOME_URL ? '' : next)
      setErr(null)
      leaf.setParams({ ...leaf.params, url: next })
      // 真标题优先(锚点内跳转不会再触发 page-title-updated/did-stop-loading,不能把标题打回主机名);
      // 拿不到才用主机名/文件名兜底,好歹让多个浏览器 tab 分得清。
      leaf.setTitle(el.getTitle() || shortTitle(next))
      sync()
    }
    const onTitle = (e: Event): void => {
      const title = (e as Event & { title?: string }).title
      if (title) leaf.setTitle(title)
    }
    const onStart = (): void => { setLoading(true); setErr(null) }
    // 补一次标题:page-title-updated 可能早于本 effect 挂载(file:// 之类瞬时加载)就已经烧过了。
    const onStop = (): void => {
      setLoading(false)
      sync()
      const t = el.getTitle()
      if (t) leaf.setTitle(t)
    }
    const onFail = (e: Event): void => {
      const d = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      // -3 = ERR_ABORTED(用户点停/被新导航取代),不是错误。
      if (d.isMainFrame === false || d.errorCode === -3) return
      setLoading(false)
      setErr(d.errorDescription || String(d.errorCode))
    }
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('did-fail-load', onFail)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [leaf])

  // 外部改 params.url(同一 tab 里被要求导航到别处)→ 跟着走。
  useEffect(() => {
    const want = typeof params.url === 'string' ? params.url : ''
    if (!want || want === url) return
    void ref.current?.loadURL(want).catch(() => {})
  }, [params.url]) // eslint-disable-line react-hooks/exhaustive-deps

  // 空白起手 = 用户接下来就是要输地址,别让他再点一下。
  useEffect(() => { if (initial.current === HOME_URL) input.current?.focus() }, [])

  const go = useCallback((raw: string) => {
    const next = normalizeAddress(raw)
    if (!next) return
    setErr(null)
    void ref.current?.loadURL(next).catch((e) => setErr(String(e?.message || e)))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={bar}>
        <button className="btn ghost sm" disabled={!nav.back} onClick={() => ref.current?.goBack()} title={t('browser.back')}><ArrowLeft size={14} /></button>
        <button className="btn ghost sm" disabled={!nav.forward} onClick={() => ref.current?.goForward()} title={t('browser.forward')}><ArrowRight size={14} /></button>
        <button
          className="btn ghost sm"
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
          title={loading ? t('browser.stop') : t('browser.reload')}
        >
          {loading ? <X size={14} /> : <RotateCw size={14} />}
        </button>
        <input
          ref={input}
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(addr) } }}
          onFocus={(e) => e.currentTarget.select()}
          placeholder={t('browser.placeholder')}
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, fontSize: 12, padding: '4px 8px', borderRadius: 6,
            border: 'var(--border-width, 1px) solid var(--border)', background: 'var(--bg)', color: 'inherit',
          }}
        />
        <button className="btn ghost sm" onClick={() => window.tangu?.openExternal?.(url)} title={t('browser.openExternal')}><ExternalLink size={14} /></button>
      </div>
      {err && <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--danger, #c0392b)' }}>{t('browser.failed', { msg: err })}</div>}
      <Webview
        ref={ref as unknown as React.Ref<HTMLElement>}
        src={initial.current}
        partition={BROWSER_PARTITION}
        // 站点里的 target=_blank 要能触发主进程的 window-open 钩子(它 deny 掉并回投成新的内置浏览器标签);
        // 不加这条则整类链接在 guest 里被静默吞掉。
        allowpopups="true"
        style={{ flex: 1, minHeight: 0, border: 'none', background: '#fff' }}
      />
    </div>
  )
}
