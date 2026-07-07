/**
 * Amadeus 笔记库 + Calendar 日程工具(双后端:host 本地磁盘 / 云端 brain.amadeus)。
 *
 * host 形态:工具跑在 agent 进程里(node:fs),**够不到**渲染端的 window.amadeus / stores,
 * 所以直接读写磁盘上的 vault。Amadeus 数据格式很简单:
 *   - 笔记 = 带 `<!-- a N -->` HTML 注释块标记的 markdown(.md)。
 *   - 多维表 = 独立 .db JSON 文件。日程 = 某 .db 里 `calendarDate` 列的行,值 = 字符串
 *     `start[/end]`,每侧 `YYYY-MM-DD`(全天)或 `YYYY-MM-DDTHH:mm`(带时刻)。
 * 极小的格式助手在此就地实现(不 import desktop/shared —— agent 要独立可 vendor);写 .db
 * 保持与桌面 serializeDb 同款(2 空格缩进 + 尾换行),桌面 parseDb 才接受、git 可 diff。
 *
 * 后端切换(v1 云端化):execMode='host' → 本地磁盘(行为与旧 host-only 版逐字节一致);
 * 否则 → deps().brain.amadeus(httpBrain 调 server /api/amadeus/vaults/default/*,thin worker
 * 云端 Tangu 读写用户云 vault)。facet 未装配(microserver 进程内/纯本地 sandbox)→ 工具隐藏。
 * .db 读-改-写在云端带 baseSeq 乐观锁,409 冲突用服务端回带的最新内容重放一次。
 */
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolProvider, ToolDef } from '../toolRegistry.js';
import type { AppProfile } from '../../seams/appProfile.js';
import type { ToolCapabilities, ToolContext } from '../toolTypes.js';
import { deps, isConfigured } from '../../seams/runtime.js';
import { AmadeusConflictError, type AmadeusBrain } from '../../seams/cloudBrain.js';

// ── vault 定位 ────────────────────────────────────────────────────────────
// 解析优先级:① FORSION_AMADEUS_VAULT 显式覆盖(standalone CLI 直指) → ② desktop 注入的
// FORSION_AMADEUS_CONFIG(amadeus-config.json)里 **实时读** lastVault(跟随桌面当前 vault,
// 支持自定义路径 + 运行时切换 vault) → ③ 默认 ~/Forsion/Amadeus。每次调用都重读,故切 vault 立即生效。
function vaultFromConfig(): string | null {
  const cfg = process.env.FORSION_AMADEUS_CONFIG?.trim();
  if (!cfg) return null;
  try {
    const lastVault = JSON.parse(readFileSync(cfg, 'utf8'))?.lastVault;
    return typeof lastVault === 'string' && lastVault.trim() ? lastVault.trim() : null;
  } catch {
    return null; // 配置缺失/损坏 → 回落默认
  }
}
export function amadeusVaultPath(): string {
  const env = process.env.FORSION_AMADEUS_VAULT?.trim();
  return env || vaultFromConfig() || path.join(os.homedir(), 'Forsion', 'Amadeus');
}
export function amadeusVaultExists(): boolean {
  try {
    return existsSync(amadeusVaultPath());
  } catch {
    return false;
  }
}
/** vault 相对路径 → 绝对路径,钳制在 vault 内(拒绝越界)。 */
function inVault(rel: string): string {
  const root = amadeusVaultPath();
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`path escapes the vault: ${rel}`);
  return abs;
}

// ── 笔记格式助手 ──────────────────────────────────────────────────────────
const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const BLOCK_MARKER_RE = /^<!--\s*a\s+[A-Za-z0-9_]+\s*-->\s*$/;
function toCleanMarkdown(md: string): string {
  const body = md.replace(FM_RE, '');
  return body
    .split('\n')
    .filter((l) => !BLOCK_MARKER_RE.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── .db / calendarDate 格式助手(镜像 desktop schema.ts / calDate.ts) ───────
type CellValue = string | number | boolean | string[] | null;
interface DbColumn {
  id: string;
  name: string;
  type: string;
  options?: string[];
}
interface DbRow {
  id: string;
  cells: Record<string, CellValue>;
}
interface DbFile {
  version: number;
  name: string;
  source?: { folder: string };
  columns: DbColumn[];
  rows: DbRow[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
function dbId(): string {
  return Math.random().toString(36).slice(2, 10);
}
function serializeDb(db: DbFile): string {
  return `${JSON.stringify(db, null, 2)}\n`;
}
function cellText(v: CellValue | undefined): string {
  if (v == null) return '';
  return Array.isArray(v) ? v.join(', ') : String(v);
}
function encodeCalDate(start: string, end?: string, allDay?: boolean): string {
  const s = allDay === true ? start.split('T')[0] : start;
  const e = end && allDay === true ? end.split('T')[0] : end;
  if (!DATE_RE.test(s)) throw new Error(`invalid start "${start}" (use YYYY-MM-DD or YYYY-MM-DDTHH:mm)`);
  if (e && !DATE_RE.test(e)) throw new Error(`invalid end "${end}" (use YYYY-MM-DD or YYYY-MM-DDTHH:mm)`);
  return e ? `${s}/${e}` : s;
}
function decodeCalDate(v: CellValue | undefined): { start: string; end?: string; allDay: boolean } | null {
  if (typeof v !== 'string' || !v) return null;
  const [start, end] = v.split('/');
  if (!DATE_RE.test(start)) return null;
  const cleanEnd = end && DATE_RE.test(end) ? end : undefined;
  return { start, end: cleanEnd, allDay: !start.includes('T') && !(cleanEnd ?? '').includes('T') };
}

// ── 磁盘枚举/读写(host 后端的底层)──────────────────────────────────────────
async function walk(dir: string, root: string, pred: (name: string) => boolean, out: string[]): Promise<void> {
  let ents: import('node:fs').Dirent[];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, root, pred, out);
    else if (e.isFile() && pred(e.name)) out.push(path.relative(root, abs));
  }
}
async function listVault(pred: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  await walk(amadeusVaultPath(), amadeusVaultPath(), pred, out);
  return out.sort();
}

// ── 后端抽象:host=本地磁盘 vault;否则=deps().brain.amadeus(云 vault API)──────
interface AmadeusBackend {
  /** vault 是否存在(local=目录存在;cloud=facet 即在,空 vault 也算存在)。 */
  exists(): boolean;
  /** write_note 前置:local 确保 vault 目录存在;cloud 无需(服务端隐式建路径)。 */
  ensureVault(): Promise<void>;
  /** 按文件名(basename)谓词列 vault 相对路径(已排序)。 */
  list(pred: (name: string) => boolean): Promise<string[]>;
  /** 读文本;不存在时抛错。seq 仅 cloud 有(乐观锁票据)。 */
  read(rel: string): Promise<{ content: string; seq?: number }>;
  /** 写文本;overwrite=无条件覆盖(cloud force),否则带 baseSeq 乐观锁(local 忽略、永不冲突)。 */
  write(rel: string, content: string, opts?: { baseSeq?: number; overwrite?: boolean }): Promise<void>;
}

const localBackend: AmadeusBackend = {
  exists: () => amadeusVaultExists(),
  ensureVault: async () => {
    if (!existsSync(amadeusVaultPath())) await fs.mkdir(amadeusVaultPath(), { recursive: true });
  },
  list: (pred) => listVault(pred),
  read: async (rel) => ({ content: await fs.readFile(inVault(rel), 'utf8') }),
  write: async (rel, content) => {
    const abs = inVault(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  },
};

function cloudAmadeus(): AmadeusBrain | null {
  if (!isConfigured()) return null;
  return deps().brain.amadeus ?? null;
}

function cloudBackend(facet: AmadeusBrain): AmadeusBackend {
  return {
    exists: () => true,
    ensureVault: async () => {},
    list: async (pred) => {
      const entries = await facet.list();
      return entries
        .map((e) => e.path)
        .filter((p) => pred(p.slice(p.lastIndexOf('/') + 1)))
        .sort();
    },
    read: (rel) => facet.read(rel),
    write: async (rel, content, opts) => {
      await facet.write(rel, content, opts?.overwrite ? { force: true } : { baseSeq: opts?.baseSeq });
    },
  };
}

/** execMode='host' → 本地磁盘(与旧 host-only 行为逐字节一致);否则 → 云端 facet;两者皆无 → null。 */
function backendFor(ctx: ToolContext | undefined): AmadeusBackend | null {
  if (ctx?.execMode === 'host') return localBackend;
  const facet = cloudAmadeus();
  return facet ? cloudBackend(facet) : null;
}

// ── 日历装配(后端无关)────────────────────────────────────────────────────
interface Cal {
  rel: string;
  db: DbFile;
  cal: DbColumn;
  /** cloud 读到的乐观锁票据(local 无)。 */
  seq?: number;
}
async function readDbBe(be: AmadeusBackend, rel: string): Promise<{ db: DbFile; seq?: number }> {
  const { content, seq } = await be.read(rel);
  const data = JSON.parse(content);
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) throw new Error(`not a valid .db file: ${rel}`);
  return { db: data as DbFile, seq };
}
/** 把 .db 装配成 Cal(须含 calendarDate 列且非 note-view 库),否则 null。 */
function toCal(rel: string, db: DbFile, seq?: number): Cal | null {
  const cal = db.columns.find((c) => c.type === 'calendarDate');
  return cal && !db.source ? { rel, db, cal, seq } : null;
}
/** 全库经典多维表里含 calendarDate 列的(note-view 库 v1 跳过)。 */
async function calendars(be: AmadeusBackend): Promise<Cal[]> {
  const out: Cal[] = [];
  for (const rel of await be.list((n) => n.toLowerCase().endsWith('.db'))) {
    try {
      const { db, seq } = await readDbBe(be, rel);
      const c = toCal(rel, db, seq);
      if (c) out.push(c);
    } catch {
      /* 跳过损坏/非法 .db */
    }
  }
  return out;
}
async function findCalendar(be: AmadeusBackend, nameOrPath?: string): Promise<Cal> {
  const cals = await calendars(be);
  if (!cals.length) {
    throw new Error('no calendar database found. A calendar is a multi-dimensional table with a "calendarDate" column; open the Calendar space in the app to create one.');
  }
  if (!nameOrPath) return cals[0];
  const q = nameOrPath.trim();
  const found = cals.find(
    (c) => c.rel === q || c.db.name === q || path.basename(c.rel).replace(/\.db$/i, '') === q,
  );
  if (!found) throw new Error(`calendar "${nameOrPath}" not found. Available: ${cals.map((c) => c.db.name).join(', ')}`);
  return found;
}

type CalMutation = (cal: Cal) => { ok: boolean; msg: string };
/**
 * 日历读-改-写:找库 → 变更(apply 就地改 cal.db,ok=false 表「不写直接回话」)→ 回写
 * (cloud 带 baseSeq 乐观锁)。写冲突(409)= 服务端已前进:用冲突携带的最新内容**重放一次**
 * apply(等价重读重试;再冲突则上抛)。local 永不冲突,读写序列与旧版一致。
 */
async function mutateCalendar(be: AmadeusBackend, nameOrPath: string | undefined, apply: CalMutation): Promise<string> {
  const attempt = async (cal: Cal): Promise<string> => {
    const r = apply(cal);
    if (!r.ok) return r.msg;
    await be.write(cal.rel, serializeDb(cal.db), { baseSeq: cal.seq });
    return r.msg;
  };
  const cal = await findCalendar(be, nameOrPath);
  try {
    return await attempt(cal);
  } catch (e) {
    if (e instanceof AmadeusConflictError) {
      let fresh: Cal | null = null;
      try {
        const db = JSON.parse(e.content);
        if (db && Array.isArray(db.columns) && Array.isArray(db.rows)) fresh = toCal(cal.rel, db as DbFile, e.seq);
      } catch {
        /* 冲突体不带合法内容 → 退回重读 */
      }
      if (!fresh) {
        const { db, seq } = await readDbBe(be, cal.rel);
        fresh = toCal(cal.rel, db, seq);
      }
      if (fresh) return await attempt(fresh);
    }
    throw e;
  }
}
function setNamedProps(db: DbFile, cells: Record<string, CellValue>, props?: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(props ?? {})) {
    const col = db.columns.find((c) => c.name === k || c.id === k);
    if (col) cells[col.id] = v as CellValue;
  }
}
function rowToEvent(cal: Cal, r: DbRow): { calendar: string; id: string; title: string; start: string; end?: string; allDay: boolean; props: Record<string, string> } | null {
  const cd = decodeCalDate(r.cells[cal.cal.id]);
  if (!cd) return null;
  const nameCol = cal.db.columns[0];
  const props: Record<string, string> = {};
  for (const c of cal.db.columns) {
    if (c.id === nameCol?.id || c.id === cal.cal.id) continue;
    const t = cellText(r.cells[c.id]);
    if (t) props[c.name] = t;
  }
  return {
    calendar: cal.db.name,
    id: r.id,
    title: (nameCol ? cellText(r.cells[nameCol.id]) : '') || '(untitled)',
    start: cd.start,
    end: cd.end,
    allDay: cd.allDay,
    props,
  };
}

// ── 工具装配 ──────────────────────────────────────────────────────────────
const READ_CAPS: ToolCapabilities = { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 };
const WRITE_CAPS: ToolCapabilities = { sideEffect: 'write', parallel: false, defaultTimeoutMs: 15_000 };

function mk(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  caps: ToolCapabilities,
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string>,
): ToolDef {
  return {
    name,
    // 双后端:host 模式沿旧门禁(hostExec 能力,本地磁盘 vault);非 host 仅当云端 amadeus
    // facet 已装配(httpBrain)才可见——microserver 进程内/纯本地 sandbox 无 facet → 隐藏,零影响。
    mode: 'both',
    capabilities: caps,
    isEnabledFor: (profile: AppProfile, ctx: ToolContext) =>
      ctx?.execMode === 'host' ? profile.capabilities.hostExec : !!cloudAmadeus(),
    definition: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    execute,
  };
}
const noVault = 'No Amadeus vault found on this machine — the user may not have set up Amadeus notes/calendar yet.';
const noBackend = 'Amadeus is not available in this environment (no local vault access and no cloud vault connection).';

export const amadeusProvider: ToolProvider = {
  id: 'builtin:amadeus',
  tools: (): ToolDef[] => [
    // ── 笔记 ──
    mk(
      'amadeus_list_notes',
      "List the user's Amadeus notes (markdown files in the vault). Optionally filter by a substring of the note path/name.",
      { query: { type: 'string', description: 'Optional case-insensitive substring to filter note paths.' } },
      [],
      READ_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        const q = String(args.query ?? '').trim().toLowerCase();
        let notes = await be.list((n) => n.toLowerCase().endsWith('.md'));
        if (q) notes = notes.filter((p) => p.toLowerCase().includes(q));
        if (!notes.length) return q ? `No notes match "${args.query}".` : 'The vault has no notes yet.';
        return notes.map((p) => `- ${p}`).join('\n');
      },
    ),
    mk(
      'amadeus_read_note',
      'Read one Amadeus note and return its markdown content (frontmatter and internal block markers stripped).',
      { path: { type: 'string', description: 'Vault-relative note path, e.g. "Notes/ideas.md".' } },
      ['path'],
      READ_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        let rel = String(args.path ?? '').trim();
        if (!rel) return 'Error: path is required';
        if (!/\.md$/i.test(rel)) rel += '.md';
        const { content: raw } = await be.read(rel);
        return toCleanMarkdown(raw) || '(empty note)';
      },
    ),
    mk(
      'amadeus_write_note',
      'Create or overwrite an Amadeus note with plain markdown. To edit an existing note, read it first, modify, then write the full new content. Overwriting resets the note to a simple linear layout.',
      {
        path: { type: 'string', description: 'Vault-relative note path, e.g. "Notes/ideas.md" (".md" appended if missing).' },
        content: { type: 'string', description: 'The full markdown content of the note.' },
      },
      ['path', 'content'],
      WRITE_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        await be.ensureVault();
        let rel = String(args.path ?? '').trim();
        if (!rel) return 'Error: path is required';
        if (!/\.md$/i.test(rel)) rel += '.md';
        // 保留覆盖语义:cloud 走 force=true 无条件覆盖(与本地直接 writeFile 等价)。
        await be.write(rel, String(args.content ?? ''), { overwrite: true });
        return `Saved note ${rel}.`;
      },
    ),

    // ── 日历 ──
    mk(
      'amadeus_list_calendars',
      "List the user's calendars (multi-dimensional tables that have a calendarDate column), with their names, paths, event counts and columns.",
      {},
      [],
      READ_CAPS,
      async (_args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        const cals = await calendars(be);
        if (!cals.length) return 'No calendars found (a calendar is a table with a "calendarDate" column).';
        return JSON.stringify(
          cals.map((c) => ({
            name: c.db.name,
            path: c.rel,
            events: c.db.rows.filter((r) => decodeCalDate(r.cells[c.cal.id])).length,
            columns: c.db.columns.map((col) => ({ name: col.name, type: col.type })),
          })),
          null,
          2,
        );
      },
    ),
    mk(
      'amadeus_list_events',
      "List calendar events/schedule. Optionally restrict to one calendar (by name or path) and/or a date range. Returns each event's calendar, id, title, start, end, allDay and other properties.",
      {
        calendar: { type: 'string', description: 'Optional calendar name or path to restrict to.' },
        from: { type: 'string', description: 'Optional inclusive start date filter, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Optional inclusive end date filter, YYYY-MM-DD.' },
      },
      [],
      READ_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        const all = args.calendar ? [await findCalendar(be, String(args.calendar))] : await calendars(be);
        if (!all.length) return 'No calendars found.';
        const from = String(args.from ?? '').slice(0, 10);
        const to = String(args.to ?? '').slice(0, 10);
        const events = [];
        for (const cal of all) {
          for (const r of cal.db.rows) {
            const ev = rowToEvent(cal, r);
            if (!ev) continue;
            const d = ev.start.slice(0, 10);
            if (from && d < from) continue;
            if (to && d > to) continue;
            events.push({ ...ev, path: cal.rel });
          }
        }
        events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
        if (!events.length) return 'No events found for that query.';
        return JSON.stringify(events, null, 2);
      },
    ),
    mk(
      'amadeus_create_event',
      'Add an event to the user\'s calendar. Times are "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm" (with a time).',
      {
        title: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'Start, YYYY-MM-DD or YYYY-MM-DDTHH:mm.' },
        end: { type: 'string', description: 'Optional end, same format as start.' },
        allDay: { type: 'boolean', description: 'Optional; force all-day (drops any time component).' },
        calendar: { type: 'string', description: 'Optional calendar name/path; defaults to the first calendar.' },
        props: { type: 'object', description: 'Optional extra column values, keyed by column name.' },
      },
      ['title', 'start'],
      WRITE_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        return mutateCalendar(be, args.calendar ? String(args.calendar) : undefined, (cal) => {
          const value = encodeCalDate(String(args.start), args.end ? String(args.end) : undefined, args.allDay === true ? true : args.allDay === false ? false : undefined);
          const nameCol = cal.db.columns[0];
          const cells: Record<string, CellValue> = { [cal.cal.id]: value };
          if (nameCol && nameCol.id !== cal.cal.id) cells[nameCol.id] = String(args.title ?? '');
          setNamedProps(cal.db, cells, args.props);
          const id = dbId();
          cal.db.rows.push({ id, cells });
          return { ok: true, msg: `Created event "${args.title}" (${value}) in "${cal.db.name}". id=${id}` };
        });
      },
    ),
    mk(
      'amadeus_edit_event',
      'Edit an existing calendar event by id. Only the fields you pass are changed.',
      {
        calendar: { type: 'string', description: 'Calendar name or path the event is in.' },
        eventId: { type: 'string', description: 'The event id (from amadeus_list_events).' },
        title: { type: 'string', description: 'New title.' },
        start: { type: 'string', description: 'New start, YYYY-MM-DD or YYYY-MM-DDTHH:mm.' },
        end: { type: 'string', description: 'New end, same format; pass empty string to clear.' },
        allDay: { type: 'boolean', description: 'Force all-day (drops time).' },
        props: { type: 'object', description: 'Extra column values to set, keyed by column name.' },
      },
      ['calendar', 'eventId'],
      WRITE_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        return mutateCalendar(be, String(args.calendar), (cal) => {
          const row = cal.db.rows.find((r) => r.id === String(args.eventId));
          if (!row) return { ok: false, msg: `Error: event ${args.eventId} not found in "${cal.db.name}".` };
          const nameCol = cal.db.columns[0];
          if (args.title !== undefined && nameCol && nameCol.id !== cal.cal.id) row.cells[nameCol.id] = String(args.title);
          if (args.start !== undefined) {
            const cur = decodeCalDate(row.cells[cal.cal.id]);
            const end = args.end !== undefined ? (String(args.end) || undefined) : cur?.end;
            row.cells[cal.cal.id] = encodeCalDate(String(args.start), end, args.allDay === true ? true : args.allDay === false ? false : undefined);
          } else if (args.end !== undefined) {
            const cur = decodeCalDate(row.cells[cal.cal.id]);
            if (cur) row.cells[cal.cal.id] = encodeCalDate(cur.start, String(args.end) || undefined);
          }
          setNamedProps(cal.db, row.cells, args.props);
          return { ok: true, msg: `Updated event ${args.eventId} in "${cal.db.name}".` };
        });
      },
    ),
    mk(
      'amadeus_delete_event',
      'Delete a calendar event by id.',
      {
        calendar: { type: 'string', description: 'Calendar name or path the event is in.' },
        eventId: { type: 'string', description: 'The event id to delete.' },
      },
      ['calendar', 'eventId'],
      WRITE_CAPS,
      async (args, ctx) => {
        const be = backendFor(ctx);
        if (!be) return noBackend;
        if (!be.exists()) return noVault;
        return mutateCalendar(be, String(args.calendar), (cal) => {
          const before = cal.db.rows.length;
          cal.db.rows = cal.db.rows.filter((r) => r.id !== String(args.eventId));
          if (cal.db.rows.length === before) return { ok: false, msg: `Error: event ${args.eventId} not found in "${cal.db.name}".` };
          return { ok: true, msg: `Deleted event ${args.eventId} from "${cal.db.name}".` };
        });
      },
    ),
  ],
};

/** 通用工具指引(local/cloud 两段共用;硬编码进模型的提示一律英文)。 */
const AMADEUS_TOOL_GUIDANCE =
  '- Notes: `amadeus_list_notes` to find, `amadeus_read_note` to read, `amadeus_write_note` to create or rewrite (plain markdown).\n' +
  '- Calendar / schedule: `amadeus_list_calendars` lists calendars; `amadeus_list_events` reads events; `amadeus_create_event` / `amadeus_edit_event` / `amadeus_delete_event` manage them.\n' +
  '- Event times are `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:mm` (with a time); an event has a start and an optional end.\n' +
  '- Use these only when the user asks about their notes, calendar, schedule, or to-dos, and prefer the calendar tools over hand-editing `.db` files.';

/**
 * 云端(非 host)系统提示段:云端 amadeus facet 已装配时输出「用户的 Amadeus 云笔记库」指引;
 * 由 promptSections 在 sandbox/云端分支追加(facet 未装配 → null,prompt 零变化)。
 */
export function amadeusCloudPromptSection(): string | null {
  if (!cloudAmadeus()) return null;
  return (
    '## Amadeus Notes & Calendar (cloud)\n' +
    "The user's Amadeus cloud note vault is available through the amadeus_* tools (reads and writes go to the user's cloud vault).\n" +
    AMADEUS_TOOL_GUIDANCE
  );
}

/** host 系统提示的 Amadeus 指引段(仅本机 vault 存在时);由 promptSections 在 host 模式追加。 */
export function amadeusPromptSection(): string | null {
  if (!amadeusVaultExists()) return null;
  return (
    '## Amadeus Notes & Calendar (local)\n' +
    `The user keeps notes and calendars in a local Amadeus vault at \`${amadeusVaultPath()}\`.\n` +
    AMADEUS_TOOL_GUIDANCE
  );
}
