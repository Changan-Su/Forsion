/**
 * 读后指纹(G3-02)+ 变动感知:按会话记住 agent 上次「看到」的文件内容。两件事共用一张表,但是两份指纹:
 *
 * ① 写闸 fp —— write_file 整篇覆盖前据此判断盘上是否在那之后被改过(用户在编辑器里接着写、别的会话/进程落了盘)。
 *    不一致就拒写,让模型重读。
 *   - 指纹 = 全文 sha1(与 checkpoints.ts 的 postHash 同算法)。按内容不按 mtime:编辑器原子写出同样字节
 *     不算改动,不会平白拒一次。
 *   - read_file 记全文指纹(offset/limit 分页读也照样读了整份 buffer,记的是整份)。
 *   - agent 自己的写(write_file / edit_file / multi_edit / apply_patch)刷新指纹 —— 否则「读 → 局部改 →
 *     write_file」会被自己的改动误拒。局部改前盘上已经不是模型看到的那份时**不刷新**:它只改了自己
 *     认得的那一小段,整篇视图仍是旧的,之后的 write_file 还得先重读。
 *   - 从没读过(无记录)= 不设闸:新建文件、模型经别的途径拿到内容的写照旧放行(见残余风险:run_bash cat /
 *     引擎重启丢记录 / 同会话子代理共用一份)。
 *
 * ② 变动感知 seen —— 模型最近「知道」的盘上版本:读到的、自己写下的、以及已经通知过它的外部改动。
 *    agentLoop 在每轮开头和 run 内每次续调模型前扫一遍(collectExternalChanges),盘上和 seen 不一样的
 *    就是「文件工具之外」改的(用户在编辑器里写、别的程序、run_bash),交给 fileChangeNotice 出一段带 diff 的通知,
 *    然后把 seen 推到现状 —— 同一处改动只报一次。
 *   - ⚠️ 通知**不动写闸 fp**:通知只进本 run 的上下文(不落库),下个 run 模型手里只有旧的 read_file 结果;
 *     这时 fp 若已被推到新内容,write_file 整篇覆盖就会放行、抹掉用户的改动。所以通知之后要整篇写仍得先重读。
 *   - agent 自己的写**总是**推 seen(哪怕写闸保持过期)—— 自己的改动永远不会被当成外部改动报回来。
 *     局部改落盘时发现盘上已经不是 seen(模型续调期间用户在改),那段外部改动记成 pending,下次扫描单独报
 *     (「你的改动落在了这一版上」),否则它会被自己的写吞掉、模型永远不知道。
 *   - 预检 = mtime + ctime + size + inode:都没变就只花一次 stat;变了才读、算指纹(同字节重写 = 不报,只刷新 stat)。
 *     ctime 改不回去,所以「保留 mtime 的替换」(cp -p / rsync -t)照样抓得到。stat 只在「先 stat 后读」里记,且刚改过
 *     (2 秒内)的不记 —— 粗粒度时间戳的文件系统上同一秒内的二次改动会骗过预检,宁可多算一次指纹。预检只是省事的启发式,
 *     写闸仍按内容判。读也有上限(HASH_MAX_BYTES):stat 之后文件变大也不会整份读进来。
 *   - 读不了(权限 / 非普通文件 / 其它错误)= 不知道,不报也不改记录;ENOENT/ENOTDIR 才算删了(删了报一次,
 *     之后又出现按「重新出现」再报)。
 *   - 快照(出 diff 用的全文)有上限:单文件 SNAPSHOT_FILE_MAX_CHARS、每会话 SNAPSHOT_SESSION_MAX_CHARS、
 *     全进程 SNAPSHOT_TOTAL_MAX_CHARS,超了从最久没碰的起丢快照(指纹留着,通知照发、只是不带 diff);二进制不留。
 *   - 只扫每会话最近碰过的 WATCH_MAX 个文件。
 *
 * 叶子模块:只依赖 node 内置 —— hostExec 与 builtin/applyPatch 都要 import 它,不能反向成环。
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

const MAX_SESSIONS = 200;
const MAX_PATHS_PER_SESSION = 2000;
/** 每次扫描只看每会话最近碰过的这么多个文件(Map 尾部 = 最近)。 */
export const WATCH_MAX = 100;
/** 单文件快照上限(字符);超了只记指纹,通知不带 diff。 */
export const SNAPSHOT_FILE_MAX_CHARS = 128 * 1024;
/** 每会话快照总量上限(字符)。 */
export const SNAPSHOT_SESSION_MAX_CHARS = 1024 * 1024;
/** 全进程快照总量上限(字符,所有会话合计)。 */
export const SNAPSHOT_TOTAL_MAX_CHARS = 8 * 1024 * 1024;
/** 扫描时超过这个大小的文件不读不算指纹,只看 stat 变没变。 */
export const HASH_MAX_BYTES = 8 * 1024 * 1024;
/** mtime 离现在这么近的不记 stat(下次照样读一遍算指纹)。 */
const RACY_MS = 2000;
/** 每个文件最多攒几段「写之前就已在盘上」的外部改动。 */
const MAX_PENDING = 3;
const BINARY_SNIFF = 8000;
/** seen 的「文件不存在」记号(sha1 不会是这个)。 */
const ABSENT = 'absent';

interface SeenStat { mtimeMs: number; ctimeMs: number; size: number; ino: number }
interface Pending { before?: string; after?: string }
interface Entry {
  /** 写闸:模型手里整份视图的指纹;undefined = 不设闸(只有 seen 的条目:目前不会出现,留作口径)。 */
  fp?: string;
  /** 变动感知:模型最近知道的盘上版本的指纹;ABSENT = 知道它被删了。 */
  seen: string;
  /** seen 对应的全文(文本且不超上限才留)。 */
  text?: string;
  /** seen 那一刻的 stat;undefined = 还没对过,下次扫描必须读一遍。 */
  stat?: SeenStat;
  /** agent 写入时撞见的外部改动(写之前就已在盘上),下次扫描单独报。 */
  pending?: Pending[];
  /** 每次读 / 写记录 +1:扫描 await 期间被工具改过就不拿旧结果覆盖。 */
  v: number;
}
interface SessionState { entries: Map<string, Entry>; chars: number }

/** sessionId → 会话表。Map 保插入序,当 LRU 用:每次触碰删了重插。 */
const sessions = new Map<string, SessionState>();
let totalChars = 0;

type Scope = { sessionId?: string };

export function contentFingerprint(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

const charsOf = (e: Entry): number =>
  (e.text?.length ?? 0) + (e.pending ?? []).reduce((n, p) => n + (p.before?.length ?? 0) + (p.after?.length ?? 0), 0);

function dropSession(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  totalChars -= s.chars;
  sessions.delete(key);
}

function scope(ctx: Scope, create: boolean): SessionState | undefined {
  const key = ctx.sessionId || '';
  let s = sessions.get(key);
  if (s) {
    sessions.delete(key);
    sessions.set(key, s);
  } else if (create) {
    s = { entries: new Map(), chars: 0 };
    sessions.set(key, s);
    if (sessions.size > MAX_SESSIONS) dropSession(sessions.keys().next().value as string);
  }
  return s;
}

/** 换掉一个条目的快照部分,账本跟着走。 */
function setSnapshots(s: SessionState, e: Entry, text: string | undefined, pending: Pending[] | undefined): void {
  const before = charsOf(e);
  e.text = text;
  e.pending = pending?.length ? pending : undefined;
  const delta = charsOf(e) - before;
  s.chars += delta;
  totalChars += delta;
}

/** 丢掉一个条目的全部快照文本;攒着的外部改动只丢文本、记号留着(seen 已经越过它们,丢了就再也报不出来)。 */
function dropText(s: SessionState, e: Entry): void {
  setSnapshots(s, e, undefined, e.pending?.map(() => ({})));
}

/** 超了上限就从最久没碰的条目起丢快照(指纹留着)。 */
function trimSnapshots(s: SessionState): void {
  if (s.chars > SNAPSHOT_SESSION_MAX_CHARS) {
    for (const e of s.entries.values()) {
      if (s.chars <= SNAPSHOT_SESSION_MAX_CHARS) break;
      if (charsOf(e)) dropText(s, e);
    }
  }
  if (totalChars > SNAPSHOT_TOTAL_MAX_CHARS) {
    for (const other of sessions.values()) {
      if (totalChars <= SNAPSHOT_TOTAL_MAX_CHARS) break;
      for (const e of other.entries.values()) {
        if (totalChars <= SNAPSHOT_TOTAL_MAX_CHARS) break;
        if (charsOf(e)) dropText(other, e);
      }
    }
  }
}

/** 读最多 max 字节;文件比这大 = 'large'(不整份读进来)。缓冲按文件现在的大小开,读的途中变大了再按倍数加,封顶 max + 1。 */
async function readBounded(abs: string, max: number): Promise<Buffer | 'large'> {
  const fh = await fsp.open(abs, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size > max) return 'large';
    let buf = Buffer.allocUnsafe(Math.min(max + 1, size + 1));
    let len = 0;
    for (;;) {
      if (len === buf.length) {
        if (buf.length > max) break;
        const grown = Buffer.allocUnsafe(Math.min(max + 1, buf.length * 2));
        buf.copy(grown, 0, 0, len);
        buf = grown;
      }
      const { bytesRead } = await fh.read(buf, len, buf.length - len, len);
      if (!bytesRead) break;
      len += bytesRead;
    }
    return len > max ? 'large' : buf.subarray(0, len);
  } finally {
    await fh.close();
  }
}

/** 按扩展名就知道是二进制容器的(read_file 读 PDF / Office 只出乱码):不留快照、不出 diff。 */
const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|zip|gz|tgz|7z|rar|png|jpe?g|gif|webp|bmp|ico|mp[34]|mov|wav|sqlite|db3?)$/i;

/** 能留快照的全文;二进制 / 太大 = undefined。 */
function snapshotOf(data: Buffer | string, abs?: string): string | undefined {
  if (abs && BINARY_EXT.test(abs)) return undefined;
  if (typeof data === 'string') {
    if (data.length > SNAPSHOT_FILE_MAX_CHARS || data.slice(0, BINARY_SNIFF).includes('\0')) return undefined;
    return data;
  }
  if (data.byteLength > SNAPSHOT_FILE_MAX_CHARS * 4 || data.subarray(0, BINARY_SNIFF).includes(0)) return undefined;
  const text = data.toString('utf8');
  return text.length > SNAPSHOT_FILE_MAX_CHARS ? undefined : text;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF).includes(0);
}

/** 触碰 abs(移到 LRU 尾部)并交回条目,没有就建。 */
function touch(ctx: Scope, abs: string, seed: () => Entry): { s: SessionState; e: Entry } {
  const s = scope(ctx, true)!;
  let e = s.entries.get(abs);
  if (e) s.entries.delete(abs);
  else e = seed();
  s.entries.set(abs, e);
  if (s.entries.size > MAX_PATHS_PER_SESSION) {
    const oldest = s.entries.keys().next().value as string;
    const gone = s.entries.get(oldest)!;
    setSnapshots(s, gone, undefined, undefined);
    s.entries.delete(oldest);
  }
  return { s, e };
}

/** 模型读到了这份全文。 */
export function noteRead(ctx: Scope, abs: string, data: Buffer | string): void {
  const fp = contentFingerprint(data);
  const { s, e } = touch(ctx, abs, () => ({ seen: fp, v: 0 }));
  e.v++;
  e.fp = fp;
  e.seen = fp;
  e.stat = undefined; // 读之前没 stat:下次扫描读一遍对上了再记
  setSnapshots(s, e, snapshotOf(data, abs), undefined); // 整份重新看过了,攒着的外部改动不用再报
  trimSnapshots(s);
}

/** 上次读到(或自己写下)的指纹;没读过 = undefined(不设闸)。 */
export function readFingerprint(ctx: Scope, abs: string): string | undefined {
  return scope(ctx, false)?.entries.get(abs)?.fp;
}

/**
 * agent 自己写完了 abs。before = 这次写之前工具读到的盘上内容(write_file 整篇覆盖不需要 → 省略):
 * - 写闸:有记录且 before 与之不符 = 模型的整篇视图本来就过期了,保持过期,不刷新。
 * - 变动感知:seen 总是推到写后内容;before 与 seen 不符 = 写之前盘上就有外部改动,记成 pending 下次单独报。
 */
export function noteAgentWrite(ctx: Scope, abs: string, written: string, before?: string | null): void {
  const fp = contentFingerprint(written);
  const { s, e } = touch(ctx, abs, () => ({ seen: fp, v: 0 }));
  e.v++;
  let pending = e.pending ? [...e.pending] : undefined;
  if (before != null) {
    const beforeFp = contentFingerprint(before);
    if (e.fp === undefined || e.fp === beforeFp) e.fp = fp;
    if (e.seen !== fp && e.seen !== beforeFp) {
      // 新建的条目 seen 先垫成了 fp,不会走到这里;走到这里 = 之前就在看着的文件,写前被外面改过
      pending = [...(pending ?? []), { before: e.seen === ABSENT ? '' : e.text, after: snapshotOf(before, abs) }].slice(-MAX_PENDING);
    }
  } else {
    e.fp = fp;
  }
  e.seen = fp;
  e.stat = undefined;
  setSnapshots(s, e, snapshotOf(written, abs), pending);
  trimSnapshots(s);
}

/** 文件被 agent 删掉/挪走:丢掉记录(之后同路径的写就是新建)。 */
export function forgetRead(ctx: Scope, abs: string): void {
  const s = scope(ctx, false);
  const e = s?.entries.get(abs);
  if (!s || !e) return;
  setSnapshots(s, e, undefined, undefined);
  s.entries.delete(abs);
}

/** 一处外部改动。before/after 是全文快照(拿不到就缺省,通知里不带 diff)。 */
export interface ExternalChange {
  abs: string;
  /** modified = 改了;deleted = 删了;created = 删了之后又出现;beforeWrite = agent 局部改落盘时撞见的、写之前就已在盘上的改动。 */
  kind: 'modified' | 'deleted' | 'created' | 'beforeWrite';
  before?: string;
  after?: string;
  /** 为什么没有 diff:binary = 二进制;large = 太大没留快照 / 没读;withheld = 现在的路径不让读。 */
  note?: 'binary' | 'large' | 'withheld';
}

export interface CollectOptions {
  /** 现在这条路径还让不让读(凭据文件 / 软链换了靶)。false = 照报「改了」但不带内容。 */
  canRead?: (abs: string) => boolean;
  /** 只扫最近的多少个文件,缺省 WATCH_MAX。 */
  max?: number;
  now?: () => number;
}

const goneCode = (e: any): boolean =>
  e?.code === 'ENOENT' || e?.code === 'ENOTDIR' || /\b(ENOENT|ENOTDIR)\b/.test(String(e?.message || ''));

/**
 * 扫这个会话最近碰过的文件,交回「文件工具之外」的改动并把 seen 推到现状(同一处改动只报一次)。
 * 不碰写闸 fp、不改 LRU 顺序。任何单个文件出错都只当「不知道」跳过。
 */
export async function collectExternalChanges(ctx: Scope, opts: CollectOptions = {}): Promise<ExternalChange[]> {
  const s = sessions.get(ctx.sessionId || ''); // 不触碰会话 LRU:扫描不算使用
  if (!s?.entries.size) return [];
  const now = opts.now ?? Date.now;
  const max = opts.max ?? WATCH_MAX;
  const key = ctx.sessionId || '';
  const recent = [...s.entries.keys()].slice(-max).reverse();
  const out: ExternalChange[] = [];
  for (const abs of recent) {
    if (sessions.get(key) !== s) break; // await 期间整个会话被挤出去了:账本已经结过,别再动它
    const e = s.entries.get(abs);
    if (!e) continue;
    const v = e.v;
    // await 期间被读 / 写 / 忘掉了,或会话被挤出去了:这次的观察作废
    const stale = (): boolean => sessions.get(key) !== s || s.entries.get(abs) !== e || e.v !== v;
    if (e.pending?.length) {
      const allowed = opts.canRead ? opts.canRead(abs) : true;
      for (const p of e.pending) {
        out.push(allowed
          ? { abs, kind: 'beforeWrite', before: p.before, after: p.after, ...(p.before === undefined || p.after === undefined ? { note: 'large' as const } : {}) }
          : { abs, kind: 'beforeWrite', note: 'withheld' });
      }
      setSnapshots(s, e, e.text, undefined);
    }
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      if (!stale() && goneCode(err) && e.seen !== ABSENT) {
        out.push({ abs, kind: 'deleted', before: e.text });
        e.seen = ABSENT;
        e.stat = undefined;
        setSnapshots(s, e, undefined, undefined);
      }
      continue; // 其它错误 = 不知道
    }
    if (stale() || !st.isFile()) continue;
    const cur: SeenStat = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
    if (e.stat && e.stat.mtimeMs === cur.mtimeMs && e.stat.ctimeMs === cur.ctimeMs && e.stat.size === cur.size && e.stat.ino === cur.ino) continue;
    const settled = now() - Math.max(cur.mtimeMs, cur.ctimeMs) >= RACY_MS;
    if (cur.size > HASH_MAX_BYTES) {
      // 太大:不读。第一次见只记基线(读后到第一次扫描之间的改动会漏,大文件接受);之后 stat 变了就报。
      if (e.stat && e.seen !== ABSENT) {
        out.push({ abs, kind: 'modified', note: 'large' });
        e.seen = `stat:${cur.mtimeMs}:${cur.size}`;
        setSnapshots(s, e, undefined, e.pending);
      } else if (e.seen === ABSENT) {
        out.push({ abs, kind: 'created', note: 'large' });
        e.seen = `stat:${cur.mtimeMs}:${cur.size}`;
      }
      e.stat = cur;
      continue;
    }
    let buf: Buffer;
    try {
      const got = await readBounded(abs, HASH_MAX_BYTES);
      if (got === 'large') {
        // stat 之后又写大了(stat 时 ≤ 上限、读时超了):内容必然变了。报一次不带 diff,下次扫描按大文件那条路记基线
        if (stale()) continue;
        out.push({ abs, kind: e.seen === ABSENT ? 'created' : 'modified', note: 'large' });
        e.seen = 'large';
        e.stat = undefined;
        setSnapshots(s, e, undefined, e.pending);
        continue;
      }
      buf = got;
    } catch (err) {
      if (!stale() && goneCode(err) && e.seen !== ABSENT) {
        out.push({ abs, kind: 'deleted', before: e.text });
        e.seen = ABSENT;
        e.stat = undefined;
        setSnapshots(s, e, undefined, undefined);
      }
      continue;
    }
    if (stale()) continue;
    const fp = contentFingerprint(buf);
    if (fp === e.seen) {
      e.stat = settled ? cur : undefined; // 同字节重写 / 读后第一次对上:只记 stat
      continue;
    }
    const kind = e.seen === ABSENT ? 'created' : 'modified';
    const allowed = opts.canRead ? opts.canRead(abs) : true;
    const after = allowed ? snapshotOf(buf, abs) : undefined;
    const change: ExternalChange = { abs, kind, before: kind === 'created' ? '' : e.text, after };
    if (!allowed) { delete change.before; change.note = 'withheld'; }
    else if (isBinary(buf) || BINARY_EXT.test(abs)) { delete change.before; delete change.after; change.note = 'binary'; }
    else if (after === undefined || change.before === undefined) change.note = 'large';
    out.push(change);
    e.seen = fp;
    e.stat = settled ? cur : undefined;
    setSnapshots(s, e, after, e.pending);
  }
  trimSnapshots(s);
  return out;
}

/** 仅测试:清空全部记录。 */
export function __resetReadStateForTests(): void {
  sessions.clear();
  totalChars = 0;
}

/** 仅测试:快照账本。 */
export function __snapshotCharsForTests(ctx?: Scope): number {
  return ctx ? (sessions.get(ctx.sessionId || '')?.chars ?? 0) : totalChars;
}
