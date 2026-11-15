/**
 * 工作台(融合插件)要打开 Forsion 的某场对话之前,先让常驻进程把那场引擎会话接上:网页界面自己点开一场没人开着的会话
 * 会一直占着它,Forsion 之后就接不上(实测,residentAcp.hold)。HTTP 路由(POST /agent/engines/:id/hold)和引擎插件
 * (ctx.sdk.engines.hold)共用这一份。
 */
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';

export type HoldResult =
  | { ok: true; engineSessionId: string; state: 'open' | 'resumed' }
  | { ok: false; status: number; detail: string; code?: 'no_engine_session' | 'not_running' | 'busy' | 'gone' | 'failed' };

/** 这场 Forsion 对话最近一次在这个引擎上跑时记下的引擎会话(id + 工作目录)。 */
async function enginePointer(engineId: string, sessionId: string): Promise<{ id: string; cwd: string } | null> {
  const runs = await query<any[]>(
    `SELECT result FROM agent_runs WHERE session_id = ? AND CAST(result AS TEXT) LIKE '%"externalSession":%' ORDER BY created_at DESC LIMIT 8`, [sessionId]);
  for (const r of runs) {
    let v: any = r.result;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    const p = v?.externalSession;
    if (p && p.engineId === engineId && typeof p.id === 'string' && p.id && typeof p.cwd === 'string') return { id: p.id, cwd: p.cwd };
  }
  return null;
}

export async function holdEngineConversation(engineId: string, sessionId: string, userId: string): Promise<HoldResult> {
  const engines = deps().engines;
  if (!engines || !engines.has(engineId) || !engines.resident) return { ok: false, status: 404, detail: 'unknown engine' };
  try {
    const own = await query<any[]>('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1', [sessionId, userId]);
    if (!own.length) return { ok: false, status: 404, detail: 'unknown session' };
    const pointer = await enginePointer(engineId, sessionId);
    if (!pointer) return { ok: false, status: 404, detail: 'This conversation has not run on this engine yet', code: 'no_engine_session' };
    const link = await engines.resident(engineId);
    if (!link) return { ok: false, status: 409, detail: 'The background engine is not running', code: 'not_running' };
    const name = engines.list().find((e) => e.id === engineId)?.name || engineId;
    const state = await link.hold(name, pointer.id, pointer.cwd);
    return { ok: true, engineSessionId: pointer.id, state };
  } catch (e: any) {
    const code = e?.externalSessionBusy ? 'busy' : e?.externalSessionGone ? 'gone' : 'failed';
    return { ok: false, status: code === 'failed' ? 500 : 409, detail: e?.message || 'hold failed', code };
  }
}
