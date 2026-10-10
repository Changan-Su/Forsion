/**
 * SketchCard —— sketch 工具画在对话流里的可交互 HTML 卡片(三端共用,按消息顺序段穿插渲染)。
 * 隔离配方与主题桥见 sketchWrapper.ts 头注;高度由卡内 ResizeObserver 经 postMessage 上报,
 * 父侧只认 event.source 配对并夹断范围(srcdoc 的 event.origin 恒为字符串 "null",不可用)。
 * 折叠:只夹超过聊天栏 1.6 倍高的巨卡,见 base.css .sketch-clip。
 * 直播(item.draft,10-09 二轮):**iframe 只装一次**(srcdoc 按挂载时的 html 定死,之后永不变);参数还在流式生成时,
 * 把去掉行为脚本的 html 经 postMessage('sketch-draft')发进卡里**原地打补丁**(sketchRuntime.js morph:同位同标签保留、
 * 文字原地续写、新节点淡入),终稿经 'sketch-final' 在原地接上脚本 —— 全程不重载、不闪、高度带过渡。
 * 回头改答案(forsionSketch.ask → 'sketch-ask'):只在对话里接(onAsk 由 ChatView 的 onSuggest 给),限长 400、每卡 1.5s 一次。
 * 复制(forsionSketch.copy → 'sketch-copy'):宿主代写剪贴板,同一道手势闸。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buildSketchDoc, readSketchTheme, subscribeThemeChange,
  SKETCH_SANDBOX, SKETCH_MIN_H, SKETCH_MAX_H, SKETCH_INITIAL_H,
} from './sketchWrapper'
import { useI18n } from '../i18n'
import { readSketchState, saveSketchState, serializeSketchState, sketchStateKey } from './sketchState'
import { draftHtml } from './sketchDraft'
import type { SketchItem } from '../types'

/** 卡内 ask() 的接口:把这句话当用户的下一条消息发出去(对话给 onSuggest;笔记里的交互块不给 → 不接)。 */
type SketchAsk = (text: string) => void
const ASK_MAX_CHARS = 400
const ASK_MIN_GAP_MS = 1500
const COPY_MAX_CHARS = 20000
const DRAFT_THROTTLE_MS = 150

/** ⚠️Capacitor 原生 App(Android WebView):addJavascriptInterface 原生桥对子 iframe 可见,sandbox/CSP
 *  拦不住 JS 桥对象——绝不在此渲染模型 HTML(见 sketch.ts 引擎门禁头注)。web-on-phone 是普通浏览器
 *  无 window.Capacitor → 不误伤;desktop/web 恒无此全局。跨端(desktop 画的卡在手机上看历史)靠这道兜底。 */
function isCapacitorNative(): boolean {
  try {
    const cap = (window as any).Capacitor
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform())
  } catch { return false }
}

/** 卡头右侧的附加操作(对话里给「插入笔记」;笔记里的交互块不给,免得插回自己)。 */
type SketchActions = (item: SketchItem) => React.ReactNode

/** 宿主侧的手势判定(ask / copy 的授权)之一:这张 iframe 是当前焦点,且父文档带着瞬时用户激活(子帧里的点击 / 键盘会上传)。
 *  ⚠️这两条单独不够(Codex 10-09 二轮 P1):卡内脚本可以 focus() 自己的控件把焦点抢过来,用户 5s 内刚在 composer 里敲过键时父文档的
 *  激活还在 —— 所以消息还必须带卡内运行时持有的 nonce(见 sketchRuntime.js 头注):运行时自己核的是**子帧**的 userActivation,父文档
 *  的输入传不进去;绕过运行时直接 postMessage 的没有 nonce。 */
export function userTouchedFrame(frame: HTMLIFrameElement | null): boolean {
  if (!frame || document.activeElement !== frame) return false
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation
  return activation?.isActive === true
}
const newNonce = (): string => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''))

const SketchFrame: React.FC<{ item: SketchItem; actions?: SketchActions; stateScope?: string; onAsk?: SketchAsk }> = ({ item, actions, stateScope, onAsk }) => {
  const { t } = useI18n()
  // 草稿不存状态(半截 html 的 key 没有意义,也不该被恢复);终稿到达时 key 才成立。
  const stateKey = useMemo(() => stateScope && !item.draft ? sketchStateKey(stateScope, item.callId, item.html) : null, [stateScope, item.callId, item.html, item.draft])
  const askRef = useRef<SketchAsk | undefined>(onAsk)
  askRef.current = onAsk
  const draftRef = useRef(!!item.draft)
  draftRef.current = !!item.draft
  const lastAsk = useRef(0)
  // ⚠️srcdoc 只按**挂载那一刻**定:html 与本地状态都冻在 ref 里。之后的草稿增量 / 终稿全部走 postMessage 原地打补丁,
  //    任何一处让 doc 重算 = iframe 重载 = 闪 + 丢交互状态(草稿→终稿时 stateKey 从 null 变成有值,也不许触发重建)。
  const mountHtml = useRef(item.draft ? draftHtml(item.html) : item.html)
  const mountState = useRef<unknown>(stateKey ? readSketchState(stateKey) : null)
  const nonce = useRef(newNonce())
  const rootRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // 直播中挂载的卡从最小高度长起(高度带过渡),历史卡照旧先给个占位高度免得页面跳。
  const [h, setH] = useState(item.draft ? SKETCH_MIN_H : SKETCH_INITIAL_H)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  // 首帧主题快照。必须在 paint 前拿到(useLayoutEffect),否则 srcdoc 二次重建 = iframe 重载 + 闪一下。
  // ⚠️此后**永不再 set**:换肤走下面的 postMessage 就地改,重建 srcdoc 会丢掉卡内交互状态。
  const [vars, setVars] = useState<Record<string, string> | null>(null)
  useLayoutEffect(() => { if (rootRef.current) setVars(readSketchTheme(rootRef.current)) }, [])

  // 换肤/明暗/扁平切换 → 就地推变量(targetOrigin 只能是 '*':沙箱帧是不透明源,载荷仅颜色值)
  useEffect(() => subscribeThemeChange(() => {
    const el = rootRef.current
    const w = frameRef.current?.contentWindow
    if (el && w) w.postMessage({ type: 'sketch-theme', vars: readSketchTheme(el) }, '*')
  }), [])

  // 直播补丁:iframe load 之后才发(之前发的会丢);草稿节流 150ms,发时再看一次 draftRef —— 终稿已到就不能再把卡打回无脚本的草稿;
  // 终稿只发一次(finalSent)。历史卡(挂载即终稿)什么都不发。
  const ready = useRef(false)
  const finalSent = useRef(false)
  const pendingDraft = useRef<string | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const post = (msg: unknown): void => { frameRef.current?.contentWindow?.postMessage(msg, '*') }
  const flushDraft = (): void => {
    draftTimer.current = undefined
    if (!ready.current) return // iframe 还没 load:留着,onFrameLoad 补发(Codex 10-09 P3:别在这里把它清掉)
    const html = pendingDraft.current
    pendingDraft.current = null
    if (html !== null && draftRef.current && !finalSent.current) post({ type: 'sketch-draft', html })
  }
  const sendFinal = (): void => {
    if (!ready.current || finalSent.current) return
    finalSent.current = true
    clearTimeout(draftTimer.current); draftTimer.current = undefined; pendingDraft.current = null
    post({ type: 'sketch-final', html: item.html })
  }
  const wasDraft = useRef(!!item.draft)
  useEffect(() => {
    if (item.draft) {
      pendingDraft.current = draftHtml(item.html)
      if (!draftTimer.current) draftTimer.current = setTimeout(flushDraft, DRAFT_THROTTLE_MS)
    } else if (wasDraft.current) {
      sendFinal()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.html, item.draft])
  useEffect(() => () => clearTimeout(draftTimer.current), [])
  const onFrameLoad = (): void => {
    ready.current = true
    // 挂载后 load 之前到达的增量 / 终稿在这里补发
    if (!draftRef.current && wasDraft.current) sendFinal()
    else if (pendingDraft.current !== null) flushDraft()
  }

  useEffect(() => {
    let pending: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      if (stateKey && pending !== undefined) saveSketchState(stateKey, JSON.parse(pending))
      pending = undefined
      timer = undefined
    }
    const onMsg = (e: MessageEvent): void => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const d: any = e.data
      if (d?.type === 'sketch-state' && stateKey) {
        const next = serializeSketchState(d.state)
        if (next !== undefined) {
          pending = next
          if (!timer) timer = setTimeout(flush, 200)
        }
      }
      if (d && d.type === 'sketch-height' && Number.isFinite(Number(d.height))) {
        setH(Math.min(SKETCH_MAX_H, Math.max(SKETCH_MIN_H, Math.ceil(Number(d.height)))))
      }
      // 卡内 ask():草稿不接(半成品的按钮不算数),没有接口不接(笔记 / 只读),限频限长;文本是模型写的,照常当用户消息发出、用户看得见。
      // ⚠️ 授权在宿主侧,不信卡内:模型 HTML 可以绕过 forsionSketch.ask() 直接 parent.postMessage(Codex 10-09)。
      //    「用户刚在这张卡里点过」= 子帧里的用户手势会把瞬时激活上传给祖先文档(navigator.userActivation,≈5s)
      //    + 焦点落在这张 iframe 上。卡一加载就自己发的:焦点还在输入框,拒;老浏览器没有 userActivation 一律拒。
      const authed = d && d.nonce === nonce.current && !draftRef.current && userTouchedFrame(frameRef.current)
      if (authed && d.type === 'sketch-ask' && typeof d.text === 'string' && askRef.current) {
        const now = Date.now()
        const text = d.text.trim().slice(0, ASK_MAX_CHARS)
        if (text && now - lastAsk.current >= ASK_MIN_GAP_MS) { lastAsk.current = now; askRef.current(text) }
      }
      // 卡内 copy():同一道手势闸;剪贴板写失败(权限 / 旧壳)静默。
      if (authed && d.type === 'sketch-copy' && typeof d.text === 'string') {
        const text = d.text.slice(0, COPY_MAX_CHARS)
        if (text) navigator.clipboard?.writeText(text).catch(() => {})
      }
    }
    window.addEventListener('message', onMsg)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('message', onMsg)
      window.removeEventListener('pagehide', flush)
      clearTimeout(timer)
      flush()
    }
  }, [stateKey])

  // 溢出判定(决定露不露展开钮)。⚠️只在**收起态**量:展开时 max-height:none → scrollHeight
  // 恒等 clientHeight,量出来永远是「不溢出」,钮会消失、收不回去。展开期间沿用上一次判定。
  useEffect(() => {
    const el = clipRef.current
    if (!el || open) return
    const measure = (): void => setOver(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [h, open])

  const doc = useMemo(() => (vars ? buildSketchDoc(mountHtml.current, vars, mountState.current, nonce.current) : ''), [vars])
  // 草稿不给头部操作(「插入笔记」插半截没意义)。
  const headActions = item.draft ? undefined : actions
  return (
    <div className="sketch-card" ref={rootRef} data-sketch-call-id={item.callId} data-sketch-draft={item.draft ? '' : undefined}>
      {(item.title || headActions) && (
        <div className="sketch-card-head">
          {item.title && <div className="sketch-card-title">{item.title}</div>}
          {headActions?.(item)}
        </div>
      )}
      <div ref={clipRef} className={`sketch-clip${open ? ' open' : ''}${over && !open ? ' faded' : ''}`}>
        {/* webhost-ok: sketch 卡的能力包络就是规格本身(JS 可跑、无网络无宿主 API,内层 CSP default-src 'none' 收口,
            见 sketchWrapper.ts 实证注);webview 反而错配:Electron-only(web/mobile 没有)且每卡一个 OS 进程。 */}
        {vars && <iframe ref={frameRef} className="sketch-frame" sandbox={SKETCH_SANDBOX} srcDoc={doc} style={{ height: h }} title={item.title || 'sketch'} onLoad={onFrameLoad} />}
      </div>
      {over && (
        <button type="button" className="sketch-card-toggle" onClick={() => setOpen((v) => !v)}>
          {t(open ? 'sketch.collapse' : 'sketch.expand')}
        </button>
      )}
    </div>
  )
}

const SketchUnavailable: React.FC<{ item: SketchItem; actions?: SketchActions }> = ({ item }) => {
  const { t } = useI18n()
  return (
    <div className="sketch-card" data-sketch-call-id={item.callId}>
      {item.title && <div className="sketch-card-title">{item.title}</div>}
      <div className="sketch-card-note">{t('sketch.mobileUnavailable')}</div>
    </div>
  )
}

export const SketchCards: React.FC<{ items: SketchItem[]; actions?: SketchActions; stateScope?: string; onAsk?: SketchAsk }> = ({ items, actions, stateScope, onAsk }) => {
  // 原生壳内一律拒渲染 iframe(桥暴露);普通浏览器/Electron 正常画。整批同判,不逐卡重算。
  const native = isCapacitorNative()
  const Card = native ? SketchUnavailable : SketchFrame
  return <>{items.map((s) => <Card key={`${stateScope || ''}:${s.callId}`} item={s} actions={native ? undefined : actions} stateScope={stateScope} onAsk={native ? undefined : onAsk} />)}</>
}
