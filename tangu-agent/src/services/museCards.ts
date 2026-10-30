/**
 * Muse 发进私聊、要用户点的卡(2026-10-30,方案 Muse与Agent升级):插件 / 功能推荐等。
 *
 * 状态住引擎(muse_cards,和 pending_approvals 同一种做法),不放渲染层的 localStorage:手机上的 Muse 私聊走隧道,
 * 而 POST /agent/special/config 与 /muse/feedback 都拒远端 —— 效果要是客户端自己去调,手机点一下就 403。
 * 所以卡片只有一条写口 decideMuseCard:客户端传 action,效果在这里按 kind 白名单执行;payload 只有工具入口校验过才写得进来。
 * 私聊消息 origin=proactive:card(只有引擎写得出这一列),正文带 ```forsion-muse-card {"id"} 围栏,流里按 id 读卡;
 * 别处(模型写的正文)的同名围栏客户端不认。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { postMuseDm } from './museDm.js';
import type { MuseCardInfo, MuseCardKind } from '../contracts/clientTypes.js';

export type { MuseCardInfo, MuseCardKind };

/** 功能卡能指向的设置页(都是 SETTINGS_TABS 里的一级页;客户端再核一遍才 openSettings)。 */
export const MUSE_FEATURES = ['computer-history', 'computer-use', 'browser', 'channels', 'sync', 'notes', 'mcp'] as const;

/** 推荐一周最多一张(插件卡 + 功能卡合计)。 */
const RECOMMEND_WINDOW_MS = 7 * 86_400_000;

/** 反馈写进 Muse 的 LOG(英文:下周期 read_log 喂给模型)。绝不抛。 */
export async function appendMuseFeedback(userId: string, line: string): Promise<void> {
  try {
    await runWithAgentSlug(MUSE_AGENT_SLUG, () => deps().brain.memory.appendLogEntry(userId, line));
  } catch { /* 反馈写失败不阻断主流程 */ }
}

/** 写进 Muse 自己的长期记忆(英文)。Muse 每个周期都是新会话,拒过的东西只有落到这里下个周期才还记得。绝不抛。 */
export async function rememberForMuse(userId: string, fact: string): Promise<void> {
  try {
    await runWithAgentSlug(MUSE_AGENT_SLUG, () => deps().brain.memory.appendMemoryEntry(userId, fact, { dedup: true }));
  } catch { /* 记忆写失败不阻断;target_key 那道闸仍挡得住重复推荐 */ }
}

function toInfo(r: any): MuseCardInfo {
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(String(r.payload)) || {}; } catch { /* 脏行按空 */ }
  return {
    id: r.id, kind: r.kind, key: r.target_key ?? null, payload, status: r.status, result: r.result ?? null,
    created_at: Number(r.created_at) || 0, decided_at: r.decided_at == null ? null : Number(r.decided_at),
  };
}

export async function listMuseCards(userId: string, status?: string): Promise<MuseCardInfo[]> {
  const rows = await query<any[]>(
    `SELECT * FROM muse_cards WHERE user_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at ASC LIMIT 100`,
    status ? [userId, status] : [userId],
  );
  return (rows || []).map(toInfo);
}

export async function getMuseCard(userId: string, id: string): Promise<MuseCardInfo | null> {
  const rows = await query<any[]>(`SELECT * FROM muse_cards WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return rows?.[0] ? toInfo(rows[0]) : null;
}

const fence = (id: string): string => '```forsion-muse-card\n' + JSON.stringify({ id }) + '\n```';

/** 建卡 + 发私聊。私聊发不出去就撤掉这一行:卡片堆里不留一张说不清来路的卡。 */
export async function postMuseCard(
  userId: string,
  card: { kind: MuseCardKind; key?: string; payload: Record<string, unknown>; text: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = uuidv4();
  await query(
    `INSERT INTO muse_cards (id, user_id, kind, target_key, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [id, userId, card.kind, card.key ?? null, JSON.stringify(card.payload), Date.now()],
  );
  const dm = await postMuseDm(userId, `${card.text.trim()}\n\n${fence(id)}`, 'proactive:card');
  if (dm.ok) return { ok: true, id };
  await query(`DELETE FROM muse_cards WHERE id = ?`, [id]).catch(() => {});
  return { ok: false, error: dm.error };
}

/** 插件 / 功能推荐的闸:同一样东西只提一次(拒过的当然也算),一周最多一张。返回拒绝理由(英文,回给模型);null = 放行。 */
export async function recommendBlocked(userId: string, key: string, now = Date.now()): Promise<string | null> {
  const rows = await query<any[]>(`SELECT target_key, created_at FROM muse_cards WHERE user_id = ? AND kind IN ('plugin', 'feature')`, [userId]);
  if ((rows || []).some((r) => r.target_key === key)) return 'Error: you already recommended this one; do not bring it up again.';
  if ((rows || []).some((r) => now - Number(r.created_at) < RECOMMEND_WINDOW_MS)) return 'Error: you already recommended something in the last 7 days. Save this for later.';
  return null;
}

/** 周期简报里的一段:这周还能推荐才出现(只写在 ephemeralHint,不进落库前缀)。失败 → 空串。 */
export async function recommendHint(userId: string, now = Date.now()): Promise<string> {
  try {
    const rows = await query<any[]>(`SELECT target_key, created_at FROM muse_cards WHERE user_id = ? AND kind IN ('plugin', 'feature')`, [userId]);
    if ((rows || []).some((r) => now - Number(r.created_at) < RECOMMEND_WINDOW_MS)) return '';
    const seen = (rows || []).map((r) => String(r.target_key || '')).filter(Boolean);
    return '\n\n[Recommendation] You may recommend one thing this week, only if their usage clearly calls for it: a chore they keep doing by hand, a built-in feature they would use and have not turned on. ' +
      `For a plugin, search_marketplace first (the user does not see those results), then send message_user with card {type:"plugin", plugin_id}. For a built-in feature, card {type:"feature", feature, title}. The message text says why, in one sentence, from what you actually saw. Nothing clear? Skip it.` +
      (seen.length ? ` Already recommended, do not repeat: ${seen.slice(-20).join(', ')}.` : '');
  } catch {
    return '';
  }
}

const dismissedFact = (card: MuseCardInfo): string => {
  const what = card.kind === 'plugin' ? `the plugin "${card.payload?.item?.name || card.key}"` : `the Forsion feature "${card.payload?.feature || card.key}"`;
  return `The user is not interested in ${what}. Do not recommend it again.`;
};

export type DecideResult = { ok: true; card: MuseCardInfo } | { ok: false; status: number; error: string; detail: string };

/** 状态 CAS:pending → 终态。别的设备已处理 → 409,调用方按真状态重拉。 */
async function settle(userId: string, id: string, status: 'done' | 'dismissed', result: string): Promise<boolean> {
  const rows = await query<any[]>(
    `UPDATE muse_cards SET status = ?, result = ?, decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' RETURNING id`,
    [status, result, Date.now(), id, userId],
  );
  return !!rows?.length;
}

/** 用户点卡。action 按 kind 白名单,认不得 → 400;效果在 CAS 成功之后才做(同一张卡点两次只生效一次)。 */
export async function decideMuseCard(userId: string, id: string, action: string): Promise<DecideResult> {
  const card = await getMuseCard(userId, id);
  if (!card) return { ok: false, status: 404, error: 'card_not_found', detail: 'card not found' };
  const bad: DecideResult = { ok: false, status: 400, error: 'bad_action', detail: `${card.kind} card has no action ${action}` };
  const gone: DecideResult = { ok: false, status: 409, error: 'card_not_pending', detail: 'card is already handled' };
  if (card.status !== 'pending') return gone;
  switch (card.kind) {
    case 'plugin':
    case 'feature': {
      if (action === 'dismiss') {
        if (!(await settle(userId, id, 'dismissed', 'dismissed'))) return gone;
        await rememberForMuse(userId, dismissedFact(card));
        await appendMuseFeedback(userId, `[feedback] recommendation ${card.key} dismissed by user: not interested`);
      } else if (action === 'open' && card.kind === 'feature') {
        if (!(await settle(userId, id, 'done', 'opened'))) return gone;
        await appendMuseFeedback(userId, `[feedback] recommendation ${card.key} opened by user`);
      } else return bad;
      break;
    }
    default: return bad;
  }
  return { ok: true, card: (await getMuseCard(userId, id)) ?? card };
}
