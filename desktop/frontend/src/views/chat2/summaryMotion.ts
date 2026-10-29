/** 摘要栏的进出场过渡(10-29 第三轮「补齐过渡」,仓根 docs/ToBeImproved/后台任务与服务面板方案_2026-10-24/round3.html 第 2 节):
 *  - 卡片 / 行出现时从 0 高长出来、离开时缩回去,用左栏分区折叠那一档(--collapse-duration × --collapse-ease),
 *    连它带来的那道间隔一起长出 / 吃掉,下面的卡和行跟着平滑让位,不跳。
 *  - 拖完松手,其他卡用松手落位同一条曲线(LCL LAND_MS)滑到新位置(flipSiblings)。
 *  一个 MutationObserver 盯着栈,不碰 React 的渲染:离开的卡 / 行在原位插一份克隆当残影,播完就摘。
 *  ⚠️ 不用 LCL 的 useExitGhost:那是整块面板卸载时用的,残影外面还包一层壳;这里要的是栈里逐张 / 逐行的。
 *  DESIGN §3 规矩 6:栈 data-still / data-moved(刚挂上、刚换会话、刚被 dockview 搬家)时不播;减少动态效果时不播。
 *  Agent Desk 卡有自己的进出场,插件卡正文是插件自己的 DOM,都不归这里管。 */
import { LAND_MS } from '@lcl/engine'
import { motion } from '../../theme/motionTokens'

/** 会长出 / 缩回的行:卡片正文(和子会话状态块)的直接子元素里认这几种。进度卡的「正在 xx」「已运行 m:ss」「正在编辑」
 *  也算:它们每次工具调用都出现 / 消失一次,不播的话下面每张卡都跟着一下子挪一行(跳变探针抓到过)。换字不重挂,不会反复播。 */
const ROW = '.t2-tsum-row, .t2-tsum-todo, .t2-tsum-attn, .t2o-desk-row, .t2-tsum-more, .t2-tsum-sub, .t2-tsum-edit'
/** LCL dropIndicator 落位那条曲线(它没导出,值照抄)。 */
const LAND_EASE = 'cubic-bezier(.2,.8,.2,1)'

const isCard = (n: Node): n is HTMLElement =>
  n instanceof HTMLElement && !!n.dataset.card && !n.classList.contains('agent-desk-card') && !n.hasAttribute('data-tsum-ghost')
const isRowHost = (n: Node): n is HTMLElement =>
  n instanceof HTMLElement && (n.classList.contains('t2-card-body') || n.classList.contains('t2o-team-status'))
    && !n.closest('.agent-desk-card, [data-tsum-ghost]')

/** 这一刻该不该播。 */
export function quiet(stack: HTMLElement): boolean {
  return stack.hasAttribute('data-still') || stack.hasAttribute('data-moved') || stack.offsetParent === null
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 高度 / 上下内边距 / 上下描边 / 透明度从 0 长出(或缩回 0);marginTop(或 marginBottom)从 -gap 回到 0,吃掉它带来的间隔。 */
function grow(el: HTMLElement, dir: 'in' | 'out', gap: number): Animation | null {
  const h = el.offsetHeight
  if (!h) return null
  const cs = getComputedStyle(el)
  const full: Keyframe = {
    height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
    borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, opacity: 1,
  }
  const zero: Keyframe = { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0 }
  const side = el.previousElementSibling ? 'marginTop' : el.nextElementSibling ? 'marginBottom' : null
  if (side && gap) { zero[side] = `${-gap}px`; full[side] = cs[side] }
  el.style.overflow = 'hidden'
  const a = el.animate(dir === 'in' ? [zero, full] : [full, zero], {
    duration: motion.ms('collapse'),
    easing: motion.css('collapse'),
    fill: dir === 'out' ? 'forwards' : 'none',
  })
  const done = (): void => { if (dir === 'out') el.remove(); else el.style.overflow = '' }
  a.onfinish = done
  a.oncancel = done
  return a
}

const gapOf = (host: Element): number => parseFloat(getComputedStyle(host).rowGap) || 0

/** 离开的卡 / 行:在原位插一份克隆,缩回去后摘掉。克隆不带 data-card(栈的查找、量高度都跳过它),点不到、读屏不读。
 *  同一批摘掉好几个时,记录里的前后邻居可能也是刚摘掉的:按 made(被摘节点 → 它的残影)找回位置。 */
function ghost(n: HTMLElement, rec: MutationRecord, host: HTMLElement, made: Map<Node, HTMLElement>): void {
  const g = n.cloneNode(true) as HTMLElement
  delete g.dataset.card
  g.setAttribute('data-tsum-ghost', '')
  g.setAttribute('aria-hidden', 'true')
  g.inert = true
  g.style.pointerEvents = 'none'
  g.querySelectorAll('iframe, video, webview').forEach((x) => x.remove())
  const at = (x: Node | null): Node | null => (x && made.get(x)) || x
  const next = at(rec.nextSibling), prev = at(rec.previousSibling)
  if (next && next.parentNode === host) host.insertBefore(g, next)
  else if (prev && prev.parentNode === host) host.insertBefore(g, prev.nextSibling)
  else host.append(g)
  made.set(n, g)
  if (!grow(g, 'out', gapOf(host))) g.remove()
}

/** 正文原本停在底部、新行加在末尾:长出来的这段时间一直贴底,新的那行看得见。 */
function follow(body: HTMLElement, row: HTMLElement, a: Animation): void {
  if (body.lastElementChild !== row) return
  if (body.scrollTop + body.clientHeight < body.scrollHeight - row.offsetHeight - 2) return
  let on = true
  a.finished.finally(() => { on = false }).catch(() => {})
  const tick = (): void => { if (!on) return; body.scrollTop = body.scrollHeight; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}

/** 盯住栈:卡 / 行增删时播长出 / 缩回。返回解绑。 */
export function watchStackMotion(stack: HTMLElement): () => void {
  // 见过的节点:React 换顺序是把同一个节点挪个位置(删 + 加两条记录),不算出现
  const seen = new WeakSet<Node>()
  const note = (n: Node): void => {
    seen.add(n)
    if (n instanceof HTMLElement) n.querySelectorAll(ROW).forEach((r) => seen.add(r))
  }
  for (const c of stack.children) note(c)
  const mo = new MutationObserver((recs) => {
    const still = quiet(stack)
    const fresh = new Set<Node>()
    const gone: [HTMLElement, MutationRecord, HTMLElement][] = []
    for (const r of recs) {
      const host = r.target
      const atStack = host === stack
      if (!atStack && !isRowHost(host)) continue
      for (const n of r.addedNodes) {
        if (seen.has(n) || (n instanceof HTMLElement && n.hasAttribute('data-tsum-ghost'))) continue
        note(n)
        fresh.add(n)
      }
      if (still) continue
      for (const n of r.removedNodes) {
        if (n.isConnected || !(n instanceof HTMLElement) || n.hasAttribute('data-tsum-ghost')) continue
        if (atStack ? !isCard(n) : !n.matches(ROW)) continue
        if (!atStack && !(host as HTMLElement).closest('details')?.open) continue
        if (n.hidden) continue
        gone.push([n, r, host as HTMLElement])
      }
    }
    if (still) return
    // 倒着补:后摘的那个先有残影,前一个的「下一个邻居」才找得到位置
    const made = new Map<Node, HTMLElement>()
    for (let i = gone.length - 1; i >= 0; i--) ghost(gone[i][0], gone[i][1], gone[i][2], made)
    for (const n of fresh) {
      if (!(n instanceof HTMLElement) || n.offsetParent === null) continue
      const host = n.parentElement
      if (!host) continue
      if (host === stack) { if (isCard(n)) grow(n, 'in', gapOf(stack)); continue }
      // 行:只在卡开着、而且卡不是这一批刚出现的时候播(整张卡一起长出来就够了)
      if (!n.matches(ROW) || !isRowHost(host)) continue
      const card = host.closest('details')
      if (!card?.open || fresh.has(card)) continue
      const a = grow(n, 'in', gapOf(host))
      if (a && host.classList.contains('t2-card-body')) follow(host, n, a)
    }
  })
  mo.observe(stack, { childList: true, subtree: true })
  return () => mo.disconnect()
}

/** 拖完松手、重排提交之前调用:记下其他卡现在的位置,等栈的子节点挪完,各自从旧位置滑到新位置。 */
export function flipSiblings(stack: HTMLElement, cards: HTMLElement[]): void {
  if (quiet(stack)) return
  const before = new Map(cards.map((c) => [c, c.getBoundingClientRect().top]))
  const z = (stack as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  let timer = 0
  const mo = new MutationObserver(() => {
    mo.disconnect()
    window.clearTimeout(timer)
    for (const [c, top] of before) {
      if (!c.isConnected) continue
      const dy = (top - c.getBoundingClientRect().top) / z
      if (Math.abs(dy) < 0.5) continue
      c.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: LAND_MS, easing: LAND_EASE })
    }
  })
  mo.observe(stack, { childList: true })
  timer = window.setTimeout(() => mo.disconnect(), 400)
}
