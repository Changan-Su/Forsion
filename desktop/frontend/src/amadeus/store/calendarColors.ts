/** 日历来源的颜色定下来就不动:一个来源第一次出现时定一个调色板色存下(calendarConfigStore 的 autoColors),
 *  之后排在它前面的来源多一个少一个、冷启动时来源分批到齐,都不再换色。
 *  这里只管「什么时候、拿哪一列来源去定色」;怎么取色是 planAutoColors(纯函数),落盘是 ensureColors(store 动作)。
 *  内置视图(日历 / 日历设置 / 待办 / 仪表盘日程)和插件接缝 ctx.calendar 共用同一个看守(acquireCalendarColors),
 *  所以各处看到的是同一份存下来的颜色,不是各自按手里那一列算。
 *
 *  播种时机(老用户升级):第一次跑到这里的库还没有 autoColors,要按老规则(排第几个取第几个色)把**到齐之后**的一整列存下,
 *  升级前后才是同一套颜色。来源是分批到的 —— 默认日历一到就插到第 0 位、Agent 日程排在订阅前面 —— 没到齐就存,
 *  存下的是冷启动半路上的过渡色。所以播种要等:表读完、另一侧库拉过、Agent 日程拉过、引擎那两样(默认日历 + Agent 日程)都答上了;
 *  拉过但引擎一直不答(旧引擎 / 不在本机)就等满 GRACE_MS 再播。没播种之前照旧按序号显示,什么都不写。
 *  只开着待办 / 主页日程卡(不拉 Agent 日程、不拉另一侧)时不播种 —— 等用户打开日历或日历插件订阅上来。
 *  播种之后的新来源不等叠加源:成员到齐就定,取这一列里用得最少的色。 */
import { useEffect } from 'react'
import { calendarSettingsSync, colorsSeeded, useCalendarConfig } from './calendarConfigStore'
import { resolveCalendarMembers, withHumanCal } from './calendarMembers'
import { getAggDb, watchAllDatabases, type AggDb } from './dbAggregateStore'
import { useDbStore } from './dbStore'
import { HUMAN_CAL } from './humanCalendarIo'
import { mdCalPathNow, useMdMarkStore } from './mdMarkStore'
import { usePageStore } from './pageStore'
import { agentScheduleDbs, useAgentSchedules } from '../../stores/agentScheduleStore'
import { useIcsCalendars } from '../../stores/icsCalendarStore'
import { otherSideKey, useOtherSideCal } from '../../stores/otherVaultCalStore'

/** 引擎迟迟不答时,播种最多等这么久(盖住默认日历 3s / 10s / 30s 的重试和 Agent 日程 60s 一轮的轮询)。 */
export const GRACE_MS = 75_000

/** 此刻的一整列来源路径,顺序 = 老规则取色的顺序(也是图例的顺序):成员(默认日历在最前)→ Agent 日程 → 另一侧库 → .ics 订阅 → 笔记里的 `@` 日程。
 *  另一侧的 dbs 只在它确实是为当前这个库拉的时候才算(刚换库那一拍 store 里还是上一个库的)。 */
export function calendarSourcePaths(dbs: AggDb[]): string[] {
  const vault = usePageStore.getState().vaultRoot ?? ''
  const members = withHumanCal(getAggDb(HUMAN_CAL), resolveCalendarMembers(dbs, vault, useCalendarConfig.getState().byVault), vault)
  const agent = useAgentSchedules.getState().schedules
  const other = useOtherSideCal.getState()
  const md = mdCalPathNow()
  return [
    ...members.map((m) => m.db.path),
    ...agentScheduleDbs(Array.isArray(agent) ? agent : []).map((db) => db.path),
    ...(other.loadedFor === otherSideKey() ? other.dbs.map((db) => db.path) : []),
    ...useIcsCalendars.getState().subs.map((s) => `ics://${s.id}`),
    ...(md ? [md] : []),
  ]
}

/** 库 → 第一次「本来可以播种、只差引擎没答」的时刻(本次运行内;宽限从这里起算)。 */
const waitingSince = new Map<string, number>()

/** 给此刻这一列来源里还没定色的定色。dbs / ready 来自 watchAllDatabases。
 *  返回还要等多少毫秒再来一次(在等引擎的宽限);不用等 = 0。 */
export function ensureCalendarColors(dbs: AggDb[], ready: boolean, now: number = Date.now()): number {
  const vault = usePageStore.getState().vaultRoot
  if (!vault || !ready) return 0
  // 默认日历落定(读到 / 读不到都算)才知道成员这一段齐了:它在不在,决定后面每个成员排第几。
  const human = useDbStore.getState().entries[HUMAN_CAL]?.status
  if (!human || human === 'loading') return 0
  const cfg = useCalendarConfig.getState()
  const seed = !colorsSeeded(vault, cfg.byVault)
  if (seed) {
    if (useOtherSideCal.getState().loadedFor !== otherSideKey()) return 0 // 拉完会再触发一次
    const agent = useAgentSchedules.getState()
    // 没人拉过 Agent 日程(只开着待办 / 主页的日程卡,它们不轮询):这一列还缺一段,等到有人拉(打开日历 / 日历插件订阅)再说
    if (!agent.loaded) return 0
    const engineAnswered = human !== 'missing' && agent.ok
    if (!engineAnswered) {
      const since = waitingSince.get(vault) ?? now
      waitingSince.set(vault, since)
      const left = since + GRACE_MS - now
      if (left > 0) return left
    }
  }
  cfg.ensureColors(vault, calendarSourcePaths(dbs), seed)
  return 0
}

let users = 0
let stop: (() => void) | undefined
function start(): () => void {
  let dbs: AggDb[] = []
  let ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (): void => {
    const wait = ensureCalendarColors(dbs, ready)
    if (wait > 0 && timer === undefined) timer = setTimeout(() => { timer = undefined; run() }, wait + 20)
  }
  const offs = [
    // 随账号走的库:有人在看日历期间,共享那份聚焦 + 定时重读(留本机的库那边直接返回)
    calendarSettingsSync.acquire(() => usePageStore.getState().vaultRoot),
    watchAllDatabases((d, r) => { dbs = d; ready = r; run() }), // 换库 / 文件清单 / 每张表(含默认日历)的读取状态都从这里来
    useCalendarConfig.subscribe(run), // 成员增删
    useAgentSchedules.subscribe(run),
    useOtherSideCal.subscribe(run),
    // 这两个 store 变得很勤(.ics 的 loading 位、拖动时每帧的乐观覆盖),只在来源那一列可能变的时候才看
    useIcsCalendars.subscribe((s, p) => { if (s.subs !== p.subs) run() }),
    useMdMarkStore.subscribe((s, p) => { if (s.marks !== p.marks) run() }),
  ]
  return () => { for (const off of offs) off(); if (timer !== undefined) clearTimeout(timer) }
}

/** 看守:来源一有变化就给新来源定色。多处共用一份订阅,最后一个使用者释放时停(释放函数只生效一次)。
 *  ⚠️只在这里(store 订阅回调里)写 —— 不在 React 渲染里、也不在算快照的纯函数里写 store。 */
export function acquireCalendarColors(): () => void {
  if (++users === 1) stop = start()
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users === 0) { stop?.(); stop = undefined }
  }
}

/** 内置视图用:挂着的时候看守在岗。颜色照旧从 colorForDb(vault, byVault, path, 序号) 读。 */
export function useStableCalendarColors(): void {
  useEffect(() => acquireCalendarColors(), [])
}
