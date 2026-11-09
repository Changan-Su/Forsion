/**
 * Agent 记忆分层(11-09 第二步,方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09 第三节):
 * 常驻 = MEMORY.md(记忆仓库照旧管版本、墓碑、撤销);详情 = Library/memory/<主题>.md;归档 = Library/memory/archive.md。
 * 详情和归档跟着 Library/** 上云,每条在哪靠内容推(contracts/memoryLayers.ts 的 winningPlace),不存本机元数据。
 *
 * 一次整理跨好几份文件,是一个事务(R3):先写好详情、读回来核对,最后才从常驻里拿掉;每一步之前先把操作记录落盘
 * (.memory-organize.json,点开头 = 只在本机),中途断了下次读的时候接着做;撤销按记录跨文件回滚(先放回常驻、再从详情里拿掉)。
 * 整个应用阶段在 Agent 目录锁里同步做完(同一把锁:记忆仓库、桌面新同步落 Library 文件都拿它),不跨 await。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteMemoryFile, createMemoryRepository, isMemoryTombstoneActive, memoryFactFingerprint, MemoryRepositoryError, readMemoryFile, safeMemoryPath, withMemoryDirectoryLock, type MemoryEntry } from './memoryRepository.js';
import { AGENT_RESIDENT_LIMIT, ARCHIVE_TOPIC, defaultTopicHeader, entryFromRaw, MEMORY_DETAIL_DIR, parseTopicFile, serializeTopicFile, winningPlace, type LayerEntry, type LayerTopic, type Place } from '../contracts/memoryLayers.js';
import { normalizeMemoryFact, splitMark, stripMark, TOPIC_KEY, withMark, type EntryAuthor } from '../contracts/entryMark.js';

const STATE = '.memory-organize.json';
const HISTORY_MAX = 20;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** 详情条目对外的号:d + 身份指纹前 16 位(常驻条目用记忆仓库的 id)。 */
export const detailEntryId = (identity: string): string => `d${sha(identity).slice(0, 16)}`;
const topicRel = (key: string): string => `${MEMORY_DETAIL_DIR}/${key}.md`;
const bodyOf = (line: string): string => stripMark(line).trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');

export interface ResidentItem { entry: MemoryEntry; identity: string; text: string; pinned: boolean; by: EntryAuthor; shadowed: boolean }
export interface DetailItem extends LayerEntry { topic: string; entryId: string; by: EntryAuthor }
export interface TopicView { key: string; title: string; about: string; path: string; entries: DetailItem[]; hash: string }
export interface AgentLayers {
  version: string;
  resident: ResidentItem[];
  /** 常驻(没被详情盖过的)给模型看的字数:去掉记号,一行一条。 */
  residentChars: number;
  limit: number;
  topics: TopicView[];
  archive: TopicView | null;
}

/** 常驻条目是谁写的:行尾记号说了算;没有就看本机来源(界面上手写的 = 人),其余算 Agent。 */
export function residentAuthor(e: MemoryEntry): EntryAuthor {
  return splitMark(e.content).meta.by ?? (e.source?.kind === 'manual' ? 'user' : 'agent');
}

/** Library/memory 下的主题键(按文件名);目录不存在 = 没有;不是真目录 / 读不了 → 抛(别当成空)。 */
export function listTopicKeys(base: string): string[] {
  const probe = safeMemoryPath(base, `${MEMORY_DETAIL_DIR}/.probe`);
  try { return readdirSync(dirname(probe)).filter((f) => /^[a-z][a-z0-9-]{0,31}\.md$/.test(f)).map((f) => f.slice(0, -3)).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
function readTopic(base: string, key: string): { topic: LayerTopic; raw: string } | null {
  const raw = readMemoryFile(base, topicRel(key));
  return raw === null ? null : { topic: parseTopicFile(key, raw), raw };
}

/** 读一个 Agent 的分层视图(不写盘,除非有没做完的整理要接着做)。忘掉的(墓碑)详情条目不算;同一条在好几处按推导规则只算一处。 */
export function readAgentLayers(base: string): AgentLayers {
  // 读的路上只在真有没做完的整理时才拿锁接着做;记录读不懂 / 锁被占着不挡读(下次写的时候再说)
  try { resumeAgentOrganize(base); } catch (e) { console.warn('[memory layers] organize resume skipped:', e instanceof Error ? e.message : e); }
  const snapshot = createMemoryRepository(base).snapshot();
  const forgotten = new Set(snapshot.tombstones.filter(isMemoryTombstoneActive).map((t) => t.fingerprint));
  const files = listTopicKeys(base).map((key) => ({ key, file: readTopic(base, key) })).filter((x): x is { key: string; file: { topic: LayerTopic; raw: string } } => !!x.file);
  const resident: ResidentItem[] = snapshot.entries.map((entry) => ({ entry, identity: normalizeMemoryFact(entry.content), text: bodyOf(entry.content), pinned: !!splitMark(entry.content).meta.pin, by: residentAuthor(entry), shadowed: false }));
  const places = new Map<string, Place[]>();
  const add = (id: string, p: Place): void => { if (!id) return; const l = places.get(id); if (l) l.push(p); else places.set(id, [p]); };
  resident.forEach((r, i) => add(r.identity, { where: 'resident', index: i, pinned: r.pinned }));
  const live = files.map(({ key, file }) => ({ key, file, entries: file.topic.entries.filter((e) => !forgotten.has(memoryFactFingerprint(e.raw.split('\n')[0]))) }));
  // 详情文件里还留着忘掉的(另一台忘的、墓碑同步过来了):顺手从文件里清掉 —— 索引里写着文件位置,整份读的时候不能再读到它(Codex 评审 11-09)
  if (live.some((t) => t.entries.length !== t.file.topic.entries.length)) scrubForgottenDetails(base, forgotten, live.filter((t) => t.entries.length !== t.file.topic.entries.length).map((t) => t.key));
  live.forEach((t) => t.entries.forEach((e, i) => add(e.id, { where: 'topic', key: t.key, index: i })));
  const dropTopic = new Set<string>();
  for (const list of places.values()) {
    if (list.length < 2) continue;
    const win = winningPlace(list);
    const anyPinned = list.some((p) => p.where === 'resident' && p.pinned);
    for (const p of list) {
      if (p === win) continue;
      // 常驻里同一句的另几份(详情 / 钉住的那份胜出,或者两台各带一份、一份带记号一份不带)都藏起来,只算一份(Codex 评审 11-09)
      if (p.where === 'resident') resident[p.index].shadowed = true;
      else dropTopic.add(`${p.key}\n${p.index}`);
    }
  }
  const view = (t: typeof live[number]): TopicView => ({
    key: t.key, title: t.file.topic.title, about: t.file.topic.about, path: topicRel(t.key), hash: sha(t.file.raw),
    entries: t.entries.filter((_, i) => !dropTopic.has(`${t.key}\n${i}`)).map((e) => ({ ...e, topic: t.key, entryId: detailEntryId(e.id), by: e.meta.by ?? 'agent' })),
  });
  const topics = live.filter((t) => t.key !== ARCHIVE_TOPIC).map(view).filter((t) => t.entries.length);
  const archive = live.find((t) => t.key === ARCHIVE_TOPIC);
  const visible = resident.filter((r) => !r.shadowed);
  return { version: snapshot.version, resident, residentChars: visible.map((r) => stripMark(r.entry.content).trim()).join('\n').length, limit: AGENT_RESIDENT_LIMIT, topics, archive: archive ? view(archive) : null };
}

/** 尽力而为:拿目录锁把忘掉的条目从这几份详情里拿掉(锁被占着、读写出错就下次再说,不挡读)。 */
function scrubForgottenDetails(base: string, forgotten: Set<string>, keys: string[]): void {
  try {
    withMemoryDirectoryLock(base, () => {
      for (const key of keys) {
        const cur = readTopic(base, key);
        if (!cur) continue;
        const entries = cur.topic.entries.filter((e) => !forgotten.has(memoryFactFingerprint(e.raw.split('\n')[0])));
        if (entries.length === cur.topic.entries.length) continue;
        if (!entries.length && !cur.topic.notes.length) unlinkSync(safeMemoryPath(base, topicRel(key)));
        else atomicWriteMemoryFile(base, topicRel(key), serializeTopicFile({ ...cur.topic, entries }));
      }
    });
  } catch (e) { console.warn('[memory layers] forgotten detail entries not scrubbed yet:', e instanceof Error ? e.message : e); }
}

// ── 整理的操作记录(只在本机)──

export interface OrganizeMove { identity: string; raw: string; to: string; by: EntryAuthor }
export interface OrganizeTopicDef { key: string; title: string; about: string }
export interface OrganizeRecord {
  id: string; at: number; moves: OrganizeMove[]; topics: OrganizeTopicDef[];
  /** 整理写完后各详情文件的内容哈希:撤销时拿来比,变过的照样只撤还在的那几条,并说出来。 */
  files: Record<string, string>;
  before: { count: number; chars: number }; after?: { count: number; chars: number };
  undoneAt?: number; undoChanged?: string[];
}
type Phase = 'writing' | 'committing' | 'restoring' | 'removing';
interface OrganizeState { v: 1; pending: { record: OrganizeRecord; phase: Phase } | null; history: OrganizeRecord[] }

/** 读不懂 ≠ 没有:抛出去,别据此当成「没有没做完的整理」往下写,更不能拿空的盖掉。 */
function readState(base: string): OrganizeState {
  const raw = readMemoryFile(base, STATE);
  if (raw === null) return { v: 1, pending: null, history: [] };
  let s: any;
  try { s = JSON.parse(raw); } catch { s = null; }
  const okRecord = (r: any): boolean => r && typeof r.id === 'string' && Array.isArray(r.moves) && r.moves.every((m: any) => m && typeof m.identity === 'string' && typeof m.raw === 'string' && typeof m.to === 'string' && TOPIC_KEY.test(m.to)) && Array.isArray(r.topics) && r.files && typeof r.files === 'object';
  if (!s || s.v !== 1 || !Array.isArray(s.history) || !s.history.every(okRecord) || (s.pending !== null && !(s.pending && okRecord(s.pending.record) && ['writing', 'committing', 'restoring', 'removing'].includes(s.pending.phase)))) {
    throw new MemoryRepositoryError('MEMORY_CORRUPT', 'The memory organize record is unreadable; nothing was changed.');
  }
  return s;
}
const writeState = (base: string, s: OrganizeState): void => atomicWriteMemoryFile(base, STATE, JSON.stringify(s));
/** 测试用:在事务的某一步之后「断电」(抛错),看下次能不能接着做。 */
let crashAfter: Phase | null = null;
export function crashOrganizeAfterForTests(phase: Phase | null): void { crashAfter = phase; }
const step = (phase: Phase): void => { if (crashAfter === phase) { crashAfter = null; throw new Error(`simulated crash after ${phase}`); } };

/** 整理写进详情的那一行(撤销时拿来比:之后被改过的 —— 加了续行、改了记号 —— 不往回挪,留在详情里并说出来)。 */
const writtenLine = (m: OrganizeMove): string => `- ${withMark(bodyOf(m.raw), { ...splitMark(m.raw).meta, pin: false, by: m.by })}`;
const unchangedSince = (base: string, m: OrganizeMove): boolean => readTopic(base, m.to)?.topic.entries.some((e) => e.id === m.identity && e.raw === writtenLine(m)) ?? false;
/** 第一步:把要挪的条目写进各详情文件(已经在那儿的不重复写),读回来核对每一条都在、原句一字不差。幂等。 */
function runWriting(base: string, r: OrganizeRecord): void {
  const byTopic = new Map<string, OrganizeMove[]>();
  for (const m of r.moves) { const l = byTopic.get(m.to); if (l) l.push(m); else byTopic.set(m.to, [m]); }
  for (const [key, moves] of byTopic) {
    const cur = readTopic(base, key);
    const def = r.topics.find((t) => t.key === key);
    const fallback = defaultTopicHeader(key, moves[0].raw);
    const topic: LayerTopic = cur?.topic ?? { key, title: def?.title || fallback.title, about: def?.about || fallback.about, notes: [], entries: [] };
    if (def?.about && !topic.about) topic.about = def.about;
    for (const m of moves) {
      if (topic.entries.some((e) => e.id === m.identity)) continue;
      topic.entries.push(entryFromRaw(writtenLine(m)));
    }
    const text = serializeTopicFile(topic);
    if (text !== cur?.raw) atomicWriteMemoryFile(base, topicRel(key), text);
    const back = readTopic(base, key);
    for (const m of moves) {
      const e = back?.topic.entries.find((x) => x.id === m.identity);
      if (!e || e.text !== bodyOf(m.raw)) throw new MemoryRepositoryError('MEMORY_ORGANIZE_VERIFY', `Moved entry did not reach ${topicRel(key)} verbatim; nothing was removed from resident memory.`);
    }
    r.files[key] = sha(back!.raw);
  }
}
/** 第二步:从常驻里拿掉已经在详情里的那几条(按身份;重读最新的一份再删,不重放旧版本)。 */
function runCommitting(base: string, r: OrganizeRecord): void {
  const repo = createMemoryRepository(base);
  const snap = repo.snapshot();
  const moved = new Set(r.moves.filter((m) => readTopic(base, m.to)?.topic.entries.some((e) => e.id === m.identity)).map((m) => m.identity));
  const lines = snap.content.split('\n');
  const keep = lines.filter((l) => !l.trim() || !moved.has(normalizeMemoryFact(l)) || splitMark(l).meta.pin);
  if (keep.length !== lines.length) repo.commit({ expectedVersion: snap.version, content: keep.join('\n'), source: { kind: 'dream' } });
  const after = createMemoryRepository(base).snapshot();
  r.after = { count: after.entries.length, chars: after.entries.map((e) => stripMark(e.content).trim()).join('\n').length };
}
/** 撤销第一步:还在详情里、整理之后没被改过的挪回常驻;已经在常驻里的不重复。
 *  人写的那条放回去时在行尾写明是人写的(重新提交的条目来源会变成「恢复」,不写就被当成 Agent 写的,下次可能被归档)。 */
function runRestoring(base: string, r: OrganizeRecord): void {
  const repo = createMemoryRepository(base);
  const snap = repo.snapshot();
  const have = new Set(snap.entries.map((e) => normalizeMemoryFact(e.content)));
  const back = r.moves.filter((m) => !have.has(m.identity) && unchangedSince(base, m));
  if (!back.length) return;
  const lineOf = (m: OrganizeMove): string => { const meta = splitMark(m.raw).meta; return m.by !== 'agent' && !meta.by ? withMark(m.raw, { ...meta, by: m.by }) : m.raw; };
  const content = `${snap.content.replace(/\n+$/, '')}${snap.content.trim() ? '\n' : ''}${back.map(lineOf).join('\n')}`;
  repo.commit({ expectedVersion: snap.version, content, source: { kind: 'restore' } });
}
/** 撤销第二步:常驻里已经有了的,从详情里拿掉;文件空了就删掉。每份比一下整理后的哈希,变过的记下来(照样只动这次挪的那几条)。 */
function runRemoving(base: string, r: OrganizeRecord): void {
  const resident = new Set(createMemoryRepository(base).snapshot().entries.map((e) => normalizeMemoryFact(e.content)));
  const changed: string[] = [];
  for (const key of [...new Set(r.moves.map((m) => m.to))]) {
    const cur = readTopic(base, key);
    if (!cur) continue;
    if (r.files[key] && sha(cur.raw) !== r.files[key]) changed.push(key);
    // 只拿掉整理时写进来、之后没改过、并且已经回到常驻的那几条;改过的留在详情里(上面记进 changed)
    const mine = r.moves.filter((m) => m.to === key && resident.has(m.identity));
    const entries = cur.topic.entries.filter((e) => !mine.some((m) => m.identity === e.id && e.raw === writtenLine(m)));
    if (entries.length === cur.topic.entries.length) continue;
    if (!entries.length && !cur.topic.notes.length) unlinkSync(safeMemoryPath(base, topicRel(key)));
    else atomicWriteMemoryFile(base, topicRel(key), serializeTopicFile({ ...cur.topic, entries }));
  }
  r.undoChanged = changed;
}
function finish(base: string, s: OrganizeState, r: OrganizeRecord, undo: boolean): OrganizeRecord {
  if (undo) r.undoneAt = Date.now();
  const history = undo ? s.history.map((h) => (h.id === r.id ? r : h)) : [...s.history, r].slice(-HISTORY_MAX);
  writeState(base, { v: 1, pending: null, history });
  return r;
}
function drive(base: string, s: OrganizeState, r: OrganizeRecord, from: Phase): OrganizeRecord {
  const undo = from === 'restoring' || from === 'removing';
  const order: Phase[] = undo ? ['restoring', 'removing'] : ['writing', 'committing'];
  for (const phase of order.slice(order.indexOf(from))) {
    writeState(base, { ...s, pending: { record: r, phase } });
    if (phase === 'writing') runWriting(base, r);
    else if (phase === 'committing') runCommitting(base, r);
    else if (phase === 'restoring') runRestoring(base, r);
    else runRemoving(base, r);
    step(phase);
  }
  return finish(base, readState(base), r, undo);
}

/** 上次整理 / 撤销中途断了:接着做完。没有没做完的就什么都不写。 */
export function resumeAgentOrganize(base: string): OrganizeRecord | null {
  if (!readState(base).pending) return null;
  return withMemoryDirectoryLock(base, () => {
    const s = readState(base);
    if (!s.pending) return null;
    return drive(base, s, s.pending.record, s.pending.phase);
  });
}

/** 应用一次整理(模型的方案已经过了闸):moves 里的是常驻里的原句。expectedVersion = 提方案时读到的常驻版本,期间被改过就不做。 */
export function applyAgentOrganize(base: string, input: { expectedVersion: string; moves: OrganizeMove[]; topics: OrganizeTopicDef[]; before: { count: number; chars: number } }): OrganizeRecord {
  return withMemoryDirectoryLock(base, () => {
    const s = readState(base);
    if (s.pending) drive(base, s, s.pending.record, s.pending.phase);
    if (createMemoryRepository(base).snapshot().version !== input.expectedVersion) throw new MemoryRepositoryError('MEMORY_VERSION_CONFLICT', 'Memory changed while it was being organized; nothing was moved.');
    const r: OrganizeRecord = { id: randomUUID(), at: Date.now(), moves: input.moves, topics: input.topics, files: {}, before: input.before };
    return drive(base, readState(base), r, 'writing');
  });
}
/** 整次撤销一次整理。 */
export function undoAgentOrganize(base: string, id: string): OrganizeRecord {
  return withMemoryDirectoryLock(base, () => {
    const s = readState(base);
    if (s.pending) drive(base, s, s.pending.record, s.pending.phase);
    const fresh = readState(base);
    const r = fresh.history.find((h) => h.id === id);
    if (!r) throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'That organize run is not in the record.');
    if (r.undoneAt) return r;
    return drive(base, fresh, structuredClone(r), 'restoring');
  });
}
export function agentOrganizeHistory(base: string): OrganizeRecord[] {
  return readState(base).history.slice().reverse();
}

/** 钉住 / 取消钉住(R8):常驻里的那条就地改记号;详情里的那条(只能钉)先写回常驻带上图钉,再从详情里拿掉。 */
export function pinAgentEntry(base: string, input: { id: string; pinned: boolean; expectedVersion?: string }): void {
  withMemoryDirectoryLock(base, () => {
    resumeAgentOrganize(base);
    const repo = createMemoryRepository(base);
    const snap = repo.snapshot();
    if (input.expectedVersion !== undefined && input.expectedVersion !== snap.version) throw new MemoryRepositoryError('MEMORY_VERSION_CONFLICT', 'Memory changed since it was read; reload and try again.');
    const resident = snap.entries.find((e) => e.id === input.id);
    if (resident) {
      const meta = splitMark(resident.content).meta;
      const by = residentAuthor(resident);
      const next = withMark(resident.content, { ...meta, pin: input.pinned, by });
      if (next === resident.content) return;
      const lines = snap.content.split('\n');
      const at = lines.findIndex((l) => l === resident.content);
      if (at < 0) throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'Memory entry was not found in this agent.');
      lines[at] = next;
      repo.commit({ expectedVersion: snap.version, content: lines.join('\n'), source: { kind: 'manual' } });
      return;
    }
    if (!input.pinned) return;
    for (const key of listTopicKeys(base)) {
      const cur = readTopic(base, key);
      const hit = cur?.topic.entries.find((e) => detailEntryId(e.id) === input.id);
      if (!cur || !hit) continue;
      // 常驻一行一条:带续行的那条钉回去会拆散它,不做(Codex 评审 11-09);人可以先在详情文件里把它并成一行
      if (hit.raw.includes('\n')) throw new MemoryRepositoryError('MEMORY_MULTILINE', 'This detail entry spans several lines; join it into one line in its topic file before pinning it.');
      const line = `- ${withMark(hit.text, { ...hit.meta, pin: true, by: hit.meta.by ?? 'agent' })}`;
      // 常驻里同一句没钉的旧副本(无基线并集带回来的)一起换成钉住的这一条
      const rest = snap.content.split('\n').filter((l) => !l.trim() || normalizeMemoryFact(l) !== hit.id).join('\n').replace(/\n+$/, '');
      repo.commit({ expectedVersion: snap.version, content: `${rest}${rest.trim() ? '\n' : ''}${line}`, source: { kind: 'manual' } });
      const entries = cur.topic.entries.filter((e) => e.id !== hit.id);
      if (!entries.length && !cur.topic.notes.length) unlinkSync(safeMemoryPath(base, topicRel(key)));
      else atomicWriteMemoryFile(base, topicRel(key), serializeTopicFile({ ...cur.topic, entries }));
      return;
    }
    throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'Memory entry was not found in this agent.');
  });
}
