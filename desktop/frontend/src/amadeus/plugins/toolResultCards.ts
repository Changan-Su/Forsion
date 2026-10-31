/**
 * 插件工具结果卡片(插件开放清单 §3.1;10-19 用户选方案 D,见 docs/ToBeImproved/插件页面与对话协作方案_2026-10-19/):
 * 认领校验、引擎名下工具的缓存、挪位置时交还的 state。画卡片在 components/PluginToolCard.tsx。
 *
 * 认领只认「本插件捆绑包里的引擎插件此刻名下注册的工具」:名单来自引擎 /agent/plugins 每项的 tools
 * (引擎已剔掉和核心工具撞名的)。名单没拉到 / 拉失败一律不认(fail closed),那时照旧是通用工具记录。
 * 认的是工具名,不是事件里的来源字段 —— 历史消息由 tool_calls 行还原,没有来源;按名现查,重载后的历史照样有卡。
 *
 * 例外(网页卡片方案 A + D,10-28):CORE_TOOL_CARDS 里写死的官方插件可以给少数核心工具画卡,前提是它捆绑包里有一个
 * 引擎插件此刻过了官方签名判定(引擎 /agent/plugins 的 official,判定见 tangu-agent plugins/official.ts)。
 * 渲染器的 match(call) 再按参数收窄(forsion_account 只认 web_pages 那一节);返回 false / 抛错 = 不认。
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { usePluginStore } from './pluginStore'
import { readTangu } from './tanguSeam'
import type { AmadeusPlugin, ToolResultRendererContribution } from './types'
import type { ToolEvent } from '../../types'
import { listPlugins } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'

interface OwnedRenderer { pluginId: string; item: ToolResultRendererContribution }
export interface ToolCardClaim { pluginId: string; item: ToolResultRendererContribution }

/** 官方插件(桌面插件 id)→ 它可以画的核心工具。名单只在这里,插件加不了。 */
export const CORE_TOOL_CARDS: Readonly<Record<string, readonly string[]>> = {
  'forsion-extend': ['publish_web_page', 'forsion_account'],
}

/** toolName 归哪个渲染器:渲染器所属插件的 bundle.enginePlugins 里,有一个引擎插件此刻名下注册了它;或者是 CORE_TOOL_CARDS
 *  放行的核心工具、且捆绑包里有官方引擎插件在跑。再过渲染器自己的 match。注册序先到先得。 */
export function claimToolCard(
  renderers: readonly OwnedRenderer[],
  plugins: readonly Pick<AmadeusPlugin, 'id' | 'bundle'>[],
  engineTools: Readonly<Record<string, readonly string[]>>,
  toolName: string,
  o: { official?: readonly string[]; args?: unknown } = {},
): OwnedRenderer | undefined {
  return renderers.find((r) => {
    if (r.item.tool !== toolName) return false
    const engines = plugins.find((p) => p.id === r.pluginId)?.bundle?.enginePlugins ?? []
    const owns = engines.some((e) => engineTools[e]?.includes(toolName))
    const core = !owns && !!CORE_TOOL_CARDS[r.pluginId]?.includes(toolName) && engines.some((e) => o.official?.includes(e))
    if (!owns && !core) return false
    if (typeof r.item.match !== 'function') return true
    try { return r.item.match({ tool: toolName, args: o.args }) === true } catch { return false }
  })
}

/** 只有跑完且成功的调用画卡片;运行中、出错、挂起等审批的都留通用记录。历史里中断的调用也是 done,但没有结果 —— 不画。 */
export const cardEligible = (ev: ToolEvent): boolean => ev.done && !ev.isError && !ev.parked && ev.result !== undefined

/** 引擎插件 id → 名下工具名。loaded 之前与拉失败时都是空表(不认领)。
 *  toolOwner:工具名 → 所属引擎插件的显示名(过程行把插件工具写成「插件名 · 工具」,走查续六 6.4)。 */
export const useEngineTools = create<{ byEngine: Record<string, string[]>; official: string[]; toolOwner: Record<string, { name: string; nameEn?: string }>; loaded?: boolean }>(() => ({ byEngine: {}, official: [], toolOwner: {} }))

let inflight: Promise<void> | null = null
let again = false
/** 重拉名单。在途时再叫只排一次尾随,不叠请求。 */
export function refreshEngineTools(): Promise<void> {
  if (inflight) { again = true; return inflight }
  inflight = (async () => {
    // 拉不到(后端没起、请求失败)就清空:引擎重载后工具可能换了主人,留着旧表 = 让旧插件接着认领(Codex 评审)
    let byEngine: Record<string, string[]> = {}
    let official: string[] = []
    const toolOwner: Record<string, { name: string; nameEn?: string }> = {}
    let loaded = false
    try {
      const cfg = await readTangu()?.waitBackend?.(15_000)
      if (cfg) {
        const list = (await listPlugins(homeTarget())).filter((p) => p.enabled && p.active !== false)
        byEngine = Object.fromEntries(list.filter((p) => p.tools?.length).map((p) => [p.id, p.tools!]))
        official = list.filter((p) => p.official === true).map((p) => p.id)
        for (const p of list) for (const tool of p.tools ?? []) toolOwner[tool] = { name: p.name, nameEn: p.nameEn }
        loaded = true
      }
    } catch (e) {
      console.warn('[amadeus] 拉引擎插件名下工具失败', e)
    } finally {
      useEngineTools.setState((s) => ({ byEngine, official, toolOwner, loaded: s.loaded || loaded }))
      inflight = null
      if (again) { again = false; void refreshEngineTools() }
    }
  })()
  return inflight
}

// 刷新时机:有插件注册 / 摘掉渲染器(插件启停、重载)、后端就绪边沿(引擎重启),以及见到「有人想认领却没认上」的
// 调用时(引擎半身比桌面半身晚激活)—— 最后这条按 STALE_GAP_MS 节流。ponytail: 引擎半身被单独停用时不推送,名单要等下一次
// 刷新才变;多出来的只会是自家工具还画卡片,不会认领别人的。
const STALE_GAP_MS = 10_000
let lastStaleKick = 0
let wired = false
function wire(): void {
  if (wired) return
  wired = true
  let timer: ReturnType<typeof setTimeout> | undefined
  usePluginStore.subscribe((s, prev) => {
    if (s.toolResultRenderers === prev.toolResultRenderers || !s.toolResultRenderers.length) return
    clearTimeout(timer)
    timer = setTimeout(() => void refreshEngineTools(), 300)
  })
  readTangu()?.subscribeReady?.(() => { if (usePluginStore.getState().toolResultRenderers.length) void refreshEngineTools() })
  if (usePluginStore.getState().toolResultRenderers.length) void refreshEngineTools()
}

function cardOf(renderers: readonly OwnedRenderer[], plugins: readonly AmadeusPlugin[], byEngine: Record<string, string[]>, official: readonly string[], ev: ToolEvent): ToolCardClaim | undefined {
  if (!cardEligible(ev)) return undefined
  const hit = claimToolCard(renderers, plugins, byEngine, ev.name, { official, args: parseToolArgs(ev.arguments) })
  if (!hit && renderers.some((r) => r.item.tool === ev.name) && Date.now() - lastStaleKick > STALE_GAP_MS) {
    lastStaleKick = Date.now()
    void refreshEngineTools()
  }
  return hit
}

/** 渲染期用:返回「这次调用画哪张插件卡片」的判定函数;渲染器、插件表、名单任一变了就换一个(调用方据此重渲)。 */
export function useToolCardOf(): (ev: ToolEvent) => ToolCardClaim | undefined {
  const renderers = usePluginStore((s) => s.toolResultRenderers)
  const plugins = usePluginStore((s) => s.plugins)
  const byEngine = useEngineTools((s) => s.byEngine)
  const official = useEngineTools((s) => s.official)
  useEffect(wire, [])
  return useMemo(
    () => (renderers.length ? (ev: ToolEvent) => cardOf(renderers, plugins, byEngine, official, ev) : () => undefined),
    [renderers, plugins, byEngine, official],
  )
}

/** 过程行见到认不出主人的工具时补拉名单(名单平时只在有插件结果卡片时才拉)。只补到第一次拉成功为止:之后认不出的
 *  多半是核心工具(ask_user、delegate…),不为它们反复打 /agent/plugins;会话中途才启用的插件等下一次后端就绪再认。 */
let ownerKick = 0
export function kickToolOwners(): void {
  if (useEngineTools.getState().loaded || Date.now() - ownerKick < STALE_GAP_MS) return
  ownerKick = Date.now()
  void refreshEngineTools()
}

/** 非渲染期(工具结果到达时决定要不要直接进 Desk)。 */
export function toolCardOf(ev: ToolEvent): ToolCardClaim | undefined {
  const s = usePluginStore.getState()
  const e = useEngineTools.getState()
  return s.toolResultRenderers.length ? cardOf(s.toolResultRenderers, s.plugins, e.byEngine, e.official, ev) : undefined
}

// 挪位置(对话 ↔ Desk)= 新位置重新 mount、旧位置先清理;视图状态按调用 id 存在这里交还。
// ponytail: 只在内存、不设上限 —— 一张卡一条,插件不调 set 就没有;要跨重启再落盘。
const cardStates = new Map<string, unknown>()
export function cardStateHandle(callId: string): { get(): unknown; set(value: unknown): void } {
  return { get: () => cardStates.get(callId), set: (value) => { cardStates.set(callId, value) } }
}

/** 入参照 JSON 解开;不是合法 JSON 就给原串。 */
export function parseToolArgs(raw: string | undefined): unknown {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return raw }
}

/** 卡片名:渲染器给的 title(函数形式按当前语言现求),没给就用工具名。 */
export function toolCardTitle(item: ToolResultRendererContribution): string {
  try {
    const t = typeof item.title === 'function' ? item.title() : item.title
    return (typeof t === 'string' && t.trim()) || item.tool
  } catch {
    return item.tool
  }
}

/** 仅供单测复位。 */
export const __resetToolCards = (): void => {
  cardStates.clear()
  lastStaleKick = 0
  ownerKick = 0
  useEngineTools.setState({ byEngine: {}, official: [], toolOwner: {}, loaded: false })
}
