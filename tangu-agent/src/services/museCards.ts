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
import { upsertTrigger, validateTriggerInput, type TriggerInput } from './museTriggers.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';
import type { MuseCardInfo, MuseCardKind } from '../contracts/clientTypes.js';
import { loadSpecialAgentsConfig, updateMuseConfig, type MuseConfig } from './specialAgentsConfig.js';
import { patchMuseOnboarding } from './museState.js';
import { normalizeMemoryFact } from './memoryRepository.js';
import { AUTO_READ_CATEGORIES, NEEDS_USER, inboxCategory, unclaimedAttachment, type InboxCategory } from './inboxCategory.js';

export type { MuseCardInfo, MuseCardKind };

/** 功能卡能指向的设置页(都是 SETTINGS_TABS 里的一级页;客户端再核一遍才 openSettings)。 */
export const MUSE_FEATURES = ['computer-history', 'computer-use', 'browser', 'channels', 'sync', 'notes', 'mcp'] as const;

/** 推荐一周最多一张(插件卡 + 功能卡合计)。 */
const RECOMMEND_WINDOW_MS = 7 * 86_400_000;
/** 收件箱清单一天最多一张;清单挂了这么久还没处理,才建议连通道。 */
const INBOX_LIST_WINDOW_MS = 86_400_000;
const CHANNEL_AFTER_MS = 2 * 86_400_000;
const MAX_LIST_ITEMS = 8;

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
  card: { kind: MuseCardKind; key?: string; payload: Record<string, unknown>; text: string; uncapped?: boolean },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = uuidv4();
  await query(
    `INSERT INTO muse_cards (id, user_id, kind, target_key, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [id, userId, card.kind, card.key ?? null, JSON.stringify(card.payload), Date.now()],
  );
  const dm = await postMuseDm(userId, `${card.text.trim()}\n\n${fence(id)}`, card.uncapped ? 'proactive:notice' : 'proactive:card');
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

/** 同一类收件箱问题只问一次;点过的类别不再问。返回拒绝理由;null = 放行。 */
export async function inboxAskBlocked(userId: string, category: string, cfg: MuseConfig): Promise<string | null> {
  if (!(AUTO_READ_CATEGORIES as readonly string[]).includes(category)) return `Error: you can only ask about ${AUTO_READ_CATEGORIES.join(', ')} mail.`;
  if (cfg.inboxAutoRead.includes(category) || cfg.inboxIgnored.includes(category)) return 'Error: the user already answered for this category.';
  const rows = await query<any[]>(`SELECT 1 FROM muse_cards WHERE user_id = ? AND target_key = ? LIMIT 1`, [userId, `inbox-ask:${category}`]);
  return rows?.length ? 'Error: you already asked once; do not ask again.' : null;
}

/** 收件箱清单的条目:只收真的要用户动手的未读信,摘要来自模型(一句),其余全从库里读。 */
export async function inboxListItems(userId: string, items: Array<{ id?: unknown; note?: unknown }>): Promise<Array<Record<string, unknown>>> {
  const ids = items.map((i) => String(i?.id || '')).filter(Boolean).slice(0, MAX_LIST_ITEMS);
  if (!ids.length) return [];
  const rows = await query<any[]>(
    `SELECT id, title, body, sender_kind, sender_id, thread, attachments, expires_at, broadcast_kind FROM inbox_messages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [userId, ...ids],
  );
  return (rows || []).filter((r) => NEEDS_USER.has(inboxCategory(r))).map((r) => {
    const note = String(items.find((i) => String(i?.id) === r.id)?.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { id: r.id, title: String(r.title || '').slice(0, 200), category: inboxCategory(r), ...(note ? { note } : {}), ...(unclaimedAttachment(r) ? { claimable: true } : {}), ...(r.expires_at ? { expires: String(r.expires_at).slice(0, 10) } : {}) };
  });
}

/** 清单一天一张(和日报能合就合,别成第二个刷屏源)。 */
export async function inboxListBlocked(userId: string, now = Date.now()): Promise<string | null> {
  const rows = await query<any[]>(`SELECT 1 FROM muse_cards WHERE user_id = ? AND kind = 'inbox-list' AND created_at >= ? LIMIT 1`, [userId, now - INBOX_LIST_WINDOW_MS]);
  return rows?.length ? 'Error: you already sent an inbox list in the last 24 hours.' : null;
}

/** 周期简报里的收件箱一段。没有未读 → 空串;规矩只在用得上时才写(不进落库前缀)。失败 → 空串。 */
export async function inboxHint(userId: string, cfg: MuseConfig, now = Date.now()): Promise<string> {
  try {
    const nowUtc = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await query<any[]>(
      `SELECT body, sender_kind, sender_id, thread, attachments, broadcast_kind FROM inbox_messages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND read_at IS NULL AND (deliver_at IS NULL OR deliver_at <= ?) LIMIT 300`,
      [userId, nowUtc],
    );
    const counts = new Map<InboxCategory, number>();
    for (const r of rows || []) { const c = inboxCategory(r); if (!cfg.inboxIgnored.includes(c)) counts.set(c, (counts.get(c) || 0) + 1); }
    if (!counts.size) return '';
    const parts = [`[Inbox] Unread: ${[...counts].map(([c, n]) => `${c} ${n}`).join(', ')}. Use inbox_read for titles and ids.`];
    const has = (c: InboxCategory): boolean => (counts.get(c) || 0) > 0;
    const asked = await query<any[]>(`SELECT target_key, kind, status, created_at FROM muse_cards WHERE user_id = ? AND kind IN ('inbox-ask', 'inbox-list', 'channel')`, [userId]);
    if ([...NEEDS_USER].some(has) && !(await inboxListBlocked(userId, now))) {
      parts.push('If a reward, feedback reply or approval is waiting, send one message_user with card {type:"inbox_list", items:[{id, note}]}: note is one short line in the user\'s language saying what they need to do. Never claim a reward yourself.');
    }
    for (const c of AUTO_READ_CATEGORIES) {
      if (!has(c)) continue;
      if (cfg.inboxAutoRead.includes(c)) parts.push(`The user agreed: mark ${c} mail as read with inbox_mark; no message needed.`);
      else if (!cfg.inboxIgnored.includes(c) && !(asked || []).some((a) => a.target_key === `inbox-ask:${c}`)) parts.push(`If they keep leaving ${c} mail unopened, you may ask once: message_user with card {type:"inbox_ask", category:"${c}"}, the text being the question.`);
    }
    const stale = (asked || []).some((a) => a.kind === 'inbox-list' && a.status === 'pending' && now - Number(a.created_at) >= CHANNEL_AFTER_MS);
    if (stale && !(asked || []).some((a) => a.kind === 'channel')) parts.push('Your last inbox list has sat untouched for two days. If they rarely open Forsion, suggest once connecting a channel so reminders reach them: message_user with card {type:"channel"}.');
    return `\n\n${parts.join(' ')}`;
  } catch {
    return '';
  }
}

/** 设置变更卡能碰的字段。这张表是唯一的放行名单:权限档、文件夹、预算不在里面,模型写什么、payload 里有什么都到不了配置。 */
const SETTINGS_FIELDS = ['heartbeatMinutes', 'activeHours', 'notify', 'maxDmPerDay'] as const;
type SettingsField = typeof SETTINGS_FIELDS[number];

/** 按名单挑出真的有变化的字段(纯函数)。 */
export function pickMuseSettings(cur: MuseConfig, wanted: Record<string, unknown>): { patch: Partial<MuseConfig>; changes: Array<{ field: SettingsField; from: unknown; to: unknown }> } {
  const patch: Record<string, unknown> = {};
  const changes: Array<{ field: SettingsField; from: unknown; to: unknown }> = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field in wanted)) continue;
    const to = wanted[field];
    if (JSON.stringify(to) === JSON.stringify(cur[field])) continue;
    patch[field] = to;
    changes.push({ field, from: cur[field], to });
  }
  return { patch: patch as Partial<MuseConfig>, changes };
}

/** 第一次见面的三问:选项 → 设置 / 记忆。能对应到设置的改设置,其余记进 Muse 自己的记忆(下个周期是新会话,只读得到这些)。 */
export const INTRO_WHEN = ['anytime', 'daytime', 'open'] as const;
export const INTRO_PACE = ['as-needed', 'daily', 'free'] as const;
export const INTRO_FOCUS = ['schedule', 'study', 'projects', 'inbox'] as const;
type IntroAnswers = { when?: string; pace?: string; focus?: string[] };
/** 答案只认选项里有的值:这张卡对远端放行,不能经它往 LOG 写任意文本。 */
function introAnswers(a: IntroAnswers = {}): Required<IntroAnswers> {
  const one = (list: readonly string[], v?: string): string => (v && list.includes(v) ? v : '');
  return { when: one(INTRO_WHEN, a.when), pace: one(INTRO_PACE, a.pace), focus: (a.focus || []).filter((f) => (INTRO_FOCUS as readonly string[]).includes(f)) };
}
async function applyIntro(userId: string, a: Required<IntroAnswers>): Promise<void> {
  const patch: Partial<MuseConfig> = {};
  if (a.when === 'anytime') patch.activeHours = null;
  if (a.when === 'daytime') patch.activeHours = { start: 9, end: 21 };
  if (a.pace === 'daily') patch.maxDmPerDay = 1;
  if (a.pace === 'free') patch.maxDmPerDay = 0;
  if (Object.keys(patch).length) updateMuseConfig(() => patch);
  if (a.when === 'open') await rememberForMuse(userId, 'Only reach out to the user while they have Forsion open.');
  if (a.pace === 'as-needed') await rememberForMuse(userId, 'The user wants you to speak up only when something matters.');
  if (a.focus.length) await rememberForMuse(userId, `The user most wants you to keep an eye on: ${a.focus.join(', ')}.`);
}

/** 小结里的一条对应一条 Muse 记忆:改 / 删跟着动记忆。按归一后的内容找(写入时的去重也是这个口径,可能并进了写法不同的旧条目);
 *  找不到就只改卡,改写的内容补记一条。写失败往外抛:卡不能显示改了、记忆却没动。 */
async function editMuseMemory(userId: string, oldText: string, newText: string | null): Promise<void> {
  await runWithAgentSlug(MUSE_AGENT_SLUG, async () => {
    const m = deps().brain.memory;
    const entry = (await m.getMemorySnapshot?.(userId))?.entries.find((e) => normalizeMemoryFact(e.content) === normalizeMemoryFact(oldText));
    if (entry && m.mutateMemory) await m.mutateMemory(userId, newText ? { action: 'update', id: entry.id, fact: newText } : { action: 'forget', id: entry.id });
    else if (newText) await m.appendMemoryEntry(userId, newText, { dedup: true });
  });
}

const dismissedFact = (card: MuseCardInfo): string => {
  const what = card.kind === 'plugin' ? `the plugin "${card.payload?.item?.name || card.key}"` : `the Forsion feature "${card.payload?.feature || card.key}"`;
  return `The user is not interested in ${what}. Do not recommend it again.`;
};

/** 第一次见面:引擎自己发,不等模型、不花 token。可跳过。 */
export async function postIntroCard(userId: string): Promise<boolean> {
  const r = await postMuseCard(userId, { kind: 'intro', key: 'intro', payload: {}, text: '', uncapped: true });
  if (r.ok) await patchMuseOnboarding({ introAt: Date.now() });
  return r.ok;
}

/** 第 14 天小结:模型写内容,一条对应一条记忆;只发一次。 */
export async function postSummaryCard(userId: string, text: string, lines: unknown[]): Promise<string> {
  const items = lines.map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 5);
  if (!items.length) return 'Error: a summary needs items, 3 to 5 short lines.';
  const seen = await query<any[]>(`SELECT 1 FROM muse_cards WHERE user_id = ? AND kind = 'summary' LIMIT 1`, [userId]);
  if (seen?.length) return 'Error: you already sent the summary.';
  for (const i of items) await rememberForMuse(userId, i);
  const r = await postMuseCard(userId, { kind: 'summary', key: 'summary', payload: { items, lead: text }, text, uncapped: true });
  if (!r.ok) return r.error;
  await patchMuseOnboarding({ summaryAt: Date.now() });
  return 'Sent. Each line is now in your memory; the user can correct or delete them, and your memory follows.';
}

/** 主动消息下面的「有用 / 少来点这种」:一条 [feedback] 进 Muse 的 LOG,下个周期 read_log 读得到。只认这个用户的主动消息,行文引擎自己拼。 */
export async function recordMessageFeedback(userId: string, messageId: string, verdict: 'up' | 'down'): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT m.content FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.id = ? AND s.user_id = ? AND m.origin LIKE 'proactive%' LIMIT 1`,
    [messageId, userId],
  );
  if (!rows?.[0]) return false;
  const excerpt = String(rows[0].content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  await appendMuseFeedback(userId, verdict === 'up'
    ? `[feedback] the user found your message useful: "${excerpt}"`
    : `[feedback] the user tapped "less of this" on your message: "${excerpt}". Take it as feedback on that kind of message (reminder, suggestion, finished result or recommendation), not just this one.`);
  return true;
}

export type DecideResult = { ok: true; card: MuseCardInfo; trigger?: { id: string } } | { ok: false; status: number; error: string; detail: string };

/** 状态 CAS:pending → 终态。别的设备已处理 → 409,调用方按真状态重拉。 */
async function settle(userId: string, id: string, status: 'done' | 'dismissed', result: string): Promise<boolean> {
  const rows = await query<any[]>(
    `UPDATE muse_cards SET status = ?, result = ?, decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' RETURNING id`,
    [status, result, Date.now(), id, userId],
  );
  return !!rows?.length;
}

/** 先 CAS 收卡再做效果(并发时只有一边能生效);效果失败把卡放回待处理,用户能再点一次。 */
async function settleThen(userId: string, id: string, status: 'done' | 'dismissed', result: string, effect: () => void | Promise<void>): Promise<boolean> {
  if (!(await settle(userId, id, status, result))) return false;
  try {
    await effect();
  } catch (e) {
    await query(`UPDATE muse_cards SET status = 'pending', result = NULL, decided_at = NULL WHERE id = ? AND user_id = ?`, [id, userId]);
    throw e;
  }
  return true;
}

/** 规则卡三个按钮:好 = 建好开着;改一下 = 建成暂停的,客户端打开画布;不用 = 不建,写进反馈让 Muse 别再提。
 *  入参在工具入口校验过,这里按当前环境再校验一次(卡可能放了几天)。建失败(比如到 50 条上限)把卡退回待处理,别让用户以为建上了。 */
async function decideRuleCard(userId: string, card: MuseCardInfo, action: string, gone: DecideResult, bad: DecideResult): Promise<DecideResult> {
  if (action === 'dismiss') {
    if (!(await settle(userId, card.id, 'dismissed', 'dismissed'))) return gone;
    await appendMuseFeedback(userId, `[feedback] proposed automation "${card.payload?.rule?.desc}" declined by user`);
    return { ok: true, card: (await getMuseCard(userId, card.id)) ?? card };
  }
  if (action !== 'accept' && action !== 'edit') return bad;
  const v = validateTriggerInput({ ...(card.payload?.input as TriggerInput), enabled: action === 'accept' }, { cwd: card.payload?.cwd, vaultPath: amadeusVaultPath() });
  if (!v.ok) return { ok: false, status: 400, error: 'bad_rule', detail: v.error };
  if (!(await settle(userId, card.id, 'done', action === 'accept' ? 'accepted' : 'editing'))) return gone;
  const r = await upsertTrigger(v.value, undefined, { actor: 'user' }).catch((e) => ({ ok: false as const, error: String(e?.message || e) }));
  if (!r.ok) {
    await query(`UPDATE muse_cards SET status = 'pending', result = NULL, decided_at = NULL WHERE id = ?`, [card.id]);
    return { ok: false, status: 409, error: 'rule_not_created', detail: r.error };
  }
  await appendMuseFeedback(userId, `[feedback] proposed automation "${v.value.desc}" ${action === 'accept' ? 'accepted' : 'taken to the canvas'} by user`);
  return { ok: true, card: (await getMuseCard(userId, card.id)) ?? card, trigger: { id: r.trigger.id } };
}

/** 用户点卡。action 按 kind 白名单,认不得 → 400;效果在 CAS 成功之后才做(同一张卡点两次只生效一次)。 */
export async function decideMuseCard(
  userId: string, id: string, action: string,
  opts: { messageId?: string; answers?: IntroAnswers; index?: number; expected?: string; text?: string } = {},
): Promise<DecideResult> {
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
    case 'inbox-ask': {
      const category = String(card.payload?.category || '');
      if (action !== 'yes' && action !== 'later' && action !== 'ignore') return bad;
      const answered = await settleThen(userId, id, 'done', action, () => {
        if (action === 'yes') updateMuseConfig((m) => ({ inboxAutoRead: [...m.inboxAutoRead, category] }));
        if (action === 'ignore') updateMuseConfig((m) => ({ inboxIgnored: [...m.inboxIgnored, category] }));
      });
      if (!answered) return gone;
      await appendMuseFeedback(userId, `[feedback] inbox question about ${category} mail answered by user: ${action === 'yes' ? 'mark it as read from now on' : action === 'ignore' ? 'ignore this kind, neither remind nor mark' : 'not now'}`);
      break;
    }
    case 'inbox-list': {
      if (action === 'ack') {
        if (!(await settle(userId, id, 'done', 'ack'))) return gone;
        await appendMuseFeedback(userId, '[feedback] inbox list acknowledged by user');
        break;
      }
      if (action !== 'item' || !opts.messageId) return bad;
      // 领了 / 打开了一条:条目记一笔,都处理完这张卡就收起
      const items = (Array.isArray(card.payload?.items) ? card.payload.items : []).map((i: any) => (i?.id === opts.messageId ? { ...i, handled: true } : i));
      if (items.every((i: any) => i?.handled)) {
        if (!(await settle(userId, id, 'done', 'handled'))) return gone;
      }
      await query(`UPDATE muse_cards SET payload = ? WHERE id = ? AND user_id = ?`, [JSON.stringify({ ...card.payload, items }), id, userId]);
      break;
    }
    case 'channel': {
      if (action === 'open') {
        if (!(await settle(userId, id, 'done', 'opened'))) return gone;
      } else if (action === 'dismiss') {
        if (!(await settle(userId, id, 'dismissed', 'dismissed'))) return gone;
        await rememberForMuse(userId, 'The user does not want to connect a chat channel for reminders. Do not suggest it again.');
      } else return bad;
      break;
    }
    case 'settings': {
      if (action === 'apply') {
        // 再过一遍名单:payload 是这张卡发出时存的,配置可能已经变了,也别信它里面只有这几个键
        const wanted = pickMuseSettings(loadSpecialAgentsConfig().muse, card.payload?.patch || {});
        if (!(await settleThen(userId, id, 'done', 'applied', () => { if (wanted.changes.length) updateMuseConfig(() => wanted.patch); }))) return gone;
        await appendMuseFeedback(userId, `[feedback] settings change applied by user: ${wanted.changes.map((c) => `${c.field} → ${JSON.stringify(c.to)}`).join(', ') || 'already in place'}`);
      } else if (action === 'dismiss') {
        if (!(await settle(userId, id, 'dismissed', 'dismissed'))) return gone;
        await appendMuseFeedback(userId, '[feedback] settings change turned down by user: keep things as they are');
      } else return bad;
      break;
    }
    case 'intro': {
      if (action !== 'answer' && action !== 'skip') return bad;
      const answers = introAnswers(opts.answers);
      if (!(await settleThen(userId, id, 'done', action, () => (action === 'answer' ? applyIntro(userId, answers) : undefined)))) return gone;
      await appendMuseFeedback(userId, action === 'answer' ? `[feedback] first-week questions answered: ${JSON.stringify(answers)}` : '[feedback] first-week questions skipped; use the defaults');
      break;
    }
    case 'summary': {
      const items: string[] = Array.isArray(card.payload?.items) ? card.payload.items : [];
      if (action === 'ok') {
        if (!(await settle(userId, id, 'done', 'ok'))) return gone;
        await appendMuseFeedback(userId, '[feedback] two-week summary confirmed by user');
        break;
      }
      const at = Number(opts.index);
      if ((action !== 'edit' && action !== 'remove') || !Number.isInteger(at) || at < 0 || at >= items.length) return bad;
      const text = action === 'edit' ? String(opts.text || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      if (action === 'edit' && !text) return bad;
      if (opts.expected !== items[at]) return gone; // 下标来自点的那一刻的卡面:别的设备改过了,按旧下标会改到另一条
      const next = action === 'edit' ? items.map((x, i) => (i === at ? text : x)) : items.filter((_, i) => i !== at);
      const before = JSON.stringify(card.payload);
      const after = JSON.stringify({ ...card.payload, items: next });
      const moved = await query<any[]>(`UPDATE muse_cards SET payload = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND payload = ? RETURNING id`, [after, id, userId, before]);
      if (!moved?.length) return gone;
      try {
        await editMuseMemory(userId, items[at], text || null);
      } catch (e) {
        // ponytail: 只在卡面还是这一步的结果时退回,不盖别的设备刚成功的改动;那种情形下这一条的卡面与记忆会差一步,两台设备同时改、记忆又写失败才碰得到
        await query(`UPDATE muse_cards SET payload = ? WHERE id = ? AND user_id = ? AND payload = ?`, [before, id, userId, after]);
        throw e;
      }
      if (!next.length && !(await settle(userId, id, 'done', 'ok'))) return gone;
      await appendMuseFeedback(userId, `[feedback] user ${action === 'edit' ? 'corrected' : 'removed'} a line of your two-week summary: "${items[at].slice(0, 120)}"${text ? ` → "${text.slice(0, 120)}"` : ''}`);
      break;
    }
    case 'rule': return decideRuleCard(userId, card, action, gone, bad);
    default: return bad;
  }
  return { ok: true, card: (await getMuseCard(userId, id)) ?? card };
}
