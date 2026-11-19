/** 两级导航里「一趟」的页内历史:从列表点进主区的那一页是这一趟的起点,返回 = 回列表。
 *
 *  2026-10-13 用户实报「侧滑返回逻辑有些诡异」:列表 → 会话甲 → 回列表 → 会话乙,按返回先翻回会话甲(这一页不是从它
 *  那儿来的),再按才是列表。页内历史(navStore)是按标签记的浏览器式栈,桌面上箭头要的就是这个;手机上列表层才是
 *  「上一页」,进这一趟之前看过的页不该排在它前面。
 *
 *  做法:列表层在屏上时,每个栈只留它现在那一页;进了主区、人还没碰屏幕之前记进来的页**顶替**留下的那一页
 *  (那是点条目开出来的页),碰过之后记进来的才往上叠(那是这一趟里自己走出来的:笔记 → 链接 → 另一篇 → 返回)。
 *  留一页而不是清空:点回刚才那一条时没有东西会重新记它(会话 id、笔记路径都没变),清空的话这一趟的第一页就不在
 *  栈里,从它点链接出去再返回会直接掉回列表(Codex 评审 P2)。
 *
 *  ⚠️ 挂在两个 store 上同步做,不放进 React effect,也不只在「回到列表」那一下做:
 *     · 人停在列表上时也有东西往栈里记 —— 进 Space 时还原出来的那条会话(bootstrapEngine 的分账)晚一拍才记
 *       (台架抓到过:重进 Tangu 后点会话甲,返回翻出了会话乙);
 *     · 点条目是「先换会话、再收列表」,会话那条记录排在微任务里,比 React 提交早。
 *  ponytail: 「碰没碰过屏幕」是猜,不是页面自己报的。一页要是等到人已经碰了屏幕才记(装载很慢的笔记),它会叠在进来之前
 *  那一页上,返回先翻出那一页 —— 就是改之前的样子。要根治得让视图在进主区时报「我现在显示的是哪一页」。
 *  桌面 / 网页 / 手机浏览器没有列表层(listFirstNow 恒 false),这里什么都不做。仪器:listTrips.test.ts、
 *  mobile `emu:nativeshell` 的「back:」那条。 */
import { useNav } from './navStore'
import { useWorkspace } from './singleColumnStore'
import { listFirstNow } from './listFirst'
import { useSpaceStore } from './spaceRegistry'

/** 栈里留着的那一页是进这一趟之前的:列表层在屏上起为真,进主区后人碰了屏幕为假。 */
let inherited = false
const atList = (): boolean => useWorkspace.getState().leftVisible && listFirstNow()

function settle(): void {
  if (atList()) inherited = true
  if (!inherited) return
  const { stacks } = useNav.getState()
  let next: typeof stacks | null = null
  for (const id in stacks) {
    const st = stacks[id]
    if (st.entries.length > 1) (next ??= { ...stacks })[id] = { entries: [st.entries[st.idx]], idx: 0 }
  }
  if (next) useNav.setState({ stacks: next })
}

/** 人碰了屏幕(或按了键):不在列表层的话,从这儿往后记下的页是这一趟里走出来的。 */
export function touchedPage(): void {
  if (!atList()) inherited = false
}

/** 手机单列壳装一次(SingleColumnHost 模块作用域)。返回值卸掉监听,测试用。 */
export function installListTrips(): () => void {
  const tripTick = (): void => {
    const lf = listFirstNow()
    const left = useWorkspace.getState().leftVisible
    settleReturnTrip(useSpaceStore.getState().activeSpaceId, lf && left, lf && !left)
  }
  const offs = [useWorkspace.subscribe(settle), useNav.subscribe(settle), useWorkspace.subscribe(tripTick), useSpaceStore.subscribe(tripTick)]
  if (typeof window !== 'undefined') {
    for (const ev of ['pointerdown', 'keydown'] as const) {
      window.addEventListener(ev, touchedPage, true)
      offs.push(() => window.removeEventListener(ev, touchedPage, true))
    }
  }
  return () => { offs.forEach((off) => off()); inherited = false; trip = null }
}

// ── 从主页「继续」点进来的一趟(2026-11-19,方向 E 第 1 步)──────────────────────────────────────
// 主页「继续」里点一行,直接进那条对话 / 那篇笔记(被带去它自己的 Space 的第二层);这一页返回 = 回主页,不经那个 Space 的列表。
// 三条返回路都问这里:顶栏左钮(SingleColumnHost 的 returnFromTrip)、系统 / 浏览器返回(mobile 的 planBack)、页面往右拖出列表
// (useDrawerDrag:这一趟里不跟手拖出列表,系统返回手势照旧)。
// 开始 = 调 beginReturnTrip(之后紧接着开内容);**落定** = 第一次看到「换到了另一个 Space、且在它的第二层」。之后:换了 Space
// (包括回到主页)、或者列表层出来了就结束;3 秒内没落定(没开成)也结束。
// ⚠️ 进去的那一下本身会经过列表层:换 Space 时先落到列表(landOnList),内容开出来才收起 —— 而 store 在换 Space 的半中间就可能
//    已经满足「另一个 Space 的第二层」(收列表之前那一拍)。所以落定后 ENTRY_MS 之内冒出来的列表层算进门的一部分,不结束这一趟。
//    只有手机两级导航用得到(listFirstNow 为假时不会落定)。
let trip: { from: string; to: string | null; until: number; settledAt: number } | null = null
const tripSubs = new Set<() => void>()
const TRIP_SETTLE_MS = 3000
const ENTRY_MS = 600
export function subscribeReturnTrip(fn: () => void): () => void { tripSubs.add(fn); return () => { tripSubs.delete(fn) } }
function setTrip(next: typeof trip): void { if (trip === next) return; trip = next; tripSubs.forEach((fn) => fn()) }

/** 主页「继续」开内容之前调:记下现在在哪个 Space(`from`)。 */
export function beginReturnTrip(from: string): void { setTrip({ from, to: null, until: Date.now() + TRIP_SETTLE_MS, settledAt: 0 }) }
/** 这一页返回该回哪个 Space(落定了才有);没有这一趟 = null。 */
export function returnTripOrigin(): string | null { return trip?.to ? trip.from : null }
export function endReturnTrip(): void { setTrip(null) }

/** 每次工作区 / Space 变化时调(installListTrips 挂上)。`active` = 当前活动 Space。 */
export function settleReturnTrip(active: string, atList: boolean, detail: boolean): void {
  if (!trip) return
  if (!trip.to) {
    if (Date.now() > trip.until) setTrip(null)
    else if (active !== trip.from && detail) setTrip({ ...trip, to: active, settledAt: Date.now() })
    return
  }
  if (active !== trip.to || (atList && Date.now() - trip.settledAt > ENTRY_MS)) setTrip(null)
}
