/**
 * 每-agent 日程 —— `agents/<slug>/SCHEDULE.db`(Amadeus DbFile JSON,桌面 Calendar Space 直接渲染)。
 *
 * 条目两类:auto=true 到点由 automation 管道无人值守执行 prompt;auto=false 纯规划条目
 * (agent 对自己的日程规划,只是日历记录)。与 muse_watch 盯任务并存:日程=时间承诺(归属
 * agent、上日历),盯任务=条件反射(事件/文件,不上日历)。
 *
 * 固定 8 列(列 id=字段名;桌面按 columns[0] 取条目名、按 type='calendarDate' 找日期列):
 *   name / date(锚点 `YYYY-MM-DD[THH:mm][/end]`) / repeat(''=一次性;`^\d+[hd]$` 从锚点滚动)
 *   / auto / prompt / description / todo / lastRun(引擎写回)
 *
 * 到期判定 = 锚点算术(见 dueEntries):停机再久只补最近一次;once 触发后改期到未来自动复活;
 * 时钟回拨静默等待不重复。'd' 用固定 24h(中国无 DST;跨 DST 地区本地时刻漂移 1h,可接受)。
 * ⚠️日期解析绝不 Date.parse('YYYY-MM-DD')——那是 UTC 午夜(桌面 calDate.ts 同款结论),
 * 一律手工拆分量构造本地 Date。
 *
 * 该文件不进云同步(agentFileSync 白名单不含它)、不影响 agent 名册缓存(dirStamp 只看 config/SOUL)。
 * DbFile 类型镜像 desktop shared/amadeus/db/schema.ts(与 tools/builtin/amadeus.ts 同一先例,
 * 刻意不 import 工具层)。
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { agentsDir } from '../core/tanguHome.js';

// ── DbFile 最小镜像(desktop schema.ts;zod 在桌面侧,这里结构性容错即可) ────────
export type CellValue = string | number | boolean | string[] | null;
export interface DbColumn { id: string; name: string; type: string; options?: string[] }
export interface DbRow { id: string; cells: Record<string, CellValue> }
export interface DbFile { version: number; name: string; columns: DbColumn[]; rows: DbRow[] }

/** calendarDate 单侧编码:YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。 */
const DATE_SIDE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const REPEAT_RE = /^(\d+)([hd])$/;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const MAX_ENTRIES = 200;

export const scheduleFile = (slug: string): string => join(agentsDir(), slug, 'SCHEDULE.db');

const SCHEDULE_COLUMNS: DbColumn[] = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'date', name: 'Date', type: 'calendarDate' },
  { id: 'repeat', name: 'Repeat', type: 'text' },
  { id: 'auto', name: 'Auto', type: 'checkbox' }, // 基础 checkbox(勿用注册类型 'todo'——防误入 Todo 视图聚合)
  { id: 'prompt', name: 'Prompt', type: 'text' },
  { id: 'description', name: 'Description', type: 'text' },
  { id: 'todo', name: 'Todo', type: 'checkbox' },
  { id: 'lastRun', name: 'Last Run', type: 'text' },
];

export interface ScheduleEntry {
  id: string;
  name: string;
  /** calendarDate 编码 `start[/end]`;''=无日期(纯备注,不上日历不触发)。 */
  date: string;
  /** ''=一次性;`\d+[hd]`(1h/1d/3d…)=从 date 锚点按间隔滚动。 */
  repeat: string;
  /** true=到点由 automation 管道无人值守执行 prompt。 */
  auto: boolean;
  prompt: string;
  description: string;
  todo: boolean;
  /** 上次实际执行的 ISO 时刻;''=从未。引擎写回,数据自含(agent 可见)。 */
  lastRun: string;
}

// ── 落盘 ─────────────────────────────────────────────────────────────────────

/** 读某 agent 的日程;无文件 → null;文件损坏 → null(不覆盖,写入方报错保数据)。 */
export async function loadSchedule(slug: string): Promise<DbFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(scheduleFile(slug), 'utf8');
  } catch {
    return null; // 无文件是常态
  }
  try {
    const db = JSON.parse(raw);
    if (!db || !Array.isArray(db.columns) || !Array.isArray(db.rows)) return null;
    return db as DbFile;
  } catch {
    return null; // 损坏:读侧当不存在,ensure/upsert 侧区分处理
  }
}

export async function saveSchedule(slug: string, db: DbFile): Promise<void> {
  await fs.mkdir(join(agentsDir(), slug), { recursive: true });
  await fs.writeFile(scheduleFile(slug), `${JSON.stringify(db, null, 2)}\n`, 'utf8');
}

/**
 * 确保日程文件存在且可解析:无文件 → 建 8 列骨架;存在但损坏 → 报错(不覆盖用户数据)。
 */
export async function ensureScheduleDb(slug: string, agentName?: string): Promise<DbFile> {
  const existing = await loadSchedule(slug);
  if (existing) return existing;
  let broken = false;
  try { await fs.access(scheduleFile(slug)); broken = true; } catch { /* 不存在 → 正常新建 */ }
  if (broken) throw new Error(`SCHEDULE.db of "${slug}" exists but is not valid JSON; fix or remove it first`);
  const db: DbFile = {
    version: 1,
    name: `${agentName || slug} Schedule`,
    columns: SCHEDULE_COLUMNS.map((c) => ({ ...c })),
    rows: [],
  };
  await saveSchedule(slug, db);
  return db;
}

// ── 行 ↔ 结构化条目 ─────────────────────────────────────────────────────────

function cellStr(v: CellValue | undefined): string {
  if (v == null) return '';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export function entriesOf(db: DbFile): ScheduleEntry[] {
  return db.rows.map((r) => ({
    id: r.id,
    name: cellStr(r.cells.name).trim(),
    date: cellStr(r.cells.date).trim(),
    repeat: cellStr(r.cells.repeat).trim(),
    auto: r.cells.auto === true,
    prompt: cellStr(r.cells.prompt),
    description: cellStr(r.cells.description),
    todo: r.cells.todo === true,
    lastRun: cellStr(r.cells.lastRun),
  }));
}

// ── 校验(manage_schedule 工具与 HTTP 路由共用) ───────────────────────────────

export interface ScheduleEntryInput {
  name?: unknown;
  date?: unknown;
  repeat?: unknown;
  auto?: unknown;
  prompt?: unknown;
  description?: unknown;
  todo?: unknown;
}

export interface ValidatedEntry {
  name: string;
  date: string;
  repeat: string;
  auto: boolean;
  prompt: string;
  description: string;
  todo: boolean;
}

function validDate(s: string): boolean {
  const [start, end, extra] = s.split('/');
  if (extra !== undefined) return false;
  if (!DATE_SIDE_RE.test(start)) return false;
  return end === undefined || DATE_SIDE_RE.test(end);
}

/**
 * 纯校验。opts.slug 用于 muse 特判:Muse 的既有安全设计=planMode+add_muse_todo 是唯一
 * 对用户的写通道,auto 日程会经 automation 管道拿到 full-auto,绕穿该防线 → 拒绝
 * (纯规划条目允许;Muse 到点做事走既有 daily_at 盯任务)。
 */
export function validateEntryInput(input: ScheduleEntryInput, opts: { slug?: string } = {}):
  | { ok: true; value: ValidatedEntry }
  | { ok: false; error: string } {
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'name is required (calendar entries with an empty name are invisible)' };
  const date = String(input.date || '').trim();
  if (date && !validDate(date)) {
    return { ok: false, error: `invalid date "${date}" (use YYYY-MM-DD or YYYY-MM-DDTHH:mm, optionally /end)` };
  }
  const repeat = String(input.repeat || '').trim();
  if (repeat) {
    const m = REPEAT_RE.exec(repeat);
    const ivl = m ? Number(m[1]) * (m[2] === 'h' ? HOUR : DAY) : 0;
    if (!m || ivl < HOUR || ivl > 365 * DAY) {
      return { ok: false, error: `invalid repeat "${repeat}" (use e.g. 1h / 1d / 3d; min 1h, max 365d)` };
    }
    if (!date) return { ok: false, error: 'repeat requires a date (the anchor to roll from)' };
  }
  const auto = input.auto === true || input.auto === 'true';
  const prompt = String(input.prompt || '').trim().slice(0, 500);
  if (auto) {
    if (!date) return { ok: false, error: 'auto entries need a date' };
    if (!prompt) return { ok: false, error: 'auto entries need a prompt (what to do when due)' };
    if (opts.slug === 'muse') return { ok: false, error: 'muse cannot have auto entries (planning-only); use muse_watch daily_at instead' };
  }
  return {
    ok: true,
    value: {
      name,
      date,
      repeat,
      auto,
      prompt,
      description: String(input.description || '').trim().slice(0, 500),
      todo: input.todo === true || input.todo === 'true',
    },
  };
}

// ── 增删改 ───────────────────────────────────────────────────────────────────

/** upsert:带 id=更新(保留 lastRun 与未知 cells);无 id=新建(MAX_ENTRIES 帽)。 */
export async function upsertEntry(slug: string, v: ValidatedEntry, id?: string, agentName?: string):
  Promise<{ ok: true; entry: ScheduleEntry; created: boolean } | { ok: false; error: string }> {
  const db = await ensureScheduleDb(slug, agentName);
  const patch: Record<string, CellValue> = {
    name: v.name,
    date: v.date,
    repeat: v.repeat,
    auto: v.auto,
    prompt: v.prompt,
    description: v.description,
    todo: v.todo,
  };
  if (id) {
    const row = db.rows.find((r) => r.id === id);
    if (!row) return { ok: false, error: `entry ${id} not found` };
    Object.assign(row.cells, patch);
    await saveSchedule(slug, db);
    return { ok: true, entry: entriesOf(db).find((e) => e.id === id)!, created: false };
  }
  if (db.rows.length >= MAX_ENTRIES) return { ok: false, error: `schedule is full (${MAX_ENTRIES} entries); remove some first` };
  const row: DbRow = { id: `s-${randomUUID().slice(0, 6)}`, cells: { ...patch, lastRun: '' } };
  db.rows.push(row);
  await saveSchedule(slug, db);
  return { ok: true, entry: entriesOf(db).find((e) => e.id === row.id)!, created: true };
}

export async function removeEntry(slug: string, id: string): Promise<boolean> {
  const db = await loadSchedule(slug);
  if (!db) return false;
  const next = db.rows.filter((r) => r.id !== id);
  if (next.length === db.rows.length) return false;
  db.rows = next;
  await saveSchedule(slug, db);
  return true;
}

/** 触发后写回 lastRun(重读最新再只改一格,收窄与工具/路由并发写的覆盖面)。 */
export async function markEntryFired(slug: string, rowId: string, at = new Date()): Promise<void> {
  const db = await loadSchedule(slug);
  const row = db?.rows.find((r) => r.id === rowId);
  if (!db || !row) return;
  row.cells.lastRun = at.toISOString();
  await saveSchedule(slug, db);
}

// ── 到期判定(纯函数,测试注入 now) ────────────────────────────────────────────

export function parseRepeat(s: string): number | null {
  const m = REPEAT_RE.exec(s);
  if (!m) return null;
  const ivl = Number(m[1]) * (m[2] === 'h' ? HOUR : DAY);
  return ivl >= HOUR && ivl <= 365 * DAY ? ivl : null;
}

/** 取 date 的 start 侧,手工拆分量构造**本地**时刻(all-day=本地 00:00)。非法 → null。 */
export function parseLocalCalStart(date: string): Date | null {
  const start = date.split('/')[0];
  if (!DATE_SIDE_RE.test(start)) return null;
  const [d, t] = start.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mm] = t ? t.split(':').map(Number) : [0, 0];
  return new Date(y, mo - 1, da, hh, mm);
}

/**
 * 本轮到期的 auto 条目。锚点算术:
 *   once:   now≥due0 且 (无 lastRun 或 lastRun<due0) —— 触发后改期到未来自动复活;
 *   repeat: latest = due0 + floor((now-due0)/ivl)*ivl(≤now 的最近应触时刻),latest>lastRun 即到期
 *           —— 停机再久只补最近一次;时钟回拨时 latest≤lastRun,静默等待不重复。
 */
export function dueEntries(entries: ScheduleEntry[], now: Date = new Date()): ScheduleEntry[] {
  const nowMs = now.getTime();
  const fired: ScheduleEntry[] = [];
  for (const e of entries) {
    if (!e.auto || !e.date) continue;
    const due0 = parseLocalCalStart(e.date);
    if (!due0) continue;
    const due0Ms = due0.getTime();
    const last = e.lastRun ? Date.parse(e.lastRun) : NaN;
    if (e.repeat) {
      const ivl = parseRepeat(e.repeat);
      if (!ivl || nowMs < due0Ms) continue;
      const latest = due0Ms + Math.floor((nowMs - due0Ms) / ivl) * ivl;
      if (Number.isNaN(last) || latest > last) fired.push(e);
    } else if (nowMs >= due0Ms && (Number.isNaN(last) || last < due0Ms)) {
      fired.push(e);
    }
  }
  return fired;
}

/** 条目的下一次应触/日程时刻(激活注入与展示用;once 返回锚点本身,过期与否由调用方过滤)。 */
export function nextDueAt(e: ScheduleEntry, from: Date): Date | null {
  const due0 = parseLocalCalStart(e.date);
  if (!due0) return null;
  if (!e.repeat) return due0;
  const ivl = parseRepeat(e.repeat);
  if (!ivl) return null;
  if (from.getTime() <= due0.getTime()) return due0;
  const k = Math.ceil((from.getTime() - due0.getTime()) / ivl);
  return new Date(due0.getTime() + k * ivl);
}

/**
 * 激活注入用的近期日程行(未来 `days` 天窗口,≤`max` 条)。刻意以**今天 0 点**为锚、
 * 不含相对时间词/lastRun —— 文本只在条目集变化或跨天时变,不打穿 prompt 前缀缓存。
 */
export function upcomingScheduleLines(entries: ScheduleEntry[], now: Date = new Date(), days = 7, max = 8): string[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const horizon = dayStart.getTime() + days * DAY;
  const p = (x: number): string => String(x).padStart(2, '0');
  const items: { at: number; line: string }[] = [];
  for (const e of entries) {
    if (!e.name || !e.date) continue;
    const next = nextDueAt(e, dayStart);
    if (!next) continue;
    const at = next.getTime();
    if (at < dayStart.getTime() || at >= horizon) continue;
    const hasTime = e.date.split('/')[0].includes('T');
    const when = `${p(next.getMonth() + 1)}-${p(next.getDate())}${hasTime ? ` ${p(next.getHours())}:${p(next.getMinutes())}` : ''}`;
    const tags = [e.repeat ? `every ${e.repeat}` : '', e.auto ? 'auto' : ''].filter(Boolean).join(', ');
    items.push({ at, line: `- ${when} ${e.name}${tags ? ` (${tags})` : ''}${e.description ? ` — ${e.description.slice(0, 80)}` : ''}` });
  }
  return items.sort((a, b) => a.at - b.at).slice(0, max).map((i) => i.line);
}
