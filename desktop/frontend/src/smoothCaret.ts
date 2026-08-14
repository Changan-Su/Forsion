/**
 * 丝滑光标(默认关):隐藏原生 caret,用自绘覆盖层 + CSS transition 平滑跟随(Word 手感)。
 * 作用范围:Amadeus 编辑器(.milkdown .ProseMirror)+ Tangu 聊天输入框(textarea.t2c-ta)。
 * 开关:设置 → 外观(localStorage SMOOTH_CARET_KEY);样式在 styles/base.css 的 .sc-caret / html.sc-on。
 */
import { SMOOTH_CARET_KEY } from './types'

/**
 * 开关的唯一读法。**没存过 = 关**(默认关),只有显式存 '1' 才开 —— 三个读点(本模块启动、
 * 设置勾选框初值、命令面板取反)必须同一套判定,否则命令面板第一次按会「开了没反应」
 * (漏改的读点算出 true,取反又得到 false=已经是的状态)。
 */
export function isSmoothCaretOn(): boolean {
  try { return localStorage.getItem(SMOOTH_CARET_KEY) === '1' } catch { return false }
}

let enabled = false
let overlay: HTMLDivElement | null = null
let raf = 0
let animateNext = true
let lastX = -1
let lastY = -1
let lastTaSig = ''
let blinkAlt = false

function ensureOverlay(): HTMLDivElement {
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.className = 'sc-caret'
    overlay.style.display = 'none'
    document.body.appendChild(overlay)
  }
  return overlay
}

function hide(): void {
  if (overlay) overlay.style.display = 'none'
  lastX = lastY = -1
}

// textarea 无光标坐标 API:经典镜像 div 技术 —— 复刻排版样式,量 selectionStart 处余文 span 的首个矩形。
const MIRROR_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height',
  'text-transform', 'word-spacing', 'text-indent', 'tab-size',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
]

/** 元素字体的行内盒高度(≈ 原生 caret 高度)的视口 px。fontSize 是未缩放局部 px,故乘自身有效缩放。 */
function caretEm(el: Element): number {
  const z = (el as Element & { currentCSSZoom?: number }).currentCSSZoom || 1
  return parseFloat(getComputedStyle(el).fontSize) * 1.2 * z
}

function textareaCaretRect(ta: HTMLTextAreaElement): { left: number; top: number; height: number } {
  const cs = getComputedStyle(ta)
  const div = document.createElement('div')
  for (const p of MIRROR_PROPS) div.style.setProperty(p, cs.getPropertyValue(p))
  div.style.position = 'fixed'
  div.style.top = '0'
  div.style.left = '0'
  div.style.visibility = 'hidden'
  div.style.border = 'none'
  div.style.boxSizing = 'border-box'
  div.style.width = `${ta.clientWidth}px` // clientWidth=padding+content,配 border-box 使换行位置一致
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordBreak = 'break-word' // textarea 的软换行行为
  const at = ta.selectionStart ?? 0
  div.textContent = ta.value.slice(0, at)
  const span = document.createElement('span')
  span.textContent = ta.value.slice(at) || '\u200b' // 留余文保证与 textarea 同处换行;空则零宽占位
  div.appendChild(span)
  document.body.appendChild(div)
  const rect = ta.getBoundingClientRect()
  // 量「余文 span 的第一个 client 矩形」而不是 span.offsetLeft/Top + line-height:
  // ① 首矩形 = caret 所在那一行的片段,跨行余文也只取第一行;② 它的高度是**行内盒(字体
  // content area)**高度 —— 原生 caret 就是按这个画的,拿 line-height 会长一截
  // (实测 14px/22.4px 的聊天框:真值 17px,line-height 22.4px,长 32%)。
  const sr = span.getClientRects()[0]
  const dr = div.getBoundingClientRect()
  // 坐标空间对齐:rect/sr/dr 是视口坐标(含 CSS zoom),而 clientLeft/scrollLeft 是未缩放的局部 px;
  // 镜像挂在 body,与 textarea 未必同一层 zoom,故先按各自的有效缩放归一再合成。
  const tz = (ta as HTMLTextAreaElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const dz = (div as HTMLDivElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const localX = sr ? (sr.left - dr.left) / dz : 0
  const localY = sr ? (sr.top - dr.top) / dz : 0
  const localH = sr ? sr.height / dz : parseFloat(cs.fontSize) * 1.2
  div.remove()
  return {
    left: rect.left + (ta.clientLeft - ta.scrollLeft + localX) * tz,
    top: rect.top + (ta.clientTop - ta.scrollTop + localY) * tz,
    height: localH * tz,
  }
}

/**
 * collapsed range 拿不到可用矩形时,按 DOM 位置找**邻居**定位:往前找到的取其右边(caret 就在它
 * 后面),往后找到的取其左边;两侧都取邻居自己的 top/height —— 那正是 caret 所在行的行内盒。
 *
 * ⚠️ 必须跳过 `img.ProseMirror-separator`:ProseMirror 在空 textblock 里塞的零尺寸占位 img,
 * 矩形是 `h=0` 且 top 落在**基线**上。病史(用户实报「开丝滑光标后打标题必偏」):空标题
 * `<h3><span.heading-hash>### </span><img.separator><br></h3>` 光标在元素 offset=1,旧代码直接取
 * `childNodes[1]` = 那个 img → 画在 top 73 / 高 18,真值是 top 56 / 高 21(h1 更夸张,偏 25px)。
 * 高度取自 `caretEm(host)` 也是错的 —— 那是 `.ProseMirror` 的字号,不是标题的。
 */
function neighborCaretRect(el: Element, offset: number): { x: number; y: number; h: number } | null {
  const usable = (n: Node | undefined): DOMRect | null => {
    if (!(n instanceof Element) || n.classList.contains('ProseMirror-separator')) return null
    const r = n.getBoundingClientRect()
    return r.height > 0 ? r : null
  }
  for (let i = offset - 1; i >= 0; i--) {
    const r = usable(el.childNodes[i])
    if (r) return { x: r.right, y: r.top, h: r.height }
  }
  for (let i = offset; i < el.childNodes.length; i++) {
    const r = usable(el.childNodes[i])
    if (r) return { x: r.left, y: r.top, h: r.height }
  }
  return null
}

function caretInfo(): { x: number; y: number; h: number; host: Element } | null {
  const ae = document.activeElement
  // 聊天输入框:textarea 分支
  if (ae instanceof HTMLTextAreaElement && ae.classList.contains('t2c-ta')) {
    if ((ae.selectionStart ?? 0) !== (ae.selectionEnd ?? 0)) return null // 有选区=无 caret
    const r = textareaCaretRect(ae)
    return { x: r.left, y: r.top, h: r.height, host: ae }
  }
  // 编辑器:contenteditable 分支
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null
  const n = sel.anchorNode
  const el = n instanceof Element ? n : n?.parentElement
  const host = el?.closest('.milkdown .ProseMirror')
  if (!host || !ae || !host.contains(ae)) return null
  const range = sel.getRangeAt(0)
  const c = range.startContainer
  let r: DOMRect | undefined = range.getClientRects()[0]
  // 空块(`<p><br></p>`、只有 `###` widget 的空标题)collapsed range 给不出可用矩形:要么一个没有,
  // 要么给个高度 0 的。此时按 DOM 位置找邻居定位(空段落照旧落到 <br>,行内盒高度即 caret 高度)。
  if (c instanceof Element && (!r || r.height === 0)) {
    const nb = neighborCaretRect(c, range.startOffset)
    if (nb) return { ...nb, host }
  }
  if (!r || (r.width === 0 && r.height === 0)) {
    const fb = c instanceof Element ? c.childNodes[range.startOffset] ?? c : c.parentElement
    if (fb instanceof Element) r = fb.getBoundingClientRect()
  }
  if (!r) return null
  const h = r.height || caretEm(host)
  return { x: r.left, y: r.top, h, host }
}

/** 触屏设备上软键盘是否正占着屏(视觉视口比布局视口矮一大截)。桌面/无 visualViewport 恒 false。
 *  ⚠️ 让位必须**连 `sc-on` 一起摘**:`html.sc-on` 把宿主的 caret-color 置成了 transparent,
 *  只 hide() 覆盖层的话用户会一个光标都看不见。 */
function softKeyboardUp(): boolean {
  const vv = window.visualViewport
  if (!vv || !window.matchMedia?.('(pointer: coarse)').matches) return false
  return window.innerHeight - vv.height > 120
}

function update(): void {
  if (!enabled || !document.hasFocus()) return hide()
  const info = caretInfo()
  if (!info) return hide()
  // caret 滚出宿主可视范围时藏起(覆盖层 fixed,不然会浮到工具栏上)
  const hr = info.host.getBoundingClientRect()
  if (info.y + info.h < hr.top + 1 || info.y > hr.bottom - 1) return hide()
  const el = ensureOverlay()
  // 颜色跟宿主:主题 --primary 优先,退回文字色(原生 caret 已被置 transparent,读不到)
  const cs = getComputedStyle(info.host)
  el.style.background = cs.getPropertyValue('--primary').trim() || cs.color
  // ⚠️ 别在这里拿 `visualViewport.offsetTop/Left` 做「补偿」:info 来自 getBoundingClientRect、覆盖层
  // 是 position:fixed,两者**本就同在布局视口**,加 offset 只会把光标反向推开一个键盘滚动量。
  // (2026-08-08 试过这个方向,评审按规范逐条驳回;也别拿 AmxMobileBar 的 lift 当反证 —— 贴底工具栏
  // 要跟住**视觉视口**所以需要 offset,光标要跟住**内容**所以不需要,两者需求相反。)
  // iOS 上光标错位的真因还没量到,所以走保守路线:软键盘占屏时整个让位给系统原生光标,见 softKeyboardUp()。
  document.documentElement.classList.toggle('sc-on', !softKeyboardUp())
  if (softKeyboardUp()) return hide()
  const x = Math.round(info.x)
  const y = Math.round(info.y)
  const moved = x !== lastX || y !== lastY
  const first = el.style.display === 'none'
  el.style.display = 'block'
  // 端级 CSS zoom(uiZoom 网页端 1.1 / 触屏 1.15、singleColumn 的 mini-shell 0.85)落在 body 上,
  // 会把覆盖层自己的 translate/height 再乘一遍,而上面量到的 info 已经是视口坐标 —— 先除掉自身
  // 有效缩放,否则光标按「离视口原点距离 ×(zoom-1)」成比例偏出去。仪器:scripts/smooth-caret.check.cjs
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  el.style.height = `${Math.round(info.h) / z}px`
  if (first || !animateNext) {
    // 首次出现 / 滚动重定位:瞬移不过渡(避免从旧位置飞过来)
    el.style.transition = 'none'
    el.style.transform = `translate(${x / z}px, ${y / z}px)`
    void el.offsetWidth
    el.style.transition = ''
  } else {
    el.style.transform = `translate(${x / z}px, ${y / z}px)`
  }
  if (moved) {
    // 移动即重置闪烁周期(Word 手感:移动中常亮)。用切换等价 keyframes 名重启动画,
    // 不能用 `void offsetWidth` 强制 reflow —— 那会把上面刚设的新 transform 立即提交,
    // 吃掉跨行 transition(表现:左右小步看着连续、上下跨行大步直接瞬移无动画)。
    blinkAlt = !blinkAlt
    el.style.animationName = blinkAlt ? 'sc-blink-b' : 'sc-blink'
  }
  lastX = x
  lastY = y
  animateNext = true
}

function schedule(animate = true): void {
  if (!animate) animateNext = false
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; update() })
}

/** main.tsx 模块级安装(每个 BrowserWindow 各自一份)。 */
export function installSmoothCaret(): void {
  // dev 热替换会让旧模块实例连同它的覆盖层/监听器一起留着(表现:两根光标,其中一根按旧算法画)。
  // 清掉遗留节点即可把旧实例无害化 —— 它的 overlay 引用还在但已脱离文档,不会再被看见。
  document.querySelectorAll('.sc-caret').forEach((n) => n.remove())
  enabled = isSmoothCaretOn()
  document.documentElement.classList.toggle('sc-on', enabled)
  document.addEventListener('selectionchange', () => schedule())
  document.addEventListener('input', () => schedule(), true) // 排版变化(autoGrow 等)可能不触发 selectionchange
  document.addEventListener('scroll', () => schedule(false), { capture: true, passive: true })
  window.addEventListener('resize', () => schedule(false))
  // 移动端软键盘弹起/收起改的是 visualViewport,window 的 resize 未必发(Android 的 overlays-content 模式)。
  window.visualViewport?.addEventListener('resize', () => schedule(false))
  window.visualViewport?.addEventListener('scroll', () => schedule(false))
  window.addEventListener('focusin', () => schedule(false))
  window.addEventListener('focusout', () => schedule(false))
  window.addEventListener('blur', hide)
  window.addEventListener('focus', () => schedule(false))
  // 程序化改 textarea.value(发送后清空草稿、↑历史召回、seed 草稿)**不触发任何事件** ——
  // input/selectionchange 浏览器只为用户操作发。表现:发完消息光标滞留在原文末尾不归位。
  // ponytail: 10Hz 比对「长度:selectionStart」兜底,好过在每个 setDraft 处插回调。
  // 仪器:npm run check:caret 的「程序化清空」用例。
  const W = window as Window & { __scPoll?: ReturnType<typeof setInterval> }
  clearInterval(W.__scPoll) // dev 热替换:旧实例的轮询会复活它自己的覆盖层(双光标)
  W.__scPoll = setInterval(() => {
    const ae = document.activeElement
    const ta = ae instanceof HTMLTextAreaElement && ae.classList.contains('t2c-ta') ? ae : null
    // ⚠️ 签名必须带上**宿主的整个视口矩形**(top/left/宽),不能只带文本与 top:
    //  · top:发送后 autoGrow 回缩,聊天框贴底 → 整个框往下挪,而「长度:选区」可能一模一样
    //    (例:发完又粘回等长文本)。
    //  · left/宽:纯横向布局变化——Agent Desk 打开只给 `.composer-anchor` 加 padding-right,
    //    居中的输入卡随之左移+收窄、文本重新折行,而 input / selectionchange / window resize /
    //    scroll **一个都不发**。漏掉它,覆盖层就钉死在原处 = 用户看到「输入框行尾多出来一格,
    //    不是空格、删不掉,退格删的是前面的字」(原生 caret 已被 caret-color:transparent 藏起来了)。
    // 编辑器分支同理纳入(desk 让位/侧栏开合同样会挪动笔记纸面)。仪器:npm run check:caret。
    const host = ta ?? (ae instanceof Element ? ae.closest('.milkdown .ProseMirror') : null)
    const r = host?.getBoundingClientRect()
    const sig = r
      ? `${ta ? `${ta.value.length}:${ta.selectionStart ?? 0}` : 'ed'}:${Math.round(r.top)}:${Math.round(r.left)}:${Math.round(r.width)}`
      : ''
    if (sig === lastTaSig) return
    lastTaSig = sig
    // ⚠️ 签名**变空**(焦点离开输入框)也必须 schedule —— 那正是该 hide() 的时刻。
    // 原来这里 `&& sig` 会在「不发 blur 的失焦路径」上让覆盖层永远钉在原处。
    if (enabled) schedule()
  }, 100)
}

/** 设置开关即时生效(SettingsModal 写完 localStorage 后调)。 */
export function setSmoothCaretEnabled(on: boolean): void {
  enabled = on
  document.documentElement.classList.toggle('sc-on', on)
  if (on) schedule(false)
  else hide()
}
