/**
 * 插件给「跑在外部引擎上的 Agent」加的东西(`ctx.registerEngineHarness`,2026-11-15+,DSH 融合插件第 1 档):
 *  - Harness 卡上「运行在」下面的几行(运行时、更新通道、DSH 插件、打开工作台……):宿主画,插件给数据;
 *  - 这类对话的右键菜单里的几项(打开工作台)。
 * 底层只画「运行在」那一行;别的行都归插件,插件停用就没了。登记表在这里,画在 AgentProfileView / SidebarPane。
 */
import { useSyncExternalStore } from 'react'
import type { PluginEngineHarness, PluginEngineSessionAction, PluginHarnessRow } from './types'

export interface HostEngineHarness {
  owner: string
  def: PluginEngineHarness
  /** 插件还活着(停用 / 重载后不再调它的回调)。 */
  alive: () => boolean
}

const entries: HostEngineHarness[] = []
const subs = new Set<() => void>()
let version = 0
const emit = (): void => { version += 1; for (const f of subs) f() }

export const MAX_HARNESS_ROWS = 8
export const MAX_SESSION_ACTIONS = 4
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 登记;返回 refresh(行变了让卡片重画)与 dispose。形态不对同步抛。 */
export function registerEngineHarness(owner: string, def: PluginEngineHarness, alive: () => boolean): { refresh(): void; dispose(): void } {
  if (!def || typeof def !== 'object' || typeof def.engineId !== 'string' || !ENGINE_ID_RE.test(def.engineId)) throw new TypeError('registerEngineHarness needs { engineId }')
  if (def.rows != null && typeof def.rows !== 'function') throw new TypeError('registerEngineHarness: rows must be a function')
  if (def.sessionActions != null && !Array.isArray(def.sessionActions)) throw new TypeError('registerEngineHarness: sessionActions must be an array')
  for (const a of def.sessionActions ?? []) if (!a || typeof a.id !== 'string' || typeof a.run !== 'function') throw new TypeError('registerEngineHarness: each session action needs { id, label, run }')
  const entry: HostEngineHarness = { owner, def, alive }
  entries.push(entry)
  emit()
  let gone = false
  return {
    refresh: () => { if (!gone && alive()) emit() },
    dispose: () => { if (gone) return; gone = true; const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); emit() },
  }
}

export function engineHarnessFor(engineId: string): HostEngineHarness[] {
  return entries.filter((e) => e.def.engineId === engineId && e.alive())
}

/** 这个引擎的对话右键菜单里插件加的项(每个插件最多 MAX_SESSION_ACTIONS 项)。 */
export function engineSessionActions(engineId: string): Array<{ owner: string; action: PluginEngineSessionAction }> {
  return engineHarnessFor(engineId).flatMap((e) => (e.def.sessionActions ?? []).slice(0, MAX_SESSION_ACTIONS).map((action) => ({ owner: e.owner, action })))
}

/** 插件给的行(调 rows(),抛错 / 超时的那家当没有)。 */
export async function collectHarnessRows(engineId: string, target: { agentSlug: string }): Promise<Array<{ owner: string; row: PluginHarnessRow }>> {
  const all = await Promise.all(engineHarnessFor(engineId).map(async (e) => {
    if (!e.def.rows) return []
    try {
      const rows = await Promise.race([
        Promise.resolve(e.def.rows({ agentSlug: target.agentSlug })),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rows() took longer than 5 s')), 5000)),
      ])
      return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string').slice(0, MAX_HARNESS_ROWS).map((row) => ({ owner: e.owner, row }))
    } catch (err) {
      console.error(`[amadeus] plugin "${e.owner}" harness rows failed`, err)
      return []
    }
  }))
  return all.flat()
}

/** 登记表变了(登记 / 撤销 / refresh)就变的版本号,给 React 用。 */
export function useEngineHarnessVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => version, () => version)
}

/** 单测用。 */
export function resetEngineHarnessForTest(): void { entries.length = 0; emit() }
