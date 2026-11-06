/** 面板展开按「动效主题」分派(动效主题方案 A2,2026-11-06 用户定):按钮长出贴着它的面板这一场合,
 *  宿主 <html data-motion-theme> 说用哪种 —— Genesis / 水滴 = 液滴(droplet.ts)、拉伸 = stretchOpen、平移 = 淡入微缩。
 *  调用方只认 `openPanel(源, 面板)`,拿回同一个 Droplet 接口(retract / cancel),换主题不用改调用处。
 *
 *  拉伸:面板从按钮那条边长出来,**远端那条边先走**、两条侧边晚一点才撑开(远端 0–0.78D、侧边 0.2D–D,各自 --ease-surface);
 *  收起倒放 0.7 倍(后撑开的先缩回)。做法照液滴:面板挂 lcl-droplet-pouring(去底色 / 描边 / 阴影)、动 clip-path;
 *  面板前面插一层兄弟节点画同形状的「底」,影子(--droplet-shadow)由这层带着形状走 —— clip-path 会裁掉面板自己的投影。
 *  平移:淡入 + 0.985→1 微缩(菜单那一对,--menu-enter-*),收起淡出 + 0.99(--menu-exit-duration、--ease-exit)。
 *  减少动态效果 / 「只淡入淡出」(reducedMotion())三种都只淡入 / 淡出。 */
import { emergeDroplet, ms, curve, splitAlpha, type Droplet, type DropletOptions } from './droplet'
import { zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'

export type MotionThemeId = 'genesis' | 'droplet' | 'stretch' | 'glide'
export const MOTION_THEME_IDS: readonly MotionThemeId[] = ['genesis', 'droplet', 'stretch', 'glide']

/** 当前动效主题(宿主写在 <html data-motion-theme>;没写 = Genesis)。 */
export function motionTheme(): MotionThemeId {
  const v = typeof document === 'undefined' ? '' : document.documentElement.dataset.motionTheme ?? ''
  return (MOTION_THEME_IDS as readonly string[]).includes(v) ? (v as MotionThemeId) : 'genesis'
}

const POURING = 'lcl-droplet-pouring'

function fadeOnly(panel: HTMLElement, settled = false): Droplet {
  const fade = (from: number, to: number, duration: number): Animation =>
    panel.animate([{ opacity: from }, { opacity: to }], { duration, easing: curve('--ease-calm', 'ease') })
  panel.style.visibility = ''
  const enter = settled ? null : fade(0, 1, ms('--duration-fast', 150))
  let closing: Promise<void> | null = null
  // 淡入还没走完就收:从此刻的透明度接着淡出,不先跳回 1(动效第三轮,同 droplet.ts)
  const leave = (): Animation => { const o = +getComputedStyle(panel).opacity; enter?.cancel(); return fade(o, 0, ms('--menu-exit-duration', 80)) }
  return {
    retract: () => (closing ??= leave().finished.then(() => { panel.style.visibility = 'hidden' }, () => undefined)),
    cancel: () => { panel.getAnimations().forEach((a) => a.cancel()); panel.style.visibility = '' },
  }
}

/** 平移:菜单那一对淡入微缩。缩放朝源那一侧收(transform-origin),用独立的 scale 属性,不碰调用方写的 transform。 */
export function fadeScaleOpen(source: HTMLElement, panel: HTMLElement, opts: DropletOptions = {}): Droplet {
  if (reducedMotion() || typeof panel.animate !== 'function') return fadeOnly(panel, opts.settled)
  const s = source.getBoundingClientRect(), p = panel.getBoundingClientRect()
  const ox = p.left >= s.right - 1 ? 'left' : p.right <= s.left + 1 ? 'right' : 'center'
  const oy = p.top >= s.bottom - 1 ? 'top' : p.bottom <= s.top + 1 ? 'bottom' : 'center'
  const origin = panel.style.transformOrigin
  panel.style.transformOrigin = `${ox} ${oy}`
  panel.style.visibility = ''
  const enter = panel.animate([{ opacity: 0, scale: '0.985' }, { opacity: 1, scale: '1' }],
    { duration: ms('--menu-enter-duration', 180), easing: curve('--menu-enter-ease', 'cubic-bezier(0.2, 0, 0.2, 1)') })
  if (opts.settled) enter.finish() // 面板开着只是换了源(悬停预览换图标):不重播
  let closing: Promise<void> | null = null
  let dead = false // cancel 之后旧的收尾不再碰面板(马上重开时面板已归新的那一次)
  return {
    retract() {
      if (closing) return closing
      // 进场还没走完就收:从此刻的透明度 / 缩放接着退,不先跳回 1(动效第三轮)
      const cs = getComputedStyle(panel), o = +cs.opacity, sc = cs.scale === 'none' ? '1' : cs.scale
      enter.cancel()
      // 不用 fill: forwards(理由同 droplet.ts 的倒放):收完由这里把面板藏起来
      const exit = panel.animate([{ opacity: o, scale: sc }, { opacity: 0, scale: '0.99' }],
        { duration: ms('--menu-exit-duration', 80), easing: curve('--ease-exit', 'cubic-bezier(0.4, 0, 1, 1)') })
      closing = exit.finished.then(() => { panel.style.visibility = 'hidden' }, () => undefined).finally(() => { if (!dead) panel.style.transformOrigin = origin })
      return closing
    },
    cancel() { dead = true; panel.getAnimations().forEach((a) => a.cancel()); panel.style.visibility = ''; panel.style.transformOrigin = origin },
  }
}

type Box = { x: number; y: number; w: number; h: number }
const PAD = 24

/** cubic-bezier 求值(形状按帧采样要用;WAAPI 的 easing 只能管整段,两条边各走各的段只能自己算)。 */
function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t
  const sy = (t: number): number => ((ay * t + by) * t + cy) * t
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 10; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break; t -= e / d }
    return sy(Math.min(1, Math.max(0, t)))
  }
}
export function easeOf(css: string): (x: number) => number {
  const m = /cubic-bezier\(([^)]+)\)/.exec(css)
  const v = m ? m[1].split(',').map(Number) : []
  return v.length === 4 && v.every(Number.isFinite) ? bezier(v[0], v[1], v[2], v[3]) : bezier(0.22, 1, 0.36, 1)
}

/** 拉伸展开。缝(源与面板之间)和液滴一样要 ≤ 12px,远了看着就不是从按钮里长出来的。 */
export function stretchOpen(source: HTMLElement, panel: HTMLElement, opts: DropletOptions = {}): Droplet {
  if (reducedMotion() || typeof panel.animate !== 'function' || !panel.parentElement) return fadeOnly(panel, opts.settled)
  panel.style.visibility = ''
  const D = ms('--stretch-open-duration', 380)
  const ez = easeOf(curve('--ease-surface', 'cubic-bezier(0.22, 1, 0.36, 1)'))
  const s = source.getBoundingClientRect()
  const pr = panel.getBoundingClientRect()
  const pcs = getComputedStyle(panel)
  const pz = zoomOf(panel)
  const radius = (parseFloat(pcs.borderTopLeftRadius) || 12) * pz
  const r0 = Math.min(radius, (parseFloat(getComputedStyle(source).borderTopLeftRadius) || 8) * zoomOf(source))
  const p: Box = { x: pr.left, y: pr.top, w: pr.width, h: pr.height }
  // 面板在源的哪一侧:远端那条边沿这个方向走,两条侧边从「源与面板重叠的那一段」撑到面板全长
  const dir = pr.left >= s.right - 1 ? 'r' : pr.right <= s.left + 1 ? 'l' : pr.top >= s.bottom - 1 ? 'd' : 'u'
  const horiz = dir === 'r' || dir === 'l'
  const lo = horiz ? p.y : p.x, hi = horiz ? p.y + p.h : p.x + p.w
  const slo = horiz ? s.top : s.left, shi = horiz ? s.bottom : s.right
  let a0 = Math.max(lo, slo), b0 = Math.min(hi, shi)
  const MIN = 8 * pz
  if (b0 - a0 < MIN) { const c = Math.min(hi - MIN / 2, Math.max(lo + MIN / 2, (slo + shi) / 2)); a0 = c - MIN / 2; b0 = c + MIN / 2 }
  const thick0 = Math.min(10 * pz, horiz ? p.w : p.h) // 起步时远端离近端多远
  const FAR: [number, number] = [0, 0.78], SIDE: [number, number] = [0.2, 1]
  const seg = (t: number, [a, b]: [number, number]): number => ez(Math.min(1, Math.max(0, (t - a) / (b - a))))
  const boxAt = (t: number): Box & { r: number } => {
    const f = seg(t, FAR), v = seg(t, SIDE)
    const a = a0 + (lo - a0) * v, b = b0 + (hi - b0) * v
    const len = thick0 + ((horiz ? p.w : p.h) - thick0) * f
    const r = Math.min(r0 + (radius - r0) * v, (b - a) / 2, len / 2)
    if (dir === 'r') return { x: p.x, y: a, w: len, h: b - a, r }
    if (dir === 'l') return { x: p.x + p.w - len, y: a, w: len, h: b - a, r }
    if (dir === 'd') return { x: a, y: p.y, w: b - a, h: len, r }
    return { x: a, y: p.y + p.h - len, w: b - a, h: len, r }
  }
  const N = 32
  const frames = (z: number, off: { x: number; y: number }): Keyframe[] => Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N, b = boxAt(t)
    const top = (b.y - off.y) / z, left = (b.x - off.x) / z
    const right = (off.x + p.w - b.x - b.w) / z, bottom = (off.y + p.h - b.y - b.h) / z
    return { offset: t, clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round ${b.r / z}px)` }
  })

  // 底层:面板前面的兄弟节点,框住面板;同形状的一块「底」带着影子走(层上 filter = 影子,块上 clip-path = 形状)
  const layer = document.createElement('div')
  layer.className = 'lcl-stretch'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.zIndex = String((parseInt(pcs.zIndex, 10) || 1) - 1)
  panel.parentElement.insertBefore(layer, panel)
  const z = zoomOf(layer)
  const ux = p.x - PAD, uy = p.y - PAD
  Object.assign(layer.style, { left: `${ux / z}px`, top: `${uy / z}px`, width: `${(p.w + 2 * PAD) / z}px`, height: `${(p.h + 2 * PAD) / z}px` })
  const at = layer.getBoundingClientRect() // 祖先带 transform 时 fixed 的坐标系不是视口:量一次差值补回去(同 droplet.ts)
  if (Math.abs(at.left - ux) > 0.5 || Math.abs(at.top - uy) > 0.5) {
    layer.style.left = `${(2 * ux - at.left) / z}px`
    layer.style.top = `${(2 * uy - at.top) / z}px`
  }
  // 底色:缺省读面板自身;材质画在 ::before 上的面板(悬停预览)由调用方传(同 emergeDroplet 的 color)。
  // 半透明拆成「不透明色 + 整层透明度」,和液滴同一种画法:形状边上不出两层叠色
  const fill = splitAlpha(opts.color ?? pcs.backgroundColor)
  if (fill.alpha < 1) layer.style.opacity = String(fill.alpha)
  const body = document.createElement('i')
  Object.assign(body.style, { left: `${PAD / z}px`, top: `${PAD / z}px`, width: `${p.w / z}px`, height: `${p.h / z}px`, background: fill.rgb })
  layer.appendChild(body)

  const kf: KeyframeAnimationOptions = { duration: D, fill: 'both' }
  const grow = body.animate(frames(z, p), kf)
  panel.classList.add(POURING)
  let clip: Animation | null = panel.animate(frames(pz, p), kf)
  const kids = (): HTMLElement[] => Array.from(panel.children) as HTMLElement[]
  const surface = curve('--ease-surface', 'cubic-bezier(0.22, 1, 0.36, 1)')
  const shows = kids().map((k) => k.animate([{ opacity: 0 }, { opacity: 1 }], { delay: D * 0.3, duration: D * 0.3, easing: surface, fill: 'backwards' }))
  let closing: Promise<void> | null = null
  // cancel 之后旧的收尾不再碰面板:收到一半又重开时,新的一次已经给面板挂上 pouring,旧 promise 的 finally 晚一拍才跑
  let dead = false
  let rebuilt: Droplet | null = null
  // 形状长满 → 真面板接手:去掉 pouring、撤掉裁切(fill 留着会把阴影也裁掉)、底层藏起来留给倒放
  const land = (): void => {
    if (closing || dead) return
    panel.classList.remove(POURING)
    clip?.cancel()
    clip = null
    layer.style.display = 'none'
  }
  grow.finished.then(land, () => {})
  if (opts.settled) {
    // 面板开着只是换了源(悬停预览换图标):同一帧放到底再接手,之后收起缩回新的源
    for (const a of [grow, ...shows]) a.finish()
    clip?.finish()
    land()
  }

  const cancelSelf = (): void => {
    dead = true
    for (const a of [grow, ...shows]) a.cancel()
    clip?.cancel()
    panel.getAnimations({ subtree: true }).forEach((a) => a.cancel())
    panel.classList.remove(POURING)
    panel.style.visibility = ''
    layer.remove()
  }
  return {
    retract() {
      if (closing) return closing
      if (rebuilt) return (closing = rebuilt.retract())
      // 开着期间面板换了位置 / 尺寸(账号卡展开额度、账号列表异步长高)或源挪了:形状还按展开时的矩形,
      // 倒放会先跳回旧位置。按现在的矩形重建一份(直接停在接手后)再倒放它(同 droplet.ts)
      const pn = panel.getBoundingClientRect(), sn = source.getBoundingClientRect()
      const off = (a: DOMRect, b: { left: number; top: number; width: number; height: number }): boolean =>
        Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) > 1
      if (off(pn, pr) || off(sn, s)) {
        cancelSelf()
        rebuilt = stretchOpen(source, panel, { ...opts, settled: true })
        return (closing = rebuilt.retract())
      }
      // 内容此刻的透明度:开到一半就收时淡入还没走完,从这里接着淡(动效第三轮,同 droplet.ts)
      const from = kids().map((k) => +getComputedStyle(k).opacity)
      shows.forEach((a) => a.cancel())
      const t = Math.min(D, Number(grow.currentTime ?? D))
      layer.style.display = ''
      panel.classList.add(POURING)
      clip?.cancel()
      clip = panel.animate(frames(pz, p), kf)
      grow.currentTime = t
      clip.currentTime = t
      // 不用 fill: forwards(理由同 droplet.ts):收完由下面藏起面板
      kids().forEach((k, i) => k.animate([{ opacity: from[i] ?? 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], { duration: D * 0.7 }))
      const rate = -1 / 0.7
      for (const a of [grow, clip]) { a.updatePlaybackRate(rate); a.play() }
      closing = grow.finished.then(() => { if (!dead) panel.style.visibility = 'hidden' }, () => undefined).finally(() => { layer.remove(); if (dead) return; clip?.cancel(); panel.classList.remove(POURING) })
      return closing
    },
    cancel() { rebuilt?.cancel(); cancelSelf() },
  }
}

/** 按当前动效主题展开面板。用法同 emergeDroplet:面板挂上、定好位之后调,收时 `await d.retract()` 再卸载,卸载时 `d.cancel()`。 */
export function openPanel(source: HTMLElement, panel: HTMLElement, opts: DropletOptions = {}): Droplet {
  const theme = motionTheme()
  if (theme === 'stretch') return stretchOpen(source, panel, opts)
  if (theme === 'glide') return fadeScaleOpen(source, panel, opts)
  return emergeDroplet(source, panel, opts)
}
