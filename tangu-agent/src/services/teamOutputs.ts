/** Public deliverables from a member run. Private tool activity stays in its child chat.
 * Live forwarding and legacy recovery deliberately share the same projection and IDs. */
import { v5 as uuidv5 } from 'uuid';
import type { AgentEvent } from './eventBus.js';
import type { FinalizeMessageInput } from '../seams/stateStore.js';
import { query } from '../core/db.js';

export const TEAM_OUTPUT_MODE = 'team_output_mode';
type Source = { runId: string; sessionId: string; slug: string; name: string; modelId: string };
export type TeamOutput = Pick<FinalizeMessageInput, 'messageId' | 'content' | 'toolCalls' | 'toolResults' | 'displayFiles' | 'agentSlug' | 'modelId'>;

export function teamOutputCollector(source: Source): (ev: AgentEvent) => TeamOutput | undefined {
  const calls = new Map<string, any>();
  const seen = new Set<string>();
  return (ev) => {
    const p = ev.payload || {};
    if (ev.type === 'tool_call' && p.name === 'sketch' && p.id) {
      calls.set(p.id, { id: p.id, type: 'function', function: { name: p.name, arguments: p.arguments }, ui_content_offset: 0 });
      return;
    }
    let key: string;
    const out: TeamOutput = {
      messageId: '', content: `**🗣 ${source.name}**\n\n`, agentSlug: source.slug, modelId: source.modelId,
      toolCalls: [], toolResults: [],
    };
    if (ev.type === 'tool_result') {
      const call = calls.get(p.id);
      if (!call || p.isError || typeof p.result !== 'string' || /^Error[:\s]/i.test(p.result)) return;
      try { if (!JSON.parse(call.function.arguments).html?.trim()) return; } catch { return; }
      key = `sketch:${p.id}`;
      out.toolCalls = [call];
      out.toolResults = [{ tool_call_id: p.id, name: 'sketch', content: p.result, isError: false }];
    } else if (ev.type === 'display_file') {
      if (typeof p.name !== 'string' || !p.name || !(typeof p.path === 'string' && p.path || typeof p.dataUrl === 'string' && p.dataUrl)) return;
      key = `file:${ev.seq}`;
      out.displayFiles = [{ name: p.name, mime: p.mime, path: p.path, dataUrl: p.dataUrl, sourceSessionId: source.sessionId }];
    } else return;
    if (seen.has(key)) return;
    seen.add(key);
    out.messageId = uuidv5(`tangu:team-output:${source.runId}:${key}`, uuidv5.URL);
    return out;
  };
}

export function teamOutputRecord(out: TeamOutput, timestamp: number): Record<string, any> {
  return {
    id: out.messageId, role: 'model', content: out.content, agent_slug: out.agentSlug, model_id: out.modelId,
    tool_calls: out.toolCalls, tool_results: out.toolResults, display_files: out.displayFiles || [], timestamp,
  };
}

function json(v: any): any { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } }
const recovering = new Map<string, Promise<void>>();

/** One-time recovery for pre-forwarding team runs, before history pagination.
 * Only runs explicitly announced by the parent's team_member events are eligible:
 * direct follow-ups in a member's private chat must never become public retroactively.
 * The marker prevents deleted recovered messages from reappearing. No session activity bump. */
export function recoverTeamOutputs(sessionId: string, userId: string): Promise<void> {
  const key = `${userId}:${sessionId}`;
  const pending = recovering.get(key);
  if (pending) return pending;
  const work = recover(sessionId, userId).finally(() => recovering.delete(key));
  recovering.set(key, work);
  return work;
}

async function recover(sessionId: string, userId: string): Promise<void> {
  const runs = await query<any[]>(
    `SELECT r.id, r.input FROM agent_runs r WHERE r.session_id = ? AND r.user_id = ?
     AND r.status IN ('done', 'failed', 'aborted')
     AND EXISTS (SELECT 1 FROM agent_run_events e WHERE e.run_id = r.id AND e.type = 'team_member')
     AND NOT EXISTS (SELECT 1 FROM agent_run_events e WHERE e.run_id = r.id AND e.type = ?)`,
    [sessionId, userId, TEAM_OUTPUT_MODE],
  );
  for (const run of runs) {
    // Rewound/deleted turns must not resurrect outputs from their retained run logs.
    const userMessageId = json(run.input)?.userMessageId;
    const retained = userMessageId && await query<any[]>('SELECT id, timestamp FROM chat_messages WHERE id = ? AND session_id = ?', [userMessageId, sessionId]);
    if (retained?.length) {
      const starts = await query<any[]>("SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'team_member' ORDER BY seq", [run.id]);
      for (const row of starts) {
        const start = json(row.payload);
        if (start?.phase !== 'start' || !start.runId || !start.sessionId) continue;
        const children = await query<any[]>(
          `SELECT r.model_id FROM agent_runs r JOIN chat_sessions s ON s.id = r.session_id
           WHERE r.id = ? AND r.session_id = ? AND r.user_id = ? AND s.user_id = ? AND s.parent_session_id = ? AND s.kind = 'teamwork'`,
          [start.runId, start.sessionId, userId, userId, sessionId],
        );
        if (!children.length) continue;
        const collect = teamOutputCollector({ runId: start.runId, sessionId: start.sessionId, slug: start.slug, name: start.name || start.slug, modelId: children[0].model_id });
        const events = await query<any[]>("SELECT seq, type, payload, created_at FROM agent_run_events WHERE run_id = ? AND type IN ('tool_call', 'tool_result', 'display_file') ORDER BY seq", [start.runId]);
        for (const event of events) {
          const payload = json(event.payload);
          const output = collect({ ...event, payload });
          if (!output) continue;
          const rawDate = event.created_at;
          const at = rawDate instanceof Date ? rawDate.getTime() : Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(String(rawDate)) ? rawDate : `${String(rawDate).replace(' ', 'T')}Z`);
          if (!Number.isFinite(at)) throw new Error('Invalid team output timestamp');
          await query(
            `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, tool_calls, tool_results, display_files, agent_slug)
             VALUES (?, ?, 'model', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            [output.messageId, sessionId, output.content, Math.max(Number(retained[0].timestamp) + 1,
              Number(payload?.startedAt) > 0 ? Number(payload.startedAt) + (Number(payload.elapsedMs) || 0) : at + Math.min(Number(event.seq), 999)), output.modelId,
              JSON.stringify(output.toolCalls), JSON.stringify(output.toolResults), JSON.stringify(output.displayFiles || []), output.agentSlug],
          );
        }
      }
    }
    // Append through the event store so sequence allocation remains consistent with SSE replay.
    const { publish } = await import('./eventBus.js');
    await publish(run.id, TEAM_OUTPUT_MODE, { version: 1, recovered: true });
  }
}
