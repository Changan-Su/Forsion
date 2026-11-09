/**
 * 画像分层(11-09 记忆分层第二步,方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09):第一期详情留在 human/SOUL.md 同一份文件里,
 * 一个详情主题 = 标题带 `<!--tg topic=<键>-->` 的那一节(格式见 contracts/memoryLayers.ts)。这里管:应用一次整理、整次撤销、钉住。
 * 画像就一份文件,一次整理 = 一次 humanStore 写入(版本比对 + 修改记录);整理记录(human-history/portrait-organize.json,只在本机)
 * 先记「正在写」再写画像,中途断了下次读的时候按画像实际的样子定:挪成了就记进历史,没挪成就丢掉这条记录。
 * 人写的、导入的只挪不改(原句一字不差,记号上写明谁写的);归档只收 Agent 写的。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import { atomicWriteMemoryFile, readMemoryFile, withMemoryDirectoryLock } from '../services/memoryRepository.js';
import { defaultTopicHeader, entryFromRaw, entryOfLine, headingOf, insertPortraitAt, insertPortraitEntry, joinPortrait, portraitAuthorAt, portraitResidentChars, removePortraitLine, splitPortrait, ORGANIZE_ACCEPT_RATIO, type LayerTopic } from '../contracts/memoryLayers.js';
import { normalizeMemoryFact, splitMark, stripMark, TOPIC_KEY, withMark, type EntryAuthor } from '../contracts/entryMark.js';
import { HumanError, readHuman, writeHuman } from './humanStore.js';
import { PORTRAIT_LIMIT, PORTRAIT_SCOPE, portraitEntryId } from './humanPortrait.js';

const STATE = 'portrait-organize.json';
const root = (): string => join(tanguHome(), 'human-history');
const bodyOf = (line: string): string => stripMark(line).trim();

export interface PortraitMove { identity: string; raw: string; to: string; by: EntryAuthor; heading: { title: string; level: number } | null }
export interface PortraitOrganizeRecord {
  id: string; at: number; moves: PortraitMove[]; topics: Array<{ key: string; title: string; about: string }>;
  before: { count: number; chars: number }; after?: { count: number; chars: number }; undoneAt?: number;
}
interface State { v: 1; pending: { record: PortraitOrganizeRecord; expectedVersion: string } | null; history: PortraitOrganizeRecord[] }
function readState(): State {
  const raw = readMemoryFile(root(), STATE);
  if (raw === null) return { v: 1, pending: null, history: [] };
  let s: any; try { s = JSON.parse(raw); } catch { s = null; }
  const ok = (r: any): boolean => r && typeof r.id === 'string' && Array.isArray(r.moves) && r.moves.every((m: any) => m && typeof m.identity === 'string' && typeof m.raw === 'string' && TOPIC_KEY.test(m.to));
  if (!s || s.v !== 1 || !Array.isArray(s.history) || !s.history.every(ok) || (s.pending !== null && !(s.pending && ok(s.pending.record)))) {
    throw new HumanError('PORTRAIT_ORGANIZE_INVALID', 'The portrait organize record is unreadable; nothing was changed.');
  }
  return s;
}
const writeState = (s: State): void => withMemoryDirectoryLock(root(), () => atomicWriteMemoryFile(root(), STATE, JSON.stringify(s)));

/** 画像里每一条在哪:常驻那段的行号(详情各节里的不算)。 */
function residentIndex(lines: string[]): Map<string, number> {
  const out = new Map<string, number>(); let topic: number | null = null;
  lines.forEach((l, i) => {
    const h = headingOf(l);
    if (h) { if (h.topic) topic = h.level; else if (topic !== null && h.level <= topic) topic = null; return; }
    if (topic !== null || !entryOfLine(l)) return;
    const id = normalizeMemoryFact(l); if (id && !out.has(id)) out.set(id, i);
  });
  return out;
}
const headingAbove = (lines: string[], i: number): { title: string; level: number } | null => {
  for (let j = i - 1; j >= 0; j--) { const h = headingOf(lines[j]); if (h) return { title: h.title, level: h.level }; }
  return null;
};
const sizeOf = (content: string): { count: number; chars: number } => ({ count: [...residentIndex(content.split('\n')).keys()].length, chars: portraitResidentChars(content) });

/** 上次整理写到一半断了:看画像实际的样子定 —— 每一条都已经在目标主题里 = 写成了(记进历史);否则 = 没写成(丢掉记录)。 */
export async function resumePortraitOrganize(): Promise<void> {
  const s = readState();
  if (!s.pending) return;
  const doc = await readHuman(PORTRAIT_SCOPE);
  const topics = splitPortrait(doc.content).topics;
  const landed = s.pending.record.moves.every((m) => topics.find((t) => t.key === m.to)?.entries.some((e) => e.id === m.identity));
  const record = { ...s.pending.record, ...(landed ? { after: sizeOf(doc.content) } : {}) };
  writeState({ v: 1, pending: null, history: landed ? [...s.history, record].slice(-20) : s.history });
}

/** 应用一次整理:moves 按身份指向常驻里的条目,to = 主题键;新主题带标题和说明。期间画像被改过(版本对不上)→ 不做。
 *  整理完常驻超过上限的七成 → 不采用(OrganizeRejected),画像原样不动。 */
export async function applyPortraitOrganize(input: { expectedVersion: string; moves: Array<{ identity: string; to: string }>; topics: Array<{ key: string; title: string; about: string }> }): Promise<PortraitOrganizeRecord> {
  await resumePortraitOrganize();
  const doc = await readHuman(PORTRAIT_SCOPE);
  if (doc.version !== input.expectedVersion) throw new HumanError('HUMAN_CONFLICT', 'The portrait changed while it was being organized; nothing was moved.');
  let content = doc.content;
  const moves: PortraitMove[] = [];
  for (const m of input.moves) {
    const lines = content.split('\n');
    const at = residentIndex(lines).get(m.identity);
    if (at === undefined) continue;
    const raw = entryOfLine(lines[at])!.content;
    if (splitMark(raw).meta.pin) continue; // 钉住的永远常驻
    moves.push({ identity: m.identity, raw, to: m.to, by: portraitAuthorAt(lines, at), heading: headingAbove(lines, at) });
    content = removePortraitLine(content, at);
  }
  if (!moves.length) throw new HumanError('PORTRAIT_ORGANIZE_EMPTY', 'Nothing to move.');
  const layers = splitPortrait(content);
  for (const m of moves) {
    let topic = layers.topics.find((t) => t.key === m.to);
    if (!topic) {
      const def = input.topics.find((t) => t.key === m.to);
      const fallback = defaultTopicHeader(m.to, m.raw);
      topic = { key: m.to, title: def?.title || fallback.title, about: def?.about || fallback.about, notes: [], entries: [] } as LayerTopic;
      layers.topics.push(topic);
    }
    if (!topic.entries.some((e) => e.id === m.identity)) topic.entries.push(entryFromRaw(`- ${withMark(bodyOf(m.raw), { ...splitMark(m.raw).meta, pin: false, by: m.by })}`));
  }
  const next = joinPortrait(layers);
  const after = sizeOf(next);
  if (after.chars > Math.floor(PORTRAIT_LIMIT * ORGANIZE_ACCEPT_RATIO)) throw new OrganizeRejected(`still ${after.chars} resident characters; ${Math.floor(PORTRAIT_LIMIT * ORGANIZE_ACCEPT_RATIO)} or fewer are needed`);
  // 硬闸:挪进去的原句一字不差
  const check = splitPortrait(next).topics;
  for (const m of moves) {
    const e = check.find((t) => t.key === m.to)?.entries.find((x) => x.id === m.identity);
    if (!e || e.text !== bodyOf(m.raw)) throw new OrganizeRejected('a moved entry did not land verbatim');
  }
  const record: PortraitOrganizeRecord = { id: randomUUID(), at: Date.now(), moves, topics: input.topics, before: sizeOf(doc.content), after };
  const s = readState();
  writeState({ ...s, pending: { record, expectedVersion: doc.version } });
  await writeHuman(PORTRAIT_SCOPE, { content: next, expectedVersion: doc.version, summary: `Organized: ${moves.length} entries moved into details`, evidence: '' }, 'agent', { kind: 'organize' });
  const latest = readState();
  writeState({ v: 1, pending: null, history: [...latest.history, record].slice(-20) });
  return record;
}
export class OrganizeRejected extends Error { code = 'ORGANIZE_REJECTED'; }

/** 整次撤销:还在目标主题里的挪回原来那一节(原句原样,连记号);已经回到常驻的只从主题里拿掉;被人删了的不复活。 */
export async function undoPortraitOrganize(id: string): Promise<PortraitOrganizeRecord> {
  await resumePortraitOrganize();
  const s = readState();
  const record = s.history.find((r) => r.id === id);
  if (!record) throw new HumanError('PORTRAIT_NOT_FOUND', 'That organize run is not in the record.');
  if (record.undoneAt) return record;
  const doc = await readHuman(PORTRAIT_SCOPE);
  let content = doc.content;
  for (const m of record.moves) {
    const lines = content.split('\n');
    let topic: { key: string; level: number } | null = null; let at = -1;
    for (let i = 0; i < lines.length; i++) {
      const h = headingOf(lines[i]);
      if (h) { if (h.topic) topic = { key: h.topic, level: h.level }; else if (topic && h.level <= topic.level) topic = null; continue; }
      if (topic?.key === m.to && entryOfLine(lines[i]) && normalizeMemoryFact(lines[i]) === m.identity) { at = i; break; }
    }
    if (at < 0) continue;
    content = removePortraitLine(content, at);
    if (!residentIndex(content.split('\n')).has(m.identity)) content = insertPortraitAt(content, m.raw, m.heading);
  }
  if (content !== doc.content) await writeHuman(PORTRAIT_SCOPE, { content, expectedVersion: doc.version, summary: 'Undo organize', evidence: '' }, 'user', { kind: 'organize' });
  const latest = readState();
  const done = { ...record, undoneAt: Date.now() };
  writeState({ ...latest, history: latest.history.map((r) => (r.id === id ? done : r)) });
  return done;
}
export async function portraitOrganizeHistory(): Promise<PortraitOrganizeRecord[]> {
  await resumePortraitOrganize();
  return readState().history.slice().reverse();
}

/** 钉住 / 取消(R8):常驻里的就地改记号;详情里的(只能钉)挪回常驻并钉上 —— Agent 写的回 Agent 那一节,其余放在开头那段。 */
export async function pinPortraitEntry(input: { id: string; pinned: boolean; expectedVersion: string }): Promise<void> {
  const doc = await readHuman(PORTRAIT_SCOPE);
  const given = input.expectedVersion;
  if (!(given === doc.version || (given.length >= 12 && doc.version.startsWith(given)))) throw new HumanError('HUMAN_CONFLICT', 'The portrait changed since it was read; reload it.');
  const lines = doc.content.split('\n');
  let topic: { key: string; level: number } | null = null; let at = -1; let inTopic = false;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (h) { if (h.topic) topic = { key: h.topic, level: h.level }; else if (topic && h.level <= topic.level) topic = null; continue; }
    const e = entryOfLine(lines[i]);
    if (e && portraitEntryId(e.content) === input.id) { at = i; inTopic = !!topic; break; }
  }
  if (at < 0) throw new HumanError('PORTRAIT_NOT_FOUND', 'There is no portrait entry with this id; reload it.');
  const e = entryOfLine(lines[at])!;
  const meta = splitMark(e.content).meta;
  let content: string;
  if (!inTopic) {
    const next = `${e.prefix}${withMark(e.content, { ...meta, pin: input.pinned })}`;
    if (next === lines[at]) return;
    lines[at] = next; content = lines.join('\n');
  } else {
    if (!input.pinned) return;
    const by = meta.by ?? portraitAuthorAt(lines, at);
    const line = withMark(bodyOf(e.content), { ...meta, pin: true, by });
    const removed = removePortraitLine(doc.content, at);
    content = by === 'agent' ? insertPortraitEntry(removed, line) : insertPortraitAt(removed, line, null);
  }
  await writeHuman(PORTRAIT_SCOPE, { content, expectedVersion: doc.version, summary: input.pinned ? 'Pinned a portrait entry' : 'Unpinned a portrait entry', evidence: '' }, 'user', { kind: 'user' });
}
