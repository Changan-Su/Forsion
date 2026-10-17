// 发送动效(用户 10-17 选 B,方案页 docs/ToBeImproved/发送动画方案_2026-10-17):
// 刚发出的那条用户消息从输入框后面升到原位,上面的对话被一起托上去;输入框里的字上移淡出。
// 只认「这次按发送的那段正文」:切会话、加载历史、别的设备同步来的消息都不动。
//   Composer2:noteSend(按下发送时记下输入框文字的位置)→ 发出去了 fadeOutDraft / 没发出去 dropSend
//   EditorialMessage:用户气泡挂载时 playSendFlight(对上正文才播,播一次就作废)

const DURATION = 420
const EASE = 'cubic-bezier(0.2, 0.8, 0.3, 1)' // = --ease-spring
const TTL = 20_000 // 服务端受理之后消息才上屏;冷启动的引擎可能慢,超过这么久就不算「刚发的」

let pending: { text: string; top: number; at: number } | null = null

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const zoomOf = (el: Element): number => (el as Element & { currentCSSZoom?: number }).currentCSSZoom || 1
const canAnimate = (el: Element): boolean => typeof (el as HTMLElement).animate === 'function'

/** 按下发送时调用:记下输入框里第一行文字的视口位置(此刻输入框还没清空、高度没变)。 */
export function noteSend(text: string, ta: HTMLTextAreaElement | null): void {
  if (!ta || !text) { pending = null; return }
  const top = ta.getBoundingClientRect().top + (parseFloat(getComputedStyle(ta).paddingTop) || 0) * zoomOf(ta)
  pending = { text, top, at: Date.now() }
}

/** 没发出去(被拒 / 出错):作废,免得之后同样内容的历史消息挂载时被认成刚发的。 */
export function dropSend(text: string): void {
  if (pending?.text === text) pending = null
}

/** 输入框清空前调用:在原位放一层字的影子,上移 10px 淡出,代替「啪」一下清空。 */
export function fadeOutDraft(ta: HTMLTextAreaElement | null): void {
  if (!ta || !ta.value.trim() || reducedMotion() || !canAnimate(ta)) return
  // 挂在聊天列上而不是输入卡里:多行草稿一清空输入卡就变矮、往下落,挂在卡里的影子会跟着往下掉
  const host = (ta.closest('.t2-chat-col') || ta.offsetParent) as HTMLElement | null
  if (!host) return
  const tr = ta.getBoundingClientRect(), hr = host.getBoundingClientRect(), hz = zoomOf(host)
  const cs = getComputedStyle(ta)
  const ghost = document.createElement('div')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.className = 't2c-send-ghost'
  for (const p of ['font', 'letter-spacing', 'word-spacing', 'text-indent', 'tab-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'box-sizing', 'color', 'text-align', 'direction']) {
    ghost.style.setProperty(p, cs.getPropertyValue(p))
  }
  Object.assign(ghost.style, {
    position: 'absolute', left: `${(tr.left - hr.left) / hz - host.clientLeft}px`, top: `${(tr.top - hr.top) / hz - host.clientTop}px`, width: `${ta.offsetWidth}px`, height: `${ta.offsetHeight}px`,
    borderStyle: 'solid', borderColor: 'transparent', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden',
    pointerEvents: 'none', margin: '0', background: 'none', zIndex: '11', // 压过悬浮输入卡(.composer-anchor z-index 10)
  })
  const inner = document.createElement('div')
  inner.textContent = ta.value
  inner.style.marginTop = `${-ta.scrollTop}px`
  ghost.appendChild(inner)
  host.appendChild(ghost)
  ta.dataset.sendGhost = '' // 影子淡出期间先不露占位提示,两行字不叠在一起(composer2.css)
  const a = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 200, easing: 'ease-out', fill: 'forwards' })
  const done = (): void => { ghost.remove(); delete ta.dataset.sendGhost }
  a.onfinish = done
  a.oncancel = done
}

/** 用户气泡挂载时调用(useLayoutEffect)。对上「刚发的那段正文」才播。 */
export function playSendFlight(wrap: HTMLElement, text: string): void {
  const p = pending
  if (!p || p.text !== text) return
  pending = null
  if (Date.now() - p.at > TTL || !canAnimate(wrap)) return
  const stream = wrap.closest('.t2-stream') as HTMLElement | null
  if (!stream) return
  // 子组件的 layout effect 先于 ChatView 的吸底滚动跑:这里量到的是滚之前,微任务里(同一帧、绘制前)是滚之后。
  const before = stream.scrollTop
  queueMicrotask(() => {
    if (!wrap.isConnected) return
    const z = zoomOf(wrap)
    const sr = stream.getBoundingClientRect()
    const r = wrap.getBoundingClientRect()
    if (r.top >= sr.bottom || r.bottom <= sr.top) return // 用户翻在上面看历史:新消息不在视口里,不播
    if (reducedMotion()) {
      wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })
      return
    }
    const shift = Math.max(0, stream.scrollTop - before) // 吸底把上面的对话顶上去了多少
    // 起点 = 输入框文字那一行;不超过气泡下方到内容底边的空间(底部留白 + 同批挂上来的回复占位),
    // 变换后的盒子不越出滚动内容,不撑高 scrollHeight(否则吸底的 follow 会多滚一截)
    const room = Math.max(0, (wrap.parentElement || stream).getBoundingClientRect().bottom - r.bottom)
    let dy = Math.min(Math.max(p.top - r.top, shift), room)
    if (dy < 4) dy = 12 // 量不出纵向差(输入框不在下面 / Mini 收起):退回原地升起
    wrap.animate(
      [{ transform: `translateY(${dy / z}px) scale(.97)`, transformOrigin: '100% 100%' }, { transform: 'none', transformOrigin: '100% 100%' }],
      { duration: DURATION, easing: EASE },
    )
    wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'linear' })
    // 同一批挂上来的回复占位(「正在思考」那行)等气泡落定再出来,不和飞行中的气泡叠在一起
    for (let sib = wrap.nextElementSibling, n = 0; sib && n < 4; sib = sib.nextElementSibling, n++) {
      sib.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: DURATION - 120, easing: 'ease-out', fill: 'backwards' })
    }
    if (!shift) return
    // 上面还看得见的消息从原位置跟着一起上来,不是先跳一下再等气泡补位
    const from = sr.top - shift
    for (let sib = wrap.previousElementSibling as HTMLElement | null, n = 0; sib && n < 40; sib = sib.previousElementSibling as HTMLElement | null, n++) {
      if (sib.getBoundingClientRect().bottom < from) break
      sib.animate([{ transform: `translateY(${shift / z}px)` }, { transform: 'none' }], { duration: DURATION, easing: EASE })
    }
  })
}

