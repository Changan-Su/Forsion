/**
 * Muse 的开场建议(新对话页 Chat Box 下最多三行;10-25 用户选方案 A,docs/ToBeImproved/Muse预制提示词方案_2026-10-25)。
 *
 * 一条 = 用户照原样就能发出去的一句话 + 它从哪来(日程 / 笔记 / 待办 / 会话 / 网页 / Muse 自己)。
 * source.label 必须原样出现在句子里:桌面把句子里第一处 label 画成链接,点它打开那个东西。
 * set_chat_starters 整组替换:句子与来源都没变的那条保留原 id(桌面不闪、用户的 × 不白点);被顶掉的记 replaced。
 * 用户点 × = dismissed,30 天内同一句不许再提;点行并发出去 = used。两种都写进 Muse 的 LOG([feedback] 行,下周期 read_log 看得到)。
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';

export const STARTER_KINDS = ['calendar', 'note', 'todo', 'session', 'web', 'muse'] as const;
export type StarterKind = typeof STARTER_KINDS[number];
export const MAX_STARTERS = 3;
const MAX_TEXT = 200;
const DISMISS_DAYS = 30;

export interface StarterInput { text: string; source: { kind: StarterKind; label: string; ref?: string } }
export interface Starter extends StarterInput { id: string }

const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
/** 去重键:大小写、空白、句末标点都不算差别(「…起一份」和「…起一份。」是同一句)。 */
export const starterKey = (text: string): string => oneLine(text).toLowerCase().replace(/[\s。.!！?？…]+$/u, '');

/** 校验模型给的一组(纯函数,单测钉)。逐条报错:一条坏了整组不收,免得用户看到缺一条、Muse 却以为都放上了。 */
export function validateStarters(raw: unknown): { starters: StarterInput[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'starters must be an array (pass [] to clear)' };
  if (raw.length > MAX_STARTERS) return { error: `at most ${MAX_STARTERS} starters` };
  const out: StarterInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as any;
    const text = oneLine(r?.text);
    const kind = oneLine(r?.source?.kind) as StarterKind;
    const label = oneLine(r?.source?.label);
    const ref = oneLine(r?.source?.ref) || undefined;
    const at = `starter ${i + 1}`;
    if (!text) return { error: `${at}: text is required` };
    if (text.length > MAX_TEXT) return { error: `${at}: text is longer than ${MAX_TEXT} characters — one sentence the user would send` };
    if (!(STARTER_KINDS as readonly string[]).includes(kind)) return { error: `${at}: source.kind must be one of ${STARTER_KINDS.join(', ')}` };
    if (!label) return { error: `${at}: source.label is required` };
    if (!text.includes(label)) return { error: `${at}: source.label "${label}" must appear verbatim in the text` };
    if (kind === 'web' && !/^https?:\/\//i.test(ref || '')) return { error: `${at}: a web source needs ref = the http(s) URL` };
    if ((kind === 'note' || kind === 'session') && !ref) return { error: `${at}: a ${kind} source needs ref (${kind === 'note' ? 'the note path' : 'the session id'})` };
    const key = starterKey(text);
    if (seen.has(key)) return { error: `${at}: duplicate of an earlier starter` };
    seen.add(key);
    out.push({ text, source: { kind, label, ...(ref ? { ref: ref.slice(0, 1000) } : {}) } });
  }
  return { starters: out };
}

/** 笔记来源的路径落到磁盘上真有的那个文件(绝对路径照用,`~/` 展开,相对路径按笔记库算),返回绝对路径;没有 → null。
 *  10-25 live:模型会把笔记库缺省路径和文件名拼成一个不存在的路径(种子笔记其实在授权文件夹里)—— 存进去就是一个点了打不开的链接。 */
export function resolveNoteRef(ref: string, vault: string = amadeusVaultPath()): string | null {
  const raw = ref.trim().replace(/^~(?=[\\/])/, os.homedir());
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.join(vault, raw);
  try { return existsSync(abs) && statSync(abs).isFile() ? abs : null; } catch { return null; }
}

/** 逐条把笔记来源换成真实的绝对路径;有找不到的就整组不收(和 validateStarters 同一纪律)。 */
export function resolveNoteRefs(list: StarterInput[], vault?: string): { starters: StarterInput[] } | { error: string } {
  const out: StarterInput[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.source.kind !== 'note') { out.push(s); continue; }
    const abs = resolveNoteRef(s.source.ref || '', vault);
    if (!abs) return { error: `starter ${i + 1}: note "${s.source.ref}" does not exist — pass the path of a file you actually read (absolute, or relative to the notes vault)` };
    out.push({ ...s, source: { ...s.source, ref: abs } });
  }
  return { starters: out };
}

const cutoff = (days: number): string => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
const rowToStarter = (r: any): Starter => ({
  id: r.id,
  text: r.text,
  source: { kind: r.source_kind, label: r.source_label, ...(r.source_ref ? { ref: r.source_ref } : {}) },
});

export async function listActiveStarters(userId: string): Promise<Starter[]> {
  const rows = await query<any[]>(
    `SELECT id, text, source_kind, source_label, source_ref FROM muse_starters WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return (rows || []).map(rowToStarter);
}

async function recentlyDismissed(userId: string): Promise<string[]> {
  const rows = await query<any[]>(
    `SELECT text FROM muse_starters WHERE user_id = ? AND status = 'dismissed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 30`,
    [userId, cutoff(DISMISS_DAYS)],
  );
  return (rows || []).map((r) => String(r.text));
}

/** 整组替换。返回实际放上去的、和因为用户刚 × 过而没收的。 */
export async function setStarters(userId: string, next: StarterInput[]): Promise<{ shown: Starter[]; refused: string[] }> {
  const active = await listActiveStarters(userId);
  const dismissed = new Set((await recentlyDismissed(userId)).map(starterKey));
  const sameSource = (a: StarterInput, b: StarterInput): boolean =>
    a.source.kind === b.source.kind && a.source.label === b.source.label && (a.source.ref || '') === (b.source.ref || '');
  const keep = new Set<string>();
  const refused: string[] = [];
  const toInsert: StarterInput[] = [];
  for (const s of next) {
    const old = active.find((a) => !keep.has(a.id) && a.text === s.text && sameSource(a, s));
    if (old) { keep.add(old.id); continue; }
    if (dismissed.has(starterKey(s.text))) { refused.push(s.text); continue; }
    toInsert.push(s);
  }
  for (const a of active) {
    if (!keep.has(a.id)) await query(`UPDATE muse_starters SET status = 'replaced', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [a.id, userId]);
  }
  for (const s of toInsert) {
    await query(
      `INSERT INTO muse_starters (id, user_id, text, source_kind, source_label, source_ref, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [uuidv4(), userId, s.text, s.source.kind, s.source.label, s.source.ref ?? null],
    );
  }
  return { shown: await listActiveStarters(userId), refused };
}

/** 用户处理了一条(× / 点行发出去):只认 active 的那条(CAS,点两下只算一次)。返回那句话,没有 = 不存在或已处理。 */
export async function markStarter(userId: string, id: string, status: 'dismissed' | 'used'): Promise<string | null> {
  const rows = await query<any[]>(`SELECT text FROM muse_starters WHERE id = ? AND user_id = ? AND status = 'active'`, [id, userId]);
  const text = rows?.[0]?.text;
  if (!text) return null;
  await query(`UPDATE muse_starters SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'active'`, [status, id, userId]);
  return String(text);
}

/** 周期简报里的那一段(纯函数,单测钉):正在显示的(让 Muse 决定留还是换)+ 最近被 × 掉的(别再提)。 */
export function buildStarterHint(active: Array<Pick<Starter, 'text' | 'source'>>, dismissed: string[]): string {
  const shown = active.length
    ? active.map((s) => `- ${s.text} (source: ${s.source.kind} "${s.source.label}")`).join('\n')
    : '- (none yet)';
  const gone = dismissed.length ? `\nDismissed by the user recently (do not suggest these or anything similar): ${dismissed.slice(0, 15).join('; ')}` : '';
  return `\n\n[Chat starters currently shown on the new-chat page]\n${shown}${gone}`;
}

export async function starterHint(userId: string): Promise<string> {
  try {
    return buildStarterHint(await listActiveStarters(userId), await recentlyDismissed(userId));
  } catch {
    return '';
  }
}
