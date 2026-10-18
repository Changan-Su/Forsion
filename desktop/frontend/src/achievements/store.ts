/**
 * 成就系统 · 状态机(依赖铁律见 definitions.ts 头注释)。
 * - 各埋点一行 track(event):fire-and-forget,内部 try/catch 永不抛、永不影响主流程。
 * - counter>=goal 即「达成」(跨线那一刻入 toast 队列一次);面板「领取」后点数才计入系列勋章。
 * - 持久化 localStorage,save=读-合并-写(counter 取 max、claimed 并集,多窗口最终一致)。
 *   ponytail: max 合并意味着将来做「重置成就」须先改此语义。
 * - queue 不持久化:重启不补播 toast,未领取的在面板仍可领。
 * - 云端成就(cloud):服务端定义 / 判定 / 发奖,跟账号走,见文件末「云端成就」一节。和本机这套是两份数据:
 *   不进 allSeries()(track 的跨线 / claim 的本地领取都不碰它),只在 hasClaimable(红点)和面板里并进来。
 */
import { create } from 'zustand'
import { OFFICIAL_SERIES, type AchievementDef, type SeriesDef } from './definitions'

const KEY = 'forsion_tangu_achievements'
const COUNTER_CAP = 999_999
const CLOUD_KEY = 'forsion_cloud_achievements'
const DEVICE_KEY = 'forsion_achievements_device'
const REPORT_DELAY = 3000

interface Persisted { v: 1; counters: Record<string, number>; claimed: string[] }

export interface AchievementsState {
  /** event -> 累计次数 */
  counters: Record<string, number>
  /** 已领取的成就 id */
  claimed: Record<string, true>
  /** 插件运行时注册的系列(不持久化,禁用插件即消失;计数/领取留在 counters/claimed 无害) */
  pluginSeries: Array<{ pluginId: string; def: SeriesDef }>
  /** 待播成就 toast 的成就 id(FIFO) */
  queue: string[]
  /** 云端成就:服务器下发的定义 + 本账号进度 / 领取(缓存在 localStorage,启动即有;没登录时进度与领取清空、定义留着展示) */
  cloud: CloudState
  claim(id: string): void
  shiftToast(id: string): void
}

function load(): { counters: Record<string, number>; claimed: Record<string, true> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Persisted | null
    if (raw?.v === 1) {
      const counters: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw.counters || {})) if (typeof v === 'number' && v > 0) counters[k] = Math.min(v, COUNTER_CAP)
      const claimed: Record<string, true> = {}
      for (const id of raw.claimed || []) if (typeof id === 'string') claimed[id] = true
      return { counters, claimed }
    }
  } catch { /* 首次 / 损坏 / node 测试环境 → 空 */ }
  return { counters: {}, claimed: {} }
}

function save(): void {
  try {
    const { counters, claimed } = useAchievements.getState()
    const disk = load()
    for (const [k, v] of Object.entries(counters)) disk.counters[k] = Math.max(disk.counters[k] || 0, v)
    const data: Persisted = { v: 1, counters: disk.counters, claimed: Object.keys({ ...disk.claimed, ...claimed }) }
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch { /* 配额 / 隐私模式:静默 */ }
}

export const useAchievements = create<AchievementsState>((set, get) => ({
  ...load(),
  pluginSeries: [],
  queue: [],
  cloud: loadCloud(),
  claim: (id) => {
    const s = get()
    const a = allSeries(s).flatMap((x) => x.achievements).find((x) => x.id === id)
    if (!a || s.claimed[id] || (s.counters[a.event] || 0) < a.goal) return
    set({ claimed: { ...s.claimed, [id]: true } })
    save()
  },
  // queue[0] 匹配才出队:animationend 与 timeout 兜底双触发下幂等。
  shiftToast: (id) => {
    const q = get().queue
    if (q[0] === id) set({ queue: q.slice(1) })
  },
}))

/** 别的窗口写了成就(设置 / 市场是独立浮窗,换主题、装插件、登录都在那边 track):按磁盘合并计数与领取,
 *  在本窗新跨线且未领取的入队 —— 成就弹窗只挂在主窗,以前那些解锁排进浮窗自己的队列永远不播(09-21)。
 *  storage 事件只发给「别的」同源窗口,且在写入可见之后发,读 localStorage 拿到的就是那次写入;
 *  也顺带修掉本窗计数陈旧(否则本窗之后再 track 同一事件会按旧值二次跨线、重播一次)。 */
export function syncAchievementsFromDisk(): void {
  const s = useAchievements.getState()
  const disk = load()
  const counters = { ...s.counters }
  for (const [k, v] of Object.entries(disk.counters)) counters[k] = Math.max(counters[k] || 0, v)
  const claimed = { ...s.claimed, ...disk.claimed }
  const crossed = allSeries(s).flatMap((x) => x.achievements)
    .filter((a) => (s.counters[a.event] || 0) < a.goal && (counters[a.event] || 0) >= a.goal && !claimed[a.id] && !s.queue.includes(a.id))
    .map((a) => a.id)
  useAchievements.setState({ counters, claimed, queue: crossed.length ? [...s.queue, ...crossed] : s.queue })
}
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY) syncAchievementsFromDisk() })

/** 官方 + 插件系列(传 state 避免组件里重复 getState;不传则取当前)。 */
export function allSeries(s?: Pick<AchievementsState, 'pluginSeries'>): SeriesDef[] {
  const ps = (s || useAchievements.getState()).pluginSeries
  return ps.length ? [...OFFICIAL_SERIES, ...ps.map((x) => x.def)] : OFFICIAL_SERIES
}

/** 「已达成、未领取」—— 成就红点的唯一判据(Ribbon 奖杯 / 「更多」、成就面板系列名)。传 series 只看这一个本机系列;
 *  不传 = 本机 + 云端一起算(云端只在已登录时算:没登录领不了,亮着也白亮)。 */
export function hasClaimable(
  s: Pick<AchievementsState, 'pluginSeries' | 'counters' | 'claimed'> & Partial<Pick<AchievementsState, 'cloud'>> = useAchievements.getState(),
  series?: SeriesDef,
): boolean {
  if (!series && s.cloud && cloudClaimable(s.cloud)) return true
  return (series ? [series] : allSeries(s)).some((x) => x.achievements.some((a) => !s.claimed[a.id] && (s.counters[a.event] || 0) >= a.goal))
}

export function findAchievement(id: string): { a: AchievementDef; series: SeriesDef } | null {
  for (const series of allSeries()) {
    const a = series.achievements.find((x) => x.id === id)
    if (a) return { a, series }
  }
  return null
}

/** 埋点入口:累计计数,新跨线(before<goal<=after)成就入 toast 队列。 */
export function track(event: string, n = 1): void {
  try {
    if (!event || !(n > 0)) return
    const s = useAchievements.getState()
    const before = s.counters[event] || 0
    const after = Math.min(before + Math.floor(n), COUNTER_CAP)
    if (after === before) return
    const crossed = allSeries(s)
      .flatMap((x) => x.achievements)
      .filter((a) => a.event === event && before < a.goal && after >= a.goal && !s.claimed[a.id] && !s.queue.includes(a.id))
      .map((a) => a.id)
    useAchievements.setState({
      counters: { ...s.counters, [event]: after },
      queue: crossed.length ? [...s.queue, ...crossed] : s.queue,
    })
    save()
    scheduleCloudReport(event)
  } catch { /* 装饰性功能,绝不拖累调用方 */ }
}

/** 插件系列注册入参(与 amadeus/plugins/types.ts 的 contribution 形状一致,此处不 import 以守铁律)。 */
export interface PluginSeriesInput {
  id: string
  title: string
  medals?: { bronze: number; silver: number; gold: number }
  achievements: Array<{ id: string; title: string; desc: string; event: string; goal: number; points: number }>
}

/** Amadeus 插件注册系列:系列 id/成就 id/event 一律强制 `plugin:<pid>:` 前缀(撞不了官方 id、伪造不了官方计数)。 */
export function registerPluginSeries(pluginId: string, def: PluginSeriesInput): void {
  try {
    if (!def?.id || !Array.isArray(def.achievements) || !def.achievements.length) throw new Error('empty series')
    const p = (x: string): string => `plugin:${pluginId}:${x}`
    const achievements: AchievementDef[] = def.achievements.map((a) => {
      if (!a.id || !a.event || !(a.goal > 0) || !(a.points >= 0)) throw new Error(`bad achievement "${a.id}"`)
      return { id: p(a.id), event: p(a.event), goal: Math.floor(a.goal), points: Math.floor(a.points), title: String(a.title || a.id), desc: String(a.desc || '') }
    })
    const total = achievements.reduce((sum, a) => sum + a.points, 0)
    const medals = def.medals && def.medals.bronze > 0 ? def.medals : { bronze: Math.ceil(total * 0.25), silver: Math.ceil(total * 0.6), gold: total }
    const series: SeriesDef = { id: p(def.id), title: String(def.title || def.id), medals, achievements }
    useAchievements.setState((s) => ({ pluginSeries: [...s.pluginSeries.filter((x) => x.def.id !== series.id), { pluginId, def: series }] }))
  } catch (e) {
    console.error(`[achievements] plugin "${pluginId}" registerSeries failed`, e)
  }
}

/** 开发者模式「触发成就弹窗」:首次跨线正常得成就(奖励一次),之后每次调用都重放 toast(队列去重防叠播)。 */
export function debugFireToast(): void {
  track('debug.toast')
  useAchievements.setState((s) => (s.queue.includes('debug-toast') ? s : { queue: [...s.queue, 'debug-toast'] }))
}

/** 插件停用时由宿主 teardown 调用。 */
export function unregisterPluginAchievements(pluginId: string): void {
  useAchievements.setState((s) => (s.pluginSeries.some((x) => x.pluginId === pluginId)
    ? { pluginSeries: s.pluginSeries.filter((x) => x.pluginId !== pluginId) }
    : s))
}

// ── 云端成就 ──────────────────────────────────────────────────────────────────
// 服务端(server microserver/achievements)定义、判定、发奖,跟账号走:客户端照旧 track(),登录状态下把云端成就用到的那几个
// 事件的**本机累计值**节流上报(服务端按 设备 取最大、各设备相加,重报幂等),领取走服务端(每个账号只发一次,数据库唯一约束)。
// 通道 = window.tangu.cloudFetch(桌面 = Extend 主进程盖令牌;Android 自带同契约实现);没有它(网页版 / 没装 Extend)= 整块不出现。

export interface Bilingual { zh: string; en: string }
/** 与服务端 GET /api/achievements/me 每一项同形 */
export interface CloudAchievement {
  id: string
  series: string
  seriesTitle: Bilingual
  title: Bilingual
  desc: Bilingual
  event: string
  goal: number
  points: number
  /** 奖励物品(label 是服务端冻结的双语名);领过的是领取那一刻的快照 */
  reward: Array<{ kind: string; label?: Bilingual }> | null
  claimUntil: string | null
  expired: boolean
  /** 服务端算的账号进度(各设备之和) */
  progress: number
  claimed: { device: string | null; at: string | null } | null
  /** 后台开关;停用了但领过的也会下发(留着「已领取」) */
  enabled?: boolean
}
export interface CloudState { list: CloudAchievement[]; signedIn: boolean }

function loadCloud(): CloudState {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null') as CloudState | null
    if (raw && Array.isArray(raw.list)) return { list: raw.list, signedIn: !!raw.signedIn }
  } catch { /* 首次 / 损坏 / node 测试环境 */ }
  return { list: [], signedIn: false }
}
function setCloud(cloud: CloudState): void {
  useAchievements.setState({ cloud })
  try { localStorage.setItem(CLOUD_KEY, JSON.stringify(cloud)) } catch { /* 配额 / 隐私模式 */ }
}

/** 已登录、达成、没领、没过期 —— 云端那半的红点判据。传 series 只看这一个系列。 */
export function cloudClaimable(c: CloudState, series?: string): boolean {
  return c.signedIn && c.list.some((a) => (!series || a.series === series) && !a.claimed && !a.expired && a.progress >= a.goal)
}

type CloudReply = { status: number; json?: any; error?: string; seq: number; epoch: number }
// 回包按发出顺序认:先发的晚到(进度回包压过领取结果)丢掉;换号(onAuthChanged)前发出的一律丢(A 的回包别落到 B 头上)
let sentSeq = 0, appliedSeq = 0, authEpoch = 0
async function cloudCall(path: string, method = 'GET', body?: unknown): Promise<CloudReply | null> {
  const f = typeof window !== 'undefined' ? window.tangu?.cloudFetch : undefined
  if (!f) return null
  const seq = ++sentSeq, epoch = authEpoch
  try { return { ...(await f({ path, method, ...(body !== undefined ? { body } : {}) })), seq, epoch } } catch { return null }
}
/** 回包 → 状态。401 = 没登录 / 令牌失效:定义留着展示(停用的去掉),进度与领取清掉(换号的人看不到上一位的)。
 *  返回是否拿到了列表(过时的回包不落状态,但照样算拿到)。 */
function absorb(r: CloudReply | null): boolean {
  if (!r) return false
  const fresh = r.epoch === authEpoch && r.seq > appliedSeq
  if (fresh) appliedSeq = r.seq
  if (r.status === 401) {
    const { list } = useAchievements.getState().cloud
    if (fresh) setCloud({ signedIn: false, list: list.filter((a) => a.enabled !== false).map((a) => ({ ...a, progress: 0, claimed: null })) })
    return false
  }
  if (r.status === 200 && Array.isArray(r.json?.achievements)) { if (fresh) setCloud({ signedIn: true, list: r.json.achievements }); return true }
  return false
}

function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = globalThis.crypto?.randomUUID?.() ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch { return 'device-unknown' } // ponytail: 存不了 localStorage 的几台并成一个设备,进度取它们里最大的
}
/** 「已在 Mac 上领取」的那个名字 */
function deviceLabel(): string {
  const t = typeof window !== 'undefined' ? window.tangu : undefined
  if (t?.mobile) return 'Android'
  return ({ darwin: 'Mac', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[t?.platform || ''] || 'Web'
}
/** 云端成就用到的事件 → 本机累计值(只报 >0 的);没有可报的回 null */
function cloudCounts(): Record<string, number> | null {
  const s = useAchievements.getState()
  const out: Record<string, number> = {}
  for (const a of s.cloud.list) if ((s.counters[a.event] || 0) > 0) out[a.event] = s.counters[a.event]
  return Object.keys(out).length ? out : null
}

/** 拉一次(有可报的计数就直接报,上报接口回的就是最新列表)。第一次还没有定义时先拉定义,再把本机已有的计数补报上去。永不抛。 */
export async function refreshCloudAchievements(): Promise<void> {
  const report = (counts: Record<string, number>) => cloudCall('/achievements/progress', 'POST', { deviceId: deviceId(), counts })
  const counts = cloudCounts()
  const got = absorb(await (counts ? report(counts) : cloudCall('/achievements/me')))
  const late = !counts && got ? cloudCounts() : null
  if (late) absorb(await report(late))
}

let reportTimer: ReturnType<typeof setTimeout> | null = null
/** track() 命中云端成就用到的事件 → 节流上报(REPORT_DELAY 内的多次合成一次;报的是累计值,丢一次下次补上) */
function scheduleCloudReport(event: string): void {
  const { cloud } = useAchievements.getState()
  if (reportTimer || !cloud.signedIn || !cloud.list.some((a) => a.event === event)) return
  reportTimer = setTimeout(() => { reportTimer = null; void refreshCloudAchievements() }, REPORT_DELAY)
}

export type ClaimError = 'not_completed' | 'expired' | 'not_found' | 'grant_failed' | 'signed_out' | 'network' | 'unknown'
const CLAIM_ERRORS = new Set<string>(['not_completed', 'expired', 'not_found', 'grant_failed'])
/** 领取云端成就。成功后状态已换成服务端回的列表;失败回错误类别(界面按它取双语文案,不显示服务端的中文 detail)并重拉一次对齐服务端。 */
export async function claimCloudAchievement(id: string): Promise<{ ok: true } | { ok: false; reason: ClaimError }> {
  const r = await cloudCall(`/achievements/${encodeURIComponent(id)}/claim`, 'POST', { device: deviceLabel() })
  if (absorb(r)) return { ok: true }
  if (r && r.status !== 401) void refreshCloudAchievements()
  const code = r?.json?.error
  return { ok: false, reason: !r || !r.status ? 'network' : r.status === 401 ? 'signed_out' : CLAIM_ERRORS.has(code) ? code : 'unknown' }
}

let cloudInited = false
/** 宿主启动时调一次(bootstrapEngine 注册奖杯处):首拉延后几秒(等 Extend 的主进程通道就位),登录 / 登出 / 换号重拉,
 *  窗口回到前台最多每分钟拉一次(别的设备上领了,这边的红点跟着灭)。 */
export function initCloudAchievements(): void {
  if (cloudInited || typeof window === 'undefined' || !window.tangu?.cloudFetch) return
  cloudInited = true
  setTimeout(() => { void refreshCloudAchievements() }, 4000)
  window.tangu.onAuthChanged?.(() => { authEpoch++; void refreshCloudAchievements() })
  let last = Date.now()
  window.addEventListener('focus', () => { if (Date.now() - last > 60_000) { last = Date.now(); void refreshCloudAchievements() } })
}
