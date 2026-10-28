/**
 * 回收站(10-28 手动卸载规范 A + D):卸载的 Agent / 技能 / 插件先整份挪进 `<tanguHome>/trash/<id>/`,30 天后引擎自动清掉。
 * 每条一个目录:`meta.json` + `items/<序号>`(原样挪进来的文件或目录,记着原来的绝对路径)。只在本机,不同步。
 * restorer = 谁负责恢复:引擎(Agent、技能、引擎插件)或桌面主进程(Forsion 插件 —— 它知道笔记库在哪、恢复后要重扫插件)。
 * 两边按同一格式写(桌面那份在 desktop/electron/trashWriter.ts,改格式两边一起改);列出、彻底删除、到期清理只在引擎。
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tanguHome } from '../core/tanguHome.js';

export type TrashKind = 'agent' | 'skill' | 'plugin';
export interface TrashItem { from: string; stored: string; role?: string }
export interface TrashEntry {
  id: string;
  kind: TrashKind;
  /** Agent / 技能的 slug、插件 id。 */
  ref: string;
  name: string;
  deletedAt: number;
  size: number;
  restorer: 'engine' | 'desktop';
  items: TrashItem[];
  /** 恢复时要接上的东西(归档的私聊、移出的团队、暂停的自动化、取消选用的 Agent…),各自的恢复逻辑认。 */
  extra?: Record<string, unknown>;
}

export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
export const trashDir = (): string => path.join(tanguHome(), 'trash');
const SAFE_ID = /^[a-z]+-[A-Za-z0-9._-]{1,80}-\d+-[0-9a-f]{8}$/;

export async function pathSize(p: string): Promise<number> {
  const st = await fs.lstat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await fs.readdir(p)) n += await pathSize(path.join(p, e));
  return n;
}

/** 同盘 rename;跨盘(笔记库在网盘 / 外接盘)退回复制后删除。 */
async function move(from: string, to: string): Promise<void> {
  try { await fs.rename(from, to); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/** 挪进回收站;一件都没挪成就不留条目(返回 null)。中途失败把已挪的挪回去再抛。 */
export async function moveToTrash(input: { kind: TrashKind; ref: string; name: string; paths: Array<{ path: string; role?: string }>; extra?: Record<string, unknown>; restorer?: 'engine' | 'desktop' }): Promise<TrashEntry | null> {
  const present: Array<{ path: string; role?: string }> = [];
  for (const p of input.paths) if (await fs.lstat(p.path).catch(() => null)) present.push(p);
  if (!present.length) return null;
  const id = `${input.kind}-${input.ref.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // 回收站要是个软链,卸载就把私有内容挪到链接指向的地方去了:必须是真目录。
  await fs.mkdir(trashDir(), { recursive: true });
  if (!(await fs.lstat(trashDir())).isDirectory()) throw new Error('Trash is not a regular directory');
  const dir = path.join(trashDir(), id);
  await fs.mkdir(path.join(dir, 'items'), { recursive: true });
  const items: TrashItem[] = [];
  let bytes = 0;
  try {
    for (const [i, p] of present.entries()) {
      const stored = `items/${i}`;
      bytes += await pathSize(p.path);
      await move(p.path, path.join(dir, stored));
      items.push({ from: path.resolve(p.path), stored, ...(p.role ? { role: p.role } : {}) });
    }
  } catch (e) {
    for (const it of items.reverse()) await move(path.join(dir, it.stored), it.from).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const entry: TrashEntry = { id, kind: input.kind, ref: input.ref, name: input.name, deletedAt: Date.now(), size: bytes, restorer: input.restorer ?? 'engine', items, ...(input.extra ? { extra: input.extra } : {}) };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(entry, null, 2), 'utf8');
  return entry;
}

export async function readTrash(id: string): Promise<TrashEntry | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    const e = JSON.parse(await fs.readFile(path.join(trashDir(), id, 'meta.json'), 'utf8')) as TrashEntry;
    return e && e.id === id && Array.isArray(e.items) ? e : null;
  } catch { return null; }
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);

/** 东西全被别处挪走了(旧版桌面勾「同时删除相关文件」会把条目里的目录再移进系统废纸篓)的条目不列。 */
export async function listTrash(): Promise<TrashEntry[]> {
  const ids = await fs.readdir(trashDir()).catch(() => [] as string[]);
  const out: TrashEntry[] = [];
  for (const id of ids) {
    const e = await readTrash(id);
    if (e && (await Promise.all(e.items.map((it) => exists(path.join(trashDir(), id, it.stored))))).some(Boolean)) out.push(e);
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** 卸载的后半段(归档私聊、移出团队…)做完再把要恢复的东西记进条目。 */
export async function setTrashExtra(id: string, extra: Record<string, unknown>): Promise<void> {
  const e = await readTrash(id);
  if (!e) return;
  await fs.writeFile(path.join(trashDir(), id, 'meta.json'), JSON.stringify({ ...e, extra: { ...e.extra, ...extra } }, null, 2), 'utf8');
}

/** 原位置被占了就落到「原名-2」「原名-3」…(目录名常常就是 slug,不能带空格括号)。返回每件实际落到哪。
 *  中途失败可重试:已经挪回去的那几件在条目里不存在了,跳过。 */
export async function restoreTrashItems(entry: TrashEntry): Promise<Map<string, string>> {
  const dir = path.join(trashDir(), entry.id);
  const placed = new Map<string, string>();
  for (const it of entry.items) {
    if (!/^items\/\d+$/.test(it.stored)) throw new Error('invalid trash item');
    const st = await fs.lstat(path.join(dir, it.stored)).catch(() => null);
    if (!st) continue;
    let target = it.from;
    const ext = st.isDirectory() ? '' : path.extname(target), stem = target.slice(0, target.length - ext.length);
    for (let n = 2; await exists(target); n++) target = `${stem}-${n}${ext}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await move(path.join(dir, it.stored), target);
    placed.set(it.from, target);
  }
  await fs.rm(dir, { recursive: true, force: true });
  return placed;
}

export async function purgeTrash(id: string): Promise<boolean> {
  if (!(await readTrash(id))) return false;
  await fs.rm(path.join(trashDir(), id), { recursive: true, force: true });
  return true;
}

/** 全清(含列表里不显示的空壳条目);只认 readTrash 认得的目录名,别的不碰。 */
export async function emptyTrash(): Promise<number> {
  const ids = (await fs.readdir(trashDir()).catch(() => [] as string[])).filter((id) => SAFE_ID.test(id));
  for (const id of ids) await fs.rm(path.join(trashDir(), id), { recursive: true, force: true });
  return ids.length;
}

/** 到期的(删了满 30 天)静默清掉,不弹提示。引擎启动时和之后每天一次。
 *  没有 meta.json 的目录(挪到一半进程没了)按目录时间同样 30 天后清。 */
export async function purgeExpiredTrash(now = Date.now()): Promise<number> {
  let n = 0;
  for (const id of await fs.readdir(trashDir()).catch(() => [] as string[])) {
    const e = await readTrash(id);
    const at = e ? e.deletedAt : (await fs.stat(path.join(trashDir(), id)).catch(() => null))?.mtimeMs ?? now;
    if (now - at >= TRASH_DAYS * DAY) { await fs.rm(path.join(trashDir(), id), { recursive: true, force: true }); n++; }
  }
  return n;
}

let janitor: NodeJS.Timeout | null = null;
export function startTrashJanitor(): void {
  if (janitor) return;
  const run = (): void => { purgeExpiredTrash().catch(() => {}); };
  run();
  janitor = setInterval(run, DAY);
  janitor.unref?.();
}
export function stopTrashJanitor(): void { if (janitor) clearInterval(janitor); janitor = null; }
