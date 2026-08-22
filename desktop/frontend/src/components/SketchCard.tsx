/**
 * SketchCard —— sketch 工具画在对话流里的可交互 HTML 卡片(三端共用,按消息顺序段穿插渲染)。
 * 隔离配方与主题桥见 sketchWrapper.ts 头注;高度由卡内 ResizeObserver 经 postMessage 上报,
 * 父侧只认 event.source 配对并夹断范围(srcdoc 的 event.origin 恒为字符串 "null",不可用)。
 * 折叠:默认高度上限 = 右侧车道那两张卡(任务概览/Agent Desk)的高度,见 base.css .sketch-clip。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buildSketchDoc, readSketchTheme, subscribeThemeChange,
  SKETCH_SANDBOX, SKETCH_MIN_H, SKETCH_MAX_H, SKETCH_INITIAL_H,
} from './sketchWrapper'
import { useI18n } from '../i18n'
import type { SketchItem } from '../types'

/** ⚠️Capacitor 原生 App(Android WebView):addJavascriptInterface 原生桥对子 iframe 可见,sandbox/CSP
 *  拦不住 JS 桥对象——绝不在此渲染模型 HTML(见 sketch.ts 引擎门禁头注)。web-on-phone 是普通浏览器
 *  无 window.Capacitor → 不误伤;desktop/web 恒无此全局。跨端(desktop 画的卡在手机上看历史)靠这道兜底。 */
function isCapacitorNative(): boolean {
  try {
    const cap = (window as any).Capacitor
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform())
  } catch { return false }
}

const SketchFrame: React.FC<{ item: SketchItem }> = ({ item }) => {
  const { t } = useI18n()
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
    const onMsg = (e: MessageEvent): void => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const d: any = e.data
      if (d && d.type === 'sketch-height' && Number.isFinite(Number(d.height))) {
        setH(Math.min(SKETCH_MAX_H, Math.max(SKETCH_MIN_H, Math.ceil(Number(d.height)))))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

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

  const doc = useMemo(() => (vars ? buildSketchDoc(item.html, vars) : ''), [item.html, vars])
  return (
    <div className="sketch-card" ref={rootRef} data-sketch-call-id={item.callId}>
      {item.title && <div className="sketch-card-title">{item.title}</div>}
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

const SketchUnavailable: React.FC<{ item: SketchItem }> = ({ item }) => {
  const { t } = useI18n()
  return (
    <div className="sketch-card" data-sketch-call-id={item.callId}>
      {item.title && <div className="sketch-card-title">{item.title}</div>}
      <div className="sketch-card-note">{t('sketch.mobileUnavailable')}</div>
    </div>
  )
}

export const SketchCards: React.FC<{ items: SketchItem[] }> = ({ items }) => {
  // 原生壳内一律拒渲染 iframe(桥暴露);普通浏览器/Electron 正常画。整批同判,不逐卡重算。
  const native = isCapacitorNative()
  const Card = native ? SketchUnavailable : SketchFrame
  return <>{items.map((s) => <Card key={s.callId} item={s} />)}</>
}
