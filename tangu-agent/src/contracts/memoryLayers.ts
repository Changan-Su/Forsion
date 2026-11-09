/**
 * 记忆分层(11-09 第二步,方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09 第三节):常驻 + 详情 + 归档的文件格式、
 * 「每条在哪」的推导规则、按条合并。引擎(读写、整理、两套同步里的旧同步)和桌面宿主(新同步的合并入口)都引这一份;纯函数,不碰 node:*。
 *
 * 画像(human/SOUL.md)第一期详情留在同一份文件里:标题行带 `<!--tg topic=<键>-->` 的那一节是一个详情主题(到下一个同级或更高级标题为止),
 * 其余全是常驻(人写的段落、Agent 那一节、导入那几节照旧)。注入只取常驻 + 每个主题一行索引。
 * Agent 记忆:常驻 = MEMORY.md(一行一条,格式不变);详情 = agents/<slug>/Library/memory/<键>.md;归档 = 同目录 archive.md。
 *
 * 每条在哪不存本机元数据,从同步得到的内容推(R1):同一条(身份 = normalizeMemoryFact)出现在好几处时,
 *   钉住的常驻那条 > 详情主题(键按字典序最小的那个;两台同时挪进不同主题时就这么定)> 归档 > 常驻。
 * 所以没有基线的第一次同步按并集合,挪进详情的那条在常驻里的旧副本不算数(整理 / 合并时顺手清掉),不会被复活回常驻。
 * 不复用遗忘墓碑:墓碑会连证据一起滤掉,画像的墓碑还只在本机。
 */
import { ARCHIVE_TOPIC, normalizeMemoryFact, splitMark, stripMark, stripMarks, TOPIC_KEY, withMark, type EntryAuthor, type EntryMeta } from './entryMark.js';
import { mergeText3With } from './contentMerge.js';
import { unionLines } from './dbRowMerge.js';
import { clipWholeLines } from './promptClip.js';

export { ARCHIVE_TOPIC, TOPIC_KEY };
/** 常驻的上限(方案页第五节:分层以后这是「常驻」的上限,不是总量)。 */
export const PORTRAIT_RESIDENT_LIMIT = 2000;
export const AGENT_RESIDENT_LIMIT = 4000;
/** 整理完常驻不超过上限的这个比例才采用(同项目记忆压缩的门槛)。 */
export const ORGANIZE_ACCEPT_RATIO = 0.7;
/** Agent 记忆详情在 Agent 文件夹里的位置。 */
export const MEMORY_DETAIL_DIR = 'Library/memory';
/** 新开一个主题、模型没给标题(归档就是这样)时的标题和说明:跟着条目的语言走(落盘的东西不能只有中文,也不能只有英文)。 */
export function defaultTopicHeader(key: string, sample: string): { title: string; about: string } {
  const zh = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(stripMarks(sample));
  if (key === ARCHIVE_TOPIC) return zh ? { title: '归档', about: '过了日期的事，原句都在，不再自动想起' } : { title: 'Archive', about: 'Past events, kept word for word and no longer recalled' };
  return { title: key, about: '' };
}
export const isMemoryDetailPath = (rel: string): boolean => /^Library\/memory\/[a-z][a-z0-9-]{0,31}\.md$/.test(rel);

// ── 画像的节:Agent 那一节、导入那几节(第一步的写法,挪到这里给合并共用)──

export const PORTRAIT_SECTION_TITLES = { zh: '最近认识的', en: 'Recently learned' } as const;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
export const isAgentTitle = (t: string): boolean => t === PORTRAIT_SECTION_TITLES.zh || t.toLowerCase() === PORTRAIT_SECTION_TITLES.en.toLowerCase();
const IMPORT_TITLE = /^(?:从其他 AI 导入 · \d{2}-\d{2}|Imported from other AIs · [A-Z][a-z]+ \d{1,2})$/;
export const isImportTitle = (t: string): boolean => IMPORT_TITLE.test(t);
/** 引擎开的标题(Agent 那一节、导入那一节):不算人写的段落,空了随条目一起收掉。 */
export const isEngineTitle = (t: string): boolean => isAgentTitle(t) || isImportTitle(t);
/** 导入那一节的标题(画像和协作说明共用一种写法):语言跟审阅单的界面语言,日期 = 这次导入。 */
export function importSectionTitle(lang: 'zh' | 'en', at: number): string {
  const d = new Date(at);
  return lang === 'zh' ? `从其他 AI 导入 · ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : `Imported from other AIs · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

const ENTRY = /^(\s*(?:[-*+]|\d+[.)])\s+)(.+?)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const CONTINUATION = /^\s+\S/;
export const entryOfLine = (line: string): { prefix: string; content: string } | null => {
  const m = line.match(ENTRY);
  return m ? { prefix: m[1], content: m[2] } : null;
};
/** 一行条目的身份:列表符号(含「1.」这种编号)和行尾记号都去掉 —— 「- x」和「1. x」是同一条(Codex 评审 11-09)。 */
export const lineIdentity = (line: string): string => { const e = entryOfLine(line); return normalizeMemoryFact(e ? e.content : line); };
/** 标题行:级别、去掉记号的标题、记号里的主题键。 */
export function headingOf(line: string): { level: number; title: string; topic: string | null } | null {
  const h = line.match(HEADING);
  if (!h) return null;
  const { body, meta } = splitMark(h[2]);
  return { level: h[1].length, title: body.trim(), topic: meta.topic ?? null };
}
type Section = { start: number; end: number };
function sectionAt(lines: string[], start: number): Section {
  const level = headingOf(lines[start])!.level;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { const h = headingOf(lines[i]); if (h && h.level <= level) { end = i; break; } }
  return { start, end };
}
function namedSection(lines: string[], match: (title: string) => boolean): Section | null {
  // 详情主题里面的小标题不算常驻的节(Codex 评审 11-09:主题里写了个「### 最近认识的」,新条目不能插进详情里)
  let start = -1; let topic: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (!h) continue;
    if (h.topic) { topic = h.level; continue; }
    if (topic !== null && h.level > topic) continue;
    topic = null;
    if (match(h.title)) start = i;
  }
  return start < 0 ? null : sectionAt(lines, start);
}
export const agentSection = (lines: string[]): Section | null => namedSection(lines, isAgentTitle);
/** 条目第 i 行之后缩进的续行一直到哪一行(含)。 */
export function entryEnd(lines: string[], i: number, end = lines.length): number {
  let last = i;
  for (let j = i + 1; j < end; j++) {
    if (!lines[j].trim()) continue;
    if (CONTINUATION.test(lines[j]) && !entryOfLine(lines[j])) last = j; else break;
  }
  return last;
}
function insertInSection(lines: string[], sec: Section, line: string): string {
  // 只认这一节自己的条目(到第一个下级标题为止):一级标题那一节包着下面所有小节和详情主题,插到末尾会落进别的节里
  let own = sec.end;
  for (let i = sec.start + 1; i < sec.end; i++) if (headingOf(lines[i])) { own = i; break; }
  let last = -1;
  for (let i = sec.start + 1; i < own; i++) if (entryOfLine(lines[i])) last = i;
  if (last >= 0) { lines.splice(entryEnd(lines, last, own) + 1, 0, line); return lines.join('\n'); }
  const next = lines[sec.start + 1];
  lines.splice(sec.start + 1, 0, '', line, ...(next !== undefined && next.trim() ? [''] : []));
  return lines.join('\n');
}
/** 第一个详情主题标题的行号(没有 = 文末):新开的常驻节放在它前面,详情总在最后。 */
const firstTopicLine = (lines: string[]): number => { const i = lines.findIndex((l) => !!headingOf(l)?.topic); return i < 0 ? lines.length : i; };
function appendSection(content: string, heading: string, line: string): string {
  const lines = content.split('\n');
  const at = firstTopicLine(lines);
  if (at < lines.length) {
    let from = at; while (from > 0 && !lines[from - 1].trim()) from--;
    const before = lines.slice(0, from).join('\n').replace(/\s+$/, '');
    return `${before ? `${before}\n\n` : ''}${heading}\n\n${line}\n\n${lines.slice(at).join('\n')}`;
  }
  const body = content.replace(/\s+$/, '');
  return `${body ? `${body}\n\n` : ''}${heading}\n\n${line}\n`;
}
/** 缺省加在 Agent 那一节(没有就在详情之前开一节);section = 导入那一节的标题时加在那一节。fact 可以带记号。 */
export function insertPortraitEntry(content: string, fact: string, section?: string): string {
  const lines = content.split('\n');
  if (section) {
    const own = namedSection(lines, (t) => t === section);
    return own ? insertInSection(lines, own, `- ${fact}`) : appendSection(content, `## ${section}`, `- ${fact}`);
  }
  const sec = agentSection(lines);
  if (sec) return insertInSection(lines, sec, `- ${fact}`);
  return appendSection(content, `## ${CJK.test(stripMark(fact)) ? PORTRAIT_SECTION_TITLES.zh : PORTRAIT_SECTION_TITLES.en}`, `- ${fact}`);
}
function collapseIfEmpty(lines: string[], sec: Section | null): void {
  if (!sec) return;
  const body = lines.slice(sec.start + 1, sec.end).filter((l) => l.trim());
  // 详情主题:条目都没了,只剩开头那句说明 = 空(说明是给索引用的,没有条目就没有意义)
  const topicOnlyAbout = !!headingOf(lines[sec.start])?.topic && body.length === 1 && !entryOfLine(body[0]) && !headingOf(body[0]);
  if (body.length && !topicOnlyAbout) return;
  const last = sec.end === lines.length;
  let from = sec.start;
  if (last) while (from > 0 && !lines[from - 1].trim()) from--;
  lines.splice(from, sec.end - from);
  if (last && lines.length) lines.push('');
}
const headingAbove = (lines: string[], index: number): number => { for (let i = index - 1; i >= 0; i--) if (headingOf(lines[i])) return i; return -1; };
/** 删掉一行(连同续行);它所在的引擎节(Agent 那一节、导入那一节、详情主题)因此空了就连标题一起收掉。 */
export function removePortraitLine(content: string, index: number): string {
  const lines = content.split('\n');
  const h = headingAbove(lines, index);
  const head = h >= 0 ? headingOf(lines[h])! : null;
  const engine = !!head && (isImportTitle(head.title) || !!head.topic);
  lines.splice(index, entryEnd(lines, index) - index + 1);
  if (engine) collapseIfEmpty(lines, sectionAt(lines, h));
  collapseIfEmpty(lines, agentSection(lines));
  return lines.join('\n');
}
/** 第 index 行这一条是谁写的:记号说了算;没有记号按它所在的节(Agent 那一节 = agent、导入那几节 = import、其余 = 人)。 */
export function portraitAuthorAt(lines: string[], index: number): EntryAuthor {
  const by = splitMark(lines[index]).meta.by;
  if (by) return by;
  const h = headingAbove(lines, index);
  const head = h >= 0 ? headingOf(lines[h]) : null;
  if (head && !head.topic && isAgentTitle(head.title)) return 'agent';
  if (head && !head.topic && isImportTitle(head.title)) return `import`; // 反引号:见 entryMark 的 EntryAuthor
  return 'user';
}

// ── 详情主题 ──

export interface LayerEntry {
  /** 原样一行(含列表符号、记号;有续行时含续行)。 */
  raw: string;
  /** 身份(normalizeMemoryFact)。 */
  id: string;
  /** 给人 / 模型看的正文:去掉列表符号和记号。 */
  text: string;
  meta: EntryMeta;
}
export interface LayerTopic { key: string; title: string; about: string; notes: string[]; entries: LayerEntry[] }
export const entryFromRaw = (raw: string): LayerEntry => {
  const first = raw.split('\n')[0];
  const { body, meta } = splitMark(first);
  const e = entryOfLine(body);
  return { raw, id: normalizeMemoryFact(e ? e.content : body), text: (e ? e.content : body).trim(), meta };
};
/** 一节(或一个文件)标题下面的正文:第一段不是条目的文字 = 索引说明;条目一行一条(缩进续行跟着上一条);其余文字原样留在 notes。 */
function parseTopicBody(lines: string[]): { about: string; notes: string[]; entries: LayerEntry[] } {
  let about = ''; const notes: string[] = []; const entries: LayerEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (entryOfLine(line)) {
      const end = entryEnd(lines, i);
      entries.push(entryFromRaw(lines.slice(i, end + 1).filter((l) => l.trim()).map((l) => l.replace(/\s+$/, '')).join('\n')));
      i = end; continue;
    }
    if (!about && !entries.length && !headingOf(line)) about = line.trim(); else notes.push(line.replace(/\s+$/, ''));
  }
  return { about, notes, entries };
}
function topicBody(t: Pick<LayerTopic, 'about' | 'notes' | 'entries'>): string[] {
  return [...(t.about ? ['', t.about] : []), ...(t.notes.length ? ['', ...t.notes] : []), ...(t.entries.length ? ['', ...t.entries.map((e) => e.raw)] : [])];
}

/** Agent 记忆的详情文件 `Library/memory/<key>.md`:`# 标题`、一段说明、一行一条。 */
export function parseTopicFile(key: string, content: string): LayerTopic {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.trim());
  const head = at >= 0 ? headingOf(lines[at]) : null;
  const body = parseTopicBody(head ? lines.slice(at + 1) : lines);
  return { key, title: head?.title || key, ...body };
}
export function serializeTopicFile(t: LayerTopic): string {
  return `${[`# ${t.title || t.key}`, ...topicBody(t)].join('\n')}\n`;
}
const topicSection = (t: LayerTopic, level = 2): string => [withMark(`${'#'.repeat(level)} ${t.title || t.key}`, { topic: t.key }), ...topicBody(t)].join('\n');

/** 画像拆成常驻(原样文字,去掉详情各节)+ 详情主题。 */
export interface PortraitLayers { resident: string; topics: LayerTopic[] }
export function splitPortrait(content: string): PortraitLayers {
  const lines = content.split('\n');
  const keep: string[] = []; const topics: LayerTopic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (!h?.topic) { keep.push(lines[i]); continue; }
    const sec = sectionAt(lines, i);
    const body = parseTopicBody(lines.slice(i + 1, sec.end));
    const same = topics.find((t) => t.key === h.topic);
    if (same) { same.entries.push(...body.entries); same.notes.push(...(body.about ? [body.about] : []), ...body.notes); }
    else topics.push({ key: h.topic, title: h.title, ...body });
    i = sec.end - 1;
  }
  while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
  return { resident: keep.join('\n'), topics };
}
/** 拼回去:常驻原样,详情各节接在后面(归档最后)。 */
export function joinPortrait(l: PortraitLayers): string {
  const topics = [...l.topics.filter((t) => t.key !== ARCHIVE_TOPIC), ...l.topics.filter((t) => t.key === ARCHIVE_TOPIC)].filter((t) => t.entries.length || t.notes.length);
  const resident = l.resident.replace(/\s+$/, '');
  const parts = [...(resident ? [resident] : []), ...topics.map((t) => topicSection(t))];
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}
export const hasPortraitTopics = (content: string): boolean => content.split('\n').some((l) => !!headingOf(l)?.topic);

// ── 每条在哪:从内容推(R1)──

/** 同一条出现在好几处时谁算数:钉住的常驻 > 详情(键最小)> 归档 > 常驻。返回每个身份胜出的位置。 */
export type Place = { where: 'resident'; index: number; pinned: boolean } | { where: 'topic'; key: string; index: number };
export function winningPlace(places: Place[]): Place {
  const pinned = places.find((p) => p.where === 'resident' && p.pinned);
  if (pinned) return pinned;
  const topics = places.filter((p): p is Extract<Place, { where: 'topic' }> => p.where === 'topic');
  const live = topics.filter((p) => p.key !== ARCHIVE_TOPIC).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  if (live.length) return live[0];
  if (topics.length) return topics[0];
  return places[0];
}

/** 画像按推导规则收拾一遍:常驻里那份被详情 / 钉住的副本盖过的删掉,同一条在几个主题里的只留胜出的那个。
 *  常驻里两条没钉的同一句不动(那是人自己写了两遍)。什么都没删时原样返回(字节不变,同步不会来回推)。 */
export function settlePortrait(content: string): string {
  const layers = splitPortrait(content);
  if (!layers.topics.length && !/<!--[ \t]*tg/.test(content)) return content;
  const lines = layers.resident.split('\n');
  const places = new Map<string, Place[]>();
  const add = (id: string, p: Place): void => { if (!id) return; const l = places.get(id); if (l) l.push(p); else places.set(id, [p]); };
  for (let i = 0; i < lines.length; i++) if (entryOfLine(lines[i])) add(lineIdentity(lines[i]), { where: 'resident', index: i, pinned: !!splitMark(lines[i]).meta.pin });
  layers.topics.forEach((t) => t.entries.forEach((e, i) => add(e.id, { where: 'topic', key: t.key, index: i })));
  const dropResident = new Set<number>(); const dropTopic = new Map<string, Set<number>>();
  for (const list of places.values()) {
    if (list.length < 2) continue;
    const win = winningPlace(list);
    const anyPinned = list.some((p) => p.where === 'resident' && p.pinned);
    for (const p of list) {
      if (p === win) continue;
      if (p.where === 'resident') { if (win.where === 'topic' || anyPinned) dropResident.add(p.index); }
      else { let s = dropTopic.get(p.key); if (!s) dropTopic.set(p.key, s = new Set()); s.add(p.index); }
    }
  }
  if (!dropResident.size && !dropTopic.size) return content;
  let resident = layers.resident;
  for (const i of [...dropResident].sort((a, b) => b - a)) resident = removePortraitLine(resident, i);
  const topics = layers.topics.map((t) => ({ ...t, entries: t.entries.filter((_, i) => !dropTopic.get(t.key)?.has(i)) }));
  return joinPortrait({ resident, topics });
}

/** 常驻那段给模型看的样子(去掉详情各节、去掉记号)。引擎注入、桌面画线、导入算账、Agent 写入的预算都量它。 */
export const portraitResidentText = (content: string): string => stripMarks(splitPortrait(content).resident).trim();
export const portraitResidentChars = (content: string): number => portraitResidentText(content).length;
/** 一个主题的索引行(给模型):标题 · 几条 — 说明。 */
export const topicIndexLine = (t: Pick<LayerTopic, 'title' | 'about' | 'entries'>, where?: string): string =>
  `- ${t.title} · ${t.entries.length} ${t.entries.length === 1 ? 'entry' : 'entries'} — ${t.about}${where ? ` (${where})` : ''}`;

// ── 合并 ──

type Diff3 = Parameters<typeof mergeText3With>[3];
const keyOf = (c: string): string => normalizeMemoryFact(c);

/** 一组条目按身份三方合并:两边都留着的留,任一边删掉的删,任一边新加的加;同一条两边改了记号(钉住、作者),改了的那边赢,都改了取云端。
 *  base = null(第一次见面)→ 并集。顺序 = 本机的,云端新加的接在后面。 */
export function mergeEntryLists(ours: LayerEntry[], base: LayerEntry[] | null, theirs: LayerEntry[]): LayerEntry[] {
  const map = (l: LayerEntry[]): Map<string, LayerEntry> => { const m = new Map<string, LayerEntry>(); for (const e of l) if (!m.has(e.id)) m.set(e.id, e); return m; };
  const o = map(ours), t = map(theirs), b = base ? map(base) : null;
  const keep = (id: string): boolean => {
    const inO = o.has(id), inT = t.has(id);
    if (!b) return inO || inT;
    const inB = b.has(id);
    return inB ? inO && inT : inO || inT;
  };
  const pick = (id: string): LayerEntry => {
    const a = o.get(id), c = t.get(id);
    if (!a) return c!; if (!c) return a;
    const was = b?.get(id)?.raw;
    return was !== undefined && a.raw !== was && c.raw === was ? a : c;
  };
  const out: LayerEntry[] = []; const seen = new Set<string>();
  for (const e of [...ours, ...theirs]) { if (seen.has(e.id) || !keep(e.id)) continue; seen.add(e.id); out.push(pick(e.id)); }
  return out;
}
/** 主题的标题 / 说明 / 其余文字:本机改过(相对基线)用本机的,否则用云端的。 */
function mergeTopicHeader(o: LayerTopic | undefined, b: LayerTopic | undefined, t: LayerTopic | undefined): Pick<LayerTopic, 'title' | 'about' | 'notes'> {
  const fields = (x: LayerTopic | undefined) => x ? { title: x.title, about: x.about, notes: x.notes } : null;
  const of = fields(o), bf = fields(b), tf = fields(t);
  if (!tf) return of!;
  if (!of) return tf;
  return {
    title: bf && of.title !== bf.title ? of.title : tf.title,
    about: bf ? (of.about !== bf.about ? of.about : tf.about) : tf.about || of.about,
    notes: bf ? (JSON.stringify(of.notes) !== JSON.stringify(bf.notes) ? of.notes : tf.notes) : [...tf.notes, ...of.notes.filter((n) => !tf.notes.includes(n))],
  };
}
export function mergeTopics(ours: LayerTopic[], base: LayerTopic[] | null, theirs: LayerTopic[]): LayerTopic[] {
  const keys = [...new Set([...theirs.map((t) => t.key), ...ours.map((t) => t.key)])];
  const out: LayerTopic[] = [];
  for (const key of keys) {
    const o = ours.find((t) => t.key === key), t = theirs.find((x) => x.key === key), b = base?.find((x) => x.key === key);
    const entries = mergeEntryLists(o?.entries ?? [], base ? b?.entries ?? [] : null, t?.entries ?? []);
    if (!entries.length && !(o?.notes.length || t?.notes.length)) continue;
    out.push({ key, ...mergeTopicHeader(o, b, t), entries });
  }
  return out;
}
/** Agent 记忆详情文件两边都改了(或第一次见面):按条合(R9)。 */
export function mergeTopicFile(key: string, ours: string, base: string | null, theirs: string): { content: string; conflict: boolean } {
  const [m] = mergeTopics([parseTopicFile(key, ours)], base === null ? null : [parseTopicFile(key, base)], [parseTopicFile(key, theirs)]);
  const fallback = parseTopicFile(key, theirs);
  return { content: serializeTopicFile(m ?? { ...fallback, entries: [] }), conflict: false };
}

/** 画像常驻那段按条合(第一步的 mergePortrait,挪进契约给桌面宿主也用上):以云端那份为底,本机相对基线新增的条目插回它在本机所在的那一节、
 *  本机删掉的条目从结果里删掉;本机改了某条的记号或挪了它所在的节(而云端那条和基线一样)→ 照本机的放;其余文字取云端。
 *  本机还改了别的文字(人写的标题、段落;引擎开的标题不算)而云端那份里没有 → conflict: true,同步照旧把本机整份存成冲突副本。 */
export function mergePortrait(ours: string, base: string, theirs: string): { content: string; conflict: boolean } {
  type Pos = { raw: string; heading: { title: string; level: number } | null };
  const index = (t: string): Map<string, Pos> => {
    const m = new Map<string, Pos>(); let heading: Pos['heading'] = null;
    for (const line of t.split('\n')) {
      const h = headingOf(line);
      if (h) { heading = { title: h.title, level: h.level }; continue; }
      const e = entryOfLine(line); if (!e) continue;
      const k = keyOf(e.content); if (!m.has(k)) m.set(k, { raw: line.replace(/\s+$/, ''), heading });
    }
    return m;
  };
  const prose = (t: string): string => t.split('\n').filter((l) => { const h = headingOf(l); return l.trim() && !entryOfLine(l) && !(h && isEngineTitle(h.title)); }).map((l) => l.trim()).join('\n');
  const b = index(base), o = index(ours), t0 = index(theirs);
  const deleted = new Set([...b.keys()].filter((k) => !o.has(k)));
  // 本机改了这一条(记号变了,或挪了节)、云端那条还是基线的样子:先从云端那份里拿掉,下面按本机的样子插回去
  const sameHeading = (x: Pos['heading'], y: Pos['heading']): boolean => (x?.title ?? null) === (y?.title ?? null) && (x?.level ?? 0) === (y?.level ?? 0);
  const changed = new Set([...o.keys()].filter((k) => {
    const was = b.get(k), mine = o.get(k)!, there = t0.get(k);
    if (!was || !there) return false;
    const mineMoved = mine.raw !== was.raw || !sameHeading(mine.heading, was.heading);
    const theirsSame = there.raw === was.raw && sameHeading(there.heading, was.heading);
    return mineMoved && theirsSame;
  }));
  let out = theirs.split('\n').filter((l) => { const e = entryOfLine(l); return !(e && (deleted.has(keyOf(e.content)) || changed.has(keyOf(e.content)))); }).join('\n');
  const have = new Set([...index(out).keys()]);
  let heading: { title: string; level: number } | null = null;
  for (const line of ours.split('\n')) {
    const h = headingOf(line);
    if (h) { heading = { title: h.title, level: h.level }; continue; }
    const e = entryOfLine(line); if (!e) continue;
    const k = keyOf(e.content);
    if ((b.has(k) && !changed.has(k)) || have.has(k)) continue;
    out = insertLikeOurs(out, e.content, heading); have.add(k);
  }
  return { content: out, conflict: prose(ours) !== prose(base) && prose(ours) !== prose(theirs) };
}
/** 把一条插回某一节(标题 = null:所有标题之前那段;同名标题不在了就进 Agent 那一节)。撤销整理、钉回常驻用。 */
export const insertPortraitAt = (content: string, fact: string, heading: { title: string; level: number } | null): string => insertLikeOurs(content, fact, heading);
/** 本机新加的一条插回它原来那一节:同名标题还在就加在那一节末尾;所有标题之前的那段就加在那一段;
 *  导入那一节在云端那份里还没有就开出来;其余(人写的标题被另一台删了、Agent 那一节)照旧进 Agent 那一节。 */
function insertLikeOurs(out: string, fact: string, heading: { title: string; level: number } | null): string {
  const lines = out.split('\n');
  if (!heading) {
    let first = lines.findIndex((l) => !!headingOf(l)); if (first < 0) first = lines.length;
    let last = -1; for (let i = 0; i < first; i++) if (entryOfLine(lines[i])) last = i;
    if (last >= 0) { lines.splice(last + 1, 0, `- ${fact}`); return lines.join('\n'); }
    if (first > 0 && lines.slice(0, first).some((l) => l.trim())) { let end = first; while (end > 0 && !lines[end - 1].trim()) end--; lines.splice(end, 0, '', `- ${fact}`); return lines.join('\n'); }
    return `- ${fact}\n${out.trim() ? `\n${out.replace(/^\s+/, '')}` : ''}`;
  }
  if (isAgentTitle(heading.title)) return insertPortraitEntry(out, fact);
  const same = lines.filter((l) => { const h = headingOf(l); return !!h && !h.topic && h.level === heading.level && h.title === heading.title; }).length;
  if (same > 1) return insertPortraitEntry(out, fact);
  const sec = namedSection(lines, (t) => t === heading.title);
  if (sec) return insertInSection(lines, sec, `- ${fact}`);
  return isImportTitle(heading.title) ? appendSection(out, `${'#'.repeat(heading.level)} ${heading.title}`, `- ${fact}`) : insertPortraitEntry(out, fact);
}

/** 画像两边都改了(或第一次见面):有详情各节时常驻和详情分开合,合完按推导规则收拾一遍(R1、R9)。
 *  常驻:没有基线 → 按行并集;有基线 → 按行三方合并,合不拢再按条合(mergePortrait)。详情:按主题、按条合。 */
export function mergeLayeredPortrait(ours: string, base: string | null, theirs: string, diff3: Diff3): { content: string; conflict: boolean } {
  const o = splitPortrait(ours), t = splitPortrait(theirs), b = base === null ? null : splitPortrait(base);
  let resident: string; let conflict = false;
  if (!b) resident = !o.resident.trim() ? t.resident : !t.resident.trim() ? o.resident : unionLines(o.resident, t.resident);
  else {
    const text = mergeText3With(o.resident, b.resident, t.resident, diff3);
    if (text !== null) resident = text;
    else { const m = mergePortrait(o.resident, b.resident, t.resident); resident = m.content; conflict = m.conflict; }
  }
  let topics = mergeTopics(o.topics, b ? b.topics : null, t.topics);
  // 跨常驻 / 详情按身份认删除(Codex 评审 11-09):基线里有、某一边哪儿都没有了 = 那边删了;另一边只是把它挪了个地方,
  // 各段各自合并会把「挪过去的那份」当成新加的留下来 —— 删除优先。没有基线(第一次见面)认不出谁删的,照旧并集
  if (b) {
    const anywhere = (l: PortraitLayers): Set<string> => new Set([...l.resident.split('\n').filter((x) => entryOfLine(x)).map(lineIdentity), ...l.topics.flatMap((x) => x.entries.map((e) => e.id))]);
    const was = anywhere(b), mine = anywhere(o), there = anywhere(t);
    const gone = new Set([...was].filter((id) => !mine.has(id) || !there.has(id)));
    if (gone.size) {
      // 每删一条重新找(删一条可能连带收掉空了的节,行号会变)
      for (let at = 0; at >= 0;) {
        at = resident.split('\n').findIndex((x) => !!entryOfLine(x) && gone.has(lineIdentity(x)));
        if (at >= 0) resident = removePortraitLine(resident, at);
      }
      topics = topics.map((x) => ({ ...x, entries: x.entries.filter((e) => !gone.has(e.id)) }));
    }
  }
  return { content: settlePortrait(joinPortrait({ resident, topics })), conflict };
}

// ── 常驻的线 ──

/** 常驻按整条截:哪些条目在线内(给模型),哪些在线外(进召回池)。identity 列表顺序 = 文中顺序。 */
export function residentLine(text: string, limit: number): { kept: string; inside: Set<string>; outside: string[] } {
  const clip = clipWholeLines(text, limit);
  const inside = new Set<string>(); const outside: string[] = [];
  for (const line of clip.kept.split('\n')) if (entryOfLine(line)) inside.add(lineIdentity(line));
  for (const line of clip.rest.split('\n')) { const e = entryOfLine(line); if (e && !inside.has(lineIdentity(line))) outside.push(e.content.trim()); }
  return { kept: clip.kept, inside, outside };
}

/** 主题说明(索引行)过不过闸:单行、写明那份里有什么 —— 不能只是标题、键或文件名,至少 6 个字。 */
export function validTopicAbout(about: unknown, title: string, key: string): about is string {
  if (typeof about !== 'string') return false;
  const a = about.trim();
  if (!a || /[\r\n]/.test(a) || a.length < 6 || a.length > 240) return false;
  const low = a.toLowerCase().replace(/[\s.。:：·—-]+$/g, '');
  return ![title.toLowerCase(), key, `${key}.md`, `library/memory/${key}.md`].includes(low) && /[\p{L}\p{N}]/u.test(a);
}
export const validTopicTitle = (title: unknown): title is string => typeof title === 'string' && !!title.trim() && title.trim().length <= 40 && !/[\r\n#<>]/.test(title);
