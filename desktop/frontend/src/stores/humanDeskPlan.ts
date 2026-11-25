/** Human Desk 纯决策(2026-11-23 用户定第三轮:两张卡各自独立、右边一次只展开一块;方案页仓根
 *  docs/ToBeImproved/HumanTask实时协作方案_2026-11-20/r3.html)。Agent Desk 的摆法在 deskPlan.ts,这里只管 Human Desk:
 *  一样东西 + 在看 / 停止 + 最近放过的几样;右边展开的是哪一块由 deskSideOf 一处判定。appStore 只执行。 */
import { deskIdentity, deskItemFor, rememberRecent, DESK_RECENT_CAP, HUMAN_DESK_PERSIST_KEY, type DeskItem } from './deskPlan'

/** 跨窗同步、落盘的那部分:放着的那样东西、最近放过的、你点过「停止」。 */
export interface HumanDeskCore {
  item?: DeskItem
  /** 最近放过的(最新在前,≤8,含正放着的那样,不带 pin)。 */
  recent?: DeskItem[]
  /** 你点了停止:不再自动挂「现场」引用,直到点「继续看」或放上新东西。 */
  stopped?: true
}

/** 每扇窗自己的那部分(内存,不落盘、不同步)。 */
export interface HumanDeskRuntime {
  /** 这扇窗里 Human Desk 展开着(右边那块现在是它)。 */
  open?: true
  /** 离开 Human Desk(切到 Agent Desk / 收起)满一分钟:自动暂停,回来(展开它)就继续。 */
  paused?: true
  /** Human Desk 展开着时 Agent 往 Agent Desk 放了东西:切换件「Agent」那段亮点,切过去就灭。 */
  agentDot?: true
  /** 笔记:你在哪一节(展开态从编辑器的光标 / 滚动位置算出来)。idx = 第几个标题,卡片预览据此滚过去。 */
  section?: { n: number; title: string; idx: number }
}

export type HumanDeskState = HumanDeskCore & HumanDeskRuntime

export type HumanDeskAction =
  /** 放上来(＋ / 拖进来 / 「我来改」/ ▾ 换成最近放过的):换掉原来那样,原来那样进「最近放过的」;放上来就开始在看。 */
  | { type: 'put'; item: DeskItem }
  /** ⋯「从 Human Desk 拿掉」:空出来,最近放过的留着。 */
  | { type: 'remove' }
  | { type: 'stop' }
  | { type: 'resume' }
  /** 库里的文件被改名 / 挪走(to = 新路径)或删掉(to = null):放着的那样和「最近放过的」跟过去 / 拿掉。
   *  prefix = 整个文件夹(子树里的都算)。不跟的话编辑器攥着已退休的旧路径,之后打的字不落盘。 */
  | { type: 'retarget'; from: string; to: string | null; prefix?: boolean }

/** 东西在 Human Desk 上才算在看:没停、也没因为离开太久自动暂停。 */
export const humanWatching = (s: HumanDeskState | undefined): boolean => !!s?.item && !s.stopped && !s.paused

const unpinned = (it: DeskItem): DeskItem => {
  if (!it.pin && !it.live) return it
  const { pin: _pin, live: _live, ...rest } = it
  return rest
}

/** Human Desk 摆法的唯一入口(纯函数)。清字段写 undefined 不用 delete:调用方 `{ ...cur, ...next }`(同 deskReduce)。 */
export function humanDeskReduce(core: HumanDeskCore, a: HumanDeskAction): HumanDeskCore {
  switch (a.type) {
    case 'put': {
      const item = unpinned(a.item)
      const same = !!core.item && deskIdentity(core.item) === deskIdentity(item)
      // 同一样东西再放一次:条目不换(不重挂编辑器),只是重新开始看
      if (same) return core.stopped ? { ...core, stopped: undefined } : core
      return { ...core, item, recent: rememberRecent(core.recent, [item, ...(core.item ? [core.item] : [])]), stopped: undefined }
    }
    case 'remove':
      return core.item ? { ...core, item: undefined, stopped: undefined } : core
    case 'stop':
      return core.item && !core.stopped ? { ...core, stopped: true } : core
    case 'resume':
      return core.stopped ? { ...core, stopped: undefined } : core
    case 'retarget': {
      const norm = (x: string): string => x.replace(/\\/g, '/')
      const from = norm(a.from)
      const hit = (p: string): boolean => { const q = norm(p); return q === from || (!!a.prefix && q.startsWith(from + '/')) }
      const move = (it: DeskItem): DeskItem | null => {
        if (!it.path || !hit(it.path)) return it
        if (a.to === null) return null
        const to = a.prefix ? a.to + norm(it.path).slice(from.length) : a.to
        return deskItemFor(to, it.at)
      }
      const item = core.item ? move(core.item) : undefined
      const recent = core.recent?.map(move).filter((x): x is DeskItem => !!x)
      const same = item === core.item && (recent?.length ?? 0) === (core.recent?.length ?? 0) && (recent ?? []).every((x, i) => x === core.recent![i])
      if (same) return core
      return { ...core, item: item ?? undefined, recent, ...(item ? {} : { stopped: undefined }) }
    }
  }
}

/** ▾ 里「最近放过的」:正放着的那样排第一(灰,标「这一样」),其余按最近。 */
export function humanMenuRows(core: HumanDeskCore): Array<{ item: DeskItem; current: boolean }> {
  const out: Array<{ item: DeskItem; current: boolean }> = []
  const cur = core.item ? deskIdentity(core.item) : null
  if (core.item) out.push({ item: core.item, current: true })
  for (const it of core.recent || []) {
    if (out.length >= DESK_RECENT_CAP) break
    if (deskIdentity(it) === cur || out.some((x) => deskIdentity(x.item) === deskIdentity(it))) continue
    out.push({ item: it, current: false })
  }
  return out
}

// ── 右边展开的是哪一块(两块共用;一次一块) ──

export type DeskSide = 'agent' | 'human' | null

/** 唯一判定:Agent Desk 的 mode === 'open' 优先(它的卡片、截图、deskCardGone 都读这一个字段),否则看 Human Desk 开没开。
 *  两扇窗写的快照恢复时两个都开着也只认一个,不会两块同时展开。 */
export const deskSideOf = (agentMode: string | undefined, humanOpen: boolean | undefined): DeskSide =>
  agentMode === 'open' ? 'agent' : humanOpen ? 'human' : null

/** 离开 Human Desk 多久自动暂停。开发 / 台架可经 localStorage `forsion.dev.humanDeskPauseMs` 改短(真实使用没有入口)。 */
export const HUMAN_DESK_PAUSE_MS = 60_000
export function humanDeskPauseMs(): number {
  try {
    const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('forsion.dev.humanDeskPauseMs') : null)
    if (Number.isFinite(v) && v > 0) return v
  } catch { /* ignore */ }
  return HUMAN_DESK_PAUSE_MS
}

// ── 你在第几节(笔记) ──

/** 「第 N 节 · 标题」:headings = 文档里依次出现的标题(级别 + 文字),at = 光标 / 视口所在的那个标题下标(之前没有标题 = -1)。
 *  只有一个一级标题且排在最前 → 当成文档题目,不算一节;剩下的标题里最浅的那一级是「节」,N = 它是第几个。
 *  光标在第一节之前(题目底下的导语)→ null。标题里自带的编号(「3. 」「三、」)去掉,不和 N 重复。 */
export function deskSection(headings: Array<{ level: number; text: string }>, at: number): { n: number; title: string; idx: number } | null {
  if (at < 0 || at >= headings.length) return null
  const h1s = headings.filter((h) => h.level === 1).length
  const skipTitle = headings[0]?.level === 1 && h1s === 1 && headings.length > 1
  const first = skipTitle ? 1 : 0
  const rest = headings.slice(first)
  if (!rest.length) return null
  const base = Math.min(...rest.map((h) => h.level))
  let idx = -1
  for (let i = at; i >= first; i--) if (headings[i].level === base) { idx = i; break }
  if (idx < 0) return null
  let n = 0
  for (let i = first; i <= idx; i++) if (headings[i].level === base) n++
  const title = headings[idx].text.replace(/^\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十百]+)\s*[.、)）:：．](?!\d)\s*/, '').trim() || headings[idx].text.trim()
  return { n, title, idx }
}

// ── 快照(本机落盘 + 两扇窗同步) ──

export { HUMAN_DESK_PERSIST_KEY }
export const HUMAN_DESK_PERSIST_CAP = 40

const persistable = (it: DeskItem | undefined): it is DeskItem => !!it && !it.live && !it.tool && !!(it.path || it.view)

/** 只落 core(item / recent / stopped);空的会话不落;超容量按最近一次放东西的时间截断。 */
export function packHumanDeskMap(map: Record<string, HumanDeskCore>, cap = HUMAN_DESK_PERSIST_CAP): string {
  const at = (s: HumanDeskCore): number => Math.max(0, s.item?.at || 0, ...(s.recent || []).map((x) => x.at || 0))
  const entries = Object.entries(map)
    .map(([sid, s]): [string, HumanDeskCore] => {
      const out: HumanDeskCore = {}
      if (persistable(s.item)) out.item = unpinned(s.item)
      const recent = (s.recent || []).filter(persistable).map(unpinned)
      if (recent.length) out.recent = recent
      if (s.stopped && out.item) out.stopped = true
      return [sid, out]
    })
    .filter(([, s]) => s.item || s.recent?.length)
    .sort((a, b) => at(b[1]) - at(a[1]))
    .slice(0, cap)
  return JSON.stringify(Object.fromEntries(entries))
}

function unpackItem(it: any): DeskItem | null {
  if (!it || typeof it !== 'object' || it.live || it.tool) return null
  const view = it.view && typeof it.view.type === 'string' && it.view.type ? it.view : null
  const path = typeof it.path === 'string' ? it.path : ''
  if (!path && !view) return null
  const id = path || view.type
  return {
    key: typeof it.key === 'string' && it.key ? it.key : `${id}@0`,
    path,
    name: typeof it.name === 'string' && it.name ? it.name : String(id).split(/[\\/]/).pop() || id,
    at: typeof it.at === 'number' ? it.at : 0,
    ...(view ? { view: { type: view.type, ...(view.params && typeof view.params === 'object' && !Array.isArray(view.params) ? { params: view.params } : {}) } } : {}),
  }
}

/** 读不出 / 畸形 → 空表(Human Desk 只是摆法,读坏了不往回写,下次放东西时整条重写)。 */
export function unpackHumanDeskMap(raw: string | null | undefined): Record<string, HumanDeskCore> {
  if (!raw) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, HumanDeskCore> = {}
  for (const [sid, v] of Object.entries(parsed as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue
    const item = unpackItem(v.item)
    const recent = (Array.isArray(v.recent) ? v.recent : []).map(unpackItem).filter((x: DeskItem | null): x is DeskItem => !!x).slice(0, DESK_RECENT_CAP)
    if (!item && !recent.length) continue
    out[sid] = { ...(item ? { item } : {}), ...(recent.length ? { recent } : {}), ...(item && v.stopped === true ? { stopped: true as const } : {}) }
  }
  return out
}

/** 另一扇窗写了快照:只认这次写入真改了的会话(同 deskSessionsChanged 的口径)。 */
export function humanDeskSessionsChanged(before: Record<string, HumanDeskCore>, incoming: Record<string, HumanDeskCore>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(incoming)])
  return [...keys].filter((sid) => sid in incoming && JSON.stringify(before[sid] ?? null) !== JSON.stringify(incoming[sid]))
}

/** 收下对面这条会话的 core;本窗的展开 / 暂停 / 点 / 小节留着。换了一样东西而本窗没展开 Human Desk → 本窗算没在场(暂停),
 *  「在看」只在你真守着它的那扇窗里成立。同一样东西沿用本窗的条目对象(不重挂编辑器)。没变 → 原对象。 */
export function adoptHumanDesk(cur: HumanDeskState | undefined, theirs: HumanDeskCore): HumanDeskState {
  const base: HumanDeskState = cur ?? {}
  const sameItem = (!base.item && !theirs.item) || (!!base.item && !!theirs.item && JSON.stringify(base.item) === JSON.stringify(theirs.item))
  const sameRest = JSON.stringify(base.recent ?? null) === JSON.stringify(theirs.recent ?? null) && !!base.stopped === !!theirs.stopped
  if (sameItem && sameRest) return base
  const changedThing = !sameItem && !(base.item && theirs.item && deskIdentity(base.item) === deskIdentity(theirs.item))
  // 对面点了「继续看」而本窗没展开 Human Desk:本窗同样不算在场(否则本窗的引用一直挂着,也没有计时来暂停它)
  const resumedThere = !!base.stopped && !theirs.stopped && !base.open
  return {
    ...base,
    item: sameItem ? base.item : theirs.item,
    recent: theirs.recent,
    stopped: theirs.stopped,
    ...(changedThing ? { section: undefined } : {}),
    ...((changedThing || resumedThere) && !base.open ? { paused: true as const } : {}),
  }
}
