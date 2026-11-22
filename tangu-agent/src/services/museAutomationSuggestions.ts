/**
 * Muse 给自动化首页的任务建议(11-22 用户选方案 A,docs/ToBeImproved/自动化任务建议方案_2026-11-22)。
 *
 * 一条 = 标题 + 一份规则草稿(和 manage_automation set 同一套入参,同一个校验)+ 一句依据 + 依据的来源。
 * 它比私聊里的规则卡轻:不等用户答复、不建规则;用户在自动化首页点了才打开一份草稿,保存与否由用户定。
 * set_automation_suggestions 整组替换:标题与规则都没变的那条保留原 id(桌面不闪、用户的 × 不白点);被顶掉的记 replaced。
 * 用户点 × = dismissed,30 天内同一标题不许再提;草稿存成了规则 = used。两种都写进 Muse 的 LOG([feedback] 行)。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { resolveNoteRef } from './museStarters.js';
import { validateTriggerInput, type TriggerInput, type ValidatedTrigger } from './museTriggers.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';

export const SUGGESTION_SOURCE_KINDS = ['calendar', 'note', 'todo', 'database', 'computer', 'muse'] as const;
export type SuggestionSourceKind = typeof SUGGESTION_SOURCE_KINDS[number];
/** Muse 一次最多给几条;首页显示 4 条,其余收进「还有 N 条」。 */
export const MAX_SUGGESTIONS = 6;
const MAX_TITLE = 60;
const MAX_WHY = 200;
const DISMISS_DAYS = 30;

/** 草稿里的规则:校验过的触发与动作(桌面画布按它填),不带 enabled / observe —— 那是用户保存时定的。 */
export type SuggestionRule = Pick<ValidatedTrigger, 'desc' | 'cond' | 'prompt' | 'cooldownHours' | 'actions' | 'only' | 'maxPerDay'>;
export interface SuggestionInput {
  title: string;
  why: string;
  source: { kind: SuggestionSourceKind; label: string; ref?: string };
  rule: SuggestionRule;
}
export interface Suggestion extends SuggestionInput { id: string }

const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
/** 去重 / 拒收键:大小写、空白、句末标点都不算差别。 */
export const suggestionKey = (title: string): string => oneLine(title).toLowerCase().replace(/[\s。.!！?？…]+$/u, '');

/** 校验模型给的一组(纯函数,单测钉)。逐条报错:一条坏了整组不收,免得用户看到缺一条、Muse 却以为都放上了。
 *  rule 走 manage_automation 同一个校验(validateTriggerInput);草稿里不许 tool_call(那要用户在画布里自己选工具)。 */
export function validateSuggestions(raw: unknown, opts: { vaultPath?: string; cwd?: string } = {}): { suggestions: SuggestionInput[] } | { error: string } {
  const vaultPath = opts.vaultPath ?? amadeusVaultPath();
  if (!Array.isArray(raw)) return { error: 'suggestions must be an array (pass [] to clear)' };
  if (raw.length > MAX_SUGGESTIONS) return { error: `at most ${MAX_SUGGESTIONS} suggestions` };
  const out: SuggestionInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as any;
    const at = `suggestion ${i + 1}`;
    const title = oneLine(r?.title);
    const why = oneLine(r?.why);
    const kind = oneLine(r?.source?.kind) as SuggestionSourceKind;
    const label = oneLine(r?.source?.label).slice(0, 80);
    let ref = oneLine(r?.source?.ref) || undefined;
    if (!title) return { error: `${at}: title is required` };
    if (title.length > MAX_TITLE) return { error: `${at}: title is longer than ${MAX_TITLE} characters — name the task in a few words` };
    if (!why) return { error: `${at}: why is required (what you saw that makes this worth automating)` };
    if (why.length > MAX_WHY) return { error: `${at}: why is longer than ${MAX_WHY} characters — one sentence` };
    if (!(SUGGESTION_SOURCE_KINDS as readonly string[]).includes(kind)) return { error: `${at}: source.kind must be one of ${SUGGESTION_SOURCE_KINDS.join(', ')}` };
    if (!label) return { error: `${at}: source.label is required (the name of the note, event, database… shown as a link)` };
    if (kind === 'note' || kind === 'database') {
      const abs = resolveNoteRef(ref || '', vaultPath);
      if (!abs) return { error: `${at}: ${kind} "${ref || ''}" does not exist — pass the path of a file you actually read (absolute, or relative to the notes vault)` };
      ref = abs;
    }
    const ruleIn = (r?.rule && typeof r.rule === 'object' ? r.rule : null) as TriggerInput | null;
    if (!ruleIn) return { error: `${at}: rule is required (the same fields as manage_automation set)` };
    // 画布只认动作链:旧式 agent_slug / agent 会在草稿里变成「叫醒 Muse」,改用 actions 里的 agent_run 步骤
    if ((ruleIn as any).agent_slug || (ruleIn as any).agent) return { error: `${at}: rule: use an agent_run step in actions instead of agent_slug` };
    const v = validateTriggerInput({ ...ruleIn, desc: oneLine(ruleIn.desc) || title }, { allowToolCall: false, vaultPath, cwd: opts.cwd });
    if (!v.ok) return { error: `${at}: rule: ${v.error}` };
    const { desc, cond, prompt, cooldownHours, actions, only, maxPerDay } = v.value;
    const key = suggestionKey(title);
    if (seen.has(key)) return { error: `${at}: duplicate of an earlier suggestion` };
    seen.add(key);
    out.push({
      title, why, source: { kind, label, ...(ref ? { ref: ref.slice(0, 1000) } : {}) },
      rule: { desc, cond, cooldownHours, ...(prompt ? { prompt } : {}), ...(actions ? { actions } : {}), ...(only ? { only } : {}), ...(maxPerDay ? { maxPerDay } : {}) },
    });
  }
  return { suggestions: out };
}

const cutoff = (days: number): string => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
const parseRule = (s: unknown): SuggestionRule | null => { try { const r = JSON.parse(String(s)); return r && typeof r === 'object' && r.cond ? r : null; } catch { return null; } };
const rowToSuggestion = (r: any): Suggestion | null => {
  const rule = parseRule(r.rule_json);
  if (!rule) return null; // 读不出来的那条当不存在,不画一条点了打不开的
  return { id: r.id, title: r.title, why: r.why, source: { kind: r.source_kind, label: r.source_label, ...(r.source_ref ? { ref: r.source_ref } : {}) }, rule };
};

export async function listActiveSuggestions(userId: string): Promise<Suggestion[]> {
  const rows = await query<any[]>(
    `SELECT id, title, why, source_kind, source_label, source_ref, rule_json FROM muse_automation_suggestions WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return (rows || []).map(rowToSuggestion).filter((s): s is Suggestion => !!s);
}

/** 30 天内被 × 掉的标题。拒收用全量;简报只列最近的几条。 */
async function recentlyDismissed(userId: string): Promise<string[]> {
  const rows = await query<any[]>(
    `SELECT title FROM muse_automation_suggestions WHERE user_id = ? AND status = 'dismissed' AND updated_at >= ? ORDER BY updated_at DESC`,
    [userId, cutoff(DISMISS_DAYS)],
  );
  return (rows || []).map((r) => String(r.title));
}

/** 整组替换。返回实际放上去的、和因为用户刚 × 过而没收的。 */
export async function setSuggestions(userId: string, next: SuggestionInput[]): Promise<{ shown: Suggestion[]; refused: string[] }> {
  const active = await listActiveSuggestions(userId);
  const dismissed = new Set((await recentlyDismissed(userId)).map(suggestionKey));
  const same = (a: SuggestionInput, b: SuggestionInput): boolean =>
    a.title === b.title && a.why === b.why && JSON.stringify(a.rule) === JSON.stringify(b.rule) &&
    a.source.kind === b.source.kind && a.source.label === b.source.label && (a.source.ref || '') === (b.source.ref || '');
  const keep = new Set<string>();
  const refused: string[] = [];
  const toInsert: SuggestionInput[] = [];
  for (const s of next) {
    const old = active.find((a) => !keep.has(a.id) && same(a, s));
    if (old) { keep.add(old.id); continue; }
    if (dismissed.has(suggestionKey(s.title))) { refused.push(s.title); continue; }
    toInsert.push(s);
  }
  for (const a of active) {
    // 只顶掉仍是 active 的:读快照之后用户刚 × 掉 / 存成规则的那条不能被改回 replaced
    if (!keep.has(a.id)) await query(`UPDATE muse_automation_suggestions SET status = 'replaced', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'active'`, [a.id, userId]);
  }
  for (const s of toInsert) {
    await query(
      `INSERT INTO muse_automation_suggestions (id, user_id, title, why, source_kind, source_label, source_ref, rule_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [uuidv4(), userId, s.title, s.why, s.source.kind, s.source.label, s.source.ref ?? null, JSON.stringify(s.rule)],
    );
  }
  return { shown: await listActiveSuggestions(userId), refused };
}

/** 用户处理了一条(× / 存成了规则):认 active,也认刚被 Muse 换掉的 replaced(用户打开草稿后 Muse 换了一组,存下来照样算 used、× 照样拒收 30 天)。
 *  只算第一次决定(CAS,点两下只算一次)。返回那条的标题,没有 = 不存在或已处理。 */
export async function markSuggestion(userId: string, id: string, status: 'dismissed' | 'used'): Promise<string | null> {
  const rows = await query<any[]>(`SELECT title, status FROM muse_automation_suggestions WHERE id = ? AND user_id = ? AND status IN ('active', 'replaced')`, [id, userId]);
  const title = rows?.[0]?.title;
  if (!title) return null;
  const from = String(rows[0].status);
  await query(`UPDATE muse_automation_suggestions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = ?`, [status, id, userId, from]);
  const after = await query<any[]>(`SELECT status FROM muse_automation_suggestions WHERE id = ? AND user_id = ?`, [id, userId]);
  return after?.[0]?.status === status ? String(title) : null;
}

/** 周期简报里的那一段(纯函数,单测钉):正在显示的(让 Muse 决定留还是换)+ 最近被 × 掉的(别再提)。 */
export function buildSuggestionHint(active: Array<Pick<Suggestion, 'title' | 'source'>>, dismissed: string[]): string {
  const shown = active.length
    ? active.map((s) => `- ${s.title} (source: ${s.source.kind} "${s.source.label}")`).join('\n')
    : '- (none yet: when you notice something the user keeps doing by hand on a schedule or in reaction to an event, suggest it via set_automation_suggestions)';
  // 11-22 live:Muse 看到「每周一手动整理周报」后自己把这一次周报做了,却没提自动化。做一次不等于下周不用再做。
  const once = '\nIf you do such a chore for the user this time, still suggest the automation: doing it once does not stop it coming back next time.';
  const gone = dismissed.length ? `\nDismissed by the user recently (do not suggest these or anything similar): ${dismissed.slice(0, 15).join('; ')}` : '';
  return `\n\n[Automation suggestions currently shown on the Automation home page]\n${shown}${once}${gone}`;
}

export async function suggestionHint(userId: string): Promise<string> {
  try {
    return buildSuggestionHint(await listActiveSuggestions(userId), (await recentlyDismissed(userId)).slice(0, 15));
  } catch {
    return '';
  }
}
