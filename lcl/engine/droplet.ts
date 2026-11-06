/** 液滴展开(DESIGN §3「液滴展开」,2026-10-30 用户定):浮层从发起它的小控件里「流出来」。
 *
 *  ① 源控件先鼓一下 ② 一滴液体从源朝面板的那条边冒出来,胀成面板 ③ 中间连着的丝在液体快长好时被拉断
 *  ④ 内容浮在液体上、按液体当前轮廓露出来(不等液体长完)⑤ 液体停稳那一刻真面板一帧接手(同色、不叠淡)。
 *  收起 = 倒放(0.7 倍时长):内容先淡掉,液体缩回一滴、被源吸回去。打断(开到一半就收)从当前帧接着倒放;
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
import { zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'

export interface DropletOptions {
  /** 液体颜色;缺省 = 面板自身的 background-color。 */
  color?: string
  /** 跳过流出,直接是接手后的样子(只为之后能倒放缩回这个源)。 */
  settled?: boolean
  /** 内部用(retract 按新矩形重建):从流出的这一毫秒接着,不放前面那段;已到 D 等同 settled。 */
  at?: number
}

export interface Droplet {
  /** 倒放收回;resolve 时面板已缩成一滴、不可见,由调用方卸载。重复调用返回同一个 Promise。 */
  retract(): Promise<void>
  /** 立刻清场(不放动画):组件卸载、被别的面板顶掉时用。 */
  cancel(): void
  /** 倒放途中又要开:从此刻掉头往前放、停在打开,返回 true;这次 retract() 的 Promise 作废(不再 resolve),
   *  之后要收再调 retract()。不在倒放(没收、已收完、减少动态效果)返回 false,调用方照旧 cancel() 再流出一滴。
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

export function emergeDroplet(source: HTMLElement, panel: HTMLElement, opts: DropletOptions = {}): Droplet {
  const kids = (): HTMLElement[] => Array.from(panel.children) as HTMLElement[]
  if (reducedMotion() || typeof panel.animate !== 'function' || !panel.parentElement) {
    // 减少动态效果:留反馈、去点缀(DESIGN §3 规矩 8)—— 只淡入 / 淡出,不形变
    const fade = (from: number, to: number, duration: number): Animation =>
      panel.animate([{ opacity: from }, { opacity: to }], { duration, easing: curve('--ease-calm', 'ease') })
    panel.style.visibility = ''
    const enter = opts.settled ? null : fade(0, 1, ms('--duration-fast', 150))
    let closing: Promise<void> | null = null
    // 淡入还没走完就收:从此刻的透明度接着淡出,不先跳回 1(11-06 动效第三轮)
    const leave = (): Animation => { const o = +getComputedStyle(panel).opacity; enter?.cancel(); return fade(o, 0, ms('--menu-exit-duration', 80)) }
    return {
      retract: () => (closing ??= leave().finished.then(() => { panel.style.visibility = 'hidden' }, () => undefined)),
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
  const fill = splitAlpha(opts.color ?? pcs.backgroundColor)
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
  if (fill.alpha < 1) layer.style.opacity = String(fill.alpha)
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
    Object.assign(el.style, { left: `${(b.x - ux) / z}px`, top: `${(b.y - uy) / z}px`, width: `${b.w / z}px`, height: `${b.h / z}px`, borderRadius: `${r / z}px`, background: fill.rgb })
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
  const srcR = (radiusOf(source, source.offsetWidth, source.offsetHeight) || 8) * zoomOf(source)
  const srcBlob = blob({ x: s.left, y: s.top, w: s.width, h: s.height }, srcR)
  const body = blob(p, 0)
  // 源被自己的层叠上下文关在液体层下面(账号卡:头像在 .shell-host 的 isolation 里,面板 portal 在 body 上,
  // 上面抬的 z-index 出不了那个上下文):命中测试看源中心最上面是不是液体,是就在液体层上按源的轮廓挖个洞,
  // 源从洞里露出来 —— 看起来仍是「源压在液体上」。能压上去的(悬停预览、「+N」、目录)不挖,液体照常垫在图标底下。
  layer.style.pointerEvents = 'auto'
  const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)
  layer.style.pointerEvents = ''
  if (hit && layer.contains(hit)) {
    const mask = holeMask(parseFloat(layer.style.width), parseFloat(layer.style.height), { x: (s.left - ux) / z, y: (s.top - uy) / z, w: s.width / z, h: s.height / z, r: srcR / z })
    Object.assign(layer.style, { maskImage: mask, webkitMaskImage: mask, maskSize: '100% 100%', webkitMaskSize: '100% 100%', maskRepeat: 'no-repeat', webkitMaskRepeat: 'no-repeat' })
    layer.dataset.hole = ''
  }

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
  let shows = kids().map((k) => k.animate([{ opacity: 0 }, { opacity: 1 }], { delay: D * 0.22, duration: D * 0.3, easing: surface, fill: 'backwards' }))
  let outs: Animation[] = [] // 倒放时内容的淡出(掉头时只撤它们,不碰内容自己的 CSS 动画)
  let closing: Promise<void> | null = null
  let gen = 0 // 每次倒放 / 掉头 +1:旧那一次的收尾(掉头后 grow.finished 还是同一个 Promise)不再碰面板
  let landed = false
  // 液体停稳(0.9D)→ 真面板一帧接手:去掉 pouring、撤掉裁切(fill 留着会把阴影也裁掉)、液体层藏起来留给倒放。
  // 描边(pouring 期间透明)从透明淡进来;edge = false 只给 settled:面板本来就开着,描边一直在
  const land = (edge = true): void => {
    // 已经在倒放就别接手:settled 时 finish() 让 handoff.finished 立刻 resolve,then(land) 排在微任务里,
    // 紧接着同步调的 retract()(开着时变了尺寸 → 重建一滴马上倒放)会被它晚一拍撤掉裁切、藏起液体,倒放就没了
    if (closing || landed) return
    landed = true
    panel.classList.remove(POURING)
    clip?.cancel()
    clip = null
    layer.style.display = 'none'
    if (edge) panel.animate([{ borderColor: 'transparent' }, {}], { duration: ms('--duration-fast', 150), easing: calm })
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
  } else if (opts.at !== undefined) {
    // 重建:停在原来那一滴此刻的进度(液体大小、内容透明度都接得上),紧接着的 retract() 从这里倒放
    for (const a of [swell, grow, handoff, ...shows, clip]) a.currentTime = Math.min(opts.at, D)
  }

  let rebuilt: Droplet | null = null
  const cancel = (): void => {
    rebuilt?.cancel()
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
      // 开着期间面板换了位置 / 尺寸(账号卡展开额度、账号列表异步长高,OverlayAt 重新夹了位置)或源挪了:
      // 液体本体和裁切还按流出时的矩形,倒放会先跳回旧位置。按现在的矩形重建一滴(直接停在接手后),再倒放它
      const pn = panel.getBoundingClientRect(), sn = source.getBoundingClientRect()
      const off = (a: DOMRect, b: { left: number; top: number; width: number; height: number }): boolean =>
        Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) > 1
      if (rebuilt) return (closing = rebuilt.retract()) // 重建的那滴掉头过(reopen)又收
      if (off(pn, pr) || off(sn, s)) {
        // 还没流完就变了尺寸又收(账号卡刚开、账号列表就长出来,马上 Esc):从同一个进度重建,
        // 不能用 settled —— 那会先跳成长满、内容推到 1 再倒放(第三轮 Codex 评审 P2)
        const at = grow.playState === 'finished' ? undefined : Math.min(D, Number(grow.currentTime ?? D))
        cancel()
        rebuilt = emergeDroplet(source, panel, at === undefined ? { ...opts, settled: true } : { ...opts, settled: false, at })
        return (closing = rebuilt.retract())
      }
      // 内容此刻的透明度:开到一半就收时淡入还没走完(0.22D 之前还没开始),从这里接着淡,
      // 别先跳回 1 再淡 —— 收得早,内容会在缩回去的液体里闪一下(11-06 动效第三轮,探针 motion-r3.probe.cjs 量到 0 → 0.9)
      const from = kids().map((k) => +getComputedStyle(k).opacity)
      handoff.cancel()
      shows.forEach((a) => a.cancel())
      outs.forEach((a) => a.cancel())
      landed = false
      const t = Math.min(D, Number(grow.currentTime ?? D)) // 开到一半被收:从这一帧接着倒放
      layer.style.display = ''
      panel.classList.add(POURING)
      clip?.cancel()
      clip = pour(panel, pz)
      clip.currentTime = t
      const rate = -1 / 0.7
      // 别用 fill: forwards:面板不卸载时,取消填充动画和隐藏面板撞在同一帧,Chromium 会把内容的透明度留在 0,
      // 元素上已没有动画,再展开就是空屏(10-30 用户报,连开 33 次空 16 次)。所以写成保持到结束,收完由下面藏起面板
      outs = kids().map((k, i) => k.animate([{ opacity: from[i] ?? 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], { duration: D * 0.7 }))
      for (const a of [swell, grow, clip]) { a.updatePlaybackRate(rate); a.play() }
      // 掉头(reopen)后 grow 往前放到底,grow.finished 照样 resolve:按 gen 认出这次收起已作废 —— 不藏面板、不收尾、不 resolve
      const g = ++gen
      closing = new Promise<void>((resolve) => {
        const done = (hide: boolean): void => {
          if (g !== gen) return
          if (hide) panel.style.visibility = 'hidden'
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
      if (rebuilt) {
        if (!closing || !rebuilt.reopen?.()) return false
        closing = null
        return true
      }
      // 只在倒放进行中掉头;已收完(面板藏了、液体层已拿掉)/ 被 cancel 就让调用方重新流出一滴。
      // 别看 playbackRate:刚调完 retract() 的那一帧倒放的速率还没生效,读到的仍是 1(Codex 评审 P3)
      if (!closing || !clip || grow.playState !== 'running') return false
      gen++
      closing = null
      const t = Math.min(D, Number(grow.currentTime ?? 0))
      // 内容从此刻的透明度回到 1,不早于 0.22D 露出(同流出)
      const from = kids().map((k) => +getComputedStyle(k).opacity)
      outs.forEach((a) => a.cancel())
      outs = []
      shows = kids().map((k, i) => k.animate([{ opacity: from[i] ?? 0 }, { opacity: 1 }], { delay: Math.max(0, D * 0.22 - t), duration: D * 0.3, easing: surface, fill: 'backwards' }))
      for (const a of [swell, grow, clip]) { a.updatePlaybackRate(1); a.play() }
      handoff = handoffAt(t)
      return true
    },
  }
}
