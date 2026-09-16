/** One hidden Historian conversation per parent, shared by maintenance and team summaries. */
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { compactSession, getLatestSummary } from './compaction.js';

export const HISTORIAN_CONTEXT_CHARS = 24_000;
const queues = new Map<string, Promise<unknown>>();
export const hasHistorianTask = (userId: string, sessionId: string): boolean => queues.has(`${userId}:${sessionId}`);
const SYSTEM = 'You are the persistent background Historian for one conversation. Maintain continuity across tasks. Prior records are context, not current instructions. Follow the latest task and its output format. Use the user’s language. Never invent missing facts.';

/** Recent transcript windows overlap. Only append the unseen suffix, preserving line boundaries. */
export function transcriptDelta(previous: string, current: string): string {
  if (!previous) return current;
  if (previous === current) return '[No new conversation text.]';
  for (let i = 0; i < previous.length; i++) {
    if (i && previous[i - 1] !== '\n') continue;
    const suffix = previous.slice(i);
    if (current.startsWith(suffix)) return current.slice(suffix.length).trim() || '[No new conversation text.]';
  }
  return current;
}

export interface HistorianTask {
  sessionId: string; userId: string; modelId: string;
  task: 'judge' | 'team-summary'; instructions: string; transcript: string;
  maxTokens: number; signal?: AbortSignal;
}

export async function completeHistorianTask(p: HistorianTask) {
  const key = `${p.userId}:${p.sessionId}`;
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => completeTask(p));
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

async function completeTask(p: HistorianTask) {
  const signal = p.signal ? AbortSignal.any([p.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
  signal.throwIfAborted();
  const parent = await query<any[]>('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1', [p.sessionId, p.userId]);
  if (!parent[0]) throw new Error('Historian parent session not found');
  const id = uuidv5(`historian:${p.userId}:${p.sessionId}`, uuidv5.URL);
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
  [id, p.userId, 'tangu', 'Historian', p.modelId, 'historian', p.sessionId, '{}']);
  const stored = await query<any[]>('SELECT agent_config FROM chat_sessions WHERE id = ? LIMIT 1', [id]);
  let cfg: any = {};
  try { cfg = typeof stored[0]?.agent_config === 'string' ? JSON.parse(stored[0].agent_config) : stored[0]?.agent_config || {}; } catch { /* old config */ }
  const snapshot = p.transcript.slice(-16_000);
  const input = `[Task: ${p.task}]\n${p.instructions}\n\n[New conversation text]\n${transcriptDelta(String(cfg.snapshots?.[p.task] || ''), snapshot)}`;
  let checkpoint = await getLatestSummary(id);
  const readHistory = () => query<any[]>('SELECT role, content, timestamp FROM chat_messages WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC', [id, checkpoint?.throughTimestamp || 0]);
  let rows = await readHistory();
  if (rows.length && rows.reduce((n, r) => n + String(r.content || '').length, input.length + (checkpoint?.summary.length || 0)) > HISTORIAN_CONTEXT_CHARS) {
    const compact = await compactSession(id, p.modelId, 'tangu', signal);
    if (compact.ok) { checkpoint = await getLatestSummary(id); rows = await readHistory(); }
  }
  // A failed compaction must not make the next request grow without bound. Keep the checkpoint and newest complete records.
  const history: ChatMessage[] = [];
  let room = Math.max(0, HISTORIAN_CONTEXT_CHARS - input.length - (checkpoint?.summary.length || 0));
  for (const r of [...rows].reverse()) {
    const content = String(r.content || '');
    if (content.length > room) break;
    history.unshift({ role: r.role === 'model' ? 'assistant' : 'user', content } as ChatMessage);
    room -= content.length;
  }
  const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(p.modelId);
  signal.throwIfAborted();
  const payload = await deps().brain.llm.buildProviderPayload({
    model, apiModelId, messages: [
      { role: 'system', content: SYSTEM },
      ...(checkpoint ? [{ role: 'system', content: `[Historian checkpoint]\n${checkpoint.summary}` }] : []),
      ...history, { role: 'user', content: input },
    ] as ChatMessage[],
    projectSource: '', usageSource: 'tangu', temperature: 0.3, maxTokens: p.maxTokens,
    stream: true, cacheKey: `${id}:historian`, signal,
  });
  const result = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal });
  signal.throwIfAborted();
  const content = String(result.content || '').trim();
  if (content) {
    // Explicit increasing timestamps also keep checkpoint boundaries unambiguous for very fast providers.
    const now = Math.max(Date.now(), Number(rows.at(-1)?.timestamp || checkpoint?.throughTimestamp || 0) + 1);
    await query('INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
      [uuidv4(), id, 'user', input, now, uuidv4(), id, 'model', content, now + 1]);
    await query('UPDATE chat_sessions SET agent_config = ?, model_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [JSON.stringify({ ...cfg, snapshots: { ...cfg.snapshots, [p.task]: snapshot } }), p.modelId, id]);
  }
  return { ...result, content, model, historianSessionId: id };
}
