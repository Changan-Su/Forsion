import type { ToolEvent } from '../types'
import { engineFetch, type EngineTarget } from './engine/targets'

/** kind 'human' = human/ 文件夹里的一份(10-20):HUMAN.md 是和这个人协作的共识,所有 Agent 都读;另外三份 AGENT / SOUL / MEMORY 走同一套接口。 */
export type HumanFile = 'HUMAN.md' | 'AGENT.md' | 'SOUL.md' | 'MEMORY.md'
export type HumanScope = { kind: 'agent'; slug: string } | { kind: 'project'; cwd: string } | { kind: 'human'; file: HumanFile }
export type HumanTarget = { kind: 'agent'; slug: string } | { kind: 'project'; sessionId: string } | { kind: 'human'; file: HumanFile }
export interface HumanChange {
  id: string; scope: HumanScope; summary: string; evidence: string; at: string; actor: 'agent' | 'user';
  beforeVersion: string; afterVersion: string; undoOf?: string
  /** 引擎给 Agent 的写入盖的章:按哪一版写法写的。没有 = 修复之前的引擎写的(那时它会把自己的承诺也写进来)。 */
  rules?: number
  /** 这一笔从哪来(10-29 画像写入):remember 记下 / Dream 整理 / 跨档挪来 / 从记忆交给所有 Agent / 用户从回执撤销。老引擎不带。 */
  source?: { kind: 'remember' | 'dream' | 'move' | 'promote' | 'user'; agent?: string; action?: 'add' | 'update' | 'forget' }
}
export interface HumanDocument {
  scope: HumanScope; path: string; content: string; version: string; exists: boolean; updatedAt: string | null;
  history: Array<HumanChange & { canUndo: boolean }>; maxLength: number
}
/** 「这份是旧版本写的」:只在更新记录证明得了的时候才说 —— 记录里全是 Agent 的写入、每一条都没有写法版本的章、用户没有手改过(撤销也算手改)。
 *  没有记录的(别的设备同步过来的、直接放在磁盘上的)不判:更新记录只存在本机,认不准的不提示。
 *  现在这份必须就是最后一条记录写成的那份(history 新的在前):之后在磁盘上改过、或从别的设备同步来了新内容,记录没跟上,也不判。 */
export const humanLegacy = (doc: Pick<HumanDocument, 'content' | 'history' | 'version'>): boolean =>
  !!doc.content.trim() && doc.history.length > 0 && doc.history[0].afterVersion === doc.version && doc.history.every(h => h.actor === 'agent' && !h.rules)
/** 「让 Agent 重写」能不能从这个会话发:manage_human 只在本机直连、非计划模式的单个 Agent 会话里有。
 *  团队 / 群聊不发 —— 那一句会被每个成员收到,各改各的;外部引擎的会话里没有这个工具。 */
export const humanRewritable = (c?: { execMode?: string; planMode?: boolean; groupChat?: boolean; teamSlug?: string; engineId?: string; soloEngineId?: string } | null): boolean =>
  !!c && c.execMode === 'host' && !c.planMode && !c.groupChat && !c.teamSlug && !c.engineId && !c.soloEngineId
export interface HumanJump { at: number; edit?: boolean; changeId?: string }
export const HUMAN_CHANGED_EVENT = 'forsion:human-changed'
export const humanTargetKey = (target: HumanTarget) => target.kind === 'agent' ? `agent:${target.slug}` : target.kind === 'human' ? `human:${target.file}` : `project:${target.sessionId}`
const endpoint = (target: HumanTarget) => target.kind === 'agent' ? `/agent/agents/${encodeURIComponent(target.slug)}/human`
  : target.kind === 'human' ? `/agent/human/${encodeURIComponent(target.file)}` : '/agent/project-context/human'
async function request<T>(engine: EngineTarget, target: HumanTarget, method: string, suffix = '', input?: Record<string, unknown>): Promise<T> {
  const project = target.kind === 'project' ? { sessionId: target.sessionId } : {}
  const query = method === 'GET' && target.kind === 'project' ? `?sessionId=${encodeURIComponent(target.sessionId)}` : ''
  const r = await engineFetch(engine, `${endpoint(target)}${suffix}${query}`, {
    method,
    ...(method === 'GET' ? {} : { body: JSON.stringify({ ...input, ...project }) }),
  })
  const body = await r.json()
  if (!r.ok) throw Object.assign(new Error(body.detail || `HTTP ${r.status}`), { status: r.status, code: body.error })
  if (method !== 'GET') window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT))
  return body as T
}
export const getHumanDocument = (engine: EngineTarget, target: HumanTarget) => request<HumanDocument>(engine, target, 'GET')
export const saveHumanDocument = (engine: EngineTarget, target: HumanTarget, content: string, expectedVersion: string, summary: string) =>
  request<{ document: HumanDocument; change: HumanChange | null }>(engine, target, 'PUT', '', { content, expectedVersion, summary })
export const undoHumanChange = (engine: EngineTarget, target: HumanTarget, change: HumanChange) =>
  request<{ document: HumanDocument; change: HumanChange }>(engine, target, 'POST', '/undo', { changeId: change.id, expectedVersion: change.afterVersion })

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
          (c.scope?.kind === 'project' && typeof c.scope.cwd === 'string' && c.scope.cwd.length > 0) ||
          (c.scope?.kind === 'human' && c.scope.file === 'HUMAN.md'))) continue
      changes.set(c.id, c)
    } catch { /* Plain error/read results do not create update cards. */ }
  }
  return [...changes.values()]
}

/** 协作请求卡的处理记录(本机):「知道了」= 收成一行(请求在卡出现时已经生效,这不是审批);「撤销」整张撤回时另记一份。
 *  卡片堆按它决定收不收这张卡(10-23「交互卡片放最新位置」);存不下就只在本次有效。多窗口靠 storage 事件同步。 */
const ACK_KEY = 'forsion.humanAck'
const UNDONE_KEY = 'forsion.humanUndone'
const readIds = (k: string): string[] => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } }
// 存不下(私密窗口 / 配额满)也要在本次生效:内存里留一份,读的时候并上
const memIds: Record<string, Set<string>> = { [ACK_KEY]: new Set(), [UNDONE_KEY]: new Set() }
const seenIds = (k: string): Set<string> => new Set([...readIds(k), ...memIds[k]])
let ackVersion = 0
const ackListeners = new Set<() => void>()
const bumpAck = (): void => { ackVersion++; for (const f of ackListeners) f() }
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === ACK_KEY || e.key === UNDONE_KEY) bumpAck() })
function addIds(k: string, ids: string[]): void {
  for (const id of ids) memIds[k].add(id)
  try { localStorage.setItem(k, JSON.stringify([...new Set([...readIds(k), ...ids])].slice(-200))) } catch { /* ignore */ }
  bumpAck()
}
export const humanAcked = (ids: string[]): boolean => { const seen = seenIds(ACK_KEY); return ids.every((id) => seen.has(id)) }
export const humanUndone = (ids: string[]): boolean => { const seen = seenIds(UNDONE_KEY); return ids.length > 0 && ids.every((id) => seen.has(id)) }
export const ackHumanChanges = (ids: string[]): void => addIds(ACK_KEY, ids)
export const markHumanUndone = (ids: string[]): void => { addIds(UNDONE_KEY, ids); addIds(ACK_KEY, ids) }
export const subscribeHumanAck = (f: () => void): (() => void) => { ackListeners.add(f); return () => { ackListeners.delete(f) } }
export const humanAckVersion = (): number => ackVersion
