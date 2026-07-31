/**
 * 引擎侧的 Amadeus `.db`(多维表)读写内核 —— 自动化的 DB 触发与 DB 动作共用这一条路。
 *
 * 为什么独立成模块(而不是继续用 tools/builtin/amadeus.ts 里那几个私有助手):
 *  ① 那些助手是文件私有的,services 够不着;
 *  ② 那条路的 write 是**裸 `fs.writeFile`** —— 没有 tmp、没有版本、没有锁。日历工具偶尔写一次
 *     还能混过去,自动化开始按行改表之后,它会和这两个写者对撞:
 *       · 渲染端 dbStore:内存快照 + 500ms 防抖落盘;
 *       · 桌面 main:原子 tmp+rename。
 *     具体后果是双向丢数据 —— 我们写完,渲染端那个还没到点的防抖把旧快照盖回来(自动化加的行没了);
 *     或者我们读改写覆盖掉用户此刻刚敲进去的格子。
 *
 * 这里给三样护栏:
 *  · **原子写**(tmp+rename):任何时刻别人读到的都是完整 JSON,不会撞上半截文件;
 *  · **每路径串行**(mutate 锁):同一张表的多条自动化不会互相读到对方的中间态;
 *  · **写前重读**:mutate 的入参永远是刚从磁盘读的最新版,不是任何缓存。
 * 渲染端那一半的护栏在 desktop 的 `db:write-cas`(比对交换 + 冲突重放),两边合起来才闭合。
 *
 * 越界:统一走 inVaultDb —— 词法钳制 + **realpath 复核**(vault 里放一条指向外面的软链,
 * 光靠 path.relative 是拦不住的)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';

export type CellValue = string | number | boolean | string[] | null;

export interface DbColumn {
  id: string;
  name: string;
  type: string;
  options?: string[];
  width?: number;
}
export interface DbRow {
  id: string;
  cells: Record<string, CellValue>;
}
export interface DbFile {
  version: number;
  name: string;
  /** 存在 = 「笔记视图」:行来自文件夹里的笔记,`rows` 恒为空。自动化一律拒绝这种库。 */
  source?: { folder: string };
  columns: DbColumn[];
  rows: DbRow[];
  views?: unknown[];
}

/** 与桌面 serializeDb 逐字节同款(2 空格缩进 + 尾换行),否则 vault 的 git diff 会整份翻红。 */
export function serializeDb(db: DbFile): string {
  return `${JSON.stringify(db, null, 2)}\n`;
}

export function dbRowId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** vault 相对路径 → 绝对路径,钳制在 vault 内。词法钳制 + realpath 复核(软链越界)。 */
export async function inVaultDb(rel: string): Promise<string> {
  const root = amadeusVaultPath();
  const abs = path.resolve(root, rel);
  const lex = path.relative(root, abs);
  if (lex.startsWith('..') || path.isAbsolute(lex)) throw new Error(`path escapes the vault: ${rel}`);
  // realpath 复核:**父目录 + 文件本身**都要查。只查父目录的话,vault 里一条
  // `evil.db -> /outside/secret.db` 的软链会大摇大摆通过(codex 抓的)。
  // 文件还不存在(新建)时只有父目录可查,那是正常路径,不算失败。
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return abs; // vault 根都解析不了:交给后续的 read/write 报真实错误
  }
  const inside = (p: string): boolean => {
    const r = path.relative(realRoot, p);
    return !r.startsWith('..') && !path.isAbsolute(r);
  };
  try {
    if (!inside(await fs.realpath(path.dirname(abs)))) throw new Error(`path escapes the vault via symlink: ${rel}`);
  } catch (e: any) {
    if (String(e?.message || '').includes('symlink')) throw e;
  }
  try {
    const realFile = await fs.realpath(abs); // 不存在 → 抛 ENOENT,走 catch(新建是正常路径)
    if (!inside(realFile)) throw new Error(`path escapes the vault via symlink: ${rel}`);
  } catch (e: any) {
    if (String(e?.message || '').includes('symlink')) throw e;
  }
  return abs;
}

export interface ParsedDb {
  db: DbFile;
  /** 磁盘原文的短票据(读到什么就是什么;调用方用不到时可忽略)。 */
  raw: string;
}

export async function readDb(rel: string): Promise<ParsedDb> {
  const abs = await inVaultDb(rel);
  const raw = await fs.readFile(abs, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    throw new Error(`not a valid .db file: ${rel}`);
  }
  return { db: data as DbFile, raw };
}

/** 自动化能不能碰这张表(笔记视图的行是笔记不是 JSON 行,按普通表改会写出无效数据)。 */
export function assertAutomatable(rel: string, db: DbFile): void {
  if (db.source) {
    throw new Error(`"${rel}" is a note view (rows come from notes in ${db.source.folder}) — automations can't add or edit its rows`);
  }
}

// 每路径一条 promise 链:同一张表的并发 mutate 串起来跑,后一个读到的一定是前一个写完的结果。
const chains = new Map<string, Promise<unknown>>();

let tmpCounter = 0;

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/**
 * 同一张表的锁文件路径。**桌面 main 侧必须逐字算出同一个路径**,否则两边各锁各的 = 白锁,
 * 且是静默失效。约定(两处都照此实现,改一处必须改另一处):
 *   `<realpath(所在目录)>/.<文件名>.lock`
 * · 点开头 —— watcher 的 ignored 里 `base.startsWith('.')` 直接滤掉,不会因为加解锁刷一堆
 *   vault 变更事件;同步侧另有一条 `isIgnoredName` 白名单,不会被当成用户文件传上云。
 * · 目录取 realpath —— 两个进程的 vault 根字符串未必逐字相同(一侧走软链就够了),
 *   落到同一个真实目录才能真的互斥。
 */
async function lockPathFor(abs: string): Promise<string> {
  const dir = await fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs));
  return path.join(dir, `.${path.basename(abs)}.lock`);
}

/**
 * 跨进程写锁(`O_EXCL` 锁文件)。
 *
 * 为什么非要有:这张表有**两个进程**在写 —— 引擎(本模块)与桌面 main(`db:write-cas`)。
 * 两边各自的护栏都只在自己进程内成立:我们是「每路径 promise 链」,它是「读→比对版本→写」。
 * 我们读完到 rename 之间它写一次,我们的 rename 就把它抹了;反过来它比对完到写之间我们
 * rename 一次,它也照抹不误。锁文件是两个进程唯一能共享的同步点。
 *
 * ponytail: 建议锁(只约束走这两条路的写者,手改 vault 里的 .db 不受约束);陈旧锁按 mtime
 *   超时破除 —— 持锁进程崩了不能让这张表永久写不进去。代价:原主还活着但被挂起超过
 *   LOCK_STALE_MS 时会出现两个持锁者。要根治得上 flock(2) 那类内核锁(node 无内建,
 *   要么加原生依赖要么自己写 addon),现在这个规模不值得。
 */
export async function withDbLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const lock = await lockPathFor(abs);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx'); // O_CREAT|O_EXCL:创建成功 = 拿到锁
      try {
        await fh.write(String(process.pid));
      } finally {
        await fh.close();
      }
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lock).catch(() => {}); // 陈旧锁:原主多半已死,破锁
      } else if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the write lock on ${path.basename(abs)} — another process is writing this table`);
      }
      // 每轮都要睡:破锁那条分支也走这里,否则争用时会退化成忙等。
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

/**
 * 读-改-写(串行 + 原子 + 跨进程互斥)。`fn` 拿到的是**刚从磁盘读出来**的最新副本,直接就地改即可;
 * 返回 false = 什么都没改(不落盘,也就不会白白触发别人的 watcher)。
 */
export async function mutateDb(rel: string, fn: (db: DbFile) => boolean | void): Promise<void> {
  const run = async (): Promise<void> => {
    const abs = await inVaultDb(rel);
    // 锁必须裹住**读**:只裹写的话,我们读到的仍可能是对方写之前的版本,rename 照样抹掉它。
    await withDbLock(abs, async () => {
      const { db } = await readDb(rel);
      assertAutomatable(rel, db);
      if (fn(db) === false) return;
      // 后缀三段(pid-时间戳-序号)是与桌面 vaultManager.atomicWrite 对齐的约定:watcher 的
      // ignored 与同步的 isIgnoredName 都按 `\.tmp-\d+-\d+-\d+$` 认它。少一段就滤不掉,
      // 这个临时文件会被当成用户文件报给界面、甚至传上云。
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
      await fs.writeFile(tmp, serializeDb(db), 'utf8');
      await fs.rename(tmp, abs); // 原子落位:别人永远读不到半截 JSON
    });
  };
  const key = path.normalize(rel);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(run, run); // 前一环失败不连坐
  const sentinel = next.then(() => undefined, () => undefined);
  chains.set(key, sentinel);
  // 链尾清理:不清的话 Map 会按**历史出现过的每条路径**永久留一个 settled Promise。
  // 只在自己仍是当前 sentinel 时删——否则会把后来追加的新链一起删掉,串行就断了。
  void sentinel.finally(() => { if (chains.get(key) === sentinel) chains.delete(key); });
  return next;
}

/** 按列名找列(大小写/首尾空白宽容);**找不到就是错误**,绝不静默跳过。 */
export function columnByName(db: DbFile, name: string): DbColumn {
  const want = name.trim().toLowerCase();
  const hit = db.columns.filter((c) => String(c.name || '').trim().toLowerCase() === want);
  if (!hit.length) throw new Error(`column "${name}" not found (have: ${db.columns.map((c) => c.name).join(', ')})`);
  if (hit.length > 1) throw new Error(`column name "${name}" is ambiguous (${hit.length} columns share it) — use the column id`);
  return hit[0];
}

/** 列 id 或列名 → 列。规则里存的应该是 **id**(列可以改名),名字只作兜底与展示。 */
export function resolveColumn(db: DbFile, idOrName: string): DbColumn {
  const byId = db.columns.find((c) => c.id === idOrName);
  return byId ?? columnByName(db, idOrName);
}

/** 单元格值 → 触发比对用的稳定字符串(数组按序 join,null/undefined 一律空串)。 */
export function cellKey(v: CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('');
  return String(v);
}

/** 列类型 → 落盘基础类型。渲染层的自定义属性类型(todo/calendarDate/relation…)在引擎这边只认
 *  它们借的那个 primitive;认不出的一律当文本(宽容折算,绝不丢数据)。 */
export function baseTypeOf(type: string): string {
  const t = String(type || '').trim();
  if (['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url', 'page'].includes(t)) return t;
  if (t === 'todo') return 'checkbox';
  if (t === 'calendarDate') return 'text'; // 'start[/end]' 字符串
  return 'text';
}

/** 表单/模板给的字符串 → 该列的规范值。数字列给非数字 = **报错**,不静默写 null。 */
export function coerceCell(col: DbColumn, raw: string): CellValue {
  const v = String(raw ?? '');
  switch (baseTypeOf(col.type)) {
    case 'checkbox':
      return ['true', '1', 'yes', 'y', 'on', '是'].includes(v.trim().toLowerCase());
    case 'number': {
      if (v.trim() === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`column "${col.name}" is a number, but got "${v}"`);
      return n;
    }
    case 'multiselect':
      return v.split(',').map((x) => x.trim()).filter(Boolean);
    default:
      return v;
  }
}
