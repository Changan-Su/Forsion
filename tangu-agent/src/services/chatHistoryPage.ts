// Read a bounded transcript window in the same order in both directions. An anchor
// belongs to this session, including when two sessions contain the same timestamp.
import { getDbType, query } from '../core/db.js';
import { failedRunsFor } from './failedRuns.js';

const fields = 'id, role, content, reasoning, tool_calls, tool_results, attachments, display_files, agent_slug, origin, timestamp, model_id, is_error';
export interface PageOptions {
  beforeId?: string;
  afterId?: string;
  aroundId?: string;
  known?: Record<string, string>;
}

export async function chatHistoryPage(sid: string, limit: number, options: PageOptions) {
  const sqlite = getDbType() === 'sqlite';
  const tie = sqlite ? 'rowid' : 'id';
  const revision = sqlite ? 'CAST(history_version AS TEXT)' : 'CAST(xmin AS TEXT)';
  const keys = `id, role, COALESCE(timestamp, 0) AS timestamp, ${tie} AS tie, ${revision} AS revision`;
  // SQLite only uses the expression index for a timestamp range if it is
  // explicit. The tuple then places the cut inside a same-millisecond group.
  const cursorPredicate = (op: '<' | '>') =>
    `COALESCE(timestamp, 0) ${op}= ? AND (COALESCE(timestamp, 0), ${tie}) ${op} (?, ?)`;
  const anchorId = options.beforeId || options.afterId || options.aroundId;
  const [anchor] = anchorId ? await query<any[]>(`SELECT ${keys} FROM chat_messages WHERE session_id = ? AND id = ?`, [sid, anchorId]) : [];
  const read = async (direction: 'ASC' | 'DESC', count: number) => {
    const op = direction === 'ASC' ? '>' : '<';
    return query<any[]>(`SELECT ${keys} FROM chat_messages WHERE session_id = ?
      ${anchor ? `AND ${cursorPredicate(op)}` : ''}
      ORDER BY COALESCE(timestamp, 0) ${direction}, ${tie} ${direction} LIMIT ${count}`,
      anchor ? [sid, anchor.timestamp, anchor.timestamp, anchor.tie] : [sid]);
  };
  let rows: any[] = [];
  let older = false, newer = false;
  if (!anchorId || anchor) {
    if (options.aroundId) {
      const half = Math.floor(limit / 2);
      const [left, right] = await Promise.all([read('DESC', half + 1), read('ASC', limit - half)]);
      older = left.length > half;
      newer = right.length >= limit - half;
      rows = [...left.slice(0, half).reverse(), anchor, ...right.slice(0, limit - half - 1)];
    } else {
      const forward = !!options.afterId;
      const batch = await read(forward ? 'ASC' : 'DESC', limit + 1);
      older = forward || batch.length > limit;
      newer = forward ? batch.length > limit : !!options.beforeId;
      rows = batch.slice(0, limit);
      if (!forward) rows.reverse();
    }
  }
  const versions: Record<string, string> = Object.fromEntries(rows.map(r => [r.id, String(r.revision)]));
  // A known id can leave the tail by deletion or simply by aging onto the next
  // page. Only report actual deletions; keep already-read earlier pages intact.
  const outside = Object.keys(options.known ?? {}).filter(id => versions[id] === undefined);
  const surviving = outside.length ? await query<any[]>(
    `SELECT id FROM chat_messages WHERE session_id = ? AND id IN (${outside.map(() => '?').join(',')})`,
    [sid, ...outside]) : [];
  const alive = new Set(surviving.map(row => row.id));
  const removed = outside.filter(id => !alive.has(id));
  const changed = rows.filter(r => options.known?.[r.id] !== String(r.revision));
  const details = changed.length ? await query<any[]>(
    `SELECT ${fields}, ${tie} AS history_order FROM chat_messages WHERE session_id = ? AND id IN (${changed.map(() => '?').join(',')})`,
    [sid, ...changed.map(r => r.id)]) : [];
  const byId = new Map(details.map(row => [row.id, row]));
  const boundary = rows[0];
  // A tail or search window can start on the answer of a failed turn. The run
  // points back to its user row, which can be immediately outside this page.
  let failureRows = rows;
  if (boundary && boundary.role !== 'user') {
    const prior = await query<any[]>(`SELECT id, role, timestamp FROM chat_messages WHERE session_id = ? AND role = 'user'
      AND ${cursorPredicate('<')} ORDER BY COALESCE(timestamp, 0) DESC, ${tie} DESC LIMIT 1`,
      [sid, boundary.timestamp, boundary.timestamp, boundary.tie]);
    failureRows = [...prior, ...rows];
  }
  const end = rows.at(-1);
  if (newer && end) {
    const nextUser = await query<any[]>(`SELECT id, role, timestamp FROM chat_messages WHERE session_id = ? AND role = 'user'
      AND ${cursorPredicate('>')} ORDER BY COALESCE(timestamp, 0), ${tie} LIMIT 1`, [sid, end.timestamp, end.timestamp, end.tie]);
    failureRows = [...failureRows, ...nextUser];
  }
  const visible = new Set(rows.map(r => r.id));
  const failed = (await failedRunsFor(sid, failureRows)).filter(f => visible.has(f.user_message_id) || visible.has(f.assistant_message_id));
  return { rows: changed.flatMap(r => byId.has(r.id) ? [byId.get(r.id)] : []), failed,
    page: { removed, ids: rows.map(r => String(r.id)), versions, older, newer, missing: !!anchorId && !anchor } };
}

// Pending task/creation/collaboration cards used to derive from the latest 200
// rows. Read just their candidate messages, independently of the reading window.
export function chatCardRows(sid: string, tailLimit: number) {
  const tie = getDbType() === 'sqlite' ? 'rowid' : 'id';
  return query<any[]>(`SELECT ${fields} FROM chat_messages WHERE session_id = ? AND id IN (
    SELECT id FROM chat_messages WHERE session_id = ? ORDER BY COALESCE(timestamp, 0) DESC, ${tie} DESC LIMIT ${Math.max(0, 200 - tailLimit)} OFFSET ${tailLimit})
    AND role IN ('model','assistant') AND
    (content LIKE '%forsion-task%' OR content LIKE '%forsion-creation%' OR CAST(tool_calls AS TEXT) LIKE '%manage_human%')
    ORDER BY COALESCE(timestamp, 0), ${tie}`, [sid, sid]);
}
