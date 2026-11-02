/**
 * 每-agent 日程 —— `agents/<slug>/CALENDAR.db`(Amadeus DbFile JSON,桌面 Calendar Space 直接渲染;2026-10-20 前叫 SCHEDULE.db,
 * 引擎第一次碰到就改名,见 migrateUnlocked)。
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
 * 2026-10-20 起跟着 Agent 上云(agentFileSync,服务端认 agent-calendar 才同步;两台都改了按行 id 合并)。到点执行只在排它的那台:
 * 每行一个看不见的 cells.device(不是列),新建时盖本机,到期评估只放行本机的(ranHere)—— 和上云前「每台各有一份」的行为一样。
 * 读—改—写在 Agent 文件夹那把跨进程锁(同步落盘用的同一把)里一次做完、原子落盘:同步刚合并进来的别的设备的行,不会被手里的旧份盖掉。
 * 不影响 agent 名册缓存(dirStamp 只看 config/SOUL)。
 * DbFile 类型镜像 desktop shared/amadeus/db/schema.ts(与 tools/builtin/amadeus.ts 同一先例,
 * 刻意不 import 工具层)。
 */
import { promises as fs, existsSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { agentsDir } from '../core/tanguHome.js';
import { getDeviceId } from '../core/deviceId.js';
import { atomicSyncWrite, conflictCopyName, readSyncBytes } from './agentSyncPaths.js';
import { withMemoryDirectoryLock, withMemoryDirectoryLockRetry } from './memoryRepository.js';
import { mergeDbFile } from './dbRowMerge.js';

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

export const scheduleFile = (slug: string): string => join(agentsDir(), slug, 'CALENDAR.db');
/** 2.13.4 及以前的名字。降级回去的老引擎看不到改名后的文件,从空日程开始(数据还在 CALENDAR.db)。 */
const legacyScheduleFile = (slug: string): string => join(agentsDir(), slug, 'SCHEDULE.db');

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
  /** 排它的那台设备(getDeviceId);''=上云前的老行,哪台都放行。 */
  device: string;
}

/** auto 条目只在排它的那台到点执行。ponytail: 那台设备不用了,它排的自动条目就不再跑;要改派再做「改到这台执行」。 */
export const ranHere = (e: ScheduleEntry): boolean => !e.device || e.device === getDeviceId();
/** 本机该跑的到期条目(普通 Agent 的 automation 管道和 Muse 的周期共用):别的设备排的在那台跑。 */
export const dueHere = (entries: ScheduleEntry[], now: Date = new Date()): ScheduleEntry[] => dueEntries(entries.filter(ranHere), now);

// ── 落盘 ─────────────────────────────────────────────────────────────────────

const parseDb = (raw: string): DbFile | null => {
  try { const db = JSON.parse(raw); return db && Array.isArray(db.columns) && Array.isArray(db.rows) ? db as DbFile : null; } catch { return null; }
};
const serialize = (db: DbFile): string => `${JSON.stringify(db, null, 2)}\n`;
const readText = (file: string): string | null => readSyncBytes(agentsDir(), file)?.toString('utf8') ?? null;

/** 在 Agent 文件夹那把跨进程锁里同步跑 fn(锁被同步 / 别的进程拿着就稍等重试,约 1 秒后放弃)。 */
const locked = <T>(slug: string, fn: () => T): Promise<T> => withMemoryDirectoryLockRetry(join(agentsDir(), slug), fn);

/** SCHEDULE.db → CALENDAR.db(须已拿着锁)。改名前每台只有自己的行,所以没盖章的行都盖本机;
 *  CALENDAR.db 已经在了(别的设备先推了一份下来)就按行并集合进去再删旧名;合不了(哪份坏了)两份都不动,读侧回落旧名。 */
function migrateUnlocked(slug: string): void {
  const legacy = legacyScheduleFile(slug), file = scheduleFile(slug);
  const old = readText(legacy);
  if (old === null) return;
  const db = parseDb(old);
  if (db) for (const r of db.rows) if (!r.cells.device) r.cells.device = getDeviceId();
  const stamped = db ? serialize(db) : old; // 坏文件原样改名:数据留着,ensure 照旧报「不是合法 JSON」
  const cur = readText(file);
  const merged = cur === null ? { content: stamped } : db ? mergeDbFile(stamped, null, cur) : null;
  if (!merged) { console.warn(`[schedule] ${slug}: SCHEDULE.db and CALENDAR.db cannot be merged; left both in place`); return; }
  atomicSyncWrite(agentsDir(), file, cur === null ? merged.content : keepLatestRuns(merged.content, stamped, cur)); // 同一行冲突:跑过的那次不能被另一份的空 lastRun 盖掉
  // 同一行两份写得不一样(合并取了 CALENDAR.db 那份):旧名那份留成冲突副本,不默默丢
  if ('conflict' in merged && merged.conflict) renameSync(legacy, join(agentsDir(), slug, conflictCopyName('SCHEDULE.db', new Date())));
  else unlinkSync(legacy);
}
/** 同步合并之后调(agentFileSync):同一行两台都改了(一台到点写了 lastRun、另一台改了描述),合并取了一边的整行;
 *  lastRun 取各份里最晚的那个,免得排它的那台把同一次再跑一遍。ISO 串按字典序比就是按时间比。 */
export function keepLatestRuns(merged: string, ...sides: string[]): string {
  const db = parseDb(merged);
  if (!db) return merged;
  const latest = new Map<string, string>();
  for (const side of sides) {
    for (const r of parseDb(side)?.rows ?? []) {
      const v = r.cells?.lastRun;
      if (typeof v === 'string' && v > (latest.get(r.id) ?? '')) latest.set(r.id, v);
    }
  }
  let changed = false;
  for (const r of db.rows) {
    const v = latest.get(r.id);
    if (v && v > String(r.cells.lastRun ?? '')) { r.cells.lastRun = v; changed = true; }
  }
  return changed ? serialize(db) : merged;
}

/** 同步这个 Agent 之前调(agentFileSync):先改好名,清单里才有 CALENDAR.db。同步的,调用方已在锁外。 */
export function migrateScheduleFile(slug: string): void {
  if (existsSync(legacyScheduleFile(slug))) withMemoryDirectoryLock(join(agentsDir(), slug), () => migrateUnlocked(slug));
}

/** 读某 agent 的日程;无文件 → null;文件损坏 → null(不覆盖,写入方报错保数据)。还没改名(锁被占着)就读旧名。 */
export async function loadSchedule(slug: string): Promise<DbFile | null> {
  if (existsSync(legacyScheduleFile(slug))) await locked(slug, () => migrateUnlocked(slug)).catch(() => {});
  let raw: string;
  try {
    raw = await fs.readFile(scheduleFile(slug), 'utf8');
  } catch {
    try { raw = await fs.readFile(legacyScheduleFile(slug), 'utf8'); } catch { return null; } // 无文件是常态
  }
  return parseDb(raw); // 损坏:读侧当不存在,ensure/upsert 侧区分处理
}

/** 锁里读出当前那份(没有 = null,坏了就抛),交给 fn 改;fn 返回要落的那份才写。 */
function mutate<T>(slug: string, fn: (db: DbFile | null) => { write?: DbFile; value: T }): Promise<T> {
  return locked(slug, () => {
    migrateUnlocked(slug);
    const raw = readText(scheduleFile(slug));
    const db = raw === null ? null : parseDb(raw);
    if (raw !== null && !db) throw new Error(`CALENDAR.db of "${slug}" exists but is not valid JSON; fix or remove it first`);
    const out = fn(db);
    if (out.write) atomicSyncWrite(agentsDir(), scheduleFile(slug), serialize(out.write));
    return out.value;
  });
}

export function saveSchedule(slug: string, db: DbFile): Promise<void> {
  return mutate(slug, () => ({ write: db, value: undefined }));
}

const skeleton = (slug: string, agentName?: string): DbFile => ({
  version: 1,
  name: `${agentName || slug} Schedule`,
  columns: SCHEDULE_COLUMNS.map((c) => ({ ...c })),
  rows: [],
});

/**
 * 确保日程文件存在且可解析:无文件 → 建 8 列骨架;存在但损坏 → 报错(不覆盖用户数据)。
 */
export function ensureScheduleDb(slug: string, agentName?: string): Promise<DbFile> {
  return mutate(slug, (db) => {
    if (db) return { value: db };
    const fresh = skeleton(slug, agentName);
    return { write: fresh, value: fresh };
  });
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
    device: cellStr(r.cells.device),
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
 * 纯校验。opts.slug 保留给调用方标注归属(2026-09-10 前这里对 muse 拒 auto:那时 Muse 跑只读 planMode,
 * auto 日程会经 automation 管道拿到 full-auto 绕穿防线;现在 Muse 按权限档工作,且它的到期条目
 * **不走** automation 管道,而是回灌进 Muse 自己的周期(muse.ts 的 museDueSchedules),预算闸照过)。
 */
export function validateEntryInput(input: ScheduleEntryInput, opts: { slug?: string; maxPrompt?: number } = {}):
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
  // 4000:任务卡「交给 Muse 追踪」把整份自包含任务书放进来(关键的复现步骤/验收条件常在尾部,500 会静默截掉);
  // 到期时它是 kickoff 消息的一部分,不进系统提示(upcomingScheduleLines 只注 name/description)。
  // maxPrompt 只给批准 Muse TODO 那一处放宽(前缀 + 标题 + 4000 字 detail);别的入口不放大 —— 到期条目全拼进同一条 kickoff。
  const prompt = String(input.prompt || '').trim().slice(0, opts.maxPrompt ?? 4000);

  void opts;
  if (auto) {
    if (!date) return { ok: false, error: 'auto entries need a date' };
    if (!prompt) return { ok: false, error: 'auto entries need a prompt (what to do when due)' };
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

type UpsertResult = { ok: true; entry: ScheduleEntry; created: boolean } | { ok: false; error: string };

/** upsert:带 id=更新(保留 lastRun、归属设备与未知 cells);无 id=新建(MAX_ENTRIES 帽),归属本机。 */
export function upsertEntry(slug: string, v: ValidatedEntry, id?: string, agentName?: string): Promise<UpsertResult> {
  return mutate(slug, (db) => upsertIn(db ?? skeleton(slug, agentName), v, id));
}

/** 已有匹配的条目就原样返回,没有才建;整段在锁里 = 并发两次只建一条(批准 TODO 的重试幂等靠它)。 */
export function ensureEntry(slug: string, v: ValidatedEntry, match: (e: ScheduleEntry) => boolean, agentName?: string): Promise<UpsertResult> {
  return mutate(slug, (cur) => {
    const db = cur ?? skeleton(slug, agentName);
    const hit = entriesOf(db).find(match);
    if (hit) return { write: cur ? undefined : db, value: { ok: true as const, entry: hit, created: false } };
    return upsertIn(db, v, undefined);
  });
}

function upsertIn(db: DbFile, v: ValidatedEntry, id?: string): { write?: DbFile; value: UpsertResult } {
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
    if (!row) return { value: { ok: false, error: `entry ${id} not found` } };
    Object.assign(row.cells, patch);
    return { write: db, value: { ok: true, entry: entriesOf(db).find((e) => e.id === id)!, created: false } };
  }
  if (db.rows.length >= MAX_ENTRIES) return { value: { ok: false, error: `schedule is full (${MAX_ENTRIES} entries); remove some first` } };
  const row: DbRow = { id: `s-${randomUUID().slice(0, 6)}`, cells: { ...patch, lastRun: '', device: getDeviceId() } };
  db.rows.push(row);
  return { write: db, value: { ok: true, entry: entriesOf(db).find((e) => e.id === row.id)!, created: true } };
}

export function removeEntry(slug: string, id: string): Promise<boolean> {
  return mutate(slug, (db) => {
    if (!db) return { value: false };
    const next = db.rows.filter((r) => r.id !== id);
    if (next.length === db.rows.length) return { value: false };
    db.rows = next;
    return { write: db, value: true };
  });
}

/** 触发后写回 lastRun(锁里重读最新再只改一格)。 */
export function markEntryFired(slug: string, rowId: string, at = new Date()): Promise<void> {
  return mutate(slug, (db) => {
    const row = db?.rows.find((r) => r.id === rowId);
    if (!db || !row) return { value: undefined };
    row.cells.lastRun = at.toISOString();
    return { write: db, value: undefined };
  });
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
