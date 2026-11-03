// 小组件原件的读取缓存:对话卡、卡片区、仪表盘、主页按 id 读同一份(本机引擎 GET /agent/widgets/:id),不拷字节。
// 工具结果回来(intelligent_ui / sketch / manage_widget)、窗口回到前台时整表作废重读,不轮询。
// ⚠️ 读不到 ≠ 删了:unreadable / missing 只画占位,摆放原样留着。
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { engineFetch, homeTarget } from './engine/targets'

export interface WidgetRecordRow { id: string; cells: Record<string, unknown> }
export interface WidgetOriginal {
  id: string
  rev: number
  name: string
  title: string
  entry: 'widget.html' | 'widget.json'
  scope: 'project' | 'agent' | 'user'
  agentSlug?: string
  deletedAt?: string
  updatedAt?: string
  summary?: string
  content: string
  records: { status: 'ok'; rows: WidgetRecordRow[] } | { status: 'none' } | { status: 'error'; error: string }
}
export type WidgetListItem = Omit<WidgetOriginal, 'content' | 'records'>
export type WidgetState =
  | { status: 'loading' }
  | { status: 'ok'; widget: WidgetOriginal }
  | { status: 'missing' }
  | { status: 'unreadable'; error: string }

// 项目级小组件要带项目目录才找得到;看板里只写 id(笔记会同步,不写本机绝对路径),目录记在本机。
const PROJECT_KEY = 'forsion.widgets.projects.v1'
function projects(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PROJECT_KEY) || '{}') as Record<string, string> } catch { return {} }
}
export function rememberWidgetProject(id: string, dir: string | null | undefined): void {
  if (!dir) return
  const all = projects()
  if (all[id] === dir) return
  try { localStorage.setItem(PROJECT_KEY, JSON.stringify({ ...all, [id]: dir })) } catch { /* 存不下就下次再记 */ }
}
export const projectOf = (id: string): string | undefined => projects()[id]
const query = (id?: string): string => {
  const dir = id ? projects()[id] : undefined
  return dir ? `?project=${encodeURIComponent(dir)}` : ''
}

const cache = new Map<string, WidgetState>()
const inflight = new Map<string, Promise<void>>()
const subs = new Set<() => void>()
let version = 0
const emit = (): void => { version++; for (const f of subs) f() }
const subscribe = (f: () => void): (() => void) => { subs.add(f); return () => subs.delete(f) }

async function load(id: string): Promise<void> {
  let next: WidgetState
  try {
    const r = await engineFetch(homeTarget(), `/agent/widgets/${encodeURIComponent(id)}${query(id)}`, { method: 'GET' }, { timeoutMs: 10_000 })
    if (r.ok) next = { status: 'ok', widget: ((await r.json()) as { widget: WidgetOriginal }).widget }
    else {
      const body = (await r.json().catch(() => ({}))) as { error?: string; unreadable?: number }
      next = r.status === 404 && body.error === 'WIDGET_NOT_FOUND' && !body.unreadable ? { status: 'missing' } : { status: 'unreadable', error: body.error || `HTTP ${r.status}` }
    }
  } catch (e) {
    next = { status: 'unreadable', error: String(e) }
  }
  cache.set(id, next)
  emit()
}

const stale = new Set<string>()
function ensure(id: string, force = false): void {
  if (!force && cache.has(id)) return
  // 读的半路原件又变了:这次读回来的可能是旧的,读完再读一遍
  if (inflight.has(id)) { if (force) stale.add(id); return }
  if (!cache.has(id)) cache.set(id, { status: 'loading' })
  const p = load(id).finally(() => { inflight.delete(id); if (stale.delete(id)) ensure(id, true) })
  inflight.set(id, p)
}

let listGen = 0
/** 原件变了(工具结果 / 回前台 / 恢复):重读所有正在看的。旧值留着画,读回来再换,不闪。 */
export function invalidateWidgets(): void {
  for (const id of cache.keys()) ensure(id, true)
  listGen++
  emit()
}

let wired = false
function wire(): void {
  if (wired || typeof window === 'undefined') return
  wired = true
  window.addEventListener('focus', invalidateWidgets)
}

const LOADING: WidgetState = { status: 'loading' }
export function useWidget(id: string | null | undefined): WidgetState {
  useEffect(() => { wire(); if (id) ensure(id) }, [id])
  return useSyncExternalStore(subscribe, () => (id ? cache.get(id) ?? LOADING : LOADING))
}

/** 一组 id 的状态(卡片区按归属筛卡要先知道每张是谁的)。 */
export function useWidgets(ids: readonly string[]): WidgetState[] {
  const key = ids.join(',')
  useEffect(() => { wire(); for (const id of ids) ensure(id) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const v = useSyncExternalStore(subscribe, () => version)
  return useMemo(() => ids.map((id) => cache.get(id) ?? LOADING), [key, v]) // eslint-disable-line react-hooks/exhaustive-deps
}

export async function restoreWidget(id: string): Promise<void> {
  const r = await engineFetch(homeTarget(), `/agent/widgets/${encodeURIComponent(id)}/restore${query(id)}`, { method: 'POST' }, { timeoutMs: 10_000 })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  invalidateWidgets()
}

/** 收纳面板「小组件」页:本机所有原件(不含删了的)。 */
export async function listWidgets(projectDir?: string | null): Promise<WidgetListItem[]> {
  const q = projectDir ? `?project=${encodeURIComponent(projectDir)}` : ''
  const r = await engineFetch(homeTarget(), `/agent/widgets${q}`, { method: 'GET' }, { timeoutMs: 10_000 })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return ((await r.json()) as { widgets: WidgetListItem[] }).widgets.filter((w) => !w.deletedAt)
}
export const useWidgetListGen = (): number => useSyncExternalStore(subscribe, () => listGen)

/** 工具结果里认出这次调用存的小组件:`Saved widget "name" (id w_…, rev N, saved to you)` / `Updated widget …`。 */
const SAVED_RE = /(?:Saved|Updated) widget "([^"]*)" \(id (w_[A-Za-z0-9_-]+), rev (\d+), (saved to this project|saved to you|available to all agents)\)/
export interface SavedWidget { name: string; id: string; rev: number; scope: WidgetOriginal['scope'] }
export function savedWidgetOf(result: unknown): SavedWidget | null {
  if (typeof result !== 'string') return null
  const m = SAVED_RE.exec(result)
  if (!m) return null
  const scope = m[4] === 'saved to this project' ? 'project' : m[4] === 'saved to you' ? 'agent' : 'user'
  return { name: m[1], id: m[2], rev: Number(m[3]), scope }
}

const WIDGET_TOOLS = new Set(['intelligent_ui', 'sketch', 'manage_widget'])
/** tanguSlice 的 tool_result 钩子:动过小组件的工具一回来就作废缓存。 */
export function noteToolResult(name: string | undefined): void {
  if (name && WIDGET_TOOLS.has(name)) invalidateWidgets()
}
