/**
 * 代码检查点(checkpoint):写类工具落盘**之前**留 pre-image,供用户「回退到某条 prompt 的时刻」。
 * 借 Claude Code 的 rewind:三态恢复(仅代码 / 仅对话 / 两者)——对话侧走既有消息删除端点,
 * 本文件只管代码侧。
 *
 * 布局(引擎私有,不污染用户仓库):~/.tangu/checkpoints/<sessionId>/<runId>/
 *   manifest.json  { runId, at, entries: [{ path(绝对), kind, snap?, bytes?, skipped? }] }
 *   f<N>.snap      pre-image 字节(kind='created' 无 snap = 墓碑)
 *
 * 三条语义纪律:
 * 1. **恢复 = 回到该时刻,不是撤销一个 run**:取 at ≥ 目标的全部 run,同一路径按**最早**那份
 *    pre-image 写回(只回退最后一个 run 会把后续 run 改过的文件留在现状,那不是回退)。
 * 2. 每个 run 每条路径只记首次(pre-image 才是「run 开始前」的样子);进程重启后按 manifest 续记。
 * 3. 只管 host 形态的写类工具。**run_bash 改的东西不在内**(与 Claude Code 同口径)——
 *    UI 必须如实写明覆盖范围,否则用户会在护栏之外信任它。
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { checkpointsDir } from '../core/tanguHome.js';
import { withWriteLock } from '../tools/writeLock.js';

/** 单条快照:modified=原本存在(snap 存旧字节,恢复=写回,含被工具删掉的);created=原本不存在(墓碑,恢复=删除)。 */
export interface CpEntry {
  /** 绝对路径(工具已解析过;恢复不依赖重建 cwd)。 */
  path: string;
  kind: 'modified' | 'created';
  /** pre-image 文件名(kind='created' 无);skipped 时亦无。 */
  snap?: string;
  bytes?: number;
  /** 原文件权限位(恢复后 chmod 回去;可执行脚本被删掉再恢复不能丢 +x)。 */
  mode?: number;
  /** 存不下字节(过大 / 读不了 / 写快照失败)→ 只记事实,恢复时如实告警而不是静默漏。 */
  skipped?: boolean;
  /** skipped 的原因(TOOBIG / EACCES / EISDIR / …),供 UI 与排查。 */
  reason?: string;
  /**
   * agent 写完那一刻的内容指纹(仅 kind='created' 记)。恢复时用它认「用户后来又改过这个文件」:
   * 指纹对不上就**不删**,如实报冲突 —— 回退可以撤销 agent 的活,但不能顺手抹掉用户自己写的东西。
   */
  postHash?: string;
}

export interface CpManifest {
  runId: string;
  /** 该 run 首次改文件的时刻(ms);恢复的时间轴就按它比。 */
  at: number;
  entries: CpEntry[];
  /**
   * 下一个快照文件序号 —— **只增不减**。绝不能用 entries.length 派生:撤销会摘掉中间的条目,
   * 长度回缩后下一次就会重用某个仍在用的 f<N>.snap,把别的文件的 pre-image 覆盖掉(静默毁数据)。
   */
  next?: number;
}

export interface CpSummary {
  runId: string;
  at: number;
  files: string[];
  /** 因过大未存字节的路径(UI 需提示这些恢复不了)。 */
  skipped: string[];
}

export interface RestoreReport {
  restored: string[];
  deleted: string[];
  skipped: string[];
  /** agent 建的、但用户后来改过的文件:保留原样不删,交给用户自己处置。 */
  conflicts: string[];
  failed: Array<{ path: string; error: string }>;
}

/** 单文件快照上限:超过只记事实(大文件多为构建产物/二进制,存了也拖垮 home)。 */
const MAX_SNAP_BYTES = 4 * 1024 * 1024;
/** 每会话保留的 checkpoint 数(对齐 Claude Code 的 100),超出删最旧。 */
const MAX_CHECKPOINTS = 100;

const sessionDir = (sessionId: string): string => path.join(checkpointsDir(), safeSeg(sessionId));
const runDir = (sessionId: string, runId: string): string => path.join(sessionDir(sessionId), safeSeg(runId));

/** id 只可能是 uuid/run id,仍收紧一层:任何非 [A-Za-z0-9._-] 转 _,杜绝路径穿越。 */
function safeSeg(s: string): string {
  return (s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

// 同一会话的 manifest 读-改-写串行(写类工具虽已声明不并行,子代理/群聊可能共用 runId)。
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

async function readManifest(sessionId: string, runId: string): Promise<CpManifest | null> {
  try {
    const raw = await fs.readFile(path.join(runDir(sessionId, runId), 'manifest.json'), 'utf8');
    const m = JSON.parse(raw);
    if (!m || !Array.isArray(m.entries)) return null;
    const entries = m.entries as CpEntry[];
    return {
      runId: String(m.runId || runId),
      at: Number(m.at) || 0,
      entries,
      next: Number.isFinite(m.next) ? Number(m.next) : entries.length,
    };
  } catch {
    return null;
  }
}

/**
 * 原子写:先写同目录 tmp 再 rename。就地截断重写的话,进程在写 manifest 的瞬间被杀(退出/崩溃/断电)
 * 会留下半截 JSON,解析失败 → 整个 run 的 pre-image 全部从时间线上消失,而恢复照样报成功。
 */
async function writeManifest(sessionId: string, m: CpManifest): Promise<void> {
  const dir = runDir(sessionId, m.runId);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'manifest.json.tmp');
  await fs.writeFile(tmp, JSON.stringify(m), 'utf8');
  await fs.rename(tmp, path.join(dir, 'manifest.json'));
}

/**
 * 工具执行前:把这些绝对路径的现状存成 pre-image。返回撤销函数——工具报错(没真写)时调用,
 * 把本次新增的条目摘掉,免得 UI 把「试图写但失败」的文件算进这次改动。
 */
export async function snapshotBeforeWrite(
  sessionId: string,
  runId: string,
  absPaths: string[],
  /** prune:false = 别在这次快照后修剪。恢复前的那次快照必须传 —— 到了 100 上限时修剪会删掉**最旧**
   *  那个检查点,而用户可能正要回退到它:那就成了「恢复动作亲手删掉了要恢复的东西」,且无法重试。 */
  opts?: { prune?: boolean },
): Promise<() => Promise<void>> {
  const paths = [...new Set(absPaths.filter((p) => p && path.isAbsolute(p)))];
  if (!sessionId || !runId || !paths.length) return async () => {};
  return serialize(sessionId, async () => {
    const m = (await readManifest(sessionId, runId)) || { runId, at: Date.now(), entries: [], next: 0 };
    const known = new Set(m.entries.map((e) => e.path));
    const added: CpEntry[] = [];
    let next = m.next ?? m.entries.length;
    for (const p of paths) {
      if (known.has(p)) continue;
      known.add(p);
      let buf: Buffer;
      let mode: number | undefined;
      try {
        const st = await fs.stat(p);
        mode = st.mode & 0o777; // 存权限位:被删掉的可执行脚本恢复回来必须还能执行
        // 大小闸放在**读之前**:几 GB 的目标读进内存既烧 RSS 又吃掉工具自己的超时预算
        // (快照跑在 withTimeoutSignal 已开始计时之后),而且 >2GiB 直接抛 ERR_FS_FILE_TOO_LARGE。
        if (st.size > MAX_SNAP_BYTES) {
          added.push({ path: p, kind: 'modified', bytes: st.size, skipped: true, reason: 'TOOBIG' });
          continue;
        }
        buf = await fs.readFile(p);
      } catch (e: any) {
        // ⚠️ 只有「真的不存在」才记墓碑(恢复=删除)。权限不足 / 是目录 / IO 错误一律**不能**当墓碑
        // —— 那会让回退把一个本来就在的用户文件删掉,是毁数据不是回退。读不了就如实记 skipped。
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') added.push({ path: p, kind: 'created' });
        else added.push({ path: p, kind: 'modified', skipped: true, reason: String(e?.code || 'EREAD') });
        continue;
      }
      if (buf.byteLength > MAX_SNAP_BYTES) {
        added.push({ path: p, kind: 'modified', bytes: buf.byteLength, skipped: true, reason: 'TOOBIG' });
        continue;
      }
      const snap = `f${++next}.snap`;
      try {
        await fs.mkdir(runDir(sessionId, runId), { recursive: true });
        await fs.writeFile(path.join(runDir(sessionId, runId), snap), buf);
        added.push({ path: p, kind: 'modified', snap, bytes: buf.byteLength, ...(mode !== undefined ? { mode } : {}) });
      } catch (e: any) {
        added.push({ path: p, kind: 'modified', bytes: buf.byteLength, skipped: true, reason: String(e?.code || 'EWRITE') });
      }
    }
    if (!added.length) return async () => {};
    m.entries.push(...added);
    m.next = next;
    await writeManifest(sessionId, m);
    if (opts?.prune !== false) await prune(sessionId);
    return async () => {
      await serialize(sessionId, async () => {
        const cur = await readManifest(sessionId, runId);
        if (!cur) return;
        // **只摘掉真没落盘的**:工具报错也可能是「写了一半才失败」,那份 pre-image 恰恰最该留。
        // 判据不是错误文本而是磁盘现状 == pre-image(精确、不猜)。
        const drop = new Set<string>();
        for (const e of added) if (await unchangedOnDisk(sessionId, runId, e)) drop.add(e.path);
        if (!drop.size) return;
        cur.entries = cur.entries.filter((e) => !drop.has(e.path));
        await writeManifest(sessionId, cur);
        for (const e of added) {
          if (e.snap && drop.has(e.path)) {
            await fs.rm(path.join(runDir(sessionId, runId), e.snap), { force: true }).catch(() => {});
          }
        }
      });
    };
  });
}

const hashOf = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

/**
 * 工具**写成功之后**:给本 run 里 kind='created' 的条目补写后指纹。
 * 有了它,恢复才分得清「删掉 agent 建的文件」(该删)与「删掉用户后来改过的文件」(不该删)。
 */
export async function recordPostWrite(sessionId: string, runId: string, absPaths: string[]): Promise<void> {
  const paths = new Set(absPaths.filter((p) => p && path.isAbsolute(p)));
  if (!sessionId || !runId || !paths.size) return;
  await serialize(sessionId, async () => {
    const m = await readManifest(sessionId, runId);
    if (!m) return;
    let changed = false;
    for (const e of m.entries) {
      if (e.kind !== 'created' || !paths.has(e.path)) continue;
      // ⚠️ 每次写成功都刷新(**不能**见 postHash 就跳过):同一个 run 里「先 write_file 建、
      // 再 edit_file 改」是编码任务的常态,只记第一次的话回退会把 agent 自己的第二次改动
      // 误判成「用户改过」→ 该删的没删,还倒打一耙。
      try {
        const st = await fs.stat(e.path);
        if (st.size > MAX_SNAP_BYTES) continue; // 太大不取指纹:恢复侧无指纹 → 按旧语义删
        e.postHash = hashOf(await fs.readFile(e.path));
        changed = true;
      } catch { /* 没写成/读不了:留空,恢复侧按旧语义处理 */ }
    }
    if (changed) await writeManifest(sessionId, m);
  });
}

/** 磁盘现状是否仍等于 pre-image(= 这次工具确实没落盘)。撤销条目的唯一判据。 */
async function unchangedOnDisk(sessionId: string, runId: string, e: CpEntry): Promise<boolean> {
  try {
    if (e.kind === 'created') {
      await fs.stat(e.path);
      return false; // 文件出现了 = 真建了
    }
  } catch {
    return true; // 仍不存在
  }
  if (e.skipped || !e.snap) return false; // 没存字节 → 无法证明未变,保守留下
  try {
    const [cur, pre] = await Promise.all([
      fs.readFile(e.path),
      fs.readFile(path.join(runDir(sessionId, runId), e.snap)),
    ]);
    return cur.equals(pre);
  } catch {
    return false;
  }
}

/** 本会话的检查点(按时间升序)。 */
export async function listCheckpoints(sessionId: string): Promise<CpSummary[]> {
  let runIds: string[];
  try {
    runIds = await fs.readdir(sessionDir(sessionId));
  } catch {
    return [];
  }
  const out: CpSummary[] = [];
  for (const rid of runIds) {
    const m = await readManifest(sessionId, rid);
    if (!m || !m.entries.length) continue;
    out.push({
      runId: m.runId,
      at: m.at,
      files: m.entries.map((e) => e.path),
      skipped: m.entries.filter((e) => e.skipped).map((e) => e.path),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 把代码恢复到 `at` 时刻:所有 at ≥ 目标的检查点里,同一路径取**最早**的 pre-image 写回;
 * 墓碑(created)→ 删除该文件。返回逐路径结果(skipped=快照太大没存,恢复不了但如实报出)。
 */
export async function restoreCodeSince(sessionId: string, at: number): Promise<RestoreReport> {
  // ⚠️整段恢复必须和写类工具**同一把锁**(codex 2026-08-17 P1)。路由只检查「被恢复的这个会话」
  // 有没有在跑的 run;**别的**会话在同一个工作区里跑着的 run 照样在写盘。不加锁的话:
  //   ① 下面那句「把现状存成新检查点」会拍到一个写了一半的文件;
  //   ② 恢复的写盘会和对方在飞的 edit 交叠(读-改-写互相覆盖)。
  // 写锁可重入,所以里面调 snapshotBeforeWrite 之类不会死锁。
  return withWriteLock(() => restoreCodeSinceLocked(sessionId, at));
}

async function restoreCodeSinceLocked(sessionId: string, at: number): Promise<RestoreReport> {
  const report: RestoreReport = { restored: [], deleted: [], skipped: [], conflicts: [], failed: [] };
  let runIds: string[];
  try {
    runIds = await fs.readdir(sessionDir(sessionId));
  } catch {
    return report;
  }
  const manifests: CpManifest[] = [];
  for (const rid of runIds) {
    const m = await readManifest(sessionId, rid);
    if (m) { if (m.at >= at) manifests.push(m); continue; }
    // 文件在却读不出 = 「这个 run 的改动恢复不了」,不能静默跳过(报成功却少恢复最坏)。
    // 目录里根本没 manifest(半路被删 / 无关文件)则不吵。
    const mf = path.join(runDir(sessionId, rid), 'manifest.json');
    if (await fs.stat(mf).then(() => true, () => false)) {
      report.failed.push({ path: mf, error: 'manifest unreadable' });
    }
  }
  manifests.sort((a, b) => a.at - b.at);
  // 同一路径取最早那份 pre-image —— 那才是目标时刻的样子(只回滚最后一个 run 不叫回退)。
  const plan = new Map<string, { e: CpEntry; runId: string }>();
  for (const m of manifests) for (const e of m.entries) if (!plan.has(e.path)) plan.set(e.path, { e, runId: m.runId });

  // 回退本身也要可回退:动手前把**现状**存成一个新检查点(用户回退错了/手改过的东西还能再捞回来)。
  await snapshotBeforeWrite(sessionId, `restore-${Date.now()}`, [...plan.keys()], { prune: false });

  for (const { e, runId } of plan.values()) {
    if (e.skipped) {
      report.skipped.push(e.path);
      continue;
    }
    try {
      if (e.kind === 'created') {
        // 用户后来动过这个文件(指纹对不上)→ 不删,报冲突。没指纹(旧检查点/当时太大)时
        // 维持旧语义照删,否则回退会变成对存量检查点的空转。
        if (e.postHash) {
          let cur: Buffer | null = null;
          try {
            cur = await fs.readFile(e.path);
          } catch (err: any) {
            // 文件已不在 → 继续走删除(no-op);读不了(EACCES/EISDIR/…)→ **绝不删**,
            // 判不出是不是用户的东西时保留是唯一安全方向(同「读不了不记墓碑」那条)。
            if (err?.code !== 'ENOENT') { report.conflicts.push(e.path); continue; }
          }
          if (cur && hashOf(cur) !== e.postHash) {
            report.conflicts.push(e.path);
            continue;
          }
        }
        await fs.rm(e.path, { force: true });
        report.deleted.push(e.path);
        continue;
      }
      const buf = await fs.readFile(path.join(runDir(sessionId, runId), e.snap || ''));
      await fs.mkdir(path.dirname(e.path), { recursive: true });
      await fs.writeFile(e.path, buf);
      if (e.mode !== undefined) await fs.chmod(e.path, e.mode).catch(() => {});
      report.restored.push(e.path);
    } catch (err: any) {
      report.failed.push({ path: e.path, error: String(err?.message || err) });
    }
  }
  return report;
}

/** 会话删除时清盘(否则 home 无界增长)。 */
export async function removeSessionCheckpoints(sessionId: string): Promise<void> {
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

/** 超出保留数 → 删最旧(按 manifest.at)。 */
async function prune(sessionId: string): Promise<void> {
  let runIds: string[];
  try {
    runIds = await fs.readdir(sessionDir(sessionId));
  } catch {
    return;
  }
  if (runIds.length <= MAX_CHECKPOINTS) return;
  const dated: Array<{ rid: string; at: number }> = [];
  for (const rid of runIds) dated.push({ rid, at: (await readManifest(sessionId, rid))?.at ?? 0 });
  dated.sort((a, b) => a.at - b.at);
  for (const d of dated.slice(0, dated.length - MAX_CHECKPOINTS)) {
    await fs.rm(path.join(sessionDir(sessionId), safeSeg(d.rid)), { recursive: true, force: true }).catch(() => {});
  }
}
