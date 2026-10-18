/**
 * 分过叉的对话里给 agent 的分支段(方案「Chat 画布分支」2026-10-18:agent 要知道分支情况)。
 *
 * 一棵树 = 树根 + 挂在它下面、fork_message_id 有值的分支(/branch 把分支的分支也挂树根,见 routes/sessions.ts)。
 * 子会话(start_session,fork_message_id 为空)不是分支,不进这一段。每支只给标题、分叉后几条、最后一句的前 80 字 ——
 * 不给全文,免得每一轮背着别的支;要细看用 read_session(只读)。「带回」是用户的动作,agent 不往别的支写。
 * 每一轮现算(新开一支 / 改名下一轮就生效);放系统提示易变区(agentLoop 8c 之后)。
 */
import { query } from '../core/db.js';
import { notRemoteTaintedSql } from './remoteTaint.js';

const EXCERPT = 80;
const MAX_LISTED = 12;

/** 一行摘句:去 markdown 记号、压空白,截 80 字。 */
export function excerpt(md: unknown): string {
  const s = String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return s.length > EXCERPT ? `${s.slice(0, EXCERPT)}…` : s;
}

async function forkTs(forkMessageId: unknown): Promise<number | null> {
  if (!forkMessageId) return null;
  const [m] = await query<any[]>(`SELECT timestamp FROM chat_messages WHERE id = ? LIMIT 1`, [forkMessageId]);
  return m ? Number(m.timestamp) : null;
}

async function lastReply(sessionId: string): Promise<string> {
  const [m] = await query<any[]>(
    `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'model' AND content IS NOT NULL AND content <> '' ORDER BY timestamp DESC LIMIT 1`,
    [sessionId],
  );
  return excerpt(m?.content);
}

/** 本会话所在的分支树有 ≥2 支 → `<branches>` 段;否则 null。只读本机库(调用方按 hostExec 门)。
 *  hideRemote(本 run 没有远程污点):远端驱动过的别的支不列 —— 它的标题和最后一句是远端给的,不自动流进本机无污点的系统提示
 *  (同 remoteTaint 的规矩,Codex 10-18 #1)。自己这一支照列(它的内容本来就在上下文里)。 */
export async function branchesSection(sessionId: string, userId: string, opts: { hideRemote?: boolean } = {}): Promise<string | null> {
  const [me] = await query<any[]>(
    `SELECT id, parent_session_id, fork_message_id FROM chat_sessions WHERE id = ? AND user_id = ? AND kind = 'user' LIMIT 1`,
    [sessionId, userId],
  );
  if (!me) return null;
  const rootId = me.fork_message_id && me.parent_session_id ? String(me.parent_session_id) : String(me.id);
  const tree = await query<any[]>(
    `SELECT s.id, s.title, s.fork_message_id FROM chat_sessions s
     WHERE s.user_id = ? AND s.kind = 'user' AND (s.id = ? OR (s.parent_session_id = ? AND s.fork_message_id IS NOT NULL AND s.archived = FALSE))
       ${opts.hideRemote ? `AND (s.id = ? OR ${notRemoteTaintedSql('s')})` : ''}
     ORDER BY s.created_at ASC`,
    opts.hideRemote ? [userId, rootId, rootId, sessionId] : [userId, rootId, rootId],
  );
  if (tree.length < 2 || !tree.some((s) => String(s.id) === sessionId)) return null;
  // 刚分出来、Historian 还没起名的分支叫 New Chat:别把这个占位名当标题念给模型(live 10-18 首跑:「You are in "New Chat"」)
  const name = (s: any): string => {
    if (String(s.id) === rootId) return 'main';
    const t = String(s.title || '').replace(/\s+/g, ' ').trim();
    return t && t !== 'New Chat' ? `"${t}"` : 'an untitled branch';
  };
  const lines: string[] = [];
  for (const s of tree.filter((x) => String(x.id) !== sessionId).slice(0, MAX_LISTED)) {
    const ts = String(s.id) === rootId ? null : await forkTs(s.fork_message_id);
    const [c] = await query<any[]>(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND role IN ('user', 'model')${ts != null ? ' AND timestamp > ?' : ''}`,
      ts != null ? [s.id, ts] : [s.id],
    );
    const n = Number(c?.n) || 0;
    const last = await lastReply(String(s.id));
    lines.push(`- ${name(s)} (session id ${s.id}) — ${n} message${n === 1 ? '' : 's'}${String(s.id) === rootId ? '' : ' since it forked'}${last ? `; last: "${last}"` : ''}`);
  }
  let where = 'You are in main.';
  if (sessionId !== rootId) {
    const [fm] = me.fork_message_id ? await query<any[]>(`SELECT role, content FROM chat_messages WHERE id = ? LIMIT 1`, [me.fork_message_id]) : [];
    const self = tree.find((s) => String(s.id) === sessionId);
    where = `You are in ${name(self)}, which forked after ${fm ? `${fm.role === 'model' ? 'assistant' : 'user'}: "${excerpt(fm.content)}"` : 'an earlier message'}.`;
  }
  return [
    '<branches>',
    `The user forked this conversation from one of its messages to try another direction. It now has ${tree.length} branches. ${where}`,
    'Other branches:',
    ...lines,
    'The user may not have read the other branches. Before relying on one, read it with read_session (load it with load_tools if it is not in your tools); messages up to its fork point are the same as here. Do not write to other branches — the user brings results back themselves.',
    '</branches>',
  ].join('\n');
}
