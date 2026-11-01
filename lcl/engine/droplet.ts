/** 液滴展开(DESIGN §3「液滴展开」,2026-10-30 用户定):浮层从发起它的小控件里「流出来」。
 *
 *  ① 源控件先鼓一下 ② 一滴液体从源朝面板的那条边冒出来,胀成面板 ③ 中间连着的丝在液体快长好时被拉断
 *  ④ 内容浮在液体上、按液体当前轮廓露出来(不等液体长完)⑤ 液体停稳那一刻真面板一帧接手(同色、不叠淡)。
 *  收起 = 倒放(0.7 倍时长):内容先淡掉,液体缩回一滴、被源吸回去。打断(开到一半就收)从当前帧接着倒放。
 *
 *  做法:面板是调用方自己的真 DOM(React 管),这里只在它身上挂 `lcl-droplet-pouring`(去底色 / 描边 / 阴影)
 *  并给它动 clip-path;液体是面板前面插的一层兄弟节点(SVG 融球滤镜:模糊 + 透明度阈值),绝不包住面板 ——
 *  filter 会让元素成为 fixed 后代的包含块(DESIGN §4),面板里的菜单会整体偏。
 *  ⚠️ 滤镜必须 color-interpolation-filters="sRGB":缺省 linearRGB 在 GPU 上 8 位往返会吃掉 --bg-card 的色调
 *  (暗色 #323134 → #323232),真面板接手时底色跳一下(10-29 用户报)。
 *  ⚠️ 真面板不能早于液体停稳出现(10-29 打回:0.28D 显形的硬边框盖住了拉丝,「没有灵动感了」)。
 *  不回弹(10-29 用户试过四档定的「无回弹」)。
 *
 *  用法:面板挂上、定好位之后 `const d = emergeDroplet(按钮, 面板)`;要收时 `await d.retract()` 再卸载面板
 *  (retract 结束时面板已 visibility: hidden,卸载晚一帧也不闪;不卸载就调 `d.cancel()` 还原);
 *  组件卸载时 `d.cancel()`。源与面板之间的缝要 ≤ 12px,再远丝连不上。减少动态效果时只淡入 / 淡出。 */
import { zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'

export interface Droplet {
  /** 倒放收回;resolve 时面板已缩成一滴、不可见,由调用方卸载。重复调用返回同一个 Promise。 */
  retract(): Promise<void>
  /** 立刻清场(不放动画):组件卸载、被别的面板顶掉时用。 */
  cancel(): void
}

const FILTER_ID = 'lcl-droplet-goo'
const POURING = 'lcl-droplet-pouring'
const PAD = 24 // 液体层比源 + 面板的外接框大一圈:模糊和鼓起都不被裁

function ensureFilter(): void {
  if (document.getElementById(FILTER_ID)) return
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.innerHTML = `<filter id="${FILTER_ID}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">`
    + '<feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>'
    + '<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9"/></filter>'
  document.body.appendChild(svg)
}

// token 从 :root 读(base.css 一份),读不到用同值兜底 —— 引擎不依赖宿主的 motionTokens.ts。
const root = (): CSSStyleDeclaration => getComputedStyle(document.documentElement)
export function ms(name: string, fallback: number): number {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(root().getPropertyValue(name).trim())
  return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : fallback
}
export const curve = (name: string, fallback: string): string => root().getPropertyValue(name).trim() || fallback

type Box = { x: number; y: number; w: number; h: number; r: number }
const inset = (b: Box, p: Box, z: number): string =>
  `inset(${(b.y - p.y) / z}px ${(p.x + p.w - b.x - b.w) / z}px ${(p.y + p.h - b.y - b.h) / z}px ${(b.x - p.x) / z}px round ${b.r / z}px)`

export function emergeDroplet(source: HTMLElement, panel: HTMLElement): Droplet {
  const kids = (): HTMLElement[] => Array.from(panel.children) as HTMLElement[]
  if (reducedMotion() || typeof panel.animate !== 'function' || !panel.parentElement) {
    // 减少动态效果:留反馈、去点缀(DESIGN §3 规矩 8)—— 只淡入 / 淡出,不形变
    const fade = (from: number, to: number, duration: number): Animation =>
      panel.animate([{ opacity: from }, { opacity: to }], { duration, easing: curve('--ease-calm', 'ease') })
    panel.style.visibility = ''
    fade(0, 1, ms('--duration-fast', 150))
    let closing: Promise<void> | null = null
    return {
      retract: () => (closing ??= fade(1, 0, ms('--menu-exit-duration', 80)).finished.then(() => { panel.style.visibility = 'hidden' }, () => undefined)),
      cancel: () => { panel.getAnimations().forEach((a) => a.cancel()); panel.style.visibility = '' },
    }
  }
  ensureFilter()
  panel.style.visibility = ''
  const D = ms('--droplet-duration', 420)
  const surface = curve('--ease-surface', 'cubic-bezier(0.22, 1, 0.36, 1)')
  const calm = curve('--ease-calm', 'cubic-bezier(0.33, 1, 0.68, 1)')
  const exit = curve('--ease-exit', 'cubic-bezier(0.4, 0, 1, 1)')
  const s = source.getBoundingClientRect()
  const pr = panel.getBoundingClientRect()
  const pcs = getComputedStyle(panel)
  const radius = parseFloat(pcs.borderTopLeftRadius) || 12
  const pz = zoomOf(panel)
  const p: Box = { x: pr.left, y: pr.top, w: pr.width, h: pr.height, r: radius * pz }
  // 出口:源朝面板的那条边的中点(面板在右 → 右边沿;在左 / 上 / 下同理)
  const d = 18 * pz
  const right = pr.left >= s.right - 1, left = pr.right <= s.left + 1
  const ex = right ? s.right : left ? s.left : s.left + s.width / 2
  const ey = right || left ? s.top + s.height / 2 : pr.top >= s.bottom - 1 ? s.bottom : s.top
  const drop: Box = { x: ex - d / 2, y: ey - d / 2, w: d, h: d, r: d / 2 }

  // 液体层:面板前面的兄弟节点,框住源 + 面板;层级比面板低一档(源按钮压在它上面,见 engine.css)
  const ux = Math.min(s.left, pr.left) - PAD, uy = Math.min(s.top, pr.top) - PAD
  const layer = document.createElement('div')
  layer.className = 'lcl-droplet'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.zIndex = String((parseInt(pcs.zIndex, 10) || 1) - 1)
  panel.parentElement.insertBefore(layer, panel)
  const z = zoomOf(layer)
  Object.assign(layer.style, {
    left: `${ux / z}px`, top: `${uy / z}px`,
    width: `${(Math.max(s.right, pr.right) + PAD - ux) / z}px`, height: `${(Math.max(s.bottom, pr.bottom) + PAD - uy) / z}px`,
  })
  // 祖先带 transform 时 fixed 的坐标系不是视口。目录挂在插件的容器里,管不到祖先:量一次差值补回去
  const at = layer.getBoundingClientRect()
  if (Math.abs(at.left - ux) > 0.5 || Math.abs(at.top - uy) > 0.5) {
    layer.style.left = `${(2 * ux - at.left) / z}px`
    layer.style.top = `${(2 * uy - at.top) / z}px`
  }
  const blob = (b: { x: number; y: number; w: number; h: number }, r: number): HTMLElement => {
    const el = document.createElement('i')
    Object.assign(el.style, { left: `${(b.x - ux) / z}px`, top: `${(b.y - uy) / z}px`, width: `${b.w / z}px`, height: `${b.h / z}px`, borderRadius: `${r / z}px`, background: pcs.backgroundColor })
    layer.appendChild(el)
    return el
  }
  // 源压在液体层上面(图标 / 「+N」字样始终看得见),收尾还原
  const srcWas = { position: source.style.position, zIndex: source.style.zIndex }
  if (getComputedStyle(source).position === 'static') source.style.position = 'relative'
  source.style.zIndex = String((parseInt(pcs.zIndex, 10) || 1) + 1)
  const restoreSource = (): void => { source.style.position = srcWas.position; source.style.zIndex = srcWas.zIndex }
  const srcBlob = blob({ x: s.left, y: s.top, w: s.width, h: s.height }, (parseFloat(getComputedStyle(source).borderTopLeftRadius) || 8) * zoomOf(source))
  const body = blob(p, 0)

  // 三段同一时间轴:源鼓起再缩没(丝在 0.6 断)/ 液体从一滴胀成面板 / 面板的裁切跟着液体
  const pour = (el: HTMLElement, zz: number): Animation => el.animate(
    [{ clipPath: inset(drop, p, zz), offset: 0 }, { clipPath: inset(drop, p, zz), offset: 0.05, easing: surface }, { clipPath: inset(p, p, zz), offset: 1 }],
    { duration: D, fill: 'both' },
  )
  const swell = srcBlob.animate(
    [{ transform: 'scale(0.7)', offset: 0, easing: calm }, { transform: 'scale(1.14)', offset: 0.14, easing: calm }, { transform: 'scale(1)', offset: 0.3, easing: exit }, { transform: 'scale(0)', offset: 0.6 }, { transform: 'scale(0)', offset: 1 }],
    { duration: D, fill: 'both' },
  )
  const grow = pour(body, z)
  panel.classList.add(POURING)
  let clip: Animation | null = pour(panel, pz)
  const shows = kids().map((k) => k.animate([{ opacity: 0 }, { opacity: 1 }], { delay: D * 0.22, duration: D * 0.3, easing: surface, fill: 'backwards' }))
  // 液体停稳(0.9D)→ 真面板一帧接手:去掉 pouring、撤掉裁切(fill 留着会把阴影也裁掉)、液体层藏起来留给倒放
  const handoff = layer.animate([{ opacity: 1 }, { opacity: 1 }], { duration: D * 0.9 })
  handoff.finished.then(() => {
    panel.classList.remove(POURING)
    clip?.cancel()
    clip = null
    layer.style.display = 'none'
  }, () => {})

  let closing: Promise<void> | null = null
  const cancel = (): void => {
    for (const a of [swell, grow, handoff, ...shows]) a.cancel()
    clip?.cancel()
    panel.getAnimations({ subtree: true }).forEach((a) => a.cancel()) // 带 subtree:收到一半又展开时,内容的淡出还在跑
    panel.classList.remove(POURING)
    panel.style.visibility = ''
    layer.remove()
    restoreSource()
  }
  return {
    retract() {
      if (closing) return closing
      handoff.cancel()
      shows.forEach((a) => a.cancel())
      const t = Math.min(D, Number(grow.currentTime ?? D)) // 开到一半被收:从这一帧接着倒放
      layer.style.display = ''
      panel.classList.add(POURING)
      clip?.cancel()
      clip = pour(panel, pz)
      clip.currentTime = t
      const rate = -1 / 0.7
      // 别用 fill: forwards:面板不卸载时,取消填充动画和隐藏面板撞在同一帧,Chromium 会把内容的透明度留在 0,
      // 元素上已没有动画,再展开就是空屏(10-30 用户报,连开 33 次空 16 次)。所以写成保持到结束,收完由下面藏起面板
      kids().forEach((k) => k.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], { duration: D * 0.7 }))
      for (const a of [swell, grow, clip]) { a.updatePlaybackRate(rate); a.play() }
      closing = grow.finished.then(() => { panel.style.visibility = 'hidden' }, () => undefined).finally(() => { layer.remove(); restoreSource() })
      return closing
    },
    cancel,
  }
}
