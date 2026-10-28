/** 会话的批量清理(删 Agent / 卸载时用):按私聊身份找会话、级联删除。路由和卸载共用这一份,别另写 DELETE FROM chat_sessions。 */
import { query, getDbType } from '../core/db.js';
import { bumpHistoryRevision } from './historyRevision.js';
import { removeSessionCheckpoints } from './checkpoints.js';

export type SoloKind = 'agent' | 'engine';

/** 私聊会话:kind='user' + agent_config 里的轨道身份键等于 id(按方言取 JSON;不写 COALESCE 默认值——
 *  历史会话缺键就是不是私聊,绝不能把它们算进默认 agent 的私聊集合)。 */
export function soloPredicate(kind: SoloKind): string {
  const key = kind === 'agent' ? 'soloAgentSlug' : 'soloEngineId';
  return getDbType() === 'sqlite'
    ? `(agent_config IS NOT NULL AND json_valid(agent_config) AND json_type(agent_config) = 'object' AND json_extract(agent_config, '$.${key}') = ?)`
    : `(agent_config IS NOT NULL AND jsonb_typeof(agent_config) = 'object' AND (agent_config ->> '${key}') = ?)`;
}

/** 这个身份的私聊会话 id;archived 不传 = 归档的和没归档的都要。 */
export async function soloSessionIds(userId: string, appId: string, kind: SoloKind, id: string, archived?: boolean): Promise<string[]> {
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM chat_sessions WHERE user_id = ? AND app_id = ? AND kind = 'user' AND ${soloPredicate(kind)}${archived === undefined ? '' : ' AND archived = ?'}`,
    archived === undefined ? [userId, appId, id] : [userId, appId, id, archived],
  );
  return rows.map((r) => r.id);
}

/** 归档这个身份还开着的私聊(只读,归档区还找得到;留在活动列表里就是工作区那行去不掉的「已删除」)。
 *  返回归档了哪些:删 Agent 时记下,从回收站恢复时再取消归档。 */
export async function archiveSoloSessions(userId: string, appId: string, kind: SoloKind, id: string): Promise<string[]> {
  const ids = await soloSessionIds(userId, appId, kind, id, false);
  await setSessionsArchived(userId, ids, true);
  return ids;
}

export async function setSessionsArchived(userId: string, ids: string[], archived: boolean): Promise<void> {
  for (const sid of ids) await query(`UPDATE chat_sessions SET archived = ? WHERE id = ? AND user_id = ?`, [archived, sid, userId]);
}

/** 删一个会话连同它的 run / 消息 / 旁聊 / 代码快照。显式级联(standalone schema 无外键 CASCADE;顺序:叶 → 根)。 */
export async function deleteSessionCascade(sid: string): Promise<void> {
  await query(`DELETE FROM agent_run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)`, [sid]);
  await query(`DELETE FROM agent_steps WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)`, [sid]);
  await query(`DELETE FROM agent_runs WHERE session_id = ?`, [sid]);
  await query(`DELETE FROM chat_messages WHERE session_id = ?`, [sid]);
  await query(`DELETE FROM chat_asides WHERE session_id = ?`, [sid]);
  await query(`DELETE FROM chat_sessions WHERE id = ?`, [sid]);
  bumpHistoryRevision(sid); // 在飞的后台摘要落库前会复核版本 → 丢弃
  await removeSessionCheckpoints(sid); // 代码快照跟着走,否则 home 无界增长
}
