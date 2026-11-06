/** 选中块 / 开关旋钮的「水滴」走法(动效主题方案 A2,2026-11-06):动效主题是水滴时,分段胶囊的滑块和开关旋钮
 *  不平移、不拉伸,而是像手机 Dock 那样**流过去** —— 源先鼓一下、头朝目标走、中间一根丝在 0.6D 断、源缩没。
 *  别的动效主题(Genesis / 拉伸 / 平移)这里什么都不做,滑块照旧由 CSS 的 left / right 过渡走(sidebar2.css、viewModes.css)。
 *
 *  做法:滑块 / 旋钮自己的 CSS 过渡在水滴主题下关掉(base.css 按 data-motion-theme),一换格就到终点;这里在它身后
 *  插一层融球(SVG 模糊 + 透明度阈值,sRGB,理由同 droplet.ts),滑块流的时候藏着,流完一帧接手。
 *  旋钮只有 14px:σ 4 会被阈值削掉一圈,用 σ 2、阈值 0.5(不吹胖)。深色下开关旋钮关 / 开颜色不同,融球跟着变色,接手不跳。
 *  减少动态效果 / 「只淡入淡出」时不流(滑块直接到位)。 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'
import { ms, curve } from './droplet'
import { motionTheme } from './panelMotion'

const FILTERS: Record<'seg' | 'knob', { id: string; sd: number; matrix: string }> = {
  seg: { id: 'lcl-flow-goo', sd: 4, matrix: '0 0 0 20 -8' },
  knob: { id: 'lcl-flow-goo-s', sd: 2, matrix: '0 0 0 18 -9' },
}
function ensureFilter(kind: 'seg' | 'knob'): string {
  const f = FILTERS[kind]
  if (!document.getElementById(f.id)) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.innerHTML = `<filter id="${f.id}" x="-30%" y="-100%" width="160%" height="300%" color-interpolation-filters="sRGB">`
      + `<feGaussianBlur in="SourceGraphic" stdDeviation="${f.sd}" result="b"/>`
      + `<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${f.matrix}"/></filter>`
    document.body.appendChild(svg)
  }
  return f.id
}

function splitAlpha(c: string): { rgb: string; a: number } {
  const m = /rgba?\(([^)]+)\)/.exec(c)
  if (!m) return { rgb: c, a: 1 }
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
  return { rgb: `rgb(${p[0]}, ${p[1]}, ${p[2]})`, a: p.length > 3 ? p[3] : 1 }
}

type Rect = { x: number; y: number; w: number; h: number }
/** 正在流的那一次:stop = 收掉融球层、交还滑块;where = 头此刻在哪(相对 host)。 */
const flows = new WeakMap<HTMLElement, { stop: () => void; where: () => Rect }>()

/** 让 thumb 从 from 流到 to(两者是相对 host 的盒子,单位 = host 的 CSS px)。thumb 此刻应已在 to。
 *  上一次还没流完(连点):从头此刻的位置接着流,不跳回上一个目标格。 */
export function flowThumb(host: HTMLElement, thumb: HTMLElement, from: Rect, to: Rect, opt: { kind?: 'seg' | 'knob'; duration?: number; fromColor?: string } = {}): void {
  const prior = flows.get(host)
  if (prior) { from = prior.where(); prior.stop() }
  if (reducedMotion() || typeof thumb.animate !== 'function') return
  const kind = opt.kind ?? 'seg'
  const filter = ensureFilter(kind)
  const D = opt.duration ?? ms('--droplet-duration', 420)
  const surface = curve('--ease-surface', 'cubic-bezier(0.22, 1, 0.36, 1)')
  const calm = curve('--ease-calm', 'cubic-bezier(0.33, 1, 0.68, 1)')
  const exit = curve('--ease-exit', 'cubic-bezier(0.4, 0, 1, 1)')
  const cs = getComputedStyle(thumb)
  const to0 = splitAlpha(cs.backgroundColor)
  const from0 = opt.fromColor ? splitAlpha(opt.fromColor) : to0
  const r = parseFloat(cs.borderTopLeftRadius) || 8
  const PAD = 14
  const layer = document.createElement('div')
  layer.className = 'lcl-flow'
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, { left: `${-PAD}px`, top: `${-PAD}px`, right: `${-PAD}px`, bottom: `${-PAD}px`, opacity: String(to0.a), filter: `url(#${filter})` })
  host.insertBefore(layer, host.firstChild)
  const blob = (b: Rect): HTMLElement => {
    const el = document.createElement('i')
    Object.assign(el.style, { left: `${b.x + PAD}px`, top: `${b.y + PAD}px`, width: `${b.w}px`, height: `${b.h}px`, borderRadius: `${Math.min(r, b.h / 2, b.w / 2)}px`, background: from0.rgb })
    layer.appendChild(el)
    return el
  }
  const tail = blob(from), head = blob(from)
  const dx = to.x - from.x, dy = to.y - from.y
  const vertical = Math.abs(dy) > Math.abs(dx)
  const cx = from.x + from.w / 2, cy = from.y + from.h / 2, th = vertical ? from.w : from.h
  const neck = document.createElement('i'), core = document.createElement('i')
  Object.assign(neck.style, vertical
    ? { left: `${cx - th / 2 + PAD}px`, top: `${Math.min(cy, cy + dy) + PAD}px`, width: `${th}px`, height: `${Math.abs(dy)}px`, transformOrigin: dy > 0 ? '50% 0' : '50% 100%' }
    : { left: `${Math.min(cx, cx + dx) + PAD}px`, top: `${cy - th / 2 + PAD}px`, width: `${Math.abs(dx)}px`, height: `${th}px`, transformOrigin: dx > 0 ? '0 50%' : '100% 50%' })
  Object.assign(core.style, { position: 'absolute', inset: '0', background: from0.rgb, borderRadius: `${th / 2}px` })
  neck.appendChild(core)
  layer.appendChild(neck)
  const axis = vertical ? 'scaleY' : 'scaleX', thin = vertical ? 'scaleX' : 'scaleY'
  const anims: Animation[] = [
    tail.animate([{ transform: 'scale(1)', offset: 0, easing: calm }, { transform: 'scale(1.08)', offset: 0.14, easing: calm }, { transform: 'scale(1)', offset: 0.3, easing: exit }, { transform: 'scale(0)', offset: 0.6 }, { transform: 'scale(0)', offset: 1 }], { duration: D, fill: 'both' }),
    head.animate([{ transform: 'translate(0, 0)' }, { transform: `translate(${dx}px, ${dy}px)` }], { duration: D * 0.9, easing: surface, fill: 'both' }),
    neck.animate([{ transform: `${axis}(0)` }, { transform: `${axis}(1)` }], { duration: D * 0.9, easing: surface, fill: 'both' }),
    core.animate([{ transform: `${thin}(0.55)`, offset: 0 }, { transform: `${thin}(0.25)`, offset: 0.55 }, { transform: `${thin}(0)`, offset: 0.6 }, { transform: `${thin}(0)`, offset: 1 }], { duration: D, fill: 'both' }),
  ]
  // 颜色跟着变(深色开关:关 = 浅灰、开 = 深色),和真旋钮的底色过渡同一个时长
  if (from0.rgb !== to0.rgb) for (const el of [tail, head, core]) anims.push(el.animate([{ background: from0.rgb }, { background: to0.rgb }], { duration: ms('--duration-fast', 150), easing: surface, fill: 'forwards' }))
  const vis = thumb.style.visibility
  thumb.style.visibility = 'hidden'
  const hand = layer.animate([{ opacity: to0.a }, { opacity: to0.a }], { duration: D * 0.9 })
  const flow = {
    stop: (): void => { anims.forEach((a) => a.cancel()); hand.cancel(); layer.remove(); thumb.style.visibility = vis; if (flows.get(host) === flow) flows.delete(host) },
    where: (): Rect => boxIn(host, head),
  }
  flows.set(host, flow)
  hand.finished.then(flow.stop, () => {})
}

/** 相对 host 的盒子(host 的 CSS px,扣掉缩放)。 */
function boxIn(host: HTMLElement, el: HTMLElement): Rect {
  const z = zoomOf(host) || 1
  const h = host.getBoundingClientRect(), b = el.getBoundingClientRect()
  return { x: (b.left - h.left) / z - host.clientLeft, y: (b.top - h.top) / z - host.clientTop, w: b.width / z, h: b.height / z }
}

/** 分段胶囊:i 变了且动效主题是水滴 → 滑块流过去。thumbRef 指向滑块(.t2s-vaultseg-thumb / .lcl-vmode-thumb),
 *  它的父元素是胶囊本身。调用处与 useSegDir 并排放(同一个 i)。
 *  上一格的盒子按几何算(水滴主题下滑块恰好一格宽、各格等宽):不靠上次量的,刚从别的主题换过来第一次也能流。 */
export function useSegFlow(i: number, thumbRef: RefObject<HTMLElement | null>): void {
  const last = useRef<number | null>(null)
  useLayoutEffect(() => {
    const prev = last.current
    last.current = i
    const thumb = thumbRef.current, host = thumb?.parentElement
    if (!thumb || !host || prev === null || prev === i || motionTheme() !== 'droplet') return
    const box = boxIn(host, thumb)
    flowThumb(host, thumb, { ...box, x: box.x - (i - prev) * box.w }, box)
  }, [i]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** 开关旋钮:checked 变了且动效主题是水滴 → 旋钮流过去(颜色跟着变)。btnRef 指向 .settings-switch,旋钮是它的第一个子元素。
 *  旋钮 = 开关里直属的 <span>。上一个位置 = 当前位置在开关里左右镜像;上一个颜色记在 lastColor(换主题后第一次没有,就从目标色起)。 */
export function useKnobFlow(checked: boolean, btnRef: RefObject<HTMLElement | null>): void {
  const last = useRef<{ on: boolean; color?: string } | null>(null)
  useLayoutEffect(() => {
    const prev = last.current
    const btn = btnRef.current, knob = btn?.querySelector<HTMLElement>(':scope > span') ?? null // 流的时候第一个子元素是融球层
    if (!btn || !knob || motionTheme() !== 'droplet') { last.current = { on: checked }; return }
    // 旋钮的底色此刻还在过渡起点(刚换 class):先让它直接到终态读出目标色。只在水滴主题下这么做 ——
    // 别的主题旋钮正按 left / right 过渡拉伸,这一下会把过渡掐掉
    const was = knob.style.transition
    knob.style.transition = 'none'
    const color = getComputedStyle(knob).backgroundColor
    const box = boxIn(btn, knob)
    knob.style.transition = was
    last.current = { on: checked, color }
    if (!prev || prev.on === checked) return
    const inner = btn.clientWidth
    flowThumb(btn, knob, { ...box, x: inner - box.x - box.w }, box, { kind: 'knob', duration: 260, fromColor: prev.color })
  }, [checked]) // eslint-disable-line react-hooks/exhaustive-deps
}
