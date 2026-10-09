/**
 * SketchCard —— sketch 工具画在对话流里的可交互 HTML 卡片(三端共用,按消息顺序段穿插渲染)。
 * 隔离配方与主题桥见 sketchWrapper.ts 头注;高度由卡内 ResizeObserver 经 postMessage 上报,
 * 父侧只认 event.source 配对并夹断范围(srcdoc 的 event.origin 恒为字符串 "null",不可用)。
 * 折叠:默认高度上限 = 右侧车道那两张卡(任务概览/Agent Desk)的高度,见 base.css .sketch-clip。
 * 草稿(item.draft,10-09):参数还在流式生成时就按已到达的 html 画(sketchDraft.ts 去掉行为脚本),节流 400ms 重绘;
 * 终稿到达换成同 callId 的正式卡 —— 同一个组件实例,只多一次 srcdoc 重建。
 * 回头改答案(forsionSketch.ask → 'sketch-ask'):只在对话里接(onAsk 由 ChatView 的 onSuggest 给),限长 400、每卡 1.5s 一次。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buildSketchDoc, readSketchTheme, subscribeThemeChange,
  SKETCH_SANDBOX, SKETCH_MIN_H, SKETCH_MAX_H, SKETCH_INITIAL_H,
} from './sketchWrapper'
import { useI18n } from '../i18n'
import { readSketchState, saveSketchState, serializeSketchState, sketchStateKey } from './sketchState'
import { draftHtml } from './sketchDraft'
import { useThrottled } from '../hooks/useThrottled'
import type { SketchItem } from '../types'

/** 卡内 ask() 的接口:把这句话当用户的下一条消息发出去(对话给 onSuggest;笔记里的交互块不给 → 不接)。 */
type SketchAsk = (text: string) => void
const ASK_MAX_CHARS = 400
const ASK_MIN_GAP_MS = 1500

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

/** 宿主侧的手势判定(ask 的授权):这张 iframe 是当前焦点,且父文档带着瞬时用户激活(子帧里的点击 / 键盘会上传)。 */
export function userTouchedFrame(frame: HTMLIFrameElement | null): boolean {
  if (!frame || document.activeElement !== frame) return false
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation
  return activation?.isActive === true
}

const SketchFrame: React.FC<{ item: SketchItem; actions?: SketchActions; stateScope?: string; onAsk?: SketchAsk }> = ({ item, actions, stateScope, onAsk }) => {
  const { t } = useI18n()
  // 草稿不存状态(半截 html 的 key 没有意义,也不该被恢复);终稿到达时 key 才成立。
  const stateKey = useMemo(() => stateScope && !item.draft ? sketchStateKey(stateScope, item.callId, item.html) : null, [stateScope, item.callId, item.html, item.draft])
  // 草稿:节流重绘(每次换 srcdoc = iframe 重载)+ 去掉行为脚本;终稿直接用 item.html,不经节流(到了就画)。
  const throttledHtml = useThrottled(item.html, 400)
  const srcHtml = item.draft ? draftHtml(throttledHtml) : item.html
  const askRef = useRef<SketchAsk | undefined>(onAsk)
  askRef.current = onAsk
  const draftRef = useRef(!!item.draft)
  draftRef.current = !!item.draft
  const lastAsk = useRef(0)
  const initialState = useMemo(() => stateKey ? readSketchState(stateKey) : null, [stateKey])
  const rootRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [h, setH] = useState(SKETCH_INITIAL_H)
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
      if (d && d.type === 'sketch-ask' && typeof d.text === 'string' && askRef.current && !draftRef.current && userTouchedFrame(frameRef.current)) {
        const now = Date.now()
        const text = d.text.trim().slice(0, ASK_MAX_CHARS)
        if (text && now - lastAsk.current >= ASK_MIN_GAP_MS) { lastAsk.current = now; askRef.current(text) }
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

  const doc = useMemo(() => (vars ? buildSketchDoc(srcHtml, vars, initialState) : ''), [srcHtml, vars, initialState])
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
        {vars && <iframe ref={frameRef} className="sketch-frame" sandbox={SKETCH_SANDBOX} srcDoc={doc} style={{ height: h }} title={item.title || 'sketch'} />}
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
