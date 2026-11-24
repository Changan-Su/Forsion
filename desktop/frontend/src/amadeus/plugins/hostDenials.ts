/**
 * 插件请求被宿主拒掉时留的痕迹(2026-11-23,插件开发优化方案第七节 C)。
 *
 * 起因:桌面只在「本机托管引擎」下才给插件 ctx.tangu.request / connectChannel;换成外部引擎后请求直接抛
 * 「A local engine is required」。插件的轮询把错吞了、退避重试,界面只剩一个空状态 —— 控制台和网络里一条痕迹都没有,
 * 作者(11-23 那次是 Tangu Agent)完全看不出自己被拒了。
 *
 * 所以被拒时宿主自己说一声,三处都能看到:
 *  · 真控制台一条 console.warn(带插件 id),开发副本的 Studio 控制台(devRecords)同一条;
 *  · 插件诊断:设置里插件详情页的「被宿主拒掉的请求」、给 agent 的 `plugin-status` 回执(pluginSpaceHealth.ts)。
 * 同一个插件、同一个接口、同一个原因,一个窗口里只记一次(轮询每几秒撞一次,不能刷屏);请求后来成功了就把这条记录撤掉,
 * 之后再被拒会重新记。
 *
 * 设置在 Electron 下是独立浮窗,和主窗不是同一份内存:记录放 localStorage,**每个窗口只写自己那把键**
 * (`forsion_plugin_host_denials:<窗口号>`),读的时候把所有窗口的合起来 —— 不共写一把键,就没有「两个窗口各读一份、
 * 各写回整份,后写的盖掉先写的」那种丢记录(Codex 11-23 评审)。主窗开机清掉所有窗口的旧键;别的窗口关掉时删自己那把。
 * 本模块零 React 依赖、不在顶层碰 window(单测跑在 node 环境);写错 / 读坏都当没有,绝不抛。
 */
import { create } from 'zustand'
import { recordDevLog } from './devRecords'
import { readTangu } from './tanguSeam'

export type HostDenialCode = 'external-engine' | 'no-local-engine' | 'engine-unavailable'
export type HostDenialApi = 'ctx.tangu.request' | 'ctx.tangu.connectChannel'

export interface HostDenial { api: HostDenialApi; code: HostDenialCode; at: number }

const KEY_PREFIX = 'forsion_plugin_host_denials:'
/** 每个插件最多留几条(接口 × 原因本来就没几种;防的是将来接口变多)。 */
const MAX_PER_PLUGIN = 8

/** 所有窗口的记录合起来(界面与 agent 读这一份)。 */
export const useHostDenials = create<{ byPlugin: Record<string, HostDenial[]> }>(() => ({ byPlugin: {} }))

/** 本窗口自己记下的(只有它写进本窗那把键)。 */
let mine: Record<string, HostDenial[]> = {}
const windowKey = `${KEY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 本窗口已经说过的(插件 id + 接口 + 原因)。 */
const seen = new Set<string>()
const seenKey = (pluginId: string, api: string, code: string): string => `${pluginId}\n${api}\n${code}`

const CODES: readonly string[] = ['external-engine', 'no-local-engine', 'engine-unavailable']
const APIS: readonly string[] = ['ctx.tangu.request', 'ctx.tangu.connectChannel']

const storage = (): Storage | null => { try { return globalThis.localStorage ?? null } catch { return null } }

function parse(raw: string | null): Record<string, HostDenial[]> {
  let obj: unknown = null
  try { obj = JSON.parse(raw || '{}') } catch { /* 写坏了当作没有 */ }
  const out: Record<string, HostDenial[]> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [id, list] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const ok = list.filter((d): d is HostDenial => !!d && typeof d === 'object'
      && APIS.includes((d as HostDenial).api) && CODES.includes((d as HostDenial).code) && typeof (d as HostDenial).at === 'number')
    if (ok.length) out[id] = ok.slice(-MAX_PER_PLUGIN)
  }
  return out
}

/** 同一插件、同一接口、同一原因在几个窗口里都撞上 → 合成一条,留最近的时间。 */
function merge(into: Record<string, HostDenial[]>, from: Record<string, HostDenial[]>): void {
  for (const [id, list] of Object.entries(from)) {
    const cur = into[id] ? [...into[id]] : []
    for (const d of list) {
      const i = cur.findIndex((x) => x.api === d.api && x.code === d.code)
      if (i < 0) cur.push(d)
      else if (d.at > cur[i].at) cur[i] = d
    }
    into[id] = cur.sort((a, b) => a.at - b.at).slice(-MAX_PER_PLUGIN)
  }
}

function ownKeys(st: Storage): string[] {
  const keys: string[] = []
  for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k?.startsWith(KEY_PREFIX)) keys.push(k) }
  return keys
}

/** 重算合并视图(本窗的以内存为准,别的窗口读它们各自的键)。 */
function refresh(): void {
  const all: Record<string, HostDenial[]> = {}
  const st = storage()
  if (st) for (const k of ownKeys(st)) if (k !== windowKey) { try { merge(all, parse(st.getItem(k))) } catch { /* ignore */ } }
  merge(all, mine)
  if (JSON.stringify(all) !== JSON.stringify(useHostDenials.getState().byPlugin)) useHostDenials.setState({ byPlugin: all })
}

function saveMine(next: Record<string, HostDenial[]>): void {
  mine = next
  try {
    const st = storage()
    if (st) { if (Object.keys(mine).length) st.setItem(windowKey, JSON.stringify(mine)); else st.removeItem(windowKey) }
  } catch { /* 存满 / 被禁用:本窗照常 */ }
  refresh()
}

/** 给开发者看的那句(英文:Studio 控制台、agent 的 plugin-status 都直接读它)。 */
export function hostDenialText(api: HostDenialApi, code: HostDenialCode): string {
  const why = code === 'external-engine'
    ? 'Forsion is connected to an external engine; this call only works with the local engine Forsion manages itself'
    : code === 'no-local-engine'
      ? 'this host (web or phone) has no local engine'
      : 'the local engine did not come up in time'
  return `${api} was refused by the host: ${why}`
}

/** 记一次被拒。同一原因在本窗口里只说一次。 */
export function noteHostDenial(pluginId: string, api: HostDenialApi, code: HostDenialCode): void {
  const key = seenKey(pluginId, api, code)
  if (seen.has(key)) return
  seen.add(key)
  const text = hostDenialText(api, code)
  try { console.warn(`[plugin:${pluginId}] ${text}`) } catch { /* ignore */ }
  try { recordDevLog(pluginId, 'warn', [text]) } catch { /* 记账坏了不影响插件拿到原来的报错 */ }
  try {
    const list = (mine[pluginId] ?? []).filter((d) => !(d.api === api && d.code === code))
    saveMine({ ...mine, [pluginId]: [...list, { api, code, at: Date.now() }].slice(-MAX_PER_PLUGIN) })
  } catch { /* ignore */ }
}

/** 本窗口里这个接口这次成功了:本窗记下的它的被拒记录撤掉,之后再被拒会重新记。别的窗口的记录不动(那边可能还在被拒)。 */
export function clearHostDenials(pluginId: string, api: HostDenialApi): void {
  for (const code of CODES) seen.delete(seenKey(pluginId, api, code))
  const cur = mine[pluginId]
  if (!cur?.some((d) => d.api === api)) return
  const rest = cur.filter((d) => d.api !== api)
  const next = { ...mine }
  if (rest.length) next[pluginId] = rest
  else delete next[pluginId]
  try { saveMine(next) } catch { /* ignore */ }
}

/** 原因已经不成立的记录不再摆出来:当时是外部引擎 / 没有本机引擎,现在宿主的判定换了(切回了托管引擎)。
 *  等引擎超时那种不看模式,留到下次成功或重新激活。 */
export function liveHostDenials(list: readonly HostDenial[] | undefined): HostDenial[] {
  if (!list?.length) return NONE
  const block = readTangu()?.hostExecutionBlock?.()
  const out = list.filter((d) => d.code === 'engine-unavailable' || block === undefined || d.code === block)
  return out.length === list.length ? (list as HostDenial[]) : out
}

export function hostDenialsOf(pluginId: string): HostDenial[] {
  return liveHostDenials(useHostDenials.getState().byPlugin[pluginId])
}
const NONE: HostDenial[] = []

/** 插件在本窗口的这一次激活(首次加载 / 重载 / 重新打开)开始:本窗重新允许说一次(开发副本重载会清掉 Studio 控制台,
 *  不重置的话那句就再也不出现),本窗记下的它的旧记录撤掉 —— 新的一版先撞一次再说。别的窗口的记录不碰。 */
export function resetHostDenials(pluginId: string): void {
  for (const key of [...seen]) if (key.startsWith(`${pluginId}\n`)) seen.delete(key)
  if (!mine[pluginId]) return
  const next = { ...mine }
  delete next[pluginId]
  try { saveMine(next) } catch { /* ignore */ }
}

let following = false
/** 每个装插件宿主的窗口调一次。主窗(owner)开机先清掉所有窗口上一次运行留下的键(重启 / 换了模式之后那些都不作数);
 *  之后各窗跟着别的窗口写的走;非主窗关掉时删自己那把键。 */
export function followHostDenials(opts: { owner: boolean }): void {
  if (following) return
  following = true
  const st = storage()
  if (opts.owner && st) {
    try { for (const k of ownKeys(st)) st.removeItem(k) } catch { /* ignore */ }
    try { st.removeItem('forsion_plugin_host_denials') } catch { /* 早期草稿用过的单键 */ }
  }
  refresh()
  try {
    window.addEventListener('storage', (event) => { if (event.key === null || event.key.startsWith(KEY_PREFIX)) refresh() })
    if (!opts.owner) window.addEventListener('pagehide', () => { try { storage()?.removeItem(windowKey) } catch { /* ignore */ } })
  } catch { /* 没有 window(单测) */ }
}

/** 单测用:清掉本窗口的「说过了」与记录。 */
export function resetHostDenialsForTest(): void {
  seen.clear()
  mine = {}
  try { const st = storage(); if (st) for (const k of ownKeys(st)) st.removeItem(k) } catch { /* ignore */ }
  useHostDenials.setState({ byPlugin: {} })
}
