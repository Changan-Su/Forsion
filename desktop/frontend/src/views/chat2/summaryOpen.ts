/** 摘要栏卡片的开合(10-29 用户选第三轮方案 A + 限长 2,仓根 docs/ToBeImproved/后台任务与服务面板方案_2026-10-24/round3.html):
 *  - 有新东西就开:计数变大;卡片在一轮跑着时新出现(没在跑时出现 = 历史 / 默认目录异步加载完,按稳态默认);进度卡每轮开跑时开。
 *  - 安静了就收:后台没有在跑的进程了;来源在这一轮跑完时。进度和产物跑完不收(它们就是这一轮的结果)。
 *  - 用户手动开 / 收只管到这一轮结束(下一次开跑清零)。按会话存在内存,不落盘:
 *    ⚠️ 第二轮那条「收起按卡片种类全局记住」用户否了(收过一次就再也看不到新内容),别加回。
 *  - 车道放不下(fitCards):收掉自动展开里最久没来新内容的那张;只剩一张还放不下,就缩它的正文封顶。
 *  纯函数 + 一个内存 store;TaskSummary 负责量 DOM、喂数据。 */
import { create } from 'zustand'

/** 一张在场卡片这一刻的事实。count 变大 = 来了新东西;dflt = 稳态下该不该开(第一次见到这个会话时用)。 */
export interface CardSig { id: string; count: number; live?: boolean; dflt: boolean }

export interface SessOpen {
  /** 用户这一轮手动点的;开跑时清空。 */
  user: Record<string, boolean>
  auto: Record<string, boolean>
  /** 上一次看到的计数;卡片不在场时删掉,再出现算新出现。 */
  prev: Record<string, number>
  /** 最近一次来新东西的序号(tick),越大越新;限长时先收最旧的。 */
  last: Record<string, number>
  tick: number
  running: boolean
}

export function stepOpen(s: SessOpen | undefined, sigs: CardSig[], running: boolean): SessOpen {
  if (!s) {
    // 第一次见到这个会话(恢复 / 切过来):按稳态默认,不当成「刚来了新东西」
    const n: SessOpen = { user: {}, auto: {}, prev: {}, last: {}, tick: 0, running }
    for (const c of sigs) { n.auto[c.id] = c.dflt; n.prev[c.id] = c.count }
    return n
  }
  const runStart = running && !s.running
  const runEnd = !running && s.running
  const n: SessOpen = { user: runStart ? {} : { ...s.user }, auto: { ...s.auto }, prev: {}, last: { ...s.last }, tick: s.tick, running }
  for (const c of sigs) {
    const before = s.prev[c.id]
    // 第一次见到这个会话之后,消息 / 默认目录多半还在异步加载:没在跑时冒出来的卡不算「来了新东西」
    const grew = before === undefined ? running && c.count > 0 : c.count > before
    let a = before === undefined ? c.dflt : (s.auto[c.id] ?? c.dflt)
    // 来源跑完就收,哪怕收尾那一下计数又变了(跑完会整份重拉消息)
    if (c.id === 'sources' && runEnd) a = false
    else if (grew || (runStart && c.id === 'progress')) { a = true; n.last[c.id] = ++n.tick }
    else if (c.id === 'bg' && !c.live) a = false
    n.auto[c.id] = a
    n.prev[c.id] = c.count
  }
  return n
}

export const openOf = (s: SessOpen | undefined, id: string, dflt: boolean): boolean => s?.user[id] ?? s?.auto[id] ?? dflt
/** 用户手动开过的卡不被限长挤收。 */
export const userOpened = (s: SessOpen | undefined, id: string): boolean => s?.user[id] === true

export interface FitCard {
  id: string
  open: boolean
  /** 自动展开、可以为腾地方收起的(进度、Desk、用户手动开的、指针停着的都不算)。 */
  squeezable: boolean
  last: number
  /** 收着时整张卡的高度。 */
  head: number
  /** 开着时比收着多出来的高度(正文上边距 + 正文自然高度,已按 240 封顶)。 */
  body: number
}

/** 正文封顶最低缩到这么高(≈ 3 行)。 */
export const MIN_BODY = 96
/** 收过的卡要多出这么多空才开回来,免得量得不准时来回翻。 */
export const REOPEN_SLACK = 24

export function fitCards(cards: FitCard[], avail: number, gap = 10, prevSqueezed: readonly string[] = []): { squeezed: string[]; cap: Record<string, number> } {
  const squeezed = new Set<string>()
  const total = (): number => cards.reduce((t, c) => t + c.head + (c.open && !squeezed.has(c.id) ? c.body : 0), 0) + gap * Math.max(0, cards.length - 1)
  const cand = cards.filter((c) => c.open && c.squeezable).sort((a, b) => a.last - b.last)
  while (total() > avail && cand.length > 1) squeezed.add(cand.shift()!.id)
  // 刚才收着、这次又放得下的:得多出 REOPEN_SLACK 才开回来。最新的那张不算 —— 它刚来了新东西,至少得露出来(缩正文也行)
  const newest = cand[cand.length - 1]?.id
  const back = prevSqueezed.filter((id) => id !== newest && !squeezed.has(id) && cand.some((c) => c.id === id))
  if (back.length && total() > avail - REOPEN_SLACK) back.forEach((id) => squeezed.add(id))
  const cap: Record<string, number> = {}
  const left = cand.filter((c) => !squeezed.has(c.id))
  const over = total() - avail
  if (over > 0 && left.length === 1) {
    const c = left[0]
    cap[c.id] = Math.max(MIN_BODY, c.body - over)
  }
  return { squeezed: [...squeezed], cap }
}

/** 按会话的开合状态(内存,不落盘)。 */
export const useSummaryOpen = create<{ by: Record<string, SessOpen> }>(() => ({ by: {} }))

const same = (a: SessOpen | undefined, b: SessOpen): boolean => !!a && JSON.stringify(a) === JSON.stringify(b)

export function syncOpen(sessionId: string, sigs: CardSig[], running: boolean): void {
  const cur = useSummaryOpen.getState().by[sessionId]
  const next = stepOpen(cur, sigs, running)
  if (!same(cur, next)) useSummaryOpen.setState((st) => ({ by: { ...st.by, [sessionId]: next } }))
}

const patch = (sessionId: string, fn: (s: SessOpen) => SessOpen): void => {
  const cur = useSummaryOpen.getState().by[sessionId] ?? { user: {}, auto: {}, prev: {}, last: {}, tick: 0, running: false }
  useSummaryOpen.setState((st) => ({ by: { ...st.by, [sessionId]: fn(cur) } }))
}

/** 用户点卡头开 / 收:管到这一轮结束。 */
export const setUserOpen = (sessionId: string, id: string, open: boolean): void =>
  patch(sessionId, (s) => ({ ...s, user: { ...s.user, [id]: open } }))

/** 计数之外的「来了新东西」(Agent Desk 换了顶格条目):自动展开并记成最新。 */
export const bumpOpen = (sessionId: string, id: string): void =>
  patch(sessionId, (s) => ({ ...s, auto: { ...s.auto, [id]: true }, last: { ...s.last, [id]: s.tick + 1 }, tick: s.tick + 1 }))
