/** 侧栏悬停提示(取代行尾的计数徽章)。单例 store + Root 挂一个浮层,同 quickFind 范式。
 *
 *  时序(用户拍板):悬停 1s 弹出;移开即收。**已弹过之后 0.1s 内移到另一行 → 立刻弹**
 *  (标准 skip-delay:连续扫行时不必每行重等 1s;停手超过 0.1s 则重新计时)。
 *
 *  内容由调用方给 loader(可 async —— 文件时间要走 fs:stat)。loader 只在延时到点后才跑,
 *  所以「悬停 1s」天然节流掉了扫过的行,不会每行一次磁盘 IO。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useApp } from './stores/appStore'
import './hoverTip.css'
import { formatDateTime } from './format/time'

const SHOW_DELAY = 1000
const SKIP_DELAY = 100

export type TipLines = string[]
type Loader = () => TipLines | Promise<TipLines | null> | null

interface TipState {
  anchor: DOMRect | null
  lines: TipLines
  open(anchor: DOMRect, lines: TipLines): void
  close(): void
}
const useTip = create<TipState>((set) => ({
  anchor: null,
  lines: [],
  open: (anchor, lines) => set({ anchor, lines }),
  close: () => set({ anchor: null, lines: [] }),
}))

let timer: number | undefined
/** 上次浮层消失的时刻 —— skip-delay 的判据(0 = 从没弹过)。 */
let lastHidden = 0
/** 本次 arm 的世代号:loader 是异步的,回来时若已换行/已移开则丢弃(防串台)。 */
let gen = 0

function fire(el: HTMLElement, load: Loader, myGen: number): void {
  const r = el.getBoundingClientRect()
  void (async () => {
    let lines: TipLines | null
    try { lines = await load() } catch { lines = null }
    if (gen !== myGen || !lines?.length) return
    useTip.getState().open(r, lines)
  })()
}

/** 悬停某行时调(mouseenter)。load 返回 null/空数组 = 不弹。 */
export function armTip(el: HTMLElement, load: Loader): void {
  window.clearTimeout(timer)
  const myGen = ++gen
  const warm = lastHidden > 0 && Date.now() - lastHidden <= SKIP_DELAY
  if (warm) fire(el, load, myGen)
  else timer = window.setTimeout(() => fire(el, load, myGen), SHOW_DELAY)
}

/** 移开某行时调(mouseleave)。 */
export function disarmTip(): void {
  window.clearTimeout(timer)
  gen++
  if (useTip.getState().anchor) lastHidden = Date.now()
  useTip.getState().close()
}

type TipHandlers = {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void
  onBlur?: () => void
}

/** 给行元素的 props;直接摊进 JSX 即可。
 *  opts.focus:键盘聚焦(:focus-visible)时也弹、失焦收起 —— 提示里有**独有信息**的行用(Orbit 一级行的「类型 · 相对时间」,
 *  Codex 第一轮 B2-4);鼠标点击带来的焦点不弹,免得点一下就冒提示。 */
export function tipProps(load: Loader, opts?: { focus?: boolean }): TipHandlers {
  const handlers: TipHandlers = {
    onMouseEnter: (e) => armTip(e.currentTarget, load),
    onMouseLeave: disarmTip,
  }
  if (opts?.focus) {
    handlers.onFocus = (e) => {
      let keyboard = true
      try { keyboard = e.currentTarget.matches(':focus-visible') } catch { /* 老内核不认伪类:按键盘处理 */ }
      if (keyboard) armTip(e.currentTarget, load)
    }
    handlers.onBlur = disarmTip
  }
  return handlers
}

/** 时间戳 → 「2026年9月17日 14:05」/「Sep 17, 2026, 14:05」(跟界面语言;秒是噪音,不显示)。 */
export function fmtTime(ms: number): string {
  return formatDateTime(ms, { year: 'always' })
}

/** 文案:loader 跑在事件回调里(非渲染),故走 store 取 tr,免得给一堆无 i18n 的文件塞 hook。 */
export const tipT = (k: string, vars?: Record<string, unknown>): string => useApp.getState().tr(k, vars)

/** 磁盘条目的提示行:文件 → 名 + 修改 + 创建;目录 → 子项计数(名字行上已有,不重复)。
 *  走主进程 fs:stat —— 悬停 1s 才调,天然节流。非 electron / 读不到 → null(不弹)。 */
export async function fsTipLines(absPath: string, displayName: string): Promise<TipLines | null> {
  const st = await window.tangu?.statPath?.(absPath).catch(() => null)
  if (!st) return null
  if (st.isDir) return [tipT('tip.folder', { files: st.files ?? 0, folders: st.folders ?? 0 })]
  const lines = [displayName, tipT('tip.modified', { t: fmtTime(st.mtimeMs) })]
  // birthtimeMs=null:该文件系统给不出创建时间(Linux 常见)→ 宁可少一行,也不显示假日期。
  if (st.birthtimeMs) lines.push(tipT('tip.created', { t: fmtTime(st.birthtimeMs) }))
  return lines
}

export function HoverTip() {
  const anchor = useTip((s) => s.anchor)
  const lines = useTip((s) => s.lines)
  const ref = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState(false)

  // 默认贴行右侧;右边放不下(如工作区 view 被拖到右栏)则翻到左侧。measure 后一次纠偏。
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const w = ref.current.offsetWidth
    setFlip(anchor.right + 10 + w > window.innerWidth - 8)
  }, [anchor, lines])
  // 滚动/改窗时锚点就失效了 —— 直接收掉,不做跟随(浮层是瞬时提示,不值当上 observer)。
  useEffect(() => {
    if (!anchor) return
    window.addEventListener('scroll', disarmTip, true)
    window.addEventListener('resize', disarmTip)
    return () => {
      window.removeEventListener('scroll', disarmTip, true)
      window.removeEventListener('resize', disarmTip)
    }
  }, [anchor])

  if (!anchor) return null
  const style = flip
    ? { right: window.innerWidth - anchor.left + 10, top: anchor.top + anchor.height / 2 }
    : { left: anchor.right + 10, top: anchor.top + anchor.height / 2 }
  return (
    // key 随锚点走:skip-delay 连跳时 close→open 可能被 React 批进同一次提交(div 被复用),
    // 那样 @starting-style 不重放、浮层会瞬移。换 key 强制重挂 → 每次都重新弹一下。
    <div key={`${anchor.top}:${lines[0]}`} ref={ref} className="amx-tip" data-flip={flip || undefined} style={style} role="tooltip">
      {lines.map((l, i) => <div key={i} className={i === 0 ? 'amx-tip-head' : undefined}>{l}</div>)}
    </div>
  )
}
