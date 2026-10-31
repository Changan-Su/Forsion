/**
 * 小组件(Widget):有名字、有原件的 Intelligent UI 卡,对话、仪表盘、卡片区引用同一份。方案页 docs/ToBeImproved/Widget与Dashboard方案_2026-10-30/storage.html。
 * 定义(普通文件,跟归属走)和记录(data.db,按行合并)分开放;点开头的两条同步都不走,这是故意的:
 *
 *   Agent 级  agents/<slug>/Library/Widgets/<name>/   记录 agents/<slug>/WidgetData/<id>/data.db
 *   项目级    <项目>/.tangu/widgets/<name>/           记录 human/WidgetData/<id>/data.db(数据跟人,不进仓库)
 *   用户级    human/Widgets/<name>/                   记录 human/WidgetData/<id>/data.db
 *
 *   <name>/widget.html 或 widget.json、manifest.json(id、rev、deletedAt…)、.local.json(这台设备的界面状态)、.history/(最近 20 版)
 *
 * ⚠️记录绝不放进 Library/:投稿快照(server isShareable)带走整个 Library。
 * ⚠️按 id 找,name 只用来找;新建撞名不覆盖;改原件带 expectedRev。
 * ⚠️读失败 ≠ 空:manifest / data.db 读不了一律报错,不当「没有」往下走,更不写回。没有 data.db 才是还没记过(或这台设备还没同步到)。
 * 写在归属文件夹那把跨进程锁里做完(同步落盘用的同一把):同步刚合进来的行,不会被手里的旧份盖掉。
 * 老同步(agentFileSync)和新同步(Extend contentSync)对这些文件都不用额外适配;删除不靠哪条管线的删除行为,所以是软删除。
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir, humanDir, tanguHome, WORKSPACE_DIR_NAME } from '../core/tanguHome.js';
import { assertSyncPath, atomicSyncWrite, readSyncBytes, validSyncSlug } from './agentSyncPaths.js';
import { withMemoryDirectoryLockRetry } from './memoryRepository.js';
import type { CellValue, DbFile, DbRow } from './agentSchedule.js';

export const WIDGET_DEF_MAX_BYTES = 256 * 1024;
/** 同步单文件上限 5 MB,留出两台设备合并后变大的余量。 */
export const WIDGET_DATA_MAX_BYTES = 4 * 1024 * 1024;
const HISTORY_KEEP = 20;
const TRASH_MS = 30 * 24 * 3600_000;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // 和 isWidgetDataPath 的 id 段同一条
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_RE = /^[\p{L}\p{N}_ -]{1,64}$/u;

export class WidgetError extends Error {}

export type WidgetScope = 'project' | 'agent' | 'user';
export type WidgetEntry = 'widget.html' | 'widget.json';
export interface WidgetManifest {
  schemaVersion: 1; id: string; rev: number; name: string; title: string; entry: WidgetEntry;
  sizes?: string[]; rail?: boolean; summary?: string; createdAt: string; updatedAt: string; deletedAt?: string;
}
/** 这次调用看得到哪几层。项目边界沿用会话存档的项目(模型给不了);云沙箱和手机没有项目级。 */
export interface WidgetPlace { agentSlug: string; projectDir?: string | null }
export interface WidgetInfo { scope: WidgetScope; dir: string; manifest: WidgetManifest }

interface Level { scope: WidgetScope; root: string; defs: string; lock: string }
interface Located extends WidgetInfo { level: Level }

const agentLevel = (slug: string): Level => { const dir = join(agentsDir(), slug); return { scope: 'agent', root: agentsDir(), defs: join(dir, 'Library', 'Widgets'), lock: dir }; };
const userLevel = (): Level => ({ scope: 'user', root: tanguHome(), defs: join(humanDir(), 'Widgets'), lock: humanDir() });
/** 就近优先:项目 → Agent → 用户,和项目技能压过全局同一个方向。 */
function levels(place: WidgetPlace): Level[] {
  const out: Level[] = [];
  if (place.projectDir) { const defs = join(place.projectDir, WORKSPACE_DIR_NAME, 'widgets'); out.push({ scope: 'project', root: place.projectDir, defs, lock: defs }); }
  if (validSyncSlug(place.agentSlug)) out.push(agentLevel(place.agentSlug));
  return [...out, userLevel()];
}

const nowIso = (now = Date.now()): string => new Date(now).toISOString();
const manifestText = (m: WidgetManifest): string => `${JSON.stringify(m, null, 2)}\n`;
const isIso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
function validManifest(m: any): m is WidgetManifest {
  return !!m && typeof m === 'object' && typeof m.id === 'string' && ID_RE.test(m.id) && Number.isInteger(m.rev) && m.rev > 0
    && typeof m.title === 'string' && (m.entry === 'widget.html' || m.entry === 'widget.json') && (m.deletedAt === undefined || isIso(m.deletedAt));
}
/** 文件夹在、manifest 读不了(坏了、还没同步到)也算「有」:这个名字被占着,不是空位。 */
function load(level: Level, name: string): Located | null {
  const dir = assertSyncPath(level.root, join(level.defs, name));
  try { if (!lstatSync(dir).isDirectory()) throw new WidgetError(`${name}: not a widget folder`); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const bytes = readSyncBytes(level.root, join(dir, 'manifest.json'));
  if (!bytes) throw new WidgetError(`widget folder "${name}" has no manifest.json yet (still syncing, or damaged)`);
  let m: unknown;
  try { m = JSON.parse(bytes.toString('utf8')); } catch { throw new WidgetError(`manifest.json of "${name}" cannot be read`); }
  if (!validManifest(m)) throw new WidgetError(`manifest.json of "${name}" is not valid`);
  return { scope: level.scope, dir, level, manifest: { ...m, name } }; // 名字以文件夹为准:别人手动改了文件夹名,manifest 里那份过期了
}
function names(level: Level): string[] {
  const defs = assertSyncPath(level.root, level.defs);
  try { return readdirSync(defs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

export interface WidgetListing { widgets: WidgetInfo[]; unreadable: Array<{ scope: WidgetScope; name: string; error: string }> }
export function listWidgets(place: WidgetPlace): WidgetListing {
  const out: WidgetListing = { widgets: [], unreadable: [] };
  for (const level of levels(place)) for (const name of names(level)) {
    try { const w = load(level, name); if (w) out.widgets.push(w); }
    catch (e) { out.unreadable.push({ scope: level.scope, name, error: (e as Error).message }); }
  }
  return out;
}
export function findWidgetByName(place: WidgetPlace, name: string): WidgetInfo | null {
  if (!NAME_RE.test(name)) throw new WidgetError(`invalid widget name "${name}"`);
  for (const level of levels(place)) { const w = load(level, name); if (w) return w; }
  return null;
}
/** 同一个 id 出现在两层(搬家断在半路,或仓库里带来一份同 id 的定义):拒绝,不猜该用哪份、也不让它读写另一份的记录。 */
function locate(place: WidgetPlace, id: string): Located {
  if (!ID_RE.test(id)) throw new WidgetError(`invalid widget id "${id}"`);
  const { widgets, unreadable } = listWidgets(place);
  const hits = widgets.filter((w) => w.manifest.id === id) as Located[];
  if (hits.length > 1) throw new WidgetError(`widget ${id} has two copies (${hits.map((w) => w.scope).join(', ')}); resolve that before changing it`);
  if (hits[0]) return hits[0];
  if (unreadable.length) throw new WidgetError(`widget ${id} not found, and ${unreadable.length} widget folder(s) could not be read: ${unreadable.map((u) => u.name).join(', ')}`);
  throw new WidgetError(`widget ${id} not found`);
}
export const readWidget = (place: WidgetPlace, id: string): WidgetInfo => locate(place, id);
export function readWidgetContent(w: WidgetInfo): string {
  const level = (w as Located).level;
  const bytes = readSyncBytes(level.root, join(w.dir, w.manifest.entry));
  if (!bytes) throw new WidgetError(`${w.manifest.entry} of "${w.manifest.name}" is missing`);
  return bytes.toString('utf8');
}

function checkDefSize(content: string): void {
  const size = Buffer.byteLength(content);
  if (size > WIDGET_DEF_MAX_BYTES) throw new WidgetError(`widget too large (${size} bytes, max ${WIDGET_DEF_MAX_BYTES})`);
}

export interface CreateWidgetInput { name: string; title?: string; entry: WidgetEntry; content: string; scope?: 'user'; sizes?: string[]; rail?: boolean; summary?: string }
/** 会话在项目里 → 项目级;不在 → 这个 Agent;用户级只在点名时。撞名(含软删除的)不覆盖,返回已有的那张。
 *  先写进点开头的临时文件夹再整个改名:半截文件既不会被同步带走,也不会占住名字。 */
export async function createWidget(place: WidgetPlace, input: CreateWidgetInput): Promise<{ created: boolean; widget: WidgetInfo }> {
  if (!NAME_RE.test(input.name)) throw new WidgetError('widget name must be a lowercase slug such as "tokyo-ledger"');
  checkDefSize(input.content);
  const existing = findWidgetByName(place, input.name);
  if (existing) return { created: false, widget: existing };
  const all = levels(place);
  const level = input.scope === 'user' ? all[all.length - 1] : all[0];
  assertSyncPath(level.root, level.defs);
  return withMemoryDirectoryLockRetry(level.lock, () => {
    const raced = load(level, input.name);
    if (raced) return { created: false, widget: raced };
    const id = `w_${randomBytes(6).toString('hex')}`, at = nowIso();
    const manifest: WidgetManifest = { schemaVersion: 1, id, rev: 1, name: input.name, title: input.title?.trim() || input.name, entry: input.entry, ...(input.sizes?.length ? { sizes: input.sizes } : {}), ...(input.rail ? { rail: true } : {}), ...(input.summary ? { summary: input.summary } : {}), createdAt: at, updatedAt: at };
    mkdirSync(level.defs, { recursive: true });
    assertSyncPath(level.root, level.defs);
    const temp = join(level.defs, `.tmp-${id}`), dir = join(level.defs, input.name);
    try {
      atomicSyncWrite(level.root, join(temp, input.entry), input.content);
      atomicSyncWrite(level.root, join(temp, 'manifest.json'), manifestText(manifest));
      renameSync(temp, dir);
    } finally { rmSync(temp, { recursive: true, force: true }); }
    return { created: true, widget: { scope: level.scope, dir, level, manifest } as Located };
  });
}

export interface WidgetEdit { find: string; replace: string }
/** 整批校验:每条 find 在当时的文本里恰好出现一次,一条不中就抛错,什么都不落盘。 */
export function applyEdits(text: string, edits: WidgetEdit[]): string {
  let out = text;
  edits.forEach((e, i) => {
    if (typeof e?.find !== 'string' || typeof e?.replace !== 'string' || !e.find) throw new WidgetError(`edits[${i}]: find and replace are required`);
    const first = out.indexOf(e.find);
    if (first < 0) throw new WidgetError(`edits[${i}]: find text not found; nothing was saved`);
    if (out.indexOf(e.find, first + 1) >= 0) throw new WidgetError(`edits[${i}]: find text matches more than once; add surrounding text; nothing was saved`);
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
  });
  return out;
}

export type UpdateResult = { ok: true; widget: WidgetInfo; fromRev: number } | { ok: false; widget: WidgetInfo; content: string };
export interface UpdateWidgetInput { id: string; expectedRev: number; entry?: WidgetEntry; edits?: WidgetEdit[]; content?: string; title?: string; summary?: string }
/** 版本对不上不落盘,交回最新版让模型重新决定。旧版进 .history/(不同步,本机留最近 20 版)。
 *  ⚠️先写 manifest 再写正文:断在中间时 rev 偏高、正文是旧的,下一次改原件只会报过期重读。反过来,没提交的正文会顶着旧 rev 成为下一次 edits 的基线。 */
export async function updateWidget(place: WidgetPlace, input: UpdateWidgetInput): Promise<UpdateResult> {
  const { level, manifest: { name } } = locate(place, input.id);
  return withMemoryDirectoryLockRetry(level.lock, () => {
    const cur = load(level, name);
    if (!cur || cur.manifest.id !== input.id) throw new WidgetError(`widget ${input.id} changed while saving; try again`);
    const m = cur.manifest;
    if (m.deletedAt) throw new WidgetError(`widget "${name}" is deleted; restore it first`);
    if (input.entry && input.entry !== m.entry) throw new WidgetError(`widget "${name}" is ${m.entry}; change it with the matching card tool`);
    const old = readWidgetContent(cur);
    if (m.rev !== input.expectedRev) return { ok: false, widget: cur, content: old };
    const content = input.edits ? applyEdits(old, input.edits) : input.content;
    if (typeof content !== 'string') throw new WidgetError('edits or new content is required');
    checkDefSize(content);
    const history = join(cur.dir, '.history');
    const ext = m.entry === 'widget.html' ? '.html' : '.json';
    atomicSyncWrite(level.root, join(history, `${m.rev}${ext}`), old);
    const kept = readdirSync(history).filter((f) => /^\d+\./.test(f)).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    for (const f of kept.slice(HISTORY_KEEP)) rmSync(join(history, f), { force: true });
    const next: WidgetManifest = { ...m, rev: m.rev + 1, updatedAt: nowIso(), ...(input.title?.trim() ? { title: input.title.trim() } : {}), ...(input.summary ? { summary: input.summary } : {}) };
    atomicSyncWrite(level.root, join(cur.dir, 'manifest.json'), manifestText(next));
    atomicSyncWrite(level.root, join(cur.dir, m.entry), content);
    return { ok: true, widget: { ...cur, manifest: next } as Located, fromRev: m.rev };
  });
}

interface DataFile { root: string; lock: string; file: string }
function dataOf(w: WidgetInfo): DataFile {
  const owner = w.scope === 'agent' ? (w as Located).level.lock : humanDir();
  return { root: w.scope === 'agent' ? agentsDir() : tanguHome(), lock: owner, file: join(owner, 'WidgetData', w.manifest.id, 'data.db') };
}
function parseData(text: string): DbFile {
  let db: any;
  try { db = JSON.parse(text); } catch { throw new WidgetError('data.db cannot be read; it was left untouched'); }
  if (!db || !Array.isArray(db.columns) || !Array.isArray(db.rows) || db.rows.some((r: any) => typeof r?.id !== 'string' || !r.cells || typeof r.cells !== 'object')) throw new WidgetError('data.db is not a records file; it was left untouched');
  return db;
}
const dataText = (db: DbFile): string => `${JSON.stringify(db, null, 2)}\n`;

/** status 'none' = 这台设备上还没有 data.db:没记过,或还没同步到。不等于「记录是空的」。 */
export function readRecords(w: WidgetInfo): { status: 'ok' | 'none'; rows: DbRow[] } {
  const { root, file } = dataOf(w);
  const bytes = readSyncBytes(root, file);
  return bytes ? { status: 'ok', rows: parseData(bytes.toString('utf8')).rows } : { status: 'none', rows: [] };
}

function validCell(v: unknown): v is CellValue {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}
const columnType = (v: CellValue): string => typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'checkbox' : Array.isArray(v) ? 'multiselect' : 'text';

/** 记一行或改一行(只动给到的字段)。列 id 就是字段名:两台设备写同一个字段落在同一列上。一条记录一行,两边各记一笔不会撞。 */
export async function setRecord(place: WidgetPlace, id: string, fields: Record<string, unknown>, recordId?: string): Promise<{ id: string; created: boolean }> {
  const keys = Object.keys(fields ?? {});
  if (!keys.length) throw new WidgetError('a record needs at least one field');
  for (const k of keys) {
    if (!FIELD_RE.test(k) || k === '__proto__') throw new WidgetError(`invalid field name "${k}"`);
    if (!validCell(fields[k])) throw new WidgetError(`field "${k}" must be text, a number, true/false, a list of text or null`);
  }
  if (recordId !== undefined && !ID_RE.test(recordId)) throw new WidgetError(`invalid record id "${recordId}"`);
  const w = locate(place, id);
  if (w.manifest.deletedAt) throw new WidgetError(`widget "${w.manifest.name}" is deleted; restore it first`);
  const { root, lock, file } = dataOf(w);
  return withMemoryDirectoryLockRetry(lock, () => {
    const bytes = readSyncBytes(root, file);
    const db: DbFile = bytes ? parseData(bytes.toString('utf8')) : { version: 2, name: w.manifest.title, columns: [], rows: [] };
    const rowId = recordId ?? `r_${randomBytes(6).toString('hex')}`;
    const row = db.rows.find((r) => r.id === rowId);
    if (!row && recordId !== undefined) throw new WidgetError(`record ${recordId} not found`);
    for (const k of keys) if (!db.columns.some((c) => c.id === k)) db.columns.push({ id: k, name: k, type: columnType(fields[k] as CellValue) });
    if (row) Object.assign(row.cells, fields);
    else db.rows.push({ id: rowId, cells: { ...fields } as Record<string, CellValue> });
    const text = dataText(db);
    if (Buffer.byteLength(text) > WIDGET_DATA_MAX_BYTES) throw new WidgetError(`records are full (max ${WIDGET_DATA_MAX_BYTES} bytes); nothing was saved`);
    atomicSyncWrite(root, file, text);
    return { id: rowId, created: !row };
  });
}
export async function deleteRecord(place: WidgetPlace, id: string, recordId: string): Promise<boolean> {
  const w = locate(place, id);
  const { root, lock, file } = dataOf(w);
  return withMemoryDirectoryLockRetry(lock, () => {
    const bytes = readSyncBytes(root, file);
    if (!bytes) return false;
    const db = parseData(bytes.toString('utf8'));
    const rows = db.rows.filter((r) => r.id !== recordId);
    if (rows.length === db.rows.length) return false;
    atomicSyncWrite(root, file, dataText({ ...db, rows }));
    return true;
  });
}

/** 软删除:manifest 写 deletedAt,随同步到所有设备,30 天内能恢复。rev 不动:删除不是改内容。 */
export async function softDeleteWidget(place: WidgetPlace, id: string): Promise<WidgetInfo> {
  const { level, manifest: { name } } = locate(place, id);
  return withMemoryDirectoryLockRetry(level.lock, () => {
    const cur = load(level, name);
    if (!cur || cur.manifest.id !== id) throw new WidgetError(`widget ${id} changed while saving; try again`);
    const manifest = { ...cur.manifest, deletedAt: cur.manifest.deletedAt ?? nowIso() };
    atomicSyncWrite(level.root, join(cur.dir, 'manifest.json'), manifestText(manifest));
    return { ...cur, manifest } as Located;
  });
}
/** 恢复时给每份同步的文件都改一个字节(行尾空行,内容不变):离线的另一台设备过了 30 天、还没拉到这次恢复就清掉了本地文件,
 *  它的删除要撞上这里新的版本才会输(两条同步都是编辑胜删除);不改的话没动过的正文和记录会被它从云端删掉。
 *  ponytail: 恢复的这台没有 data.db 就改不了字节,记录挡不住那次过期清理;要等清理改成先看云端(软删除状态)才算全堵上。 */
export async function restoreWidget(place: WidgetPlace, id: string): Promise<WidgetInfo> {
  const w = locate(place, id);
  if (!w.manifest.deletedAt) return w;
  const data = dataOf(w);
  await withMemoryDirectoryLockRetry(data.lock, () => {
    const bytes = readSyncBytes(data.root, data.file);
    if (bytes) atomicSyncWrite(data.root, data.file, Buffer.concat([bytes, Buffer.from('\n')]));
  });
  const { level, manifest: { name } } = w as Located;
  return withMemoryDirectoryLockRetry(level.lock, () => {
    const cur = load(level, name);
    if (!cur || cur.manifest.id !== id) throw new WidgetError(`widget ${id} changed while saving; try again`);
    atomicSyncWrite(level.root, join(cur.dir, cur.manifest.entry), `${readWidgetContent(cur)}\n`);
    const { deletedAt: _gone, ...rest } = cur.manifest;
    atomicSyncWrite(level.root, join(cur.dir, 'manifest.json'), manifestText(rest));
    return { ...cur, manifest: rest } as Located;
  });
}

/** 过了 30 天的软删除才真删文件。读不了的不碰;只清定义和它自己的记录,找不到定义的记录不算孤儿(项目可能不在这台设备上)。
 *  ponytail: 启动时扫 Agent 和用户两层,常驻进程下次重启才清;项目级留着(删的是别人仓库里的文件,要等管理页让人点)。 */
export async function purgeExpiredWidgets(now = Date.now()): Promise<number> {
  let slugs: string[] = [];
  try { slugs = readdirSync(agentsDir()).filter(validSyncSlug); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let purged = 0;
  for (const level of [...slugs.map(agentLevel), userLevel()]) {
    for (const name of names(level)) {
      const expired = (w: Located | null): w is Located => !!w?.manifest.deletedAt && now - Date.parse(w.manifest.deletedAt) > TRASH_MS;
      try {
        if (!expired(load(level, name))) continue;
        await withMemoryDirectoryLockRetry(level.lock, () => {
          const w = load(level, name);
          if (!expired(w)) return;
          const data = dataOf(w);
          rmSync(assertSyncPath(data.root, join(data.file, '..')), { recursive: true, force: true });
          rmSync(w.dir, { recursive: true, force: true });
          purged++;
        });
      } catch (e) { console.warn(`[widgets] purge skipped ${name}:`, (e as Error).message); }
    }
  }
  return purged;
}
