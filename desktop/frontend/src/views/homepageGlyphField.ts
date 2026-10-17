/**
 * 主页主题背景「字阵」:满屏等宽淡字,在输入框打字、点空白处、发送时漾开涟漪。
 * 方案页 docs/ToBeImproved/主页插件化与美化方案_2026-10-17/code.html 的 C(10-17 用户定;第二轮「和星轨 / 日行的纹样联动」用户否了,别加回)。
 *
 * 一张 canvas 铺字格;字形先画进图集(每种字 × 每档亮度一格),之后每格只是一次 drawImage;只重画亮度档或字变了的格子;
 * 没有格子在变时 rAF 停下 —— 静置是零帧。指针移动不起作用,画布也不接收指针(点击、选字照旧)。
 * ⚠️方案里调过三次的口径(方案引擎 instrument/glyph-field.cjs):亮度曲线指数 1.6、涟漪尾巴 0.03 秒暗一半、低于 0.05 不亮 ——
 * 曲线平了或尾巴长了,暗色底上淡尾巴连成一整块实心盘。时钟、问候后面是安静区(最多 22%),同色亮字会把时钟吃掉。
 * 坐标:getBoundingClientRect / clientX 是视口坐标(已含 CSS zoom),字号、内边距是未缩放的局部 px,要乘 currentCSSZoom。
 */

const FONT = 12
const LINE = 16
const TRACK = 1.8
const BASE = 0.04
const STEPS = 7
const HALF_LIFE = 0.03
const QUIET = 0.22
const LO = 'abcdefghijklmnopqrstuvwxyz0123456789'
const UP = 'ABCDEFGHJKLMNPRSTUVWXYZ'
const GLYPHS = [...(LO + UP)]
/** 点了这些地方不算「点空白处」。 */
const NOT_BLANK = 'button, a, input, textarea, select, [contenteditable], [role="button"], [role="menu"], .hp-composer, .hp-status-card, .hp-shelf, .hp-wallpaper-sheet'

interface Ring { x: number; y: number; t0: number; v: number; max: number; amp: number; w: number }
export interface GlyphField { setStill(still: boolean): void; destroy(): void }

/** `interactive: false` = 壁纸面板里的缩略图:画一张静止的小字阵,不挂任何监听。`scale` 只给缩略图用。 */
export function createGlyphField(host: HTMLElement, { scale = 1, interactive = true, quiet = '.hp-title' } = {}): GlyphField {
  const doc = host.ownerDocument
  const win = doc.defaultView ?? window
  const root = host.closest<HTMLElement>('.hp-root')
  const cv = doc.createElement('canvas')
  cv.className = 'hpw-glyph-canvas'
  host.appendChild(cv)
  const g = cv.getContext('2d')!

  // 固定种子:每次打开同一张字阵,缩略图和主页也是同一张
  let seed = 7
  const rand = (): number => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296 }
  const randGlyph = (): number => rand() < 0.14 ? LO.length + ((rand() * UP.length) | 0) : (rand() * LO.length) | 0

  let dpr = 1; let zoom = 1; let cols = 0; let rows = 0; let cw = 1; let ch = 1; let ox = 0; let oy = 0
  let glyph = new Uint8Array(0); let energy = new Float32Array(0); let drawn = new Uint8Array(0); let noise = new Float32Array(0); let hush = new Float32Array(0)
  let atlas: HTMLCanvasElement | null = null
  let font = 'monospace'; let text = '#1c1c1c'; let ink = '#1c1c1c'
  const active = new Set<number>()
  let rings: Ring[] = []
  let raf = 0; let last = 0; let still = !interactive

  function readTheme(): void {
    const probe = doc.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--text);font-family:var(--font-mono, ui-monospace, Menlo, monospace)'
    host.appendChild(probe)
    text = getComputedStyle(probe).color
    font = getComputedStyle(probe).fontFamily
    probe.style.color = 'var(--accent-ink)'
    ink = getComputedStyle(probe).color
    probe.remove()
  }

  function buildAtlas(): void {
    const a = doc.createElement('canvas')
    a.width = GLYPHS.length * cw; a.height = (STEPS + 1) * ch
    const x = a.getContext('2d')!
    x.font = `${FONT * scale * zoom * dpr}px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle'
    for (let lv = 0; lv <= STEPS; lv++) {
      x.fillStyle = lv ? ink : text
      x.globalAlpha = lv ? BASE + (0.95 - BASE) * Math.pow(lv / STEPS, 1.6) : BASE
      GLYPHS.forEach((c, k) => x.fillText(c, k * cw + cw / 2, lv * ch + ch / 2 + 0.5 * scale * zoom * dpr))
    }
    atlas = a
  }

  const level = (e: number): number => e < 0.05 ? 0 : Math.min(STEPS, 1 + Math.floor(e * STEPS))
  function paint(i: number, lv: number): void {
    const x = ox + (i % cols) * cw; const y = oy + ((i / cols) | 0) * ch
    g.clearRect(x, y, cw, ch)
    g.drawImage(atlas!, glyph[i] * cw, lv * ch, cw, ch, x, y, cw, ch)
    drawn[i] = lv
  }
  function full(): void {
    if (!atlas) return
    g.clearRect(0, 0, cv.width, cv.height)
    for (let i = 0; i < glyph.length; i++) paint(i, level(energy[i]))
  }

  /** 安静区:直接写在背景上、没有玻璃垫着的字(时钟、问候)后面,亮字最多亮到 22%。 */
  function quietZone(): void {
    hush.fill(1)
    if (!interactive || !root) return
    const r0 = cv.getBoundingClientRect()
    for (const el of root.querySelectorAll(quiet)) {
      const b = el.getBoundingClientRect(); const pad = 10
      const c0 = Math.max(0, Math.floor(((b.left - r0.left - pad) * dpr - ox) / cw)); const c1 = Math.min(cols - 1, Math.floor(((b.right - r0.left + pad) * dpr - ox) / cw))
      const rA = Math.max(0, Math.floor(((b.top - r0.top - pad) * dpr - oy) / ch)); const rB = Math.min(rows - 1, Math.floor(((b.bottom - r0.top + pad) * dpr - oy) / ch))
      for (let r = rA; r <= rB; r++) for (let c = c0; c <= c1; c++) hush[r * cols + c] = QUIET
    }
  }

  function layout(): void {
    const r = host.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    dpr = win.devicePixelRatio || 1
    zoom = (host as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr)
    readTheme()
    g.font = `${FONT * scale * zoom * dpr}px ${font}`
    cw = Math.round(g.measureText('m').width + TRACK * scale * zoom * dpr); ch = Math.round(LINE * scale * zoom * dpr)
    if (cw < 2 || ch < 2) return
    cols = Math.ceil(cv.width / cw); rows = Math.ceil(cv.height / ch)
    ox = Math.floor((cv.width - cols * cw) / 2); oy = Math.floor((cv.height - rows * ch) / 2)
    const n = cols * rows
    glyph = new Uint8Array(n); energy = new Float32Array(n); drawn = new Uint8Array(n); noise = new Float32Array(n); hush = new Float32Array(n)
    seed = 7
    for (let i = 0; i < n; i++) { glyph[i] = randGlyph(); noise[i] = 0.5 + rand() * 0.7 }
    active.clear(); rings = []
    quietZone(); buildAtlas(); full()
  }

  function lift(i: number, v: number): void { v *= hush[i]; if (v > energy[i]) { energy[i] = Math.min(1, v); active.add(i) } }

  function ringStep(now: number): void {
    rings = rings.filter((ring) => {
      const r = (now - ring.t0) / 1000 * ring.v
      if (r - ring.w > ring.max) return false
      const amp = ring.amp * Math.pow(Math.max(0, 1 - r / ring.max), 0.7)
      const ro = r + ring.w; const ri = r - ring.w
      const rowA = Math.max(0, Math.floor((ring.y - oy - ro) / ch)); const rowB = Math.min(rows - 1, Math.floor((ring.y - oy + ro) / ch))
      for (let row = rowA; row <= rowB; row++) {
        const dy = oy + (row + 0.5) * ch - ring.y
        if (Math.abs(dy) > ro) continue
        const xo = Math.sqrt(ro * ro - dy * dy); const xi = ri > Math.abs(dy) ? Math.sqrt(ri * ri - dy * dy) : 0
        // 只扫环带(左右两段),环里面不碰
        for (const [a, b] of [[ring.x - xo, ring.x - xi], [ring.x + xi, ring.x + xo]]) {
          const c0 = Math.max(0, Math.floor((a - ox) / cw)); const c1 = Math.min(cols - 1, Math.floor((b - ox) / cw))
          for (let c = c0; c <= c1; c++) {
            const k = 1 - Math.abs(Math.hypot(ox + (c + 0.5) * cw - ring.x, dy) - r) / ring.w
            if (k > 0) { const i = row * cols + c; lift(i, amp * k * noise[i]) }
          }
        }
      }
      return true
    })
  }

  function tick(now: number): void {
    raf = 0
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now
    let busy = false
    if (rings.length) { ringStep(now); busy = true }
    const k = Math.pow(0.5, dt / HALF_LIFE)
    for (const i of active) {
      let e = energy[i] * k
      let swap = false
      if (e > 0.1 && rand() < dt * 5) { glyph[i] = randGlyph(); swap = true } // 亮着的字每秒约换 5 次
      if (e < 0.02) { e = 0; active.delete(i) }
      energy[i] = e; busy = true
      const lv = level(e); if (swap || lv !== drawn[i]) paint(i, lv)
    }
    if (busy) kick()
  }
  function kick(): void {
    if (raf || still) return
    if (!last || performance.now() - last > 100) last = performance.now()
    raf = win.requestAnimationFrame(tick)
  }
  function calm(): void {
    if (raf) win.cancelAnimationFrame(raf)
    raf = 0
    for (const i of active) energy[i] = 0
    active.clear(); rings = []
    full()
  }

  /** x / y 是相对画布的视口 px;其余参数是未缩放的 CSS px。 */
  function pulse(x: number, y: number, { speed = 380, max = 150, amp = 0.7, width = 12 } = {}): void {
    if (still) return
    const u = zoom * dpr
    rings.push({ x: x * dpr, y: y * dpr, t0: performance.now(), v: speed * u, max: max * u, amp, w: width * u })
    kick()
  }
  const local = (cx: number, cy: number): [number, number] => { const r = cv.getBoundingClientRect(); return [cx - r.left, cy - r.top] }

  let meter: CanvasRenderingContext2D | null = null
  /** 光标大概在哪:同一行光标前那段字的宽度。不追求逐像素准,一圈涟漪的起点而已。 */
  function caret(ta: HTMLTextAreaElement): [number, number] {
    const r = ta.getBoundingClientRect(); const cs = getComputedStyle(ta)
    const z = (ta as HTMLTextAreaElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    meter ??= doc.createElement('canvas').getContext('2d')
    if (meter) meter.font = cs.font
    const line = ta.value.slice(0, ta.selectionStart ?? ta.value.length).split('\n').pop() || ''
    const pad = (parseFloat(cs.paddingLeft) || 0) * z
    const w = (meter?.measureText(line).width || 0) * z
    const lh = (parseFloat(cs.lineHeight) || 20) * z
    return local(r.left + pad + Math.min(w, r.width - pad * 2), r.top + Math.min(r.height, lh) / 2 + (parseFloat(cs.paddingTop) || 0) * z)
  }
  const inComposer = (t: EventTarget | null): t is HTMLTextAreaElement => t instanceof HTMLTextAreaElement && !!t.closest('.hp-composer')

  function onInput(ev: Event): void {
    if (inComposer(ev.target)) { const [x, y] = caret(ev.target); pulse(x, y) }
  }
  function onKey(ev: KeyboardEvent): void {
    // 发送:一道环扫过整屏(真主页按回车会马上进对话,多半看不到;留着它是为了在主页多停一会儿时也有反馈)
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || !inComposer(ev.target)) return
    const b = ev.target.getBoundingClientRect(); const r = cv.getBoundingClientRect()
    const [x, y] = local(b.left + b.width / 2, b.top + b.height / 2)
    pulse(x, y, { speed: 1000, max: Math.hypot(r.width, r.height) / zoom, amp: 0.75, width: 14 })
  }
  function onDown(ev: PointerEvent): void {
    if (ev.button !== 0 || (ev.target as Element | null)?.closest?.(NOT_BLANK)) return
    const [x, y] = local(ev.clientX, ev.clientY)
    pulse(x, y, { speed: 520, max: 260, amp: 0.8, width: 16 })
  }

  const ro = new win.ResizeObserver(() => layout())
  ro.observe(host)
  // 亮暗 / 主题色 / 背景色换了只重画图集,不重排字
  let themeQueued = false
  const mo = new win.MutationObserver(() => {
    if (themeQueued) return
    themeQueued = true
    win.requestAnimationFrame(() => { themeQueued = false; readTheme(); buildAtlas(); full() })
  })
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-mode', 'data-skin', 'data-bg', 'data-theme'] })
  if (interactive && root) {
    root.addEventListener('input', onInput, true)
    root.addEventListener('keydown', onKey, true)
    root.addEventListener('pointerdown', onDown, true)
  }
  layout()

  return {
    setStill(next) {
      if (!interactive) return
      still = next
      if (still) calm()
    },
    destroy() {
      if (raf) win.cancelAnimationFrame(raf)
      ro.disconnect(); mo.disconnect()
      if (root) {
        root.removeEventListener('input', onInput, true)
        root.removeEventListener('keydown', onKey, true)
        root.removeEventListener('pointerdown', onDown, true)
      }
      cv.remove()
    },
  }
}
