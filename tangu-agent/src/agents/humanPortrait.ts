/** 画像 = human/SOUL.md(10-29 画像写入第 1 步):Agent 们对这个人的认识,每个 Agent 都读。
 *  归 humanStore 管(版本、修改记录、撤销);人可以随意改标题和段落。Agent 只按「条目」(列表项行)增删改:
 *  新增只进 Agent 自己那一节(「最近认识的」/ Recently learned,没有就在文末开一节),人写的标题和段落文字它不碰。
 *  删掉 / 改写掉的条目记进本机墓碑(human-history/portrait-tombstones.json,不上云:human/ 的云槽位只收固定几份):
 *  Dream 遇到同一句不再写回;显式 add 撤掉墓碑。
 *  方案页 docs/ToBeImproved/human文件夹写入方案_2026-10-29。 */
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
/** Agent 那一节的标题。两种都认(任意 #{1,6} 级);新开一节时按这句话的语言挑。 */
export const PORTRAIT_SECTION_TITLES = { zh: '最近认识的', en: 'Recently learned' } as const;
/** 什么算「关于这个人」:remember 的 person 档和搬家的挑选共用一句(五轮 live 调出来的,一句都别删)。 */
export const PERSON_IS = '"person" = about the user themself and their life, true with any agent and in any project (what to call them, language, background, what they are working on or learning now — a few weeks counts, their tastes and habits); every agent reads it, and so does the user: write it to them ("you …"), one fact per sentence, in their language. What they ask of you about the work itself (how to test, report or structure answers) is "agent", even when phrased as their preference; what to call them and their language stay "person". ';

const ENTRY = /^(\s*(?:[-*+]|\d+[.)])\s+)(.+?)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
// ponytail: 引擎拿不到界面语言,标题按这句话本身的书写系统挑(和 core/scriptCheck 的 cjk 一类同一个字符集);日文也落中文标题。
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const isAgentTitle = (t: string): boolean => t === PORTRAIT_SECTION_TITLES.zh || t.toLowerCase() === PORTRAIT_SECTION_TITLES.en.toLowerCase();

export interface PortraitEntry { id: string; content: string }
export interface PortraitView { version: string; entries: PortraitEntry[]; chars: number; limit: number }

/** 条目编号 = 规范化原文的哈希:同一句不管在第几行都是同一个号,换了说法就是另一条。 */
export const portraitEntryId = (content: string): string => `p${createHash('sha256').update(normalizeMemoryFact(content)).digest('hex').slice(0, 10)}`;
const entryOfLine = (line: string): { prefix: string; content: string } | null => {
  const m = line.match(ENTRY);
  return m ? { prefix: m[1], content: m[2] } : null;
};
/** 文档里的条目(同一句只算第一次出现)。 */
export function portraitEntries(content: string): PortraitEntry[] {
  const out: PortraitEntry[] = []; const seen = new Set<string>();
  for (const line of content.split('\n')) {
    const e = entryOfLine(line); if (!e) continue;
    const id = portraitEntryId(e.content);
    if (!seen.has(id)) { seen.add(id); out.push({ id, content: e.content }); }
  }
  return out;
}
/** Agent 那一节:最后一个叫「最近认识的 / Recently learned」的标题,到下一个同级或更高级标题为止。 */
function agentSection(lines: string[]): { start: number; end: number } | null {
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) { const h = lines[i].match(HEADING); if (h && isAgentTitle(h[2].trim())) { start = i; level = h[1].length; } }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { const h = lines[i].match(HEADING); if (h && h[1].length <= level) { end = i; break; } }
  return { start, end };
}
function sectionEntries(content: string): PortraitEntry[] {
  const lines = content.split('\n'); const sec = agentSection(lines);
  return sec ? portraitEntries(lines.slice(sec.start + 1, sec.end).join('\n')) : [];
}
/** 加在 Agent 那一节最后一个条目后面;那一节还没有条目就接在标题下;没有那一节就在文末开一节。 */
export function insertPortraitEntry(content: string, fact: string): string {
  const lines = content.split('\n'); const sec = agentSection(lines);
  if (sec) {
    let last = -1;
    for (let i = sec.start + 1; i < sec.end; i++) if (entryOfLine(lines[i])) last = i;
    if (last >= 0) { lines.splice(last + 1, 0, `- ${fact}`); return lines.join('\n'); }
    const next = lines[sec.start + 1];
    lines.splice(sec.start + 1, 0, '', `- ${fact}`, ...(next !== undefined && next.trim() ? [''] : []));
    return lines.join('\n');
  }
  const body = content.replace(/\s+$/, '');
  return `${body ? `${body}\n\n` : ''}## ${CJK.test(fact) ? PORTRAIT_SECTION_TITLES.zh : PORTRAIT_SECTION_TITLES.en}\n\n- ${fact}\n`;
}
/** 删掉一行;Agent 那一节因此空了就连标题一起收掉(那一节的标题是 Agent 开的,不是人写的)。 */
function removeLine(content: string, index: number): string {
  const lines = content.split('\n');
  lines.splice(index, 1);
  const sec = agentSection(lines);
  if (sec && lines.slice(sec.start + 1, sec.end).every((l) => !l.trim())) {
    const last = sec.end === lines.length;
    let from = sec.start;
    if (last) while (from > 0 && !lines[from - 1].trim()) from--;
    lines.splice(from, sec.end - from);
    if (last && lines.length) lines.push('');
  }
  return lines.join('\n');
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
  return { version: doc.version.slice(0, PORTRAIT_SHORT_VERSION), entries: portraitEntries(doc.content), chars: doc.content.length, limit: PORTRAIT_LIMIT };
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
    after = insertPortraitEntry(before, fact);
  } else {
    const lines = before.split('\n');
    const index = lines.findIndex((l) => { const e = entryOfLine(l); return !!e && portraitEntryId(e.content) === m.id; });
    if (index < 0) throw new HumanError('PORTRAIT_NOT_FOUND', 'There is no portrait entry with this id; list it again.');
    const line = entryOfLine(lines[index])!;
    removed = { id: m.id!, content: line.content };
    if (m.action === 'update') { lines[index] = `${line.prefix}${fact}`; after = lines.join('\n'); }
    else after = removeLine(before, index);
  }
  // 预算只拦 Agent「这次让全文变长」:改短、删掉永远放行;人自己写(含回执上撤销)不受它限制,超出的部分只是 Agent 看不到
  if (m.actor === 'agent' && after.length > PORTRAIT_LIMIT && after.length > before.length) throw new PortraitFullError(sectionEntries(before), before.length, doc.version);
  const summary = (m.action === 'forget' ? removed!.content : fact).slice(0, 240);
  const result = await writeHuman(PORTRAIT_SCOPE, { content: after, expectedVersion: doc.version, summary, evidence: '' }, m.actor, { ...m.source, action: m.action });
  const written = result.document.content;
  const now = portraitEntries(written);
  const entry = m.action === 'forget' ? undefined
    : now.find((e) => e.id === portraitEntryId(redactSecrets(fact))) ?? now.find((e) => !entries.some((x) => x.id === e.id));
  if (m.action !== 'add' && removed) {
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
  return { ...result, ...(entry ? { entry } : {}), ...(removed ? { removed } : {}) };
}

/** 撤回刚写的那一笔(跨档挪的第二步失败时):先按修改记录撤;撤不了(期间又有人改过)就只删掉那一条。返回撤成没有。 */
export async function revertPortraitWrite(written: PortraitResult, source: HumanChangeSource): Promise<boolean> {
  if (!written.change) return true;
  try {
    await writeHuman(PORTRAIT_SCOPE, { expectedVersion: written.document.version, undoId: written.change.id }, written.change.actor, source);
    return true;
  } catch { return false; } // 这期间画像又改过:留着新句子(两边都有,模型看得到),不按条目号删 —— 编号跟内容走,可能删到人后来重新加的同一句
}

/** 两台设备都改了画像、按行三方合并又合不拢(两台都往 Agent 那一节末尾各加了一条,几乎总是这样):
 *  以云端那份为底,本机相对基线新增的条目补进 Agent 那一节、本机删掉的条目从结果里删掉,其余文字取云端。
 *  本机还改了别的文字(标题、段落)而云端那份里没有 → conflict: true,同步照旧把本机整份存成冲突副本。 */
export function mergePortrait(ours: string, base: string, theirs: string): { content: string; conflict: boolean } {
  const key = (c: string): string => normalizeMemoryFact(c);
  const keys = (t: string): Set<string> => new Set(t.split('\n').map(entryOfLine).filter((e): e is NonNullable<typeof e> => !!e).map((e) => key(e.content)));
  const prose = (t: string): string => t.split('\n').filter((l) => { const h = l.match(HEADING); return l.trim() && !entryOfLine(l) && !(h && isAgentTitle(h[2].trim())); }).map((l) => l.trim()).join('\n');
  const b = keys(base), o = keys(ours);
  const deleted = new Set([...b].filter((k) => !o.has(k)));
  let out = theirs.split('\n').filter((l) => { const e = entryOfLine(l); return !(e && deleted.has(key(e.content))); }).join('\n');
  const have = keys(out);
  for (const e of portraitEntries(ours)) {
    const k = key(e.content);
    if (b.has(k) || have.has(k)) continue;
    out = insertPortraitEntry(out, e.content); have.add(k);
  }
  return { content: out, conflict: prose(ours) !== prose(base) && prose(ours) !== prose(theirs) };
}
