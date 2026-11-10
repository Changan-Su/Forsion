/** 画像 = human/SOUL.md(10-29 画像写入第 1 步):Agent 们对这个人的认识,每个 Agent 都读。
 *  归 humanStore 管(版本、修改记录、撤销);人可以随意改标题和段落。Agent 只按「条目」(列表项行)增删改:
 *  新增只进 Agent 自己那一节(「最近认识的」/ Recently learned,没有就在文末开一节),人写的标题和段落文字它不碰。
 *  删掉 / 改写掉的条目记进本机墓碑(human-history/portrait-tombstones.json,不上云:human/ 的云槽位只收固定几份):
 *  Dream 遇到同一句不再写回;显式 add 撤掉墓碑。
 *  方案页 docs/ToBeImproved/human文件夹写入方案_2026-10-29。
 *  11-09(记忆分层第一步):从其他 AI 导入的条目自己成一节「从其他 AI 导入 · MM-DD」,不混进 Agent 那一节;Agent 写满时只让它合并自己那一节。
 *  两台设备合并时,本机新加的条目插回它原来那一节。方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09。 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import { redactSecrets } from '../core/redact.js';
import { atomicWriteMemoryFile, memoryFactFingerprint, normalizeMemoryFact, readMemoryFile, withMemoryDirectoryLock } from '../services/memoryRepository.js';
import { HumanError, readHuman, writeHuman, type HumanChange, type HumanChangeSource, type HumanDocument, type HumanScope } from './humanStore.js';
import { ABOUT_HUMAN_LIMITS } from './humanFolder.js';

export const PORTRAIT_SCOPE: HumanScope = { kind: 'human', file: 'SOUL.md' };
/** 注入提示词时只取前这么多字(renderAboutHuman 同一个数):Agent 新增不许把全文推过它。 */
export const PORTRAIT_LIMIT = ABOUT_HUMAN_LIMITS['SOUL.md'];
/** 对外只给版本号前 12 位(同 manage_human 的 SHORT_VERSION):64 位十六进制模型偶尔抄漏。 */
export const PORTRAIT_SHORT_VERSION = 12;
/** 什么算「关于这个人」:remember 的 person 档和搬家的挑选共用一句(五轮 live 调出来的,一句都别删)。 */
export const PERSON_IS = '"person" = about the user themself and their life, true with any agent and in any project (what to call them, language, background, what they are working on or learning now — a few weeks counts, their tastes and habits); every agent reads it, and so does the user: write it to them ("you …"), one fact per sentence, in their language. What they ask of you about the work itself (how to test, report or structure answers) is "agent", even when phrased as their preference; what to call them and their language stay "person". ';
// 节、条目、合并这些纯函数在契约里(11-09 记忆分层:桌面宿主的新同步也要用同一份画像合并)
import { entryOfLine, entryEnd, agentSection, headingOf, insertPortraitEntry, removePortraitLine, portraitResidentChars, portraitResidentText, residentLine, PORTRAIT_SECTION_TITLES, importSectionTitle, isImportTitle, mergePortrait, ARCHIVE_TOPIC } from '../contracts/memoryLayers.js';
import { splitMark, stripMark, withMark, type EntryMeta } from '../contracts/entryMark.js';
export { PORTRAIT_SECTION_TITLES, importSectionTitle, isImportTitle, insertPortraitEntry, mergePortrait };

/** 画像里的一条。content 去掉了行尾记号;pinned = 钉住(永远常驻);topic = 在哪个详情主题里(archive = 归档),不在 = 常驻。 */
export interface PortraitEntry { id: string; content: string; pinned?: true; topic?: string }
export interface PortraitView { version: string; entries: PortraitEntry[]; chars: number; limit: number }

/** 条目编号 = 规范化原文的哈希(去掉记号):同一句不管在第几行、钉没钉都是同一个号,换了说法就是另一条。 */
export const portraitEntryId = (content: string): string => `p${createHash('sha256').update(normalizeMemoryFact(content)).digest('hex').slice(0, 10)}`;
/** 文档里的条目(同一句只算第一次出现),按文中顺序;详情主题里的带 topic。 */
export function portraitEntries(content: string): PortraitEntry[] {
  const out: PortraitEntry[] = []; const seen = new Set<string>();
  let topic: { key: string; level: number } | null = null;
  for (const line of content.split('\n')) {
    const h = headingOf(line);
    if (h) { if (h.topic) topic = { key: h.topic, level: h.level }; else if (topic && h.level <= topic.level) topic = null; continue; }
    const e = entryOfLine(line); if (!e) continue;
    const id = portraitEntryId(e.content);
    if (seen.has(id)) continue;
    seen.add(id);
    const { body, meta } = splitMark(e.content);
    out.push({ id, content: body.trim(), ...(meta.pin && !topic ? { pinned: true as const } : {}), ...(topic ? { topic: topic.key } : {}) });
  }
  return out;
}
function sectionEntries(content: string): PortraitEntry[] {
  const lines = content.split('\n'); const sec = agentSection(lines);
  return sec ? portraitEntries(lines.slice(sec.start + 1, sec.end).join('\n')) : [];
}
/** 这一句在画像里落在哪:inside = 常驻且在线内(每轮都带);outside = 常驻但在线外(只有召回才带);detail = 某个详情主题(召回 + 索引);archive;null = 没有。 */
export function portraitPlace(content: string, fact: string): 'inside' | 'outside' | 'detail' | 'archive' | null {
  const key = normalizeMemoryFact(fact);
  const hit = portraitEntries(content).find((e) => normalizeMemoryFact(e.content) === key);
  if (!hit) return null;
  if (hit.topic) return hit.topic === ARCHIVE_TOPIC ? 'archive' : 'detail';
  return residentLine(portraitResidentText(content), PORTRAIT_LIMIT).inside.has(key) ? 'inside' : 'outside';
}

// ── 墓碑:只在本机 ──
interface PortraitTombstone { fingerprint: string; content: string; forgottenAt: number }
const TOMBSTONES = 'portrait-tombstones.json';
const historyRoot = (): string => join(tanguHome(), 'human-history');
/** 读不懂 ≠ 没有:抛出去,调用方别据此当成「没忘过」往下写,更不能拿空列表写回去盖掉。 */
function readTombstones(): PortraitTombstone[] {
  const raw = readMemoryFile(historyRoot(), TOMBSTONES);
  if (raw === null) return [];
  let v: any;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || !Array.isArray(v.tombstones) || v.tombstones.some((t: any) => !t || typeof t.fingerprint !== 'string' || typeof t.content !== 'string' || !Number.isFinite(t.forgottenAt))) {
    throw new HumanError('PORTRAIT_TOMBSTONES_INVALID', 'The list of forgotten portrait entries is unreadable; nothing was written.');
  }
  return v.tombstones;
}
function updateTombstones(fn: (list: PortraitTombstone[]) => PortraitTombstone[]): void {
  withMemoryDirectoryLock(historyRoot(), () => {
    const list = readTombstones(); const next = fn(list);
    if (JSON.stringify(next) !== JSON.stringify(list)) atomicWriteMemoryFile(historyRoot(), TOMBSTONES, JSON.stringify({ schemaVersion: 1, tombstones: next.slice(-500) }));
  });
}
/** 文档已经改成了,墓碑记不上只影响「Dream 别写回」:记一笔日志,不让这次修改报失败。 */
function tombstoneBestEffort(fn: (list: PortraitTombstone[]) => PortraitTombstone[]): void {
  try { updateTombstones(fn); } catch (e) { console.warn('[portrait] tombstones not updated:', e instanceof Error ? e.message : e); }
}
export function isPortraitFactForgotten(fact: string): boolean {
  const fp = memoryFactFingerprint(fact);
  return readTombstones().some((t) => t.fingerprint === fp);
}

export async function readPortrait(): Promise<PortraitView> {
  const doc = await readHuman(PORTRAIT_SCOPE);
  return { version: doc.version.slice(0, PORTRAIT_SHORT_VERSION), entries: portraitEntries(doc.content), chars: portraitResidentChars(doc.content), limit: PORTRAIT_LIMIT };
}

/** 写满:错误里带 Agent 那一节的条目,让模型先合并那一节(update 变短 / forget 永远放行;人写的段落绝不替它压缩)。 */
export class PortraitFullError extends HumanError {
  constructor(public readonly section: PortraitEntry[], public readonly chars: number, public readonly version: string) {
    super('PORTRAIT_FULL', `The portrait would exceed the ${PORTRAIT_LIMIT} characters every agent reads (now ${chars}).`);
  }
}

export interface PortraitMutation {
  action: 'add' | 'update' | 'forget';
  fact?: string; id?: string;
  /** 前 12 位(对得上当前版本才换成完整版本)或完整版本;add 可以不带。 */
  expectedVersion?: string;
  actor: 'agent' | 'user';
  source: HumanChangeSource;
  /** Dream:这一句被忘过(墓碑)就不写。显式 add 反过来撤掉墓碑。 */
  skipForgotten?: boolean;
  /** 撤销一次导入:回到导入前,不算人删过,不记墓碑(否则再导入同一句会被标成「删过」默认不勾)。 */
  noTombstone?: boolean;
  /** add 写进哪一节(导入那一节的标题,见 importSectionTitle);不给 = Agent 那一节。 */
  section?: string;
  /** add 时盖在这一行上的记号(导入:by=import + 日期,跟着条目走,挪进详情、两台合并之后还认得出)。 */
  meta?: EntryMeta;
  /** 超了一律拒(即使配了后台整理):搬家这种「写完就删原件」的,写到线外 = 原来每轮都读的那句变成只在聊到时才读。拒的同时照样排一次整理,腾出地方再搬。 */
  strict?: boolean;
}
export interface PortraitResult {
  document: HumanDocument; change: HumanChange | null;
  entry?: PortraitEntry; removed?: PortraitEntry; duplicate?: boolean; forgotten?: boolean;
}
const cleanFact = (fact: unknown): string => typeof fact === 'string' ? fact.trim().replace(/\s*\n\s*/g, ' ').replace(/^[-*+]\s+/, '') : '';

export async function mutatePortrait(m: PortraitMutation): Promise<PortraitResult> {
  // 不带版本的 add(remember 的新增、Dream)没读过画像,别的 Agent 恰好同时记了一条就是一次比对冲突:重读再加,别把「你没读过的版本变了」报给模型
  for (let attempt = 0; ; attempt++) {
    try { return await mutateOnce(m); }
    catch (e) { if (m.action !== 'add' || m.expectedVersion !== undefined || attempt >= 2 || !(e instanceof HumanError && e.code === 'HUMAN_CONFLICT')) throw e; }
  }
}
async function mutateOnce(m: PortraitMutation): Promise<PortraitResult> {
  const doc = await readHuman(PORTRAIT_SCOPE);
  const given = m.expectedVersion;
  const expected = typeof given === 'string' && given.length === PORTRAIT_SHORT_VERSION && /^[a-f0-9]+$/.test(given) && doc.version.startsWith(given) ? doc.version : given;
  if (expected !== undefined && expected !== doc.version) throw new HumanError('HUMAN_CONFLICT', 'The portrait changed since it was read; list it again before changing it.');
  const before = doc.content;
  const fact = cleanFact(m.fact);
  if (m.action !== 'forget' && !fact) throw new HumanError('PORTRAIT_INVALID', 'fact is required.');
  const entries = portraitEntries(before);
  let after: string; let removed: PortraitEntry | undefined;
  if (m.action === 'add') {
    const dup = entries.find((e) => normalizeMemoryFact(e.content) === normalizeMemoryFact(fact));
    if (dup) return { document: doc, change: null, entry: dup, duplicate: true };
    if (m.skipForgotten && isPortraitFactForgotten(fact)) return { document: doc, change: null, forgotten: true };
    after = insertPortraitEntry(before, m.meta ? withMark(fact, m.meta) : fact, m.section);
  } else {
    const lines = before.split('\n');
    const index = lines.findIndex((l) => { const e = entryOfLine(l); return !!e && portraitEntryId(e.content) === m.id; });
    if (index < 0) throw new HumanError('PORTRAIT_NOT_FOUND', 'There is no portrait entry with this id; list it again.');
    const line = entryOfLine(lines[index])!;
    removed = { id: m.id!, content: stripMark(line.content).trim() };
    // 改写只换正文:记号(钉住、谁写的、从哪来)留在这一行上
    if (m.action === 'update') { lines[index] = `${line.prefix}${withMark(fact, splitMark(line.content).meta)}`; after = lines.join('\n'); }
    else after = removePortraitLine(before, index);
  }
  // 预算只拦 Agent「这次让常驻变长」:改短、删掉永远放行;人自己写(含回执上撤销)不受它限制,超出的部分只是 Agent 每轮看不到。
  // 11-09 分层:量的是常驻(详情各节不算);配了后台模型时照样写进去(前台写入永远成功),排一次后台整理,不再把整份条目甩给正在聊天的 Agent
  const over = m.actor === 'agent' && portraitResidentChars(after) > PORTRAIT_LIMIT && portraitResidentChars(after) > portraitResidentChars(before);
  if (over && (m.strict || !(await organizerReady()))) {
    if (m.strict) void import('../services/memoryOrganize.js').then((o) => o.scheduleOrganize({ kind: 'portrait' })).catch(() => {});
    throw new PortraitFullError(sectionEntries(before), portraitResidentChars(before), doc.version);
  }
  const summary = (m.action === 'forget' ? removed!.content : fact).slice(0, 240);
  const result = await writeHuman(PORTRAIT_SCOPE, { content: after, expectedVersion: doc.version, summary, evidence: '' }, m.actor, { ...m.source, action: m.action });
  const written = result.document.content;
  const now = portraitEntries(written);
  const entry = m.action === 'forget' ? undefined
    : now.find((e) => e.id === portraitEntryId(redactSecrets(fact))) ?? now.find((e) => !entries.some((x) => x.id === e.id));
  if (m.action !== 'add' && removed && !m.noTombstone) {
    const gone = removed.content;
    // 改写 / 删掉的原句记墓碑(同记忆:update 也挡住旧说法被自动写回);新句子要是被忘过,显式写入撤掉它
    if (!now.some((e) => normalizeMemoryFact(e.content) === normalizeMemoryFact(gone))) {
      tombstoneBestEffort((list) => [...list.filter((t) => t.fingerprint !== memoryFactFingerprint(gone)), { fingerprint: memoryFactFingerprint(gone), content: gone, forgottenAt: Date.now() }]);
    }
  }
  if (m.action !== 'forget' && !m.skipForgotten) {
    const fp = memoryFactFingerprint(fact);
    tombstoneBestEffort((list) => list.filter((t) => t.fingerprint !== fp));
  }
  if (over) void import('../services/memoryOrganize.js').then((o) => o.scheduleOrganize({ kind: 'portrait' })).catch(() => {});
  return { ...result, ...(entry ? { entry } : {}), ...(removed ? { removed } : {}) };
}
/** 有没有后台整理可排(配了后台模型):有就让前台写入照样成功;没有(或判不出来)= 第一步的行为。 */
export async function organizerReady(): Promise<boolean> {
  try { return await (await import('../services/memoryOrganize.js')).organizeAvailable(); } catch { return false; }
}

/** 导入迁移(11-09):Agent 那一节里这些条目挪进各自的一节(按 moves 的顺序;只认 Agent 那一节里的,别处同一句不碰)。 */
export function moveEntriesToSections(content: string, moves: Array<{ content: string; section: string }>): { content: string; moved: number; sections: string[] } {
  let out = content; let moved = 0; const sections: string[] = [];
  for (const m of moves) {
    const lines = out.split('\n'); const sec = agentSection(lines);
    if (!sec) break;
    let index = -1;
    for (let i = sec.start + 1; i < sec.end; i++) { const e = entryOfLine(lines[i]); if (e && normalizeMemoryFact(e.content) === normalizeMemoryFact(m.content)) { index = i; break; } }
    if (index < 0) continue;
    if (entryEnd(lines, index, sec.end) !== index) continue; // 人后来补了续行(限定条件之类):只搬首行会拆散这一条,留在原处
    const line = entryOfLine(lines[index])!.content;
    // 挪进导入那一节的同时在这一行上记下「导入的」(11-09 第二步):两台合并把它放回 Agent 那一节时也还认得出
    out = insertPortraitEntry(removePortraitLine(out, index), withMark(line, { ...splitMark(line).meta, by: 'import' }), m.section);
    moved++; sections.push(m.section);
  }
  return { content: out, moved, sections };
}

// ── Dream 因为画像满了、退回各 Agent 记忆的条目(11-09):只在本机,画像页提示一句、点开看是哪几条 ──
export interface PortraitOverflowItem { agent: string; fact: string; at: number }
const OVERFLOW = 'portrait-overflow.json';
/** 读不懂 ≠ 没有:抛出去,别拿空列表盖掉。 */
function readOverflowFile(): PortraitOverflowItem[] {
  const raw = readMemoryFile(historyRoot(), OVERFLOW);
  if (raw === null) return [];
  let v: any;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || !Array.isArray(v.items) || v.items.some((t: any) => !t || typeof t.agent !== 'string' || typeof t.fact !== 'string' || !Number.isFinite(t.at))) {
    throw new HumanError('PORTRAIT_OVERFLOW_INVALID', 'The list of entries that did not fit in the portrait is unreadable; nothing was changed.');
  }
  return v.items;
}
/** Dream 往画像加不进去(写满了),这一条照样记进那个 Agent 的记忆:记一笔给画像页看。记不上只影响提示,不让整理失败。 */
export function notePortraitOverflow(agent: string, facts: string[]): void {
  if (!facts.length) return;
  try {
    withMemoryDirectoryLock(historyRoot(), () => {
      const list = readOverflowFile();
      const next = [...list.filter((x) => !(x.agent === agent && facts.some((f) => memoryFactFingerprint(f) === memoryFactFingerprint(x.fact)))),
        ...facts.map((fact) => ({ agent, fact, at: Date.now() }))];
      atomicWriteMemoryFile(historyRoot(), OVERFLOW, JSON.stringify({ schemaVersion: 1, items: next.slice(-100) }));
    });
  } catch (e) { console.warn('[portrait] overflow not recorded:', e instanceof Error ? e.message : e); }
}
/** 画像页读:已经进了画像的(人挪进来了 / 整理后又写进去了)不再提。 */
export async function readPortraitOverflow(): Promise<PortraitOverflowItem[]> {
  const list = readOverflowFile();
  if (!list.length) return [];
  const have = new Set(portraitEntries((await readHuman(PORTRAIT_SCOPE)).content).map((e) => normalizeMemoryFact(e.content)));
  return list.filter((x) => !have.has(normalizeMemoryFact(x.fact)));
}
/** 人点了「知道了」:清掉。读不懂就报错,不拿空列表盖。 */
export function dismissPortraitOverflow(): void {
  withMemoryDirectoryLock(historyRoot(), () => {
    if (readOverflowFile().length) atomicWriteMemoryFile(historyRoot(), OVERFLOW, JSON.stringify({ schemaVersion: 1, items: [] }));
  });
}

/** 撤回刚写的那一笔(跨档挪的第二步失败时):先按修改记录撤;撤不了(期间又有人改过)就只删掉那一条。返回撤成没有。 */
export async function revertPortraitWrite(written: PortraitResult, source: HumanChangeSource): Promise<boolean> {
  if (!written.change) return true;
  try {
    await writeHuman(PORTRAIT_SCOPE, { expectedVersion: written.document.version, undoId: written.change.id }, written.change.actor, source);
    return true;
  } catch { return false; } // 这期间画像又改过:留着新句子(两边都有,模型看得到),不按条目号删 —— 编号跟内容走,可能删到人后来重新加的同一句
}
