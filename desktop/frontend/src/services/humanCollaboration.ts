import type { TanguDesktopConfig, ToolEvent } from '../types'
import { authFetch } from './http'

export type HumanScope = { kind: 'agent'; slug: string } | { kind: 'project'; cwd: string }
export type HumanTarget = { kind: 'agent'; slug: string } | { kind: 'project'; sessionId: string }
export interface HumanChange {
  id: string; scope: HumanScope; summary: string; evidence: string; at: string; actor: 'agent' | 'user';
  beforeVersion: string; afterVersion: string; undoOf?: string
}
export interface HumanDocument {
  scope: HumanScope; path: string; content: string; version: string; exists: boolean; updatedAt: string | null;
  history: Array<HumanChange & { canUndo: boolean }>; maxLength: number
}
export interface HumanJump { at: number; edit?: boolean; changeId?: string }
export const HUMAN_CHANGED_EVENT = 'forsion:human-changed'
export const humanTargetKey = (target: HumanTarget) => target.kind === 'agent' ? `agent:${target.slug}` : `project:${target.sessionId}`
const endpoint = (target: HumanTarget) => target.kind === 'agent' ? `/agent/agents/${encodeURIComponent(target.slug)}/human` : '/agent/project-context/human'
async function request<T>(cfg: TanguDesktopConfig, target: HumanTarget, method: string, suffix = '', input?: Record<string, unknown>): Promise<T> {
  const project = target.kind === 'project' ? { sessionId: target.sessionId } : {}
  const query = method === 'GET' && target.kind === 'project' ? `?sessionId=${encodeURIComponent(target.sessionId)}` : ''
  const r = await authFetch(`${cfg.backendUrl}${endpoint(target)}${suffix}${query}`, {
    method, headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ ...input, ...project }) }),
  })
  const body = await r.json()
  if (!r.ok) throw Object.assign(new Error(body.detail || `HTTP ${r.status}`), { status: r.status, code: body.error })
  if (method !== 'GET') window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT))
  return body as T
}
export const getHumanDocument = (cfg: TanguDesktopConfig, target: HumanTarget) => request<HumanDocument>(cfg, target, 'GET')
export const saveHumanDocument = (cfg: TanguDesktopConfig, target: HumanTarget, content: string, expectedVersion: string, summary: string) =>
  request<{ document: HumanDocument; change: HumanChange | null }>(cfg, target, 'PUT', '', { content, expectedVersion, summary })
export const undoHumanChange = (cfg: TanguDesktopConfig, target: HumanTarget, change: HumanChange) =>
  request<{ document: HumanDocument; change: HumanChange }>(cfg, target, 'POST', '/undo', { changeId: change.id, expectedVersion: change.afterVersion })

/** Durable tool results are the notification source, including restored chat history.
 * Never interpret arbitrary assistant prose or another tool's output as an update. */
export function humanChanges(events: ToolEvent[] = []): HumanChange[] {
  const changes = new Map<string, HumanChange>()
  for (const ev of events) {
    if (ev.name !== 'manage_human' || !ev.done || ev.isError || !ev.result) continue
    try {
      const result = JSON.parse(ev.result), c = result.change
      if (result.kind !== 'human_update' || !c || typeof c.id !== 'string' || !/^[a-f0-9-]{36}$/.test(c.id) ||
        typeof c.summary !== 'string' || typeof c.evidence !== 'string' || typeof c.at !== 'string' || c.actor !== 'agent' ||
        !/^[a-f0-9]{64}$/.test(c.beforeVersion) || !/^[a-f0-9]{64}$/.test(c.afterVersion) ||
        !((c.scope?.kind === 'agent' && typeof c.scope.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(c.scope.slug)) ||
          (c.scope?.kind === 'project' && typeof c.scope.cwd === 'string' && c.scope.cwd.length > 0))) continue
      changes.set(c.id, c)
    } catch { /* Plain error/read results do not create update cards. */ }
  }
  return [...changes.values()]
}
