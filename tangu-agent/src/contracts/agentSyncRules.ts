/**
 * Agent 文件(agents/<slug>/、human/)的同步规则,两套同步共用这一份(2026-11-05,方案页 Agent设备隔离方案 ⑤ 第 1、2 步):
 * 旧同步 = 引擎 services/agentFileSync.ts;新同步 = Forsion Extend 的 contentSync,两边都改了时经桌面宿主
 * electron/contentSyncHost.ts 的 mergeSyncContent 调到这里。
 * - 哪些路径上云:和服务端 tanguAgentFilePaths.isValidAgentFileAddress 同一张表;另外 Muse、Historian 临时目录、冲突副本只留本机。
 * - 两边都改了怎么合:记忆按事实行、墓碑并集、日志按块、.db 按行(Agent 日历 lastRun 取最晚)、第一次见面可合并的取并集、
 *   出厂 Agent 认指纹(用云端那份,不出副本)。
 * - 冲突副本叫什么:只生成一种名字;认得两套同步用过的两种名字。
 * - 哪些文件不出冲突副本:随账号走的设置文件(human/Settings/<name>.db),任何情况下都有确定的赢家(mergeSettingsDb / neverConflictCopy)。
 * 纯函数,不碰磁盘 / 网络 / node 内置模块:diff3 和画像合并由调用方注入(桌面主进程只引 contracts,不引引擎 services)。
 */
import { mergeDbFile, unionLines } from './dbRowMerge.js';
import { mergeText3With, splitLogBlocks, mergeBlocks, mergeLogHeaders } from './contentMerge.js';
import { LEGACY_PERSONAS, LEGACY_PERSONA_PROMPTS_ZH } from './legacyPersonas.js';
import { USER_MD_TEMPLATE, LEGACY_USER_MD_TEMPLATES } from './userMdTemplate.js';
import { normalizeMemoryFact } from './entryMark.js';
import { hasPortraitTopics, isMemoryDetailPath, mergeLayeredPortrait, mergePortrait, mergeTopicFile, settlePortrait } from './memoryLayers.js';

// ── 路径:哪些上云 ─────────────────────────────────────────────────────────────

/** Agent 文件夹根上上云的文件。和服务端 isValidAgentFileAddress 同一张表。 */
export const AGENT_SYNC_FILES = ['config.toml', 'SOUL.md', 'HARNESS.md', 'HUMAN.md', 'MEMORY.md', 'CALENDAR.db'] as const;
/** human/ 上云的文件(服务端 HUMAN_SLOT_FILES 去掉云端自用的 .layout)。 */
export const HUMAN_SYNC_FILES = ['HUMAN.md', 'AGENT.md', 'SOUL.md', 'MEMORY.md', 'CALENDAR.db'] as const;
/** 忘掉的事实(墓碑):点开头里唯一上云的一份。 */
export const MEMORY_TOMBSTONES = '.memory-tombstones.json';
export const MUSE_SLUG = 'muse';

export const isWidgetDataPath = (p: string): boolean => /^WidgetData\/[a-z0-9][a-z0-9_-]{0,63}\/data\.db$/.test(p);
/** 随账号走的设置文件(2026-11-10):human/Settings/<name>.db,可选族 `settings`(服务端声明了才同步,和 widget-data 同一套做法)。
 *  只在 human/ 下有;一行一项设置的 DbFile。按族写,不认具体哪一份(第一份是日历设置 calendar.db)。 */
export const isSettingsPath = (p: string): boolean => /^Settings\/[a-z0-9][a-z0-9-]{0,63}\.db$/.test(p);
/** 设置文件的大小上限(本机读写接口、同步推送同一个数)。 */
export const SETTINGS_MAX_BYTES = 256 * 1024;
export function validLogDate(date: unknown): date is string {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
export function validAgentSyncSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && !slug.startsWith('__');
}
/** Agent 文件夹里的相对路径能不能上云(服务端 isValidAgentFileAddress 的 Agent 那半)。不管副本、Muse,那些见 agentFileSyncable。 */
export function validAgentFilePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 1024 || /[\\\x00-\x1f:]/.test(p)) return false;
  if (p === MEMORY_TOMBSTONES) return true;
  const parts = p.split('/');
  if (parts.some((s) => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith(' '))) return false;
  if ((AGENT_SYNC_FILES as readonly string[]).includes(p) || isWidgetDataPath(p)) return true;
  if (p.startsWith('LOG/')) return parts.length === 2 && p.endsWith('.md') && validLogDate(parts[1].slice(0, -3));
  return parts.length > 1 && parts[0] === 'Library';
}
/** 只在本机、不进任何一套同步的 Agent 文件夹:Muse(11-05 用户定「暂不开放同步」,两台各跑各的)、
 *  Historian 复盘时建的临时目录 historian-<会话 id 前 12 位>(只有 MEMORY.md,传上去成了云端的「幽灵 Agent」)。 */
export function agentSlugLocalOnly(slug: string): boolean {
  return slug === MUSE_SLUG || /^historian-[a-z0-9]{1,12}$/.test(slug) || isStandInSlugShape(slug);
}
/** Agent 分身(11-09,方案「记忆分层与 Agent 分身」第三步):`<本体>-standin-<通道>[-<联系人哈希>]`,超长截断加哈希也留着 `-standin-`。
 *  分身文件夹装着别人在通道里说的话,只留本机、不进任何一套同步;这里是纯函数、读不到 config.toml,只能按形状认 ——
 *  新建普通 Agent 时引擎拒绝这种形状(agentRegistry.writeAgentLocked),形状就等于身份。 */
export function isStandInSlugShape(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*-standin-[a-z0-9]/.test(slug);
}

const CONFLICT_STAMP = /\(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)/;
const CONFLICT_DEVICE = /\(conflict [A-Za-z0-9_-]{1,64} \d{10,}\)/;
/** 是不是冲突副本:旧同步的 `x (conflict 2026-11-04 0150).md`(含撞名时的 `.2` 尾巴)、
 *  新同步以前的 `x (conflict 28991363 1793741084626).md`,以及现在统一的写法。只看最后一段文件名。 */
export function isConflictCopyPath(p: string): boolean {
  const name = p.slice(p.lastIndexOf('/') + 1);
  return CONFLICT_STAMP.test(name) || CONFLICT_DEVICE.test(name);
}
/** 冲突副本名(两套同步、human/ 镜像、日程改名共用一种):`notes (conflict 2026-07-19 1532).md`;
 *  同一分钟撞名时 n ≥ 2:`notes (conflict 2026-07-19 1532 2).md`(扩展名留在最后,打得开)。本地时间。 */
export function conflictCopyName(relPath: string, now: Date, n = 1): string {
  const slash = relPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relPath.slice(0, slash + 1);
  const base = slash < 0 ? relPath : relPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const p = (v: number): string => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${n > 1 ? ` ${n}` : ''}`;
  return `${dir}${stem} (conflict ${stamp})${ext}`;
}

/** 内容同步的路径(`agents/<slug>/<相对路径>`、`human/<相对路径>`)拆开;别的区域返回 null。 */
export function parseAgentContentPath(path: string): { area: 'agents' | 'human'; slug: string | null; rel: string } | null {
  if (path === 'agents' || path === 'human') return { area: path, slug: null, rel: '' };
  if (path.startsWith('human/')) return { area: 'human', slug: null, rel: path.slice(6) };
  if (!path.startsWith('agents/')) return null;
  const rest = path.slice(7), slash = rest.indexOf('/');
  return slash < 0 ? { area: 'agents', slug: rest, rel: '' } : { area: 'agents', slug: rest.slice(0, slash), rel: rest.slice(slash + 1) };
}
/**
 * 新同步在 agents/、human/ 下的边界:true = 上云;false = 只留本机(不上传、不下载、不删);null = 不归这里管(Amadeus/、Plugins/…)。
 * 文件 = 服务端白名单,去掉 Muse / Historian 临时目录 / 冲突副本。文件夹 = 装得下白名单文件的那几层(agents、agents/<slug>、
 * Library/**、LOG、WidgetData/<id>;human、human/WidgetData/<id>、human/Settings),其余文件夹不在云端建、也不从云端建到本机
 * —— 尤其 agents/muse:另一台凭空多出一个空的 muse 文件夹,就不再播种 Muse 了。
 */
export function agentContentSyncable(path: string, kind: 'file' | 'folder' = 'file'): boolean | null {
  const at = parseAgentContentPath(path);
  if (!at) return null;
  if (isConflictCopyPath(path)) return false;
  const { area, slug, rel } = at;
  if (area === 'human') {
    if (kind === 'folder') return rel === '' || rel === 'WidgetData' || /^WidgetData\/[a-z0-9][a-z0-9_-]{0,63}$/.test(rel) || rel === 'Settings';
    return (HUMAN_SYNC_FILES as readonly string[]).includes(rel) || isWidgetDataPath(rel) || isSettingsPath(rel);
  }
  if (slug === null) return kind === 'folder';
  if (!validAgentSyncSlug(slug) || agentSlugLocalOnly(slug)) return false;
  if (kind === 'file') return validAgentFilePath(rel);
  if (rel === '' || rel === 'LOG' || rel === 'WidgetData' || /^WidgetData\/[a-z0-9][a-z0-9_-]{0,63}$/.test(rel)) return true;
  const parts = rel.split('/');
  return parts[0] === 'Library' && parts.every((s) => s && !s.startsWith('.') && !s.endsWith('.') && !s.endsWith(' '));
}

// ── 合并:两边都改了 ─────────────────────────────────────────────────────────

export type Diff3 = (a: string[], b: string[], c: string[], options: { excludeFalseConflicts: boolean }) => Array<{ ok?: string[]; conflict?: unknown }>;
export interface AgentMergeResult { content: string; conflict: boolean }
export interface AgentMergeDeps {
  diff3: Diff3;
  /** human/SOUL.md(画像)行合不拢时按条目合;不传 = 契约里的 mergePortrait(11-09 起挪进契约,引擎和桌面宿主同一份)。 */
  portrait?: (ours: string, base: string, theirs: string) => AgentMergeResult;
}

/** 新装机播种的 USER.md / human/MEMORY.md 空模板:第一次见面认得它,一边是空模板就用另一边,别把模板行混进真资料。定义在 userMdTemplate.ts(渲染层也引)。 */
export { USER_MD_TEMPLATE, LEGACY_USER_MD_TEMPLATES };

/** 没有基线时两份文本怎么合:一边是空的或新装机的空模板就用另一边,否则按行取并集(一行都不丢)。 */
export function joinFirstContact(ours: string, theirs: string): string {
  const blank = (s: string): boolean => !s.trim() || s === USER_MD_TEMPLATE || LEGACY_USER_MD_TEMPLATES.includes(s);
  if (blank(ours)) return theirs;
  if (blank(theirs)) return ours;
  return unionLines(ours, theirs);
}

/** 记忆一行一条事实,按集合三方合并:两边都留着的留,任一边删掉的删(改 = 删旧加新),任一边新加的加。
 *  diff3 会把相邻两行的改动(网页改了一条、本机在后面记了一条)判成冲突,记忆里这几乎是常态。顺序 = 本机的顺序,云端新加的接在后面。 */
export function mergeFactLines(ours: string, base: string, theirs: string): string {
  const count = (t: string): Map<string, number> => { const m = new Map<string, number>(); for (const l of t.split('\n')) if (l.trim()) m.set(l, (m.get(l) ?? 0) + 1); return m; };
  const b = count(base), o = count(ours), t = count(theirs);
  // 每行保留的份数:两边都没删的那部分 + 新加的(取多的那边)
  const keep = new Map<string, number>();
  for (const l of new Set([...o.keys(), ...t.keys()])) {
    const nb = b.get(l) ?? 0, no = o.get(l) ?? 0, nt = t.get(l) ?? 0;
    keep.set(l, Math.min(nb, no, nt) + Math.max(0, no - nb, nt - nb)); // 两边各自记了同一条 = 一条,不重复
  }
  const out: string[] = [];
  const take = (l: string): boolean => { const n = keep.get(l) ?? 0; if (n <= 0) return false; keep.set(l, n - 1); return true; };
  for (const l of ours.split('\n')) if (!l.trim() ? out.length && out[out.length - 1].trim() : take(l)) out.push(l);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const l of theirs.split('\n')) if (l.trim() && take(l)) out.push(l);
  return out.length ? `${out.join('\n')}\n` : '';
}

/** 日志一天一份,按块(### 时:分)并集、页眉按行并集,只增不减;各设备收敛到同一份文本。 */
export function mergeLogContent(ours: string, theirs: string, date = ''): string {
  const a = splitLogBlocks(ours), b = splitLogBlocks(theirs);
  const blocks = mergeBlocks(a.blocks, b.blocks).merged;
  const header = mergeLogHeaders(a.header, b.header).header || (date ? `# ${date}` : '');
  return logText(header, blocks);
}
export function logText(header: string, blocks: string[]): string { return blocks.length ? `${header.trimEnd()}\n\n${blocks.map((b) => `${b}\n`).join('\n')}` : `${header.trimEnd()}\n`; }

/** Agent 日历(CALENDAR.db)合并后调:同一行两台都改了(一台到点写了 lastRun、另一台改了描述),合并取了一边的整行;
 *  lastRun 取各份里最晚的那个,免得排它的那台把同一次再跑一遍。ISO 串按字典序比就是按时间比。 */
export function keepLatestRuns(merged: string, ...sides: string[]): string {
  type Db = { columns: unknown[]; rows: Array<{ id: string; cells: Record<string, unknown> }> };
  const parse = (raw: string): Db | null => { try { const db = JSON.parse(raw); return db && Array.isArray(db.columns) && Array.isArray(db.rows) ? db : null; } catch { return null; } };
  const db = parse(merged);
  if (!db) return merged;
  const latest = new Map<string, string>();
  for (const side of sides) {
    for (const r of parse(side)?.rows ?? []) {
      const v = r.cells?.lastRun;
      if (typeof v === 'string' && v > (latest.get(r.id) ?? '')) latest.set(r.id, v);
    }
  }
  let changed = false;
  for (const r of db.rows) {
    const v = latest.get(r.id);
    if (v && v > String(r.cells.lastRun ?? '')) { r.cells.lastRun = v; changed = true; }
  }
  return changed ? `${JSON.stringify(db, null, 2)}\n` : merged;
}

/** 墓碑在云端的样子(和记忆仓库 MemoryTombstone 同形)。 */
export interface WireTombstone { id: string; fingerprint: string; content: string; forgottenAt: number; restoredAt?: number; evidenceIds: string[] }
/** 墓碑文件的字节:旧同步一直这么写,本机投影和合并结果也逐字节照此,两套同步之间不会因为键序来回推。 */
export function serializeTombstones(tombstones: readonly WireTombstone[]): string {
  return JSON.stringify({ schemaVersion: 1, tombstones: tombstones.map((t) => ({ ...t, evidenceIds: [...t.evidenceIds].sort() })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) });
}
export function parseTombstones(text: string): WireTombstone[] | null {
  try {
    const v = JSON.parse(text);
    if (v?.schemaVersion !== 1 || !Array.isArray(v.tombstones)) return null;
    const ok = v.tombstones.every((t: any) => t && typeof t.id === 'string' && typeof t.fingerprint === 'string' && typeof t.content === 'string' && Number.isFinite(t.forgottenAt) && (t.restoredAt === undefined || Number.isFinite(t.restoredAt)) && Array.isArray(t.evidenceIds) && t.evidenceIds.every((x: unknown) => typeof x === 'string'));
    return ok ? v.tombstones : null;
  } catch { return null; }
}
/** 两份墓碑并集:同一条事实取较晚忘掉的那次,恢复时间取最晚,证据合并。和记忆仓库 mergeTombstones 同一个口径(连键序都一样)。 */
export function mergeTombstoneLists(ours: readonly WireTombstone[], theirs: readonly WireTombstone[]): WireTombstone[] {
  const merged = new Map(ours.map((t) => [t.fingerprint, t]));
  for (const t of theirs) {
    const prev = merged.get(t.fingerprint);
    const winner = prev && (prev.forgottenAt > t.forgottenAt || (prev.forgottenAt === t.forgottenAt && prev.id >= t.id)) ? prev : t;
    merged.set(t.fingerprint, prev ? { ...winner, ...(prev.restoredAt || t.restoredAt ? { restoredAt: Math.max(prev.restoredAt ?? 0, t.restoredAt ?? 0) } : {}), evidenceIds: [...new Set([...prev.evidenceIds, ...t.evidenceIds])].sort() } : t);
  }
  return [...merged.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
/** 两份墓碑说的是不是同一件事(不看键序、证据顺序):投影 / 导入只在真有新内容时才落盘,不然每轮重写一遍、来回推。 */
export function sameTombstones(a: readonly WireTombstone[], b: readonly WireTombstone[]): boolean {
  const key = (l: readonly WireTombstone[]): string => JSON.stringify([...l].sort((x, y) => x.fingerprint.localeCompare(y.fingerprint))
    .map((t) => [t.fingerprint, t.id, t.content, t.forgottenAt, t.restoredAt ?? null, [...t.evidenceIds].sort()]));
  return key(a) === key(b);
}
/** 事实行的身份:去掉行尾记号、列表符号、压空白、小写(定义在 entryMark.ts,11-09 起记号不算事实的一部分)。 */
export { normalizeMemoryFact };
export function isMemoryTombstoneActive(tombstone: { forgottenAt: number; restoredAt?: number }): boolean {
  return tombstone.forgottenAt >= (tombstone.restoredAt ?? 0);
}
/** 按墓碑滤掉忘掉的事实行(只按指纹;按证据那半在记忆仓库里)。sha256 由调用方给:契约不引 node 内置模块。 */
export function dropForgottenFacts(content: string, tombstones: readonly WireTombstone[], sha256: (text: string) => string): string {
  const hashes = new Set(tombstones.filter(isMemoryTombstoneActive).map((t) => t.fingerprint));
  if (!hashes.size) return content;
  return content.split('\n').filter((line) => !hashes.has(sha256(normalizeMemoryFact(line)))).join('\n');
}

/** config.toml 里顶层的 `key = 值` 一行一个;多行字符串、表头这类看不懂的返回 null(就不按出厂认)。 */
function tomlLines(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m || out.has(m[1]) || /^("""|''')/.test(m[2])) return null;
    out.set(m[1], m[2]);
  }
  return out;
}
const tomlString = (raw: string | undefined): string | null => { if (!raw?.startsWith('"')) return null; try { const v = JSON.parse(raw); return typeof v === 'string' ? v : null; } catch { return null; } };
/** 这个 Agent 历届出厂提示词(中文 06-18 版、英文 09-06 版)。 */
function factoryPrompts(slug: string): string[] {
  const en = LEGACY_PERSONAS.find((p) => p.slug === slug)?.systemPrompt;
  return [en, LEGACY_PERSONA_PROMPTS_ZH[slug]].filter((p): p is string => !!p);
}
/** 两台各自播种的同一个 Agent:去掉创建时间、版本号后逐行相同,或者提示词两边都是这个 Agent 的某一版出厂预设、
 *  其余只差创建时间和版本号 → 用云端那份,不出冲突副本(06-18 中文版 vs 09-06 英文版那批就是这么来的)。 */
export function sameFactoryConfig(slug: string, ours: string, theirs: string): boolean {
  const a = tomlLines(ours), b = tomlLines(theirs);
  if (!a || !b) return false;
  const ignore = new Set(['created_at', 'version']);
  const prompts = factoryPrompts(slug);
  const promptOk = (m: Map<string, string>): boolean => { const v = tomlString(m.get('developer_instructions')); return v !== null && prompts.includes(v.trim()); };
  if (promptOk(a) && promptOk(b)) ignore.add('developer_instructions');
  const keys = new Set([...a.keys(), ...b.keys()].filter((k) => !ignore.has(k)));
  return [...keys].every((k) => a.get(k) === b.get(k));
}

/** 内容路径(`human/Settings/<name>.db`)是不是随账号走的设置文件。 */
export function isSettingsContentPath(path: string): boolean {
  const at = parseAgentContentPath(path);
  return at?.area === 'human' && isSettingsPath(at.rel);
}
/** 这个内容路径是不是「不出冲突副本」的那一族(现在只有设置文件)。两套同步在要存副本的地方都问它:
 *  合并规则已经保证有确定的赢家(mergeSettingsDb),这里再兜住不经过合并的那几条路(云端那份标成二进制、老服务端没有版本号)。 */
export const neverConflictCopy = (path: string): boolean => isSettingsContentPath(path);

/** 设置文件的形状(本机读写接口、同步共用这一条;server 那边的同名接口照同一条写):DbFile —— version 是数字、name 是字符串、不是笔记视图(没有 source);
 *  列 / 行(有的话还有视图)都是带字符串 id 的对象且 id 不重复(同步按 id 合并,重复的合不了);每行有 cells 对象。不解释格子里的内容。 */
export function isSettingsDbShape(d: unknown): boolean {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const idList = (v: unknown): v is Array<Record<string, unknown>> => Array.isArray(v) && v.every((x) => obj(x) && typeof x.id === 'string') && new Set(v.map((x) => x.id)).size === v.length;
  return obj(d) && typeof d.version === 'number' && typeof d.name === 'string' && d.source === undefined
    && idList(d.columns) && idList(d.rows) && d.rows.every((r) => obj(r.cells)) && (d.views === undefined || idList(d.views));
}
/** 这份设置文件读不读得懂:是 JSON、形状对。读不懂的(断电后零字节、写了一半、别的东西)不是「空」,是「不知道」:
 *  接口对它回 422、不许盖;同步不拿它去盖读得懂的那份(见 mergeSettingsDb 和旧同步 reconcileFile 的快进闸)。 */
export function isReadableSettingsDb(text: string): boolean {
  try { return isSettingsDbShape(JSON.parse(text)); } catch { return false; }
}

type SettingsDb = Record<string, unknown> & { columns: unknown[]; rows: Array<Record<string, unknown> & { id: string }> };
function parseSettingsDb(text: string | null): SettingsDb | null {
  if (text === null) return null;
  try { const d: unknown = JSON.parse(text); return isSettingsDbShape(d) ? d as SettingsDb : null; } catch { return null; }
}
/** 键序无关的比较(两台写出同一行、键的先后不同,不算改动)。undefined = 这一行不存在,也是一个值。 */
function canonValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonValue).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonValue((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

/**
 * 设置文件(human/Settings/<name>.db)两边不一样怎么合。和 human/ 里别的文件不同:**任何情况下都有确定的结果,不出冲突副本**
 * (conflict 恒为 false,也不返回 null)—— 渲染层读这份文件时不会去翻副本,留副本等于悄悄丢设置。ours = 这台,theirs = 云端。
 * 自己的一套行合并(不委托 mergeDbFile:那边的「整份重置 / 种子替换」猜测和「编辑胜删除」对这个族都不对)。「这一行不存在」也是一个值;
 * 对每个行 id 比 基线 / 这台 / 云端 三份(整行比较,键序无关):
 * - 有基线:这台 == 基线 → 取云端(云端删了 = 删);云端 == 基线 → 取这台(这台删了 = 删);两边都和基线不同 → 取云端(云端删了也是删)。
 *   这台空了(合法的 columns: [] / rows: [])就是这台把这些行删了,照上面走,不当成「换了一个库」丢掉基线。
 * - 没有基线(两台各自建了文件,第一次见面;或基线读不懂):行取并集,同一个行 id 两边不同 → 取云端。
 * - 列定义取云端的;云端是空数组而这台有 → 取这台的。version / name 和其余表头取云端的。
 * - 某一份读不懂(isReadableSettingsDb)= 读得懂的那份整份赢;都读不懂 = 云端那份。
 * 输出确定:行按 id 排序(按码点比,不随系统语言)、两格缩进;结果和云端那份一模一样(同样的行、同样的表头)就原样给回云端的字节 ——
 * 两台合出来的字节一样,下一轮是空转,不会为排版互推。
 */
export function mergeSettingsDb(ours: string, base: string | null, theirs: string): AgentMergeResult {
  const O = parseSettingsDb(ours), T = parseSettingsDb(theirs);
  if (!O || !T) return { content: T || !O ? theirs : ours, conflict: false };
  const B = parseSettingsDb(base);
  const index = (d: SettingsDb | null) => new Map((d?.rows ?? []).map((r) => [r.id, r]));
  const o = index(O), t = index(T), b = index(B);
  const same = (x: unknown, y: unknown): boolean => canonValue(x) === canonValue(y);
  const rows: SettingsDb['rows'] = [];
  for (const id of [...new Set([...o.keys(), ...t.keys()])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
    const ov = o.get(id), tv = t.get(id), bv = b.get(id);
    const pick = B ? (same(ov, bv) ? tv : same(tv, bv) ? ov : tv) : (tv ?? ov);
    if (pick) rows.push(pick);
  }
  const columns = T.columns.length === 0 && O.columns.length > 0 ? O.columns : T.columns;
  const out = { ...T, columns, rows };
  if (same(out.columns, T.columns) && rows.length === T.rows.length && rows.every((r) => same(r, t.get(r.id)))) return { content: theirs, conflict: false };
  return { content: `${JSON.stringify(out, null, 2)}\n`, conflict: false };
}

const TEXT_FILE = /\.(md|txt|toml|json|yaml|yml|csv|html|xml|js|ts|py)$/i;

/**
 * 同一份 Agent 文件两边都改了(或第一次见面两份不一样)怎么合。path = 内容路径:`agents/<slug>/<相对>`、`human/<相对>`,
 * 旧同步的 USER.md 槽位传 `USER.md`。返回 null = 合不了,调用方照旧整份存冲突副本、取云端那份。
 * 设置文件(human/Settings/<name>.db)例外:恒有结果、conflict 恒为 false,见 mergeSettingsDb。
 * base = 上次两边一致时的原文;null = 第一次见面(没有基线)。
 */
export function mergeAgentSyncContent(path: string, ours: string, base: string | null, theirs: string, deps: AgentMergeDeps): AgentMergeResult | null {
  const at = parseAgentContentPath(path);
  const rel = at ? at.rel : path;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const diff3 = (o: string, b: string, t: string): string | null => mergeText3With(o, b, t, deps.diff3);
  if (at?.area === 'agents' && rel === MEMORY_TOMBSTONES) {
    const a = parseTombstones(ours), b = parseTombstones(theirs);
    return a && b ? { content: serializeTombstones(mergeTombstoneLists(a, b)), conflict: false } : null;
  }
  if (at?.area === 'agents' && rel.startsWith('LOG/')) return { content: mergeLogContent(ours, theirs, rel.slice(4, -3)), conflict: false };
  if (at?.area === 'human' && isSettingsPath(rel)) return mergeSettingsDb(ours, base, theirs);
  if (rel.toLowerCase().endsWith('.db')) {
    const merged = mergeDbFile(ours, base, theirs, { fieldColumns: isWidgetDataPath(rel) });
    // Agent 的日历:同一行冲突时整行取了一边,lastRun 不能跟着回滚(否则排它的那台会把同一次再跑一遍)
    return merged && at?.area === 'agents' && rel === 'CALENDAR.db' ? { ...merged, content: keepLatestRuns(merged.content, ours, theirs) } : merged;
  }
  if (!TEXT_FILE.test(name)) return null;
  // 记忆详情(11-09 分层):Library/memory/<主题>.md 按条合(第一次见面取并集),别的 Library 文件照旧按行三方合、合不拢出副本
  if (at?.area === 'agents' && isMemoryDetailPath(rel)) return mergeTopicFile(name.slice(0, -3), ours, base, theirs);
  // 画像带详情各节时常驻和详情分开合、合完按「每条在哪」的推导规则收拾(第一次见面也是:不把挪进详情的那条复活回常驻)
  if (at?.area === 'human' && rel === 'SOUL.md' && (hasPortraitTopics(ours) || hasPortraitTopics(theirs) || (base !== null && hasPortraitTopics(base)))) {
    return mergeLayeredPortrait(ours, base, theirs, deps.diff3);
  }
  // 只有 Agent 的记忆按事实集合合并;human/MEMORY.md 是人的本子、和 USER.md 镜像互相 diff3,集合合并会重排行,下一轮镜像那对合不拢、丢行(10-23)
  if (at?.area === 'agents' && rel === 'MEMORY.md') return { content: base === null ? joinFirstContact(ours, theirs) : mergeFactLines(ours, base, theirs), conflict: false };
  if (at?.area === 'agents' && rel === 'config.toml' && at.slug && sameFactoryConfig(at.slug, ours, theirs)) return { content: theirs, conflict: false };
  // human/ 那几份、USER.md:人的资料,第一次见面取并集;有基线时按行三方合并
  const mergeable = !at || at.area === 'human';
  const soul = at?.area === 'human' && rel === 'SOUL.md';
  // 画像合完收拾一遍:并集出来的钉住 / 没钉两份同一句只留钉住的(没有记号的老画像原样不动)
  const tidy = (r: AgentMergeResult): AgentMergeResult => soul ? { ...r, content: settlePortrait(r.content) } : r;
  if (base === null) return mergeable ? tidy({ content: joinFirstContact(ours, theirs), conflict: false }) : null;
  const text = diff3(ours, base, theirs);
  if (text !== null) return tidy({ content: text, conflict: false });
  // 画像(human/SOUL.md,10-29):两台都往 Agent 那一节末尾各记一条,按行三方合并几乎必然合不拢 → 条目按集合合
  if (soul) return tidy((deps.portrait ?? mergePortrait)(ours, base, theirs));
  return null;
}
