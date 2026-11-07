/**
 * 插件的上手提示(2026-11-02;方案页 docs/ToBeImproved/可复用引导系统方案_2026-11-02/,用户选 D「用到时再提示」+ B 空态例句)。
 *
 * 插件在 manifest `guide.tips` 里声明,宿主决定什么时候出:锚点(插件自己 View 里的 `data-guide-anchor`)在屏幕上、`when` 成立、
 * 还没会(`done` 计数 = 0)、没看过 / 没被关、宿主节奏允许。出的样子复用 guideSpotlight(同一个槽:全应用同一时刻一处)。
 *
 * - 「会了」不存,每次从成就计数算(同插件闸卡「状态全由实测派生」):用户后来做没做,计数说了算。
 * - 看过 / 不再提示只记本机(成就计数本身也是本机的,换台电脑会再出一次,方案页写明了)。
 * - 记账按「插件 id + 提示 id」:插件升级新加的提示是新 id,老用户自然会碰到 —— 别做「装好时把现有提示全记成看过」这种捷径。
 * - 读本机存储失败 = 不知道,这一回不出(不当成没看过,坏掉的存储不该每次都弹;CLAUDE.md 读写用户数据那条)。
 * - 提示不进 popupQueue(它不是弹窗,不该让公告排在它后面),但有弹窗在排 / 开着、首启向导开着时等着。
 */
import type { PluginGuideTip } from '@amadeus-shared/ipc'
import { useAchievements } from '../../achievements/store'
import { usePopupQueue } from '../../stores/popupQueue'
import { currentLocale, registerMessages } from '../../i18n'
import { closeSpotlight, showTip, spotlightActive } from './guideSpotlight'
import { sendTelemetry } from '../../telemetrySend'
import { telemetryPluginRef, type TelemetryPluginLike } from '../../telemetryPluginId'

export const GUIDE_DAILY_MAX = 3 // 全应用一天最多出几条
export const OPEN_DELAY_MS = 2000 // 锚点出现后至少这么久才出(刚打开 View 时别抢)
export const IDLE_MS = 1500 // 停手这么久才出(正在打字不打断)

const mem = new Map<string, string>()
const K = {
  enabled: 'guide.enabled',
  day: 'guide.day',
  seen: (p: string, t: string) => `guide.${p}.${t}`,
  muted: (p: string) => `guide.${p}.__muted`,
  open: (p: string, v: string) => `guide.${p}.__open.${v}`,
}
/** undefined = 读失败(不知道);null = 没有这条。 */
const read = (k: string): string | null | undefined => { if (mem.has(k)) return mem.get(k); try { return localStorage.getItem(k) } catch { return undefined } }
/** 写不进(存储满了)就在内存里记着这一程,否则点过 × 的一重开 View 又出、当天条数也不涨。 */
const write = (k: string, v: string): void => { try { localStorage.setItem(k, v); mem.delete(k) } catch { mem.set(k, v) } }
/** 本地日期键 YYYY-MM-DD(记账用,不是显示文案)。 */
const today = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const tipsOf = new Map<string, PluginGuideTip[]>()
const requested = new Set<string>()
const rk = (p: string, t: string): string => `${p}\n${t}`
let current: { pluginId: string; tip: PluginGuideTip } | null = null
let lastInput = 0
let timer: ReturnType<typeof setInterval> | null = null
const shownHosts = new WeakSet<Element>() // 一个 View 打开一次最多出一条:View 重新挂载就是新的宿主元素
const firstSeen = new Map<string, { el: Element; t: number }>() // 锚点连续看得见的起点;看不见了 / 换了元素就重新计

export const guideEnabled = (): boolean => read(K.enabled) !== '0'
export function setGuideEnabled(on: boolean): void {
  write(K.enabled, on ? '1' : '0')
  if (!on && current) closeSpotlight(current.pluginId)
}
/** 设置里的「重新显示」/ 命令面板「重置上手提示」:清掉看过、不再提示和当天计数(开关和打开次数留着)。 */
export function resetGuide(): void {
  try {
    const drop: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('guide.') && k !== K.enabled && !k.includes('.__open.')) drop.push(k)
    }
    for (const k of drop) localStorage.removeItem(k)
  } catch { /* 读不了就没什么可清 */ }
  for (const k of [...mem.keys()]) if (k !== K.enabled && !k.includes('.__open.')) mem.delete(k)
}

/** PluginViewHost 每挂载一次记一次(manifest `when.open`)。 */
export function noteViewOpen(pluginId: string, viewId: string): void {
  if (!tipsOf.has(pluginId)) return
  const n = Number(read(K.open(pluginId, viewId)) ?? 0) || 0
  write(K.open(pluginId, viewId), String(n + 1))
}

const counter = (pluginId: string, ev: string): number =>
  useAchievements.getState().counters[ev.startsWith('app:') ? ev.slice(4) : `plugin:${pluginId}:${ev}`] || 0
const learned = (pluginId: string, tip: PluginGuideTip): boolean => !!tip.done?.some((e) => counter(pluginId, e) >= 1)

export function tipState(pluginId: string, tipId: string): 'waiting' | 'seen' | 'learned' | 'muted' | 'off' {
  const tip = tipsOf.get(pluginId)?.find((t) => t.id === tipId)
  if (tip && learned(pluginId, tip)) return 'learned'
  const muted = read(K.muted(pluginId)), seen = read(K.seen(pluginId, tipId))
  if (!guideEnabled() || muted === undefined || seen === undefined) return 'off'
  return muted ? 'muted' : seen ? 'seen' : 'waiting'
}

/** 只在这个插件自己的 View 里找,而且要在视口里(看不见的锚点不算「在屏幕上」)。 */
function anchor(pluginId: string, name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide-owner="${CSS.escape(pluginId)}"] [data-guide-anchor="${CSS.escape(name)}"]`)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) return el
  }
  return null
}

/** 真看得见:中心点打到的是锚点自己或它里面(被列表滚出去、被浮层盖住的不算;否则出提示时还会把列表滚过去)。 */
function seenAnchor(pluginId: string, name: string): HTMLElement | null {
  const el = anchor(pluginId, name)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return hit && el.contains(hit) ? el : null
}

function condOk(pluginId: string, tip: PluginGuideTip): boolean {
  const w = tip.when
  if (!w) return false // 没写 when = 只能 ctx.guide.show
  if ('open' in w) return (Number(read(K.open(pluginId, w.open)) ?? 0) || 0) >= w.times
  if ('count' in w) return counter(pluginId, w.count) >= w.atLeast
  return w.visible.every((n) => !!seenAnchor(pluginId, n))
}

export interface GuideCandidate {
  pluginId: string
  tip: PluginGuideTip
  /** 记账原值:null = 没有;undefined = 读失败。 */
  seen: string | null | undefined
  muted: string | null | undefined
  learned: boolean
  condOk: boolean
  requested: boolean
  /** 锚点第一次被看见的时刻;不在屏幕上 = null。 */
  anchorSince: number | null
  /** 锚点所在的 View 这次打开已经出过一条。 */
  hostShown: boolean
}
export interface GuideInput {
  now: number
  enabled: boolean
  /** 有弹窗在排 / 开着、首启向导开着、已经有圈注或提示在出。 */
  busy: boolean
  /** 今天已出几条;undefined = 读失败。 */
  dayCount: number | undefined
  lastInput: number
  en: boolean
  mobile: boolean
  candidates: GuideCandidate[]
}

/** 出不出、出哪条(纯函数,单测打它)。按插件登记顺序 × manifest 顺序取第一条合格的。 */
export function pickTip(i: GuideInput): GuideCandidate | null {
  if (!i.enabled || i.busy || i.dayCount === undefined || i.dayCount >= GUIDE_DAILY_MAX || i.now - i.lastInput < IDLE_MS) return null
  for (const c of i.candidates) {
    if (c.seen !== null || c.muted !== null || c.learned) continue // 读失败(undefined)也跳过
    if (c.tip.platform && c.tip.platform !== (i.mobile ? 'mobile' : 'desktop')) continue
    if (i.en && (!c.tip.en?.text || (c.tip.style === 'ring' && !c.tip.en.title))) continue // 英文界面缺英文:不出,不回落中文
    if (!c.condOk && !c.requested) continue
    if (c.anchorSince == null || i.now - c.anchorSince < OPEN_DELAY_MS || c.hostShown) continue
    return c
  }
  return null
}

function dayCount(): number | undefined {
  const raw = read(K.day)
  if (raw === undefined) return undefined
  try { const o = JSON.parse(raw || '{}') as { d?: string; n?: number }; return o.d === today() ? Number(o.n) || 0 : 0 } catch { return 0 }
}

const isMobile = (): boolean => !!(typeof window !== 'undefined' && (window.tangu as { mobile?: boolean } | undefined)?.mobile)

function tick(): void {
  if (document.hidden) { firstSeen.clear(); return }
  if (!tipsOf.size) return
  const q = usePopupQueue.getState()
  const now = Date.now()
  const candidates: GuideCandidate[] = []
  for (const [pluginId, tips] of tipsOf) {
    const muted = read(K.muted(pluginId))
    for (const tip of tips) {
      const seen = read(K.seen(pluginId, tip.id))
      const done = learned(pluginId, tip)
      // 已经结束的不去量 DOM
      const el = seen === null && muted === null && !done ? seenAnchor(pluginId, tip.at) : null
      const key = rk(pluginId, tip.id)
      let since: number | null = null
      let hostShown = false
      if (!el) firstSeen.delete(key)
      else {
        const f = firstSeen.get(key)
        if (!f || f.el !== el) firstSeen.set(key, { el, t: now })
        since = firstSeen.get(key)!.t
        const host = el.closest('[data-guide-owner]')
        hostShown = !!host && shownHosts.has(host)
      }
      candidates.push({ pluginId, tip, seen, muted, learned: done, condOk: el ? condOk(pluginId, tip) : false, requested: requested.has(key), anchorSince: since, hostShown })
    }
  }
  const c = pickTip({
    now, enabled: guideEnabled(), busy: !!(q.active || q.waiting.length || q.blocked) || spotlightActive(),
    dayCount: dayCount(), lastInput, en: currentLocale() === 'en', mobile: isMobile(), candidates,
  })
  if (c) present(c)
}

function present(c: GuideCandidate): void {
  const { pluginId, tip } = c
  const host = anchor(pluginId, tip.at)?.closest('[data-guide-owner]')
  if (host) shownHosts.add(host)
  write(K.day, JSON.stringify({ d: today(), n: (dayCount() ?? 0) + 1 }))
  requested.delete(rk(pluginId, tip.id))
  current = { pluginId, tip }
  const en = currentLocale() === 'en'
  void showTip(pluginId, {
    find: () => anchor(pluginId, tip.at),
    style: tip.style,
    title: en ? tip.en?.title : tip.title,
    body: en ? tip.en!.text! : tip.text,
    dock: isMobile(),
  }).then((r) => {
    if (current?.tip === tip) current = null
    reportTip(pluginId, tip, r)
    if (r === 'ok') write(K.seen(pluginId, tip.id), today())
    else if (r === 'mute') write(K.muted(pluginId), today())
    // gone / replaced / closed / missing:不记,下回条件满足再出(受当天条数限制)
  })
}

function ensureRunning(): void {
  if (timer || typeof window === 'undefined') return
  const touch = (): void => { lastInput = Date.now() }
  for (const ev of ['keydown', 'input', 'pointerdown', 'wheel', 'dragover']) window.addEventListener(ev, touch, { capture: true, passive: true })
  window.addEventListener('pointermove', (e) => { if (e.buttons) touch() }, { capture: true, passive: true }) // 按着拖
  // 提示出着时来了弹窗:收掉让路(不记看过),否则压在弹窗底下还先吃掉 Esc
  usePopupQueue.subscribe((q) => { if (current && (q.active || q.waiting.length || q.blocked)) closeSpotlight(current.pluginId) })
  // 提示出着时用户做了那件事:当场收掉(会了)
  useAchievements.subscribe((s, prev) => {
    if (s.counters !== prev.counters && current && learned(current.pluginId, current.tip)) closeSpotlight(current.pluginId)
  })
  timer = setInterval(tick, 1000)
}

/** 匿名遥测 guide_tip(契约 §9):提示收起的结果;提示出着时用户做了那件事 → learned。只发公开插件(内置 / 商店)的提示,
 *  插件 id 换成公开 id(侧载的整条不发,主进程再核一遍)。 */
const pluginOf = new Map<string, TelemetryPluginLike>()
function reportTip(pluginId: string, tip: PluginGuideTip, r: string): void {
  try {
    const ref = telemetryPluginRef(pluginOf.get(pluginId))
    if (!ref.pluginOfficial) return
    const result = r === 'closed' && learned(pluginId, tip) ? 'learned' : r
    sendTelemetry('guide_tip', { ...ref, tipId: tip.id, result })
  } catch { /* 遥测不影响提示 */ }
}

/** 插件启用时登记(manifest 里消毒过的 tips);停用 / 重载时撤。plugin = 插件记录(遥测换公开 id 用)。 */
export function registerGuideTips(pluginId: string, tips: PluginGuideTip[] | undefined, plugin?: TelemetryPluginLike): void {
  if (!tips?.length) return unregisterGuideTips(pluginId)
  tipsOf.set(pluginId, tips)
  if (plugin) pluginOf.set(pluginId, plugin)
  ensureRunning()
}
export function unregisterGuideTips(pluginId: string): void {
  tipsOf.delete(pluginId)
  pluginOf.delete(pluginId)
  for (const k of [...requested]) if (k.startsWith(`${pluginId}\n`)) requested.delete(k)
  if (current?.pluginId === pluginId) current = null
}
/** ctx.guide.show:不认识的 id 什么都不做。 */
export function requestTip(pluginId: string, tipId: string): void {
  if (tipsOf.get(pluginId)?.some((t) => t.id === tipId)) requested.add(rk(pluginId, tipId))
}

registerMessages({
  'guideTips.group': { zh: '上手提示', en: 'Tips' },
  'guideTips.groupHint': { zh: '插件在你用到某个功能时提示一次怎么用，用过就不再出。', en: 'Plugins show a one-time tip when you reach a feature. Once you have used it, the tip stops.' },
  'guideTips.enable': { zh: '显示上手提示', en: 'Show tips' },
  'guideTips.reset': { zh: '重新显示提示', en: 'Show tips again' },
  'guideTips.resetHint': { zh: '点过「知道了」或「不再提示」的，重新出现。', en: 'Tips you dismissed or turned off will show again.' },
  'guideTips.resetDone': { zh: '已重置，用到时会再提示。', en: 'Reset. Tips will show again when you get there.' },
  'guideTips.resetBtn': { zh: '重置', en: 'Reset' },
  'guideTips.command': { zh: '重置上手提示', en: 'Reset tips' },
})
