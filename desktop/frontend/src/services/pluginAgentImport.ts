/**
 * 插件建 Agent / 导入会话(2026-11-16,`ctx.tangu.createAgent` / `importSessions`,声明 `"agentImport"` 才有)。
 *
 * 写进**本端**引擎(homeTarget):桌面 = 本机引擎,手机 / 网页 = 云端。不跨端同步 —— 用户 11-16 定「各端各导各的」。
 *
 * 导进来的会话和用户点「新建 Chat」建出来的同一个形状(preset chat + sandbox + 不挂项目),再挂到指定 Agent 名下;
 * 不进私聊轨道(私聊是每个 Agent 一条活动会话,一批旧对话塞不进去)。
 */
import { homeTarget } from './engine/targets'
import { importSessions as postImport, saveAgentDef, type SessionImportBody, type SessionImportRow } from './backendService'
import type {
  TanguCreateAgentInput, TanguCreateAgentResult, TanguImportSessionResult, TanguImportSessionsInput, TanguImportSessionsResult,
} from '../amadeus/plugins/tanguSeam'

/** 一批的上限:条数与引擎同(50),字数留在引擎上限(800 万)以内、也让单个请求不至于太大(手机网络)。 */
const BATCH_CONVERSATIONS = 40
const BATCH_CHARS = 1_500_000
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface AgentImportDeps {
  waitBackend(): Promise<unknown>
  activeModelId(): string | null
  refreshAgents(): void
  refreshSessions(): void
}

export async function createAgentForPlugin(input: TanguCreateAgentInput, alive: () => boolean, deps: AgentImportDeps): Promise<TanguCreateAgentResult> {
  try {
    if (!input || typeof input.name !== 'string' || !input.name.trim()) return { ok: false, error: 'name is required' }
    if (typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim()) return { ok: false, error: 'systemPrompt is required' }
    if (input.slug != null && (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug))) return { ok: false, error: 'Invalid agent id' }
    if (!(await deps.waitBackend())) return { ok: false, error: 'The engine is not connected' }
    if (!alive()) return { ok: false, error: 'plugin disabled' }
    const agent = await saveAgentDef(homeTarget(), {
      name: input.name.trim().slice(0, 80),
      ...(input.nameEn ? { nameEn: String(input.nameEn).slice(0, 80) } : {}),
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.description ? { description: String(input.description).slice(0, 500) } : {}),
      systemPrompt: input.systemPrompt,
      ...(input.soul ? { soul: String(input.soul) } : {}),
      ...(typeof input.model === 'string' && input.model ? { model: input.model.slice(0, 128) } : {}),
    } as Parameters<typeof saveAgentDef>[1])
    deps.refreshAgents()
    return { ok: true, slug: agent.slug }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

/** 按条数和字数切批:一条超过字数上限的长对话自己成一批(引擎那头还有 800 万的硬上限)。 */
export function batchConversations<T extends { messages: Array<{ content: string; reasoning?: string }> }>(list: T[]): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let chars = 0
  for (const c of list) {
    const n = c.messages.reduce((s, m) => s + (m.content?.length ?? 0) + (m.reasoning?.length ?? 0), 0)
    if (cur.length && (cur.length >= BATCH_CONVERSATIONS || chars + n > BATCH_CHARS)) { out.push(cur); cur = []; chars = 0 }
    cur.push(c)
    chars += n
  }
  if (cur.length) out.push(cur)
  return out
}

export async function importSessionsForPlugin(input: TanguImportSessionsInput, alive: () => boolean, deps: AgentImportDeps): Promise<TanguImportSessionsResult> {
  const results: TanguImportSessionResult[] = []
  try {
    if (!input || typeof input.agent !== 'string' || !SLUG_RE.test(input.agent)) return { ok: false, error: 'agent must be an agent id', results }
    if (typeof input.source !== 'string' || !SOURCE_RE.test(input.source)) return { ok: false, error: 'source must match ^[a-z0-9][a-z0-9-]{0,31}$', results }
    if (!Array.isArray(input.conversations)) return { ok: false, error: 'conversations must be an array', results }
    if (!(await deps.waitBackend())) return { ok: false, error: 'The engine is not connected', results }
    const modelId = (typeof input.modelId === 'string' && input.modelId) || deps.activeModelId() || undefined
    const total = input.conversations.length
    let done = 0
    let wrote = false
    try {
      for (const batch of batchConversations(input.conversations)) {
        if (!alive()) return { ok: false, error: 'plugin disabled', results }
        if (input.signal?.aborted) return { ok: false, error: 'cancelled', results }
        const body: SessionImportBody = {
          source: input.source,
          agent_config: { preset: 'chat', execMode: 'sandbox', agentSlug: input.agent },
          ...(modelId ? { model_id: modelId } : {}),
          conversations: batch.map((c) => ({
            external_id: String(c.id),
            ...(c.title ? { title: String(c.title) } : {}),
            ...(c.createdAt != null ? { created_at: c.createdAt } : {}),
            ...(c.updatedAt != null ? { updated_at: c.updatedAt } : {}),
            messages: c.messages.map((m) => ({
              role: m.role, content: m.content,
              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
              ...(m.timestamp != null ? { timestamp: m.timestamp } : {}),
              ...(m.model ? { model_id: m.model } : {}),
            })),
          })),
        }
        const rows: SessionImportRow[] = await postImport(homeTarget(), body, input.signal)
        for (const r of rows) {
          results.push({ id: r.external_id, status: r.status, ...(r.session_id ? { sessionId: r.session_id } : {}), ...(r.error ? { error: r.error } : {}) })
          if (r.status === 'created') wrote = true
        }
        done += batch.length
        try { input.onProgress?.(done, total) } catch { /* 插件回调抛错不打断导入 */ }
      }
    } finally {
      if (wrote) deps.refreshSessions()
    }
    return { ok: true, results }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e), results }
  }
}
