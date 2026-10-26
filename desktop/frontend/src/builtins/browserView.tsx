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
import { ArrowLeft, ArrowRight, ExternalLink, GlobeLock, Loader2, MousePointerClick, RotateCw, X } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { BROWSER_PARTITION } from '../../../shared/browser'
import { registerMessages, useI18n } from '../i18n'
import type { ElementPick } from '@tangu/ui/views/chat2/elementPick'
import { deliverElementPick, hostOf } from './elementPickDelivery'
import { EmptyState } from '../components/EmptyState'
import './browserView.css'

registerMessages({
  'browser.pick': { zh: '点选元素发进对话', en: 'Pick an element to send to chat' },
  'browser.pick.hint': { zh: '点一下要发的元素', en: 'Click the element to send' },
  'browser.pick.keys': { zh: ' · Esc 取消 · {alt} 选上一层', en: ' · Esc cancel · {alt} parent' },
  'browser.pick.noChat': { zh: '没找到可以放进去的对话', en: 'No chat to send it to' },
  'browser.fail.title': { zh: '打不开这个网页', en: 'Can’t open this page' },
  'browser.fail.loading': { zh: '正在打开…', en: 'Opening…' },
  'browser.fail.refused': { zh: '{host} 拒绝了连接。检查地址是否写对，或者这个本地服务有没有启动。', en: '{host} refused to connect. Check the address, or whether this local server is running.' },
  'browser.fail.host': { zh: '找不到 {host}。', en: 'Can’t find {host}.' },
  'browser.fail.offline': { zh: '现在没有网络。', en: 'You’re offline.' },
  'browser.fail.cert': { zh: '这个网站的证书有问题。', en: 'This site’s certificate has a problem.' },
  'browser.fail.timeout': { zh: '等了太久没有响应。', en: 'The page took too long to respond.' },
  'browser.fail.port': { zh: '出于安全，这个端口不允许打开。', en: 'This port is blocked for safety.' },
  'browser.fail.other': { zh: '这个网页现在打不开。', en: 'This page can’t be opened right now.' },
  'browser.fail.retry': { zh: '重试', en: 'Retry' },
})

/** 加载失败的人话分档(走查续七 7.9):按 Chromium 的网络错误码 / 错误名归类,其余一律 other。 */
export type LoadFailKind = 'refused' | 'host' | 'offline' | 'cert' | 'timeout' | 'port' | 'other'
export interface LoadFail { url: string; code: string; kind: LoadFailKind }
/** raw:did-fail-load 的 errorDescription,或 loadURL 拒绝时的整句(「…ERR_CONNECTION_REFUSED (-102) loading '…'」)。 */
export function loadFail(url: string, raw: string, errorCode?: number): LoadFail {
  const name = raw.match(/ERR_[A-Z0-9_]+/)?.[0] ?? ''
  const num = errorCode ?? Number(raw.match(/\((-\d+)\)/)?.[1] ?? NaN)
  const kind: LoadFailKind =
    num === -102 || /CONNECTION_REFUSED/.test(name) ? 'refused'
    : num === -105 || num === -137 || /NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/.test(name) ? 'host'
    : num === -106 || /INTERNET_DISCONNECTED/.test(name) ? 'offline'
    : (num <= -200 && num > -300) || /CERT|SSL/.test(name) ? 'cert'
    : num === -7 || num === -118 || /TIMED_OUT/.test(name) ? 'timeout'
    : num === -312 || /UNSAFE_PORT/.test(name) ? 'port'
    : 'other'
  return { url, code: name || (Number.isFinite(num) ? String(num) : raw), kind }
}

const ALT_KEY = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent) ? '⌥' : 'Alt'

/** 注进 guest 的引语高亮配色:Chromium 默认的 `::target-text` 是浅紫,与本应用引用高亮的琥珀不是
 *  一套语汇 —— 网页引用点开落在哪一句,要和 PDF 引语带子、代码行高亮长一个样。
 *  - `#ffe14d` = 批注调色板的「黄」,与 pdfAnnotator.css 的 `.pdfa-citehl-band` **同一支笔**。
 *    第三方页面里没有本应用的 token,只能写字面值 —— 改色要两处同改。
 *  - **底色与字色必须一起给**:目标页的正文可能是任何颜色,只改底色会在深色站点上变成黄底白字。
 *    这里是**不透明**琥珀 + 近黑字(物理荧光笔那种),所以不适用「暗色禁用黄底」那条纪律 ——
 *    那条针对的是半透明黄铺在深色面上糊成橄榄色,不透明覆盖不会。
 *  - 高亮伪元素只吃 color / background-color / text-decoration / text-shadow 这几样,**动不了动画**,
 *    所以网页落点没有别处那种提醒脉冲(原生高亮本身就是到达信号)。 */
const TARGET_TEXT_CSS = '::target-text { background-color: #ffe14d; color: #111; }'

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
  insertCSS(css: string): Promise<string>
  getURL(): string
  getTitle(): string
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getWebContentsId(): number
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
  const [err, setErr] = useState<LoadFail | null>(null)
  // 打不开的地址也记进 params:失败的加载不会 did-navigate,不记的话重启 / 重载后这个标签恢复成一张空白页。
  // url 一并改:下面「外部改 params.url 就跟着走」那条 effect 看到两边相等,不会把失败的地址再拉一遍。
  const remember = useCallback((failed: string) => { setUrl(failed); if (leaf.params.url !== failed) leaf.setParams({ ...leaf.params, url: failed }) }, [leaf])
  // 点选元素(shared/browserPick.ts):picking = 进行中那次的 guest id。只有桌面宿主有 browserPick。
  const pickApi = window.tangu?.browserPick
  const [picking, setPicking] = useState<number | null>(null)
  const [pickMsg, setPickMsg] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // 送进输入框那一步可能要等对话面板摆出来:视图卸载了就别再送
  const delivery = useRef<AbortController | null>(null)
  useEffect(() => () => delivery.current?.abort(), [])

  // 导航落点回写 leaf:标题进 tab、url 进 params(随布局持久化 → 重启回到同一页)。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void => setNav({ back: el.canGoBack(), forward: el.canGoForward() })
    const onNavigate = (e: Event): void => {
      const next = (e as Event & { url?: string }).url || el.getURL()
      setUrl(next)
      setAddr(next === HOME_URL ? '' : next)
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
    const onStart = (): void => { setLoading(true) }
    // 失败的空态只在一趟加载**顺利跑完**时才撤:重试时换成加载中,再失败 / 点了停止都原样留着,不闪回空白页。
    const onFinish = (): void => { setErr(null) }
    // insertCSS 随文档走(换页就没了)→ 每次 dom-ready 补一次。同文档只换 fragment(引用条点第二条
    // 引语)不触发 dom-ready,那时样式还在,正好不用重注。
    const onDomReady = (): void => { void el.insertCSS(TARGET_TEXT_CSS).catch(() => {}) }
    // 补一次标题:page-title-updated 可能早于本 effect 挂载(file:// 之类瞬时加载)就已经烧过了。
    const onStop = (): void => {
      setLoading(false)
      sync()
      const t = el.getTitle()
      if (t) leaf.setTitle(t)
    }
    const onFail = (e: Event): void => {
      const d = e as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      // -3 = ERR_ABORTED(用户点停/被新导航取代),不是错误。
      if (d.isMainFrame === false || d.errorCode === -3) return
      setLoading(false)
      const fail = loadFail(d.validatedURL || el.getURL(), d.errorDescription || '', d.errorCode)
      setErr(fail)
      remember(fail.url)
    }
    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-finish-load', onFinish)
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('did-fail-load', onFail)
    return () => {
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-finish-load', onFinish)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [leaf])

  // 聊天网页引用条:同一页点第二条引语 → 就地跳(不重挂 webview = 不重下整页)。
  // ⚠️ 必须走事件,不能靠 params:Agent Desk 的 DeskShimView 只按 key memo 出 leaf,
  //    params 变化到不了已挂载的视图(PDF/WsFileView 同款坑,见 openPdfCitation 注释)。
  // 只有 Desk 那份带 params.path(=去 fragment 的 URL),主区普通浏览器标签天然不接。
  // 实测同文档换 fragment 也能触发文本片段定位(scripts/text-fragment.check.cjs 的 B),
  // 所以直接 loadURL 就够,不必 reload 整页。
  useEffect(() => {
    const key = typeof params.path === 'string' ? params.path : ''
    if (!key) return
    const on = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string; url?: string } | undefined
      if (!d?.url || d.path !== key) return
      void ref.current?.loadURL(d.url).catch(() => {})
    }
    window.addEventListener('amadeus:browser-goto', on)
    return () => window.removeEventListener('amadeus:browser-goto', on)
  }, [params.path])

  // 外部改 params.url(同一 tab 里被要求导航到别处)→ 跟着走。
  useEffect(() => {
    const want = typeof params.url === 'string' ? params.url : ''
    if (!want || want === url) return
    void ref.current?.loadURL(want).catch(() => {})
  }, [params.url]) // eslint-disable-line react-hooks/exhaustive-deps

  // 空白起手 = 用户接下来就是要输地址,别让他再点一下。
  useEffect(() => { if (initial.current === HOME_URL) input.current?.focus() }, [])

  const pick = useCallback(async () => {
    const el = ref.current
    if (!el || !pickApi) return
    if (picking !== null) { void pickApi.control(picking, 'cancel'); return }
    let id: number
    try { id = el.getWebContentsId() } catch { return } // guest 还没挂上
    setPicking(id)
    setPickMsg(null)
    el.focus() // 键盘要落进 guest:Esc / ⌥ 由页面里的点选脚本接
    try {
      const res = await pickApi.start(id)
      if (!res?.ok || !res.pick) return
      const p = res.pick
      const item: ElementPick = {
        id: `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        url: p.url, host: hostOf(p.url), title: p.title, selector: p.selector, tag: p.tag, text: p.text,
        image: res.image ? {
          name: `element-${p.tag}.${res.image.mimeType === 'image/png' ? 'png' : 'jpg'}`,
          mimeType: res.image.mimeType, data: res.image.data, size: Math.floor(res.image.data.length * 3 / 4),
        } : null,
      }
      delivery.current?.abort()
      const ac = new AbortController()
      delivery.current = ac
      if (!await deliverElementPick(item, rootRef.current, ac.signal) && !ac.signal.aborted) setPickMsg(t('browser.pick.noChat'))
    } catch { /* 主进程那头出错 = 这次不算 */ } finally {
      setPicking((cur) => (cur === id ? null : cur))
    }
  }, [pickApi, picking, t])

  // 焦点还在宿主(按完按钮没进 guest、或用户点回了地址栏)时也认 Esc / ⌥;卸载 / 跳走时把进行中的那次收掉。
  useEffect(() => {
    if (picking === null || !pickApi) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); void pickApi.control(picking, 'cancel') }
      else if (e.key === 'Alt' && !e.repeat) { e.preventDefault(); void pickApi.control(picking, 'parent') }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); void pickApi.control(picking, 'cancel') }
  }, [picking, pickApi])

  const load = useCallback((next: string) => {
    void ref.current?.loadURL(next).catch((e) => {
      const msg = String(e?.message || e)
      if (/ERR_ABORTED|\(-3\)/.test(msg)) return // 被新导航取代,不算失败
      setLoading(false)
      setErr(loadFail(next, msg))
      remember(next)
    })
  }, [remember])
  const go = useCallback((raw: string) => {
    const next = normalizeAddress(raw)
    if (next) load(next)
  }, [load])
  // 打不开时「刷新」= 重试那个地址:reload() 重载的是 Chromium 的错误页,什么都不会发生(空白)。
  const retry = useCallback(() => { if (err) load(err.url) }, [err, load])

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      <div ref={barRef} style={bar}>
        <button className="btn ghost sm" data-press="back" disabled={!nav.back} onClick={() => ref.current?.goBack()} title={t('browser.back')}><ArrowLeft size={14} /></button>
        <button className="btn ghost sm" data-press="forward" disabled={!nav.forward} onClick={() => ref.current?.goForward()} title={t('browser.forward')}><ArrowRight size={14} /></button>
        <button
          className="btn ghost sm"
          data-press={loading ? undefined : 'reload'}
          onClick={() => (loading ? ref.current?.stop() : err ? retry() : ref.current?.reload())}
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
            flex: 1, minWidth: 0, fontSize: 'var(--ui-font-meta, 12px)', padding: '4px 8px', borderRadius: 'var(--radius-sm, 6px)',
            border: 'var(--border-width, 1px) solid var(--border)', background: 'var(--bg)', color: 'inherit',
          }}
        />
        {pickApi && (
          <button
            className="btn ghost sm"
            data-press="pick"
            aria-pressed={picking !== null}
            disabled={picking === null && (url === HOME_URL || !!err)}
            onClick={() => { void pick() }}
            title={t('browser.pick')}
            aria-label={t('browser.pick')}
            style={picking !== null ? { background: 'var(--overlay-medium)', borderColor: 'var(--hover-line)' } : undefined}
          >
            <MousePointerClick size={14} />
          </button>
        )}
        <button className="btn ghost sm" onClick={() => window.tangu?.openExternal?.(err?.url ?? url)} title={t('browser.openExternal')}><ExternalLink size={14} /></button>
      </div>
      {picking !== null && (
        <div
          className="browser-pick-hint"
          role="status"
          style={{
            position: 'absolute', left: '50%', top: (barRef.current?.offsetHeight ?? 36) + 12, transform: 'translateX(-50%)', zIndex: 5, pointerEvents: 'none',
            padding: '5px 12px', borderRadius: 'var(--radius-pill, 999px)', background: 'var(--bg-card, var(--bg))', boxShadow: 'var(--card-shadow)',
            fontSize: 'var(--ui-font-caption, 11px)', fontWeight: 500, lineHeight: 1.3, color: 'var(--text)', whiteSpace: 'nowrap',
          }}
        >
          {t('browser.pick.hint')}<span style={{ color: 'var(--text-muted)' }}>{t('browser.pick.keys', { alt: ALT_KEY })}</span>
        </div>
      )}
      {pickMsg && !err && <div role="status" style={{ padding: '6px 10px', fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>{pickMsg}</div>}
      <div className="browser-stage">
      <Webview
        ref={ref as unknown as React.Ref<HTMLElement>}
        src={initial.current}
        partition={BROWSER_PARTITION}
        // 站点里的 target=_blank 要能触发主进程的 window-open 钩子(它 deny 掉并回投成新的内置浏览器标签);
        // 不加这条则整类链接在 guest 里被静默吞掉。
        allowpopups="true"
        style={{ flex: 1, minHeight: 0, border: 'none', background: '#fff' }}
      />
      {/* 打不开:盖在 webview 上的居中空态(webview 留着,重试 / 改地址照常走它)。地址栏不动,用户能直接改。 */}
      {err && (
        <div className="browser-fail" data-loading={loading || undefined} role="alert">
          {loading
            ? <EmptyState icon={Loader2} title={t('browser.fail.loading')} />
            : <EmptyState
                icon={GlobeLock}
                title={t('browser.fail.title')}
                line={<>{t(`browser.fail.${err.kind}`, { host: hostOf(err.url) || err.url })}<span className="browser-fail-code">{err.code}</span></>}
                action={{ label: t('browser.fail.retry'), icon: RotateCw, onClick: retry, action: 'retry' }}
                secondary={window.tangu?.openExternal && <button type="button" className="btn" data-action="open-external" onClick={() => void window.tangu?.openExternal?.(err.url)}><ExternalLink size={14} />{t('browser.openExternal')}</button>}
              />}
        </div>
      )}
      </div>
    </div>
  )
}
