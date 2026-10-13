/**
 * 应用 / 窗口引用在界面上的那一半(契约见 shared/appRefs.ts):图标与状态的缓存 + 文字里的那枚芯片。
 *
 * 聊天气泡(ChatWikiLink)、输入框「已选择」条(RefChipView)、引用菜单、笔记编辑器都从这里拿图标和状态。
 * 宿主没有 `window.tangu.appRefs`(网页版 / 手机)时芯片只显示名字、不可点;Linux 桌面有这组方法但什么都列不出,状态恒为「这台设备上没有」。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { appRefKey, parseAppRefInner, type AppRef, type AppRefState, type AppRefStatus } from '../../../shared/appRefs'
import { registerMessages, translate, useI18n } from '../i18n'
import './appRefs.css'

registerMessages({
  'appref.sub.live': { zh: '{app} · 窗口还开着', en: '{app} · Window is open' },
  'appref.sub.closed': { zh: '{app} · 找不到这个窗口了', en: "{app} · Can't find this window" },
  'appref.sub.running': { zh: '应用 · 正在运行', en: 'App · Running' },
  'appref.sub.idle': { zh: '应用 · 没在运行', en: 'App · Not running' },
  'appref.sub.missing': { zh: '这台设备上没有这个应用', en: "This app isn't on this device" },
  'appref.hint.live': { zh: '点击切到这个窗口', en: 'Click to switch to this window' },
  'appref.hint.closed': { zh: '点击打开 {app}', en: 'Click to open {app}' },
  'appref.hint.running': { zh: '点击切过去', en: 'Click to switch to it' },
  'appref.hint.idle': { zh: '点击启动', en: 'Click to launch' },
})

export const appRefsSupported = (): boolean => !!window.tangu?.appRefs

// ── 小缓存:同一轮渲染里要的图标 / 状态攒成一次 IPC ──
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const emit = (): void => { listeners.forEach((fn) => fn()) }

/** 主进程每次最多认这么多条(electron/appIcons.ts 的 MAX_IDS、appRefs.status 的 slice),多的分几次问。 */
const BATCH = 64
const batches = <T,>(all: T[]): T[][] => Array.from({ length: Math.ceil(all.length / BATCH) }, (_, i) => all.slice(i * BATCH, (i + 1) * BATCH))

const icons = new Map<string, string | null>()
let iconQueue = new Set<string>()

function wantIcon(id: string): void {
  if (icons.has(id) || iconQueue.has(id) || !window.tangu?.appRefs) return
  if (!iconQueue.size) setTimeout(() => {
    const all = [...iconQueue]
    iconQueue = new Set()
    // 问失败的不记(下次挂载再问);问到了但没有这一项 = 确实没有图标
    for (const ids of batches(all)) void window.tangu!.appRefs!.icons(ids).then((got) => {
      for (const one of ids) icons.set(one, got[one] ?? null)
      emit()
    }, () => {})
  }, 0)
  iconQueue.add(id)
}

/** 应用图标(dataURL)。还没取到 / 取不到 → null,调用方画通用图标。 */
export function useAppIcon(id: string): string | null {
  useEffect(() => wantIcon(id), [id])
  return useSyncExternalStore(subscribe, () => icons.get(id) ?? null)
}

const STATUS_TTL_MS = 5_000
const statuses = new Map<string, { at: number; status: AppRefStatus }>()
let statusQueue = new Map<string, AppRef>()

/** 重新问一次这条引用的状态(悬停、点击之后调;TTL 内不重复问)。 */
export function refreshAppRef(ref: AppRef, force = false): void {
  const key = appRefKey(ref)
  const hit = statuses.get(key)
  if (!window.tangu?.appRefs || statusQueue.has(key) || (!force && hit && Date.now() - hit.at < STATUS_TTL_MS)) return
  if (!statusQueue.size) setTimeout(() => {
    const all = [...statusQueue.entries()]
    statusQueue = new Map()
    for (const batch of batches(all)) void window.tangu!.appRefs!.status(batch.map(([, r]) => r)).then((got) => {
      batch.forEach(([k], i) => { if (got[i]) statuses.set(k, { at: Date.now(), status: got[i] }) })
      emit()
    }, () => {})
  }, 0)
  statusQueue.set(key, ref)
}

export function useAppRefStatus(ref: AppRef): AppRefStatus | null {
  const key = appRefKey(ref)
  useEffect(() => refreshAppRef(ref), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return useSyncExternalStore(subscribe, () => statuses.get(key)?.status ?? null)
}

/** 悬停卡的两行字(笔记编辑器那边没有 React,也用这份拼 title)。 */
export function appRefCardText(ref: AppRef, status: AppRefStatus | null): { sub: string; hint: string } {
  const state: AppRefState | null = appRefsSupported() ? status?.state ?? null : 'missing'
  if (!state) return { sub: '', hint: '' }
  const app = status?.appName || ref.id
  return {
    sub: translate(`appref.sub.${state}`, { app }),
    hint: state === 'missing' ? '' : translate(`appref.hint.${state}`, { app }),
  }
}

export function openAppRef(ref: AppRef): void {
  void window.tangu?.appRefs?.open(ref).then(() => refreshAppRef(ref, true), () => {})
}

/** `[[…]]` 的内文如果是应用 / 窗口引用就切过去并返回 true —— 调用方据此不再把它当笔记链接(属性值、数据库格子这些不走编辑器芯片的地方)。 */
export function openAppRefInner(inner: string): boolean {
  const ref = parseAppRefInner(inner)
  if (ref) openAppRef(ref)
  return !!ref
}

export function AppRefIcon({ id, className = 'app-ref-ico' }: { id: string; className?: string }) {
  const src = useAppIcon(id)
  return src ? <img className={className} src={src} alt="" draggable={false} /> : <AppWindow className={className} aria-hidden />
}

/** 文字里的引用芯片:应用图标 + 名字;悬停出小卡,点击切过去。窗口关了 / 这台设备上没有 → 变灰。 */
export function AppRefChip({ appRef }: { appRef: AppRef }) {
  useI18n() // 切语言时重渲(卡片文案走 translate)
  const status = useAppRefStatus(appRef)
  const state = appRefsSupported() ? status?.state : 'missing'
  const canOpen = appRefsSupported() && state !== 'missing'
  const { sub, hint } = appRefCardText(appRef, status)
  // 悬停卡挂到 body 上、按芯片的位置摆(OverlayAt 负责收进窗口、处理界面缩放):做成芯片的子元素的话,
  // 贴着滚动区上沿 / 窄栏右沿时会被裁掉一截。停留 0.3 秒才出;滚动、点击、离开就收。
  const [card, setCard] = useState<{ x: number; top: number; bottom: number } | null>(null)
  const timer = useRef(0)
  const hide = (): void => { window.clearTimeout(timer.current); setCard(null) }
  const show = (el: HTMLElement): void => {
    refreshAppRef(appRef)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = el.getClientRects()[0] ?? el.getBoundingClientRect() // 折行的芯片贴第一行
      setCard({ x: r.left, top: r.top, bottom: r.bottom })
    }, 300)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const shown = !!card
  useEffect(() => {
    if (!shown) return
    const close = (): void => setCard(null)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [shown])
  const open = (): void => { hide(); if (canOpen) openAppRef(appRef) }
  const cps = [...appRef.name]
  const head = cps.slice(0, 2).join('')
  const rest = cps.slice(2).join('')
  return (
    <span
      className="app-ref"
      data-kind={appRef.kind}
      data-state={state}
      data-off={state === 'closed' || state === 'missing' || undefined}
      role={canOpen ? 'link' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); open() }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open() } }}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={hide}
      onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget) }}
      onBlur={hide}
    >
      {/* 图标和名字的头两个字包在一个不折行的块里:不然折行时图标会单独留在上一行末尾、名字掉到下一行
          (试过在两者之间放 U+2060,Chromium 在图片旁边照样断) */}
      <span className="app-ref-head"><AppRefIcon id={appRef.id} />{head}</span>{rest}
      {card && sub && createPortal(
        <OverlayAt className="app-ref-card" role="tooltip" x={card.x} y={card.bottom + 6} anchorTop={card.top - 6} prefer="above">
          <AppRefIcon id={appRef.id} className="app-ref-card-ico" />
          <span className="app-ref-card-main">
            <b>{appRef.name}</b>
            <small>{sub}</small>
            {hint && <em>{hint}</em>}
          </span>
        </OverlayAt>,
        document.body,
      )}
    </span>
  )
}
