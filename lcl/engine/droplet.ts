/** 液滴展开(DESIGN §3「液滴展开」,2026-10-30 用户定):浮层从发起它的小控件里「流出来」。
 *
 *  ① 源控件先鼓一下 ② 一滴液体从源朝面板的那条边冒出来,胀成面板 ③ 中间连着的丝在液体快长好时被拉断
 *  ④ 内容浮在液体上、按液体当前轮廓露出来(不等液体长完)⑤ 液体停稳那一刻真面板一帧接手(同色、不叠淡)。
 *  收起 = 倒放(0.7 倍时长):内容先淡掉,液体缩回一滴、被源吸回去。打断(开到一半就收)从当前帧接着倒放;
 *  倒放时液体那段的曲线换成两头缓的 --droplet-retract-ease(2026-11-16 Chat Box 水滴方案):展开曲线直接倒着放是
 *  前慢后快,前 130ms 几乎不动、最后一下冲完,用户说「抽搐不连贯」。换曲线时按「此刻长到几成」换算播放头,不跳帧;
 *  倒放途中又要开(再点源 / 指针回来),调用方先试 `reopen()`:从这一帧掉头往前放,不撤掉从一滴重来。
 *  ⑥ 接手后 1px 描边从透明淡进来(--duration-fast):底色、投影接得住,只有描边会整条一帧出现(11-06 动效第三轮,用户选)。
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
 *  组件卸载时 `d.cancel()`。源与面板之间的缝要 ≤ 12px,再远丝连不上。减少动态效果时只淡入 / 淡出。
 *
 *  选项(2026-11-05 水滴复用第一批:悬停预览 / 账号卡 / Mini 胶囊):
 *  - `color`:液体的颜色,缺省读面板自身底色。底色画在 ::before 上的面板(Space 悬停预览 .rb-peek,卡里是活的 View,
 *    DESIGN §4)自身是透明的,不传就看不见液体。
 *  - `settled`:直接到「已接手」的状态,不放流出动画 —— 面板已经开着、只是换了源(预览换图标),之后收起要缩回新的源。
 *  半透明底色(玻璃卡面、暗色下的半透明白)拆成「不透明色 + 整层透明度」:融球的透明度阈值会把半透明整块吃掉。
 *  源被关在别的层叠上下文里、z-index 抬不过液体层时(账号卡的头像),液体层按源的轮廓挖洞,源照样露在上面。 */
import { UI_ZOOM_EVENT, zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'

export interface DropletOptions {
  /** 液体颜色;缺省 = 面板自身的 background-color。 */
  color?: string
  /** 跳过流出,直接是接手后的样子(只为之后能倒放缩回这个源)。 */
  settled?: boolean
}

export interface Droplet {
  /** 倒放收回;resolve 时面板已缩成一滴、不可见,由调用方卸载。重复调用返回同一个 Promise。 */
  retract(): Promise<void>
  /** 立刻清场(不放动画):组件卸载、被别的面板顶掉时用。 */
  cancel(): void
  /** 倒放途中又要开:从此刻掉头往前放、停在打开,返回 true;这次 retract() 的 Promise 作废(不再 resolve),
   *  之后要收再调 retract()。不在倒放(没收、已收完、被 cancel)返回 false,调用方照旧 cancel() 再流出一滴。
   *  减少动态效果那支(只淡入淡出)同样有:淡出途中从此刻的透明度淡回来。
   *  可选:别的展开方式(动效主题的拉伸 / 平移)可以不实现,调用方写 `d.reopen?.()`。 */
  reopen?(): boolean
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
/** 「rgba(r, g, b, a)」→ 不透明色 + 透明度;认不出的格式原样、当不透明。 */
export function splitAlpha(color: string): { rgb: string; alpha: number } {
  const m = /^rgba?\(([^)]+)\)$/.exec(color.trim())
  if (!m) return { rgb: color, alpha: 1 }
  const p = m[1].split(/[\s,/]+/).filter(Boolean)
  if (p.length < 4) return { rgb: color, alpha: 1 }
  const a = p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])
  return Number.isFinite(a) && a < 1 ? { rgb: `rgb(${p[0]}, ${p[1]}, ${p[2]})`, alpha: Math.max(0, a) } : { rgb: color, alpha: 1 }
}

/** 圆角:百分比(头像 50%)按短边折成 px。 */
function radiusOf(el: HTMLElement, w: number, h: number): number {
  const v = getComputedStyle(el).borderTopLeftRadius.trim()
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return 0
  return v.endsWith('%') ? (n / 100) * Math.min(w, h) : n
}

/** 液体层上按源的轮廓挖洞(局部 px):整层矩形 + 圆角矩形,evenodd 填充 = 中间透明。 */
function holeMask(W: number, H: number, b: Box): string {
  const { x, y, w, h } = b, r = Math.min(b.r, w / 2, h / 2)
  const rr = `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><path fill-rule='evenodd' d='M0 0H${W}V${H}H0Z${rr}'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

const inset = (b: Box, p: Box, z: number): string =>
  `inset(${(b.y - p.y) / z}px ${(p.x + p.w - b.x - b.w) / z}px ${(p.y + p.h - b.y - b.h) / z}px ${(b.x - p.x) / z}px round ${b.r / z}px)`

/** cubic-bezier(x1, y1, x2, y2) → 进度函数;认不出(steps、linear(…)、关键字)返回 null。 */
export function bezierProgress(css: string): ((x: number) => number) | null {
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(css.trim())
  if (!m) return null
  const [x1, y1, x2, y2] = m[1].split(',').map(Number)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  const at = (a: number, b: number, t: number): number => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0, hi = 1
    for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (at(x1, x2, mid) < x) lo = mid; else hi = mid }
    return at(y1, y2, (lo + hi) / 2)
  }
}

/** 同一段关键帧(offset 0.05 → 1)换曲线时的播放头换算:找新曲线上「长到同样几成」的那一刻,换完那一帧形状不变。
 *  0.05 之前是停在一滴的那段,原样;曲线认不出就不换算。 */
export function remapPlayhead(t: number, D: number, from: string, to: string): number {
  const f = bezierProgress(from), g = bezierProgress(to)
  const u = (t / D - 0.05) / 0.95
  if (!f || !g || !(u > 0)) return t
  if (u >= 1) return t
  const p = f(u)
  let lo = 0, hi = 1
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (g(mid) < p) lo = mid; else hi = mid }
  return D * (0.05 + 0.95 * (lo + hi) / 2)
}

export function motionRectChanged(a: DOMRect, b: DOMRect): boolean {
  return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) > 0.5
}

export function observePanelGeometry(source: HTMLElement, panel: HTMLElement, sync: () => void): () => void {
  const observer = new ResizeObserver(sync)
  observer.observe(panel, { box: 'border-box' })
  observer.observe(source, { box: 'border-box' })
  window.addEventListener('resize', sync)
  window.addEventListener(UI_ZOOM_EVENT, sync)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', sync)
    window.removeEventListener(UI_ZOOM_EVENT, sync)
  }
}

export function positionMotionLayer(layer: HTMLElement, x: number, y: number, width: number, height: number): number {
  const z = zoomOf(layer)
  Object.assign(layer.style, { left: `${x / z}px`, top: `${y / z}px`, width: `${width / z}px`, height: `${height / z}px` })
  // A transformed ancestor can establish a containing block even for fixed-position layers.
  const rect = layer.getBoundingClientRect()
  if (Math.abs(rect.left - x) > 0.5 || Math.abs(rect.top - y) > 0.5) {
    layer.style.left = `${(2 * x - rect.left) / z}px`
    layer.style.top = `${(2 * y - rect.top) / z}px`
  }
  return z
}

/** 面板里真正画出来的那一层子节点:穿过 display: contents 的包装层(模型菜单的 .cm-main)—— 它没有自己的盒子,
 *  opacity / translate 动在它身上不会传给里面的行(Codex 评审 P2,2026-11-26)。 */
export function paintedChildren(panel: Element): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const c of Array.from(panel.children) as HTMLElement[]) {
    if (typeof getComputedStyle === 'function' && getComputedStyle(c).display === 'contents') out.push(...paintedChildren(c))
    else out.push(c)
  }
  return out
}

/** 内容收起时朝源挪的方向(4px):源在面板下方就往下、上方往上、左右同理;重叠或量不到就原地淡。 */
export function driftToward(source: Element, panel: Element): { x: number; y: number } {
  const s = source.getBoundingClientRect(), p = panel.getBoundingClientRect()
  const y = s.top >= p.bottom - 1 ? 4 : s.bottom <= p.top + 1 ? -4 : 0
  const x = y ? 0 : s.left >= p.right - 1 ? 4 : s.right <= p.left + 1 ? -4 : 0
  return { x, y }
}

/** Fade out alongside the retreating surface, including when interrupted during entry.
 *  `ratio`:内容在倒放进行到几成时淡完(缺省 0.65);`drift`:同时朝源挪多少(缺省不挪)。
 *  液滴主题传 0.3 + 朝源 4px(2026-11-26 用户选「菜单字先收」,方案页 docs/ToBeImproved/胶囊收起与Ribbon过渡方案_2026-11-26/):
 *  液滴的内容不受液体形状裁切,液体 ~100ms 已缩离文字区、字还要 ~190ms 才淡完,一排字浮在液体外面。
 *  拉伸主题照旧 0.65、不挪:那边内容被同一个 clip-path 裁着,不会浮在外面;早淡完反而是「卡先空了再缩」
 *  (droplet-reuse.e2e「卡片开始明显收拢前,内容仍在淡出」钉着)。 */
export function fadePanelContentOut(children: HTMLElement[], opacity: number[], time: number, duration: number, drift: { x: number; y: number } = { x: 0, y: 0 }, ratio = 0.65): Animation[] {
  // 关键帧的 offset 只收 [0,1]:刚开就收(动画还在 delay 里 currentTime 为负)或时长读成 0 时会算出负数 / NaN,
  // animate() 直接抛错(11-09 2.14.0-beta.1 tag 构建的打包验收报过)。夹住之后最坏是「立刻淡到 0」。
  const k = ratio * time / duration
  const offset = Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0
  const moves = drift.x !== 0 || drift.y !== 0
  const away = moves ? { translate: `${drift.x}px ${drift.y}px`, scale: '0.98' } : {}
  const home = moves ? { translate: '0 0', scale: '1' } : {}
  // 无 DOM(单测)读不到 :root 的 token,用同值兜底
  const ease = typeof getComputedStyle === 'function' ? curve('--ease-exit', 'cubic-bezier(0.4, 0, 1, 1)') : 'cubic-bezier(0.4, 0, 1, 1)'
  return children.map((child, i) => child.animate(
    [{ opacity: opacity[i], ...home, ...(moves ? { easing: ease } : {}) }, { opacity: 0, offset, ...away }, { opacity: 0, ...away }],
    { duration: duration * 0.7 },
  ))
}

export function emergeDroplet(source: HTMLElement, panel: HTMLElement, opts: DropletOptions = {}): Droplet {
  const kids = (): HTMLElement[] => paintedChildren(panel)
  if (reducedMotion() || typeof panel.animate !== 'function' || !panel.parentElement) {
    // 减少动态效果:留反馈、去点缀(DESIGN §3 规矩 8)—— 只淡入 / 淡出,不形变
    const fade = (from: number, to: number, duration: number): Animation =>
      panel.animate([{ opacity: from }, { opacity: to }], { duration, easing: curve('--ease-calm', 'ease') })
    panel.style.visibility = ''
    let enter = opts.settled ? null : fade(0, 1, ms('--duration-fast', 150))
    let exit: Animation | null = null
    let closing: Promise<void> | null = null
    let gen = 0 // 掉头(reopen)后旧那次淡出的收尾作废
    return {
      retract() {
        if (closing) return closing
        // 淡入还没走完就收:从此刻的透明度接着淡出,不先跳回 1(11-06 动效第三轮)
        const o = +getComputedStyle(panel).opacity
        enter?.cancel()
        const ex = (exit = fade(o, 0, ms('--menu-exit-duration', 80)))
        const g = ++gen
        closing = new Promise<void>((resolve) => {
          ex.finished.then(() => { if (g !== gen) return; panel.style.visibility = 'hidden'; resolve() }, () => { if (g === gen) resolve() })
        })
        return closing
      },
      cancel: () => { panel.getAnimations().forEach((a) => a.cancel()); panel.style.visibility = '' },
      // 淡出途中又要开:从此刻的透明度淡回来,不从 0 重来
      reopen() {
        if (!closing || !exit || exit.playState !== 'running') return false
        gen++
        closing = null
        const o = +getComputedStyle(panel).opacity
        exit.cancel()
        exit = null
        enter = fade(o, 1, ms('--duration-fast', 150))
        return true
      },
    }
  }
  ensureFilter()
  panel.style.visibility = ''
  const D = ms('--droplet-duration', 420)
  const surface = curve('--ease-surface', 'cubic-bezier(0.22, 1, 0.36, 1)')
  const calm = curve('--ease-calm', 'cubic-bezier(0.33, 1, 0.68, 1)')
  const exit = curve('--ease-exit', 'cubic-bezier(0.4, 0, 1, 1)')
  const back = curve('--droplet-retract-ease', 'cubic-bezier(0.65, 0, 0.35, 1)')
  let ease = surface // 液体那段此刻用的曲线:展开 / 掉头 = surface,倒放 = back
  let s = source.getBoundingClientRect()
  let pr = panel.getBoundingClientRect()
  const pcs = getComputedStyle(panel)
  const fill = splitAlpha(opts.color ?? pcs.backgroundColor)
  const radius = parseFloat(pcs.borderTopLeftRadius) || 12
  let pz = zoomOf(panel)

  // 液体层:面板前面的兄弟节点,框住源 + 面板;层级比面板低一档(源按钮压在它上面,见 engine.css)
  const layer = document.createElement('div')
  layer.className = 'lcl-droplet'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.zIndex = String((parseInt(pcs.zIndex, 10) || 1) - 1)
  if (fill.alpha < 1) layer.style.opacity = String(fill.alpha)
  panel.parentElement.insertBefore(layer, panel)
  const blob = (): HTMLElement => {
    const el = document.createElement('i')
    el.style.background = fill.rgb
    layer.appendChild(el)
    return el
  }
  // 源压在液体层上面(图标 / 「+N」字样始终看得见),收尾还原
  const srcWas = { position: source.style.position, zIndex: source.style.zIndex }
  if (getComputedStyle(source).position === 'static') source.style.position = 'relative'
  source.style.zIndex = String((parseInt(pcs.zIndex, 10) || 1) + 1)
  // 只还原一次:倒放中途被 cancel() 后马上又对同一个源流出新的一滴,旧倒放的 finally 晚一拍才到,不能把新那滴抬的层级撤掉
  let restored = false
  const restoreSource = (): void => {
    if (restored) return
    restored = true
    source.style.position = srcWas.position
    source.style.zIndex = srcWas.zIndex
  }
  const srcBlob = blob()
  const body = blob()
  const placeSurface = (): void => {
    const x = Math.min(s.left, pr.left) - PAD, y = Math.min(s.top, pr.top) - PAD
    const width = Math.max(s.right, pr.right) + PAD - x, height = Math.max(s.bottom, pr.bottom) + PAD - y
    const z = positionMotionLayer(layer, x, y, width, height)
    const place = (el: HTMLElement, rect: DOMRect, r: number): void => {
      Object.assign(el.style, { left: `${(rect.left - x) / z}px`, top: `${(rect.top - y) / z}px`, width: `${rect.width / z}px`, height: `${rect.height / z}px`, borderRadius: `${r / z}px` })
    }
    const srcR = (radiusOf(source, source.offsetWidth, source.offsetHeight) || 8) * zoomOf(source)
    place(srcBlob, s, srcR)
    place(body, pr, 0)
    if ('hole' in layer.dataset) {
      layer.style.maskImage = holeMask(width / z, height / z, { x: (s.left - x) / z, y: (s.top - y) / z, w: s.width / z, h: s.height / z, r: srcR / z })
    }
  }
  placeSurface()
  // 源被自己的层叠上下文关在液体层下面(账号卡:头像在 .shell-host 的 isolation 里,面板 portal 在 body 上,
  // 上面抬的 z-index 出不了那个上下文):命中测试看源中心最上面是不是液体,是就在液体层上按源的轮廓挖个洞,
  // 源从洞里露出来 —— 看起来仍是「源压在液体上」。能压上去的(悬停预览、「+N」、目录)不挖,液体照常垫在图标底下。
  layer.style.pointerEvents = 'auto'
  const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)
  layer.style.pointerEvents = ''
  if (hit && layer.contains(hit)) {
    Object.assign(layer.style, { maskSize: '100% 100%', maskRepeat: 'no-repeat' })
    layer.dataset.hole = ''
    placeSurface()
  }

  // 三段同一时间轴:源鼓起再缩没(丝在 0.6 断)/ 液体从一滴胀成面板 / 面板的裁切跟着液体
  const frames = (z: number): Keyframe[] => {
    const p: Box = { x: pr.left, y: pr.top, w: pr.width, h: pr.height, r: radius * pz }
    // 出口是源朝向面板的那条边的中点。
    const d = 18 * pz
    const right = pr.left >= s.right - 1, left = pr.right <= s.left + 1
    const ex = right ? s.right : left ? s.left : s.left + s.width / 2
    const ey = right || left ? s.top + s.height / 2 : pr.top >= s.bottom - 1 ? s.bottom : s.top
    const start = inset({ x: ex - d / 2, y: ey - d / 2, w: d, h: d, r: d / 2 }, p, z)
    return [{ clipPath: start, offset: 0 }, { clipPath: start, offset: 0.05, easing: ease }, { clipPath: inset(p, p, z), offset: 1 }]
  }
  const pour = (el: HTMLElement, z: number): Animation => el.animate(frames(z), { duration: D, fill: 'both' })
  const swell = srcBlob.animate(
    [{ transform: 'scale(0.7)', offset: 0, easing: calm }, { transform: 'scale(1.14)', offset: 0.14, easing: calm }, { transform: 'scale(1)', offset: 0.3, easing: exit }, { transform: 'scale(0)', offset: 0.6 }, { transform: 'scale(0)', offset: 1 }],
    { duration: D, fill: 'both' },
  )
  const grow = pour(body, zoomOf(layer))
  panel.classList.add(POURING)
  let clip: Animation | null = pour(panel, pz)
  let shows = kids().map((k) => k.animate([{ opacity: 0 }, { opacity: 1 }], { delay: D * 0.22, duration: D * 0.3, easing: surface, fill: 'backwards' }))
  let outs: Animation[] = [] // 倒放时内容的淡出(掉头时只撤它们,不碰内容自己的 CSS 动画)
  let closing: Promise<void> | null = null
  let gen = 0 // 每次倒放 / 掉头 +1:旧那一次的收尾(掉头后 grow.finished 还是同一个 Promise)不再碰面板
  let landed = false
  let dead = false
  const syncGeometry = (): void => {
    const nextPanel = panel.getBoundingClientRect(), nextSource = source.getBoundingClientRect(), nextZoom = zoomOf(panel)
    if (!motionRectChanged(pr, nextPanel) && !motionRectChanged(s, nextSource) && pz === nextZoom) return
    pr = nextPanel
    s = nextSource
    pz = nextZoom
    placeSurface()
    // Retarget both clips together without replacing either animation or changing its playhead.
    const effect = grow.effect as KeyframeEffect
    effect.setKeyframes(frames(zoomOf(layer)))
    if (clip) (clip.effect as KeyframeEffect).setKeyframes(frames(pz))
  }
  const stopObserving = observePanelGeometry(source, panel, () => { if (!landed) syncGeometry() })
  // 液体停稳(0.9D)→ 真面板一帧接手:去掉 pouring、撤掉裁切(fill 留着会把阴影也裁掉)、液体层藏起来留给倒放。
  // 描边(pouring 期间透明)从透明淡进来;edge = false 只给 settled:面板本来就开着,描边一直在
  const land = (edge = true): void => {
    // 已经在倒放就别接手:上一帧的 handoff.finished 可能刚排进微任务。
    if (closing || landed || dead) return
    landed = true
    panel.classList.remove(POURING)
    clip?.cancel()
    clip = null
    layer.style.display = 'none'
    if (edge) panel.animate([{ borderColor: 'transparent' }, {}], { duration: ms('--duration-fast', 150), easing: calm })
  }
  /** 液体那段换曲线(倒放 ↔ 掉头):播放头按「长到几成」换算(形状不跳)。源的鼓起是另一套关键帧,不跟着换算播放头
   *  (直接对齐会让它从 0.5 一下鼓到 1.1,Codex 评审 P2):保留它自己的播放头,只改速率,让它和液体同一刻到头。 */
  const setEase = (next: string, rate: number): number => {
    const t = Math.min(D, Number(grow.currentTime ?? D))
    const t2 = next === ease ? t : remapPlayhead(t, D, ease, next)
    if (next !== ease) {
      ease = next
      const z = zoomOf(layer)
      ;(grow.effect as KeyframeEffect).setKeyframes(frames(z))
      grow.currentTime = t2
      if (clip) { (clip.effect as KeyframeEffect).setKeyframes(frames(pz)); clip.currentTime = t2 }
    }
    const ts = Math.min(D, Math.max(0, Number(swell.currentTime ?? t)))
    // 液体还要走多久 = 剩下的路 / |rate|;鼓起按同样的时长走完自己剩下的路
    const liquidLeft = rate < 0 ? t2 : D - t2, swellLeft = rate < 0 ? ts : D - ts
    swell.playbackRate = liquidLeft > 1 && swellLeft > 0 ? rate * (swellLeft / liquidLeft) : rate
    return t2
  }
  /** 接手的计时器:液体走到 0.9D 那一刻接手;t = 此刻在时间轴上的位置(掉头时从中途接着计)。 */
  const handoffAt = (t: number): Animation => {
    const h = layer.animate([{ opacity: fill.alpha }, { opacity: fill.alpha }], { duration: D * 0.9 })
    h.currentTime = Math.min(t, D * 0.9)
    const g = gen
    h.finished.then(() => { if (g === gen) land() }, () => {})
    return h
  }
  let handoff = handoffAt(0)
  if (opts.settled) {
    // 同一帧里放到底再接手:页面不会画出中间态(finish 是同步的,接手也同步做,不等 finished 的微任务)
    for (const a of [swell, grow, handoff, ...shows]) a.finish()
    land(false)
  }

  const cancel = (): void => {
    dead = true
    stopObserving()
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
      layer.style.display = ''
      syncGeometry() // The settled panel may have moved or resized since the handoff.
      // 内容此刻的透明度:开到一半就收时淡入还没走完(0.22D 之前还没开始),从这里接着淡,
      // 别先跳回 1 再淡 —— 收得早,内容会在缩回去的液体里闪一下(11-06 动效第三轮,探针 motion-r3.probe.cjs 量到 0 → 0.9)
      const from = kids().map((k) => +getComputedStyle(k).opacity)
      handoff.cancel()
      shows.forEach((a) => a.cancel())
      outs.forEach((a) => a.cancel())
      landed = false
      const t = Math.min(D, Number(grow.currentTime ?? D)) // 开到一半被收:从这一帧接着倒放
      panel.classList.add(POURING)
      clip?.cancel()
      clip = pour(panel, pz)
      clip.currentTime = t
      const rate = -1 / 0.7
      setEase(back, rate)
      // 别用 fill: forwards:面板不卸载时,取消填充动画和隐藏面板撞在同一帧,Chromium 会把内容的透明度留在 0,
      // 元素上已没有动画,再展开就是空屏(10-30 用户报,连开 33 次空 16 次)。所以写成保持到结束,收完由下面藏起面板
      outs = fadePanelContentOut(kids(), from, t, D, driftToward(source, panel), 0.3)
      // 直接赋 playbackRate(同步生效):updatePlaybackRate 要等下一帧才换向,掉头 / 中途收那一帧会先朝原方向多走一步,
      // 曲线陡的地方就是肉眼可见的一跳(droplet-retract.probe.cjs 量到 5–8%)
      for (const a of [grow, clip]) { a.playbackRate = rate; a.play() }
      swell.play()
      // 掉头(reopen)后 grow 往前放到底,grow.finished 照样 resolve:按 gen 认出这次收起已作废 —— 不藏面板、不收尾、不 resolve
      const g = ++gen
      closing = new Promise<void>((resolve) => {
        const done = (hide: boolean): void => {
          if (g !== gen) return
          if (hide) panel.style.visibility = 'hidden'
          stopObserving()
          layer.remove()
          restoreSource()
          resolve()
        }
        grow.finished.then(() => done(true), () => done(false))
      })
      return closing
    },
    cancel,
    reopen() {
      // 只在倒放进行中掉头;已收完(面板藏了、液体层已拿掉)/ 被 cancel 就让调用方重新流出一滴。
      // 别看 playbackRate:刚调完 retract() 的那一帧倒放的速率还没生效,读到的仍是 1(Codex 评审 P3)
      if (!closing || !clip || grow.playState !== 'running') return false
      gen++
      closing = null
      // 曲线换回展开那条,播放头按形状换算(不跳帧)
      const t = setEase(surface, 1)
      // 内容从此刻的透明度回到 1,不早于 0.22D 露出(同流出)
      // 透明度、朝源挪的位移与缩放都从这一帧接着回(只接透明度的话,还看得见的字会一帧弹回原位;Codex 评审 P2)
      const from = kids().map((k) => { const cs = getComputedStyle(k); return { opacity: +cs.opacity, translate: cs.translate === 'none' ? '0px 0px' : cs.translate, scale: cs.scale === 'none' ? '1' : cs.scale } })
      outs.forEach((a) => a.cancel())
      outs = []
      shows = kids().map((k, i) => k.animate([from[i] ?? { opacity: 0 }, { opacity: 1, translate: '0px 0px', scale: '1' }], { delay: Math.max(0, D * 0.22 - t), duration: D * 0.3, easing: surface, fill: 'backwards' }))
      // 只改速率、不 play():刚调完 retract() 的同一帧里它们还停在终点,play() 遇到「正向 + 在终点」会倒回 0 重放(Codex 评审 P3)
      for (const a of [grow, clip]) { a.playbackRate = 1; if (a.playState === 'paused') a.play() }
      if (swell.playState === 'paused') swell.play() // 速率 setEase 已按剩下的路配好
      handoff = handoffAt(t)
      return true
    },
  }
}
