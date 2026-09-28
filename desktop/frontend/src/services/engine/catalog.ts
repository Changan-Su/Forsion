/**
 * 按目标的目录缓存(P1-K6 §3.4「swap-on-focus」;INTEGRATION R-18:一份缓存,K6 所有,K7 的 useLocationCatalog 只是薄包装)。
 *
 * 为什么要它:appStore 顶层的 modelsResp / agentDefs / defaultAgentSlug / skillsList **永远是焦点目标的目录**
 * (22 个读 agentDefs、13 个读 modelsResp 的文件因此不用改);焦点切到「我的电脑」之后,仍打 home 的管理面板 /
 * 收件箱 / 自动化要的是 **home** 的目录 —— 读 catalogFor('home')。多目标的列表行(K7)也按键取。
 *
 * - catalogFor(key):缓存里有就给(不论新旧),没有 → null。
 * - ensureCatalog(key, {force}):没有 / 超过 5 分钟 / force → 拉(同一目标并发只拉一次);目标解析不出来 → null。
 * - rememberCatalog(key, patch):appStore 连上焦点时把拉到的那份顺手记进来(不重复打引擎)。
 * 头像是 blob URL:只由 ensureCatalog 自己拉、自己回收;rememberCatalog 不收头像(那些归 appStore 管生命周期)。
 */
import { create } from 'zustand'
import type { ModelsResponse, NormalAgentDef, SkillInfo } from '../../types'
import { fetchAgentAvatar, getAgentsMeta, listAgents, listModels, listSkills } from '../backendService'
import { isTargetKey, type TargetKey, type TargetRef } from './target'
import { targetForRef } from './targets'

export interface TargetCatalog {
  models: ModelsResponse | null
  agents: NormalAgentDef[]
  defaultAgentSlug: string
  skills: SkillInfo[] | null
  /** slug → blob URL;只有 ensureCatalog 拉的那份才有(appStore 记进来的不带)。 */
  avatars?: Record<string, string>
  /** 上次整份拉齐的时刻(ms);rememberCatalog 的局部更新也刷新它。 */
  at: number
}

export const CATALOG_TTL_MS = 5 * 60_000

export const useTargetCatalogs = create<{ byKey: Partial<Record<TargetKey, TargetCatalog>> }>(() => ({ byKey: {} }))

export function catalogFor(key: TargetKey): TargetCatalog | null {
  return useTargetCatalogs.getState().byKey[key] ?? null
}

function revokeAvatars(c: TargetCatalog | null | undefined, keep?: Record<string, string>): void {
  if (!c?.avatars) return
  const kept = new Set(Object.values(keep || {}))
  for (const url of Object.values(c.avatars)) {
    if (kept.has(url)) continue
    try { URL.revokeObjectURL(url) } catch { /* node / 已回收 */ }
  }
}

function put(key: TargetKey, next: TargetCatalog): void {
  const prev = catalogFor(key)
  if (prev?.avatars && prev.avatars !== next.avatars) revokeAvatars(prev, next.avatars)
  useTargetCatalogs.setState((s) => ({ byKey: { ...s.byKey, [key]: next } }))
}

const EMPTY = (): TargetCatalog => ({ models: null, agents: [], defaultAgentSlug: 'xyra', skills: null, at: 0 })

/** 局部记入(appStore 连上焦点时顺手记)。头像不收。 */
export function rememberCatalog(key: TargetKey, patch: Partial<Omit<TargetCatalog, 'avatars' | 'at'>>): void {
  const prev = catalogFor(key) ?? EMPTY()
  put(key, { ...prev, ...patch, avatars: prev.avatars, at: Date.now() })
}

/** 清一格或全部(账号切换 / 焦点回 home 后不再需要 home 那份独立缓存时)。 */
export function forgetCatalog(key?: TargetKey): void {
  const all = useTargetCatalogs.getState().byKey
  if (!key) {
    for (const c of Object.values(all)) revokeAvatars(c)
    useTargetCatalogs.setState({ byKey: {} })
    return
  }
  revokeAvatars(all[key])
  useTargetCatalogs.setState((s) => {
    const byKey = { ...s.byKey }
    delete byKey[key]
    return { byKey }
  })
}

function refOfKey(key: TargetKey): TargetRef {
  return key === 'home' ? { kind: 'home' } : { kind: 'unit', unitId: key.slice('unit:'.length) }
}

const inflight = new Map<TargetKey, Promise<TargetCatalog | null>>()

/**
 * 保证某目标的目录在缓存里且不旧于 5 分钟(R-18)。失败的单项保留旧值(模型没拉到不把 Agent 清空);
 * 整体拉不到(目标解析不出来)→ null。
 */
export function ensureCatalog(key: TargetKey, opts: { force?: boolean } = {}): Promise<TargetCatalog | null> {
  if (!isTargetKey(key)) return Promise.resolve(null)
  const cached = catalogFor(key)
  if (!opts.force && cached && cached.at > 0 && Date.now() - cached.at < CATALOG_TTL_MS) return Promise.resolve(cached)
  const running = inflight.get(key)
  if (running) return running
  const t = targetForRef(refOfKey(key))
  if (!t) return Promise.resolve(cached)
  const p = (async (): Promise<TargetCatalog | null> => {
    const [models, agents, meta, skills] = await Promise.allSettled([listModels(t), listAgents(t), getAgentsMeta(t), listSkills(t)])
    const base = catalogFor(key) ?? EMPTY()
    const agentList = agents.status === 'fulfilled' ? agents.value : base.agents
    const avatarPairs = await Promise.all(agentList.filter((a) => a.avatar).map(async (a) => [a.slug, await fetchAgentAvatar(t, a.slug).catch(() => null)] as const))
    const next: TargetCatalog = {
      models: models.status === 'fulfilled' ? models.value : base.models,
      agents: agentList,
      defaultAgentSlug: meta.status === 'fulfilled' ? (meta.value.defaultSlug || 'xyra') : base.defaultAgentSlug,
      skills: skills.status === 'fulfilled' ? skills.value : base.skills,
      avatars: Object.fromEntries(avatarPairs.filter(([, u]) => !!u) as Array<[string, string]>),
      at: Date.now(),
    }
    put(key, next)
    return next
  })().finally(() => { inflight.delete(key) })
  inflight.set(key, p)
  return p
}
