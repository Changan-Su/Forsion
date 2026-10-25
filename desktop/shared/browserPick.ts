/**
 * 内置浏览器「点选元素发进对话」(借鉴 Comma 方案 2.4,仓根 docs/ToBeImproved/借鉴Comma方案_2026-10-21/rest.html)。
 *
 * 安全边界(和 main.ts will-attach-webview 那一套同一道墙,不开新口子):
 *  - guest 不加 preload、不给 IPC。点选脚本由**主进程**经 `executeJavaScriptInIsolatedWorld` 注入:
 *    独立 JS 世界只共享 DOM,网页自己的脚本改不了点选脚本的函数 / 原型,也拿不到它的状态。
 *  - guest → 宿主唯一的回路是那次注入的**返回值**(一个在点下 / 取消时兑现的 Promise),不存在网页能主动调用的通道。
 *  - 返回值来自第三方页面,一律当不可信数据:主进程过 `sanitizePick`(类型、长度、数值范围);URL / 域名由主进程
 *    从 guest.getURL() 自己取,不信页面报的。
 *
 * ⚠️ `pickerProgram` / `buildSelector` 会被 `Function.prototype.toString()` 整段注入 guest:函数体内**不许引用模块里的
 *    任何东西**(import、别的顶层函数、常量),也别用会让打包器塞辅助函数的语法(对象展开、class 字段之类)。
 */

/** 注入用的独立 JS 世界编号(≠ 999,那是 Electron 给 preload 的)。同一编号的多次注入共享全局 → 取消 / 上一层能找到进行中的那次。 */
export const PICK_WORLD_ID = 1777

export interface PickRect { x: number; y: number; w: number; h: number }

/** guest 报回来的点选结果(过 sanitizePick 之后的形状)。 */
export interface RawPick {
  selector: string
  tag: string
  text: string
  rect: PickRect
  /** guest 视口 CSS 像素,主进程据此把 rect 换算成截图坐标 */
  vw: number
  vh: number
}

/** 主进程交给渲染层的结果。image = 元素截图(base64,不带 data: 前缀);截不到就是 null,磁贴照样挂。 */
export interface PickResponse {
  ok: boolean
  /** 用户取消 / 页面跳走 / 被下一次点选顶掉 */
  cancelled?: boolean
  error?: string
  pick?: RawPick & { url: string; title: string }
  image?: { mimeType: string; data: string; width: number; height: number } | null
}

export const PICK_TEXT_MAX = 200
export const PICK_SELECTOR_MAX = 300

const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null

/** 页面报回来的东西不可信:形状不对一律丢,字符串截长,数值夹进视口。 */
export function sanitizePick(raw: unknown): RawPick | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const rect = r.rect as Record<string, unknown> | undefined
  if (typeof r.selector !== 'string' || typeof r.tag !== 'string' || !rect || typeof rect !== 'object') return null
  const vw = num(r.vw, 1, 20000), vh = num(r.vh, 1, 20000)
  if (vw === null || vh === null) return null
  const x = num(rect.x, 0, vw), y = num(rect.y, 0, vh)
  const w = num(rect.w, 0, vw), h = num(rect.h, 0, vh)
  if (x === null || y === null || w === null || h === null) return null
  const tag = r.tag.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
  const selector = r.selector.replace(/[\r\n]+/g, ' ').trim().slice(0, PICK_SELECTOR_MAX)
  if (!tag || !selector) return null
  const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, PICK_TEXT_MAX) : ''
  return { selector, tag, text, rect: { x, y, w: Math.min(w, vw - x), h: Math.min(h, vh - y) }, vw, vh }
}

/**
 * 元素 → 一条短而尽量稳的 CSS 选择器(在它所在的文档 / shadow root 里唯一)。
 * 顺序:稳定的 id → `tag.class` → 加 :nth-of-type → 往上最多 4 层拼 `父 > 子`。
 * 像生成出来的 id / class(长数字串、css-xxxx、模块哈希、Tailwind 任意值)不用:换次构建就变,写进对话没意义。
 * ⚠️ 被 toString() 注入 guest,函数体必须自给自足(见文件头)。
 */
export function buildSelector(el: Element): string {
  const esc = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c))
  const root = el.getRootNode() as Document | ShadowRoot
  const unique = (sel: string): boolean => {
    try { return root.querySelectorAll(sel).length === 1 } catch { return false }
  }
  const stableId = (id: string): boolean => !!id && id.length <= 40 && !/\d{4,}|^\d|[:.[\]\s]|^(ember|react|radix|headlessui|mui|rc_|:r)/i.test(id)
  const goodClass = (c: string): boolean => !!c && c.length <= 32 && !/\d{3,}|^(css|sc|jsx|emotion|svelte|astro)-|^_|__[a-z0-9]{4,}$|[:[\]/!@%()]/i.test(c)
  const idSel = (e: Element): string | null => (stableId(e.id) && unique('#' + esc(e.id)) ? '#' + esc(e.id) : null)
  const part = (e: Element): string => {
    const classes = Array.from(e.classList).filter(goodClass).slice(0, 2)
    return e.localName + classes.map((c) => '.' + esc(c)).join('')
  }
  const nth = (e: Element, sel: string): string => {
    const parent = e.parentElement
    if (!parent) return sel
    const same = Array.from(parent.children).filter((c) => c.localName === e.localName)
    return same.length > 1 ? sel + ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : sel
  }
  const own = idSel(el)
  if (own) return own
  let path = part(el)
  if (unique(path)) return path
  path = nth(el, path)
  if (unique(path)) return path
  let cur: Element = el
  for (let i = 0; i < 4 && cur.parentElement && cur.parentElement.localName !== 'html'; i++) {
    cur = cur.parentElement
    const anchor = idSel(cur)
    if (anchor) return anchor + ' > ' + path
    const plain = part(cur) + ' > ' + path
    if (unique(plain)) return plain
    path = nth(cur, part(cur)) + ' > ' + path
    if (unique(path)) return path
  }
  return path
}

/** 磁贴 / 悬浮标签上显示的短名:`tag#id` 或 `tag.class`(只取第一个能用的 class)。 */
export function shortElementLabel(el: { localName: string; id?: string; classList?: ArrayLike<string> }): string {
  const cls = Array.from(el.classList || []).find((c) => !!c && c.length <= 32 && !/[:[\]/]/.test(c))
  return el.localName + (cls ? '.' + cls : '')
}

/**
 * guest 里跑的点选程序(注入进 PICK_WORLD_ID 那个独立世界)。返回的 Promise:点下 → 结果对象;Esc / 取消 → null。
 * 盖一层透明罩(z-index 顶格、十字光标)接住所有指针事件 —— 网页自己元素上的点击处理器根本收不到这一下;
 * 窗口级的捕获监听再兜一道 preventDefault + stopImmediatePropagation。罩子下面是谁用 elementsFromPoint 找(跳过罩子自己,
 * 能钻进开放的 shadow root)。高亮 = 中性灰底 + 2px 中性描边 + 一圈白细边(任何页面底色上都看得清);下面一枚深色小标签。
 * 罩子挂在 <html> 上、内容放进 shadow root,样式全走 CSSOM(element.style)—— 页面 CSS 选不中它,CSP 的 style-src 也拦不住。
 * ⚠️ 被 toString() 注入 guest,函数体必须自给自足;selector 构造器作为参数传进来。
 */
export function pickerProgram(makeSelector: (el: Element) => string): Promise<unknown> {
  type Ctl = { cancel: () => void; parent: () => void }
  const w = window as unknown as { __forsionPick?: Ctl }
  if (w.__forsionPick) w.__forsionPick.cancel()
  return new Promise((resolve) => {
    const doc = document
    const set = (el: HTMLElement, css: Record<string, string>): HTMLElement => {
      for (const k of Object.keys(css)) el.style.setProperty(k, css[k], 'important')
      return el
    }
    const host = set(doc.createElement('forsion-pick'), {
      all: 'initial', position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh',
      'z-index': '2147483647', cursor: 'crosshair', display: 'block', background: 'transparent',
    })
    // open:台架要读标签;页面本来就能删 / 改自己 DOM 里的任何东西,closed 挡不住什么
    const shadow = host.attachShadow({ mode: 'open' })
    const box = set(doc.createElement('div'), {
      position: 'fixed', display: 'none', 'pointer-events': 'none', 'box-sizing': 'border-box', 'border-radius': '3px',
      background: 'rgba(128,128,128,0.22)', border: '2px solid rgba(110,110,110,0.95)', 'box-shadow': '0 0 0 1px rgba(255,255,255,0.75)',
    })
    const label = set(doc.createElement('div'), {
      position: 'fixed', display: 'none', 'pointer-events': 'none', padding: '3px 7px', 'border-radius': '5px',
      background: 'rgba(28,28,28,0.9)', color: '#fff', font: '500 11px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      'white-space': 'pre', 'max-width': '80vw', overflow: 'hidden', 'text-overflow': 'ellipsis', 'letter-spacing': '0',
    })
    label.setAttribute('data-forsion-pick-label', '')
    shadow.append(box, label)
    doc.documentElement.appendChild(host)

    let base: Element | null = null
    let depth = 0
    let target: Element | null = null
    let px = -1, py = -1
    let done = false

    const under = (x: number, y: number): Element | null => {
      for (const hit of doc.elementsFromPoint(x, y)) {
        if (hit === host) continue
        let e: Element = hit
        // 钻进开放的 shadow root(组件库常见);closed 的进不去,停在宿主上
        for (let i = 0; i < 8 && e.shadowRoot; i++) {
          const inner = e.shadowRoot.elementFromPoint(x, y)
          if (!inner || inner === e) break
          e = inner
        }
        return e
      }
      return null
    }
    const up = (e: Element): Element | null => {
      if (e.parentElement) return e.parentElement
      const r = e.getRootNode() as ShadowRoot
      return r && r.host ? r.host : null
    }
    const lift = (): void => {
      let e = base
      for (let i = 0; e && i < depth; i++) {
        const p = up(e)
        if (!p || p === doc.documentElement) { depth = i; break }
        e = p
      }
      target = e
    }
    const tagOf = (e: Element): string => {
      const cls = Array.from(e.classList).find((c) => !!c && c.length <= 32 && !/[:[\]/]/.test(c))
      return e.localName + (cls ? '.' + cls : '')
    }
    const paint = (): void => {
      if (!target) { box.style.setProperty('display', 'none', 'important'); label.style.setProperty('display', 'none', 'important'); return }
      const r = target.getBoundingClientRect()
      set(box, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 2) + 'px', height: Math.max(r.height, 2) + 'px' })
      label.textContent = tagOf(target) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height)
      const below = r.bottom + 6
      const top = below + 22 > innerHeight ? Math.max(4, r.top - 26) : below
      set(label, { display: 'block', left: Math.min(Math.max(4, r.left), Math.max(4, innerWidth - 220)) + 'px', top: top + 'px' })
    }
    const track = (x: number, y: number): void => {
      px = x; py = y
      const b = under(x, y)
      if (b !== base) { base = b; depth = 0 }
      lift()
      paint()
    }
    const swallow = (e: Event): void => { e.preventDefault(); e.stopImmediatePropagation() }
    const onMove = (e: MouseEvent): void => { swallow(e); track(e.clientX, e.clientY) }
    const onScroll = (): void => { if (px >= 0) track(px, py) }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { swallow(e); finish(null); return }
      if (e.key === 'Alt') { swallow(e); if (!e.repeat) parent() }
    }
    const parent = (): void => { if (base) { depth++; lift(); paint() } }
    const onClick = (e: MouseEvent): void => {
      swallow(e)
      if (e.button !== 0) return
      if (!target) track(e.clientX, e.clientY)
      if (!target) return
      const r = target.getBoundingClientRect()
      const x = Math.max(0, r.left), y = Math.max(0, r.top)
      const text = ((target as HTMLElement).innerText || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      let selector = target.localName
      try { selector = makeSelector(target) } catch { /* 选择器没算出来就退回标签名 */ }
      finish({
        selector, tag: target.localName, text,
        rect: { x, y, w: Math.max(0, Math.min(r.right, innerWidth) - x), h: Math.max(0, Math.min(r.bottom, innerHeight) - y) },
        vw: innerWidth, vh: innerHeight,
      })
    }
    const swallowTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu', 'pointermove', 'mouseover', 'mouseout']
    const finish = (res: unknown): void => {
      if (done) return
      done = true
      removeEventListener('mousemove', onMove, true)
      removeEventListener('click', onClick, true)
      removeEventListener('keydown', onKey, true)
      removeEventListener('scroll', onScroll, true)
      for (const t of swallowTypes) removeEventListener(t, swallow, true)
      host.remove()
      if (w.__forsionPick === ctl) delete w.__forsionPick
      // 先让去掉高亮的那一帧画出来,主进程再截图(不然截到灰底)
      if (res) requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(res), 30)))
      else resolve(null)
    }
    const ctl: Ctl = { cancel: () => finish(null), parent }
    w.__forsionPick = ctl
    addEventListener('mousemove', onMove, true)
    addEventListener('click', onClick, true)
    addEventListener('keydown', onKey, true)
    addEventListener('scroll', onScroll, { capture: true, passive: true })
    for (const t of swallowTypes) addEventListener(t, swallow, true)
  })
}

/** 注入 guest 的完整代码:pickerProgram(buildSelector)。 */
export const pickerSource = (): string => `(${pickerProgram.toString()})(${buildSelector.toString()})`
/** 同一世界里控制进行中的那次点选。 */
export const pickControlSource = (action: 'cancel' | 'parent'): string =>
  `(() => { const c = window.__forsionPick; if (c) c.${action === 'parent' ? 'parent' : 'cancel'}(); return !!c })()`
