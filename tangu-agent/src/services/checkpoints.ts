/**
 * 代码检查点(checkpoint):写类工具落盘**之前**留 pre-image,供用户「回退到某条 prompt 的时刻」。
 * 借 Claude Code 的 rewind:三态恢复(仅代码 / 仅对话 / 两者)——对话侧走既有消息删除端点,
 * 本文件只管代码侧。
 *
 * 布局(引擎私有,不污染用户仓库):~/.tangu/checkpoints/<sessionId>/<runId>/
 *   manifest.json  { runId, at, entries: [{ path(绝对), kind, snap?, bytes?, skipped?, postHash?, postAbsent? }] }
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
import { diffIndices } from 'node-diff3';

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
   * 写完那一刻的内容指纹(sha1;每次写成功都刷新,两种 kind 都记;>4MB / 读不了时不记)。
   * - kind='created':恢复时用它认「用户后来又改过这个文件」:指纹对不上就**不删**,如实报冲突 ——
   *   回退可以撤销 agent 的活,但不能顺手抹掉用户自己写的东西。(这条既有判据只看 created。)
   * - kind='modified':供 listChanges 的 editedLater 与 restoreCodeSince({ keepEdited }) 认
   *   「agent 最后一次写完之后,磁盘又被别人改过」。缺省 = 不知道(不下结论),绝不等于「没改过」。
   * restore-* 运行恢复成功的路径也记一份(恢复写下的内容),好让「撤销过的文件」不被误判成用户改过。
   */
  postHash?: string;
  /**
   * 写完那一刻文件**不存在**(工具把它删了)。与 postHash 互斥地表达「写后状态」:
   * 同一个 run 里先改后删时,modified 条目上旧的 postHash 会被清掉,不能拿过期指纹判「用户改过」。
   * (created 条目上的 postHash 照旧保留,恢复侧那条既有判据不变。)
   */
  postAbsent?: boolean;
  /**
   * 写成了,但写后状态说不清(读不了 / 太大不取指纹)。有它时 postHash / postAbsent 一律不作数:
   * keepEdited 按「判不出 = 改过」不覆盖;restore-* 的条目带它也算「恢复写过这里」,不会退回去拿更早的过期指纹。
   */
  postUnknown?: boolean;
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
 * 工具**写成功之后**:给本 run 里写到的条目补写后状态(postHash / postAbsent)。
 * 有了它,恢复才分得清「删掉 agent 建的文件」(该删)与「删掉用户后来改过的文件」(不该删);
 * modified 条目的指纹供 editedLater / keepEdited 认「agent 写完之后又被人改过」。
 */
export async function recordPostWrite(sessionId: string, runId: string, absPaths: string[]): Promise<void> {
  const paths = new Set(absPaths.filter((p) => p && path.isAbsolute(p)));
  if (!sessionId || !runId || !paths.size) return;
  await serialize(sessionId, async () => {
    const m = await readManifest(sessionId, runId);
    if (!m) return;
    let changed = false;
    // modified 条目「写后状态说不清」时清掉旧值:过期指纹会把 agent 自己的后续写误判成用户改过。
    // created 条目**不清**(恢复侧既有判据依赖它,行为保持原样)。
    const forget = (e: CpEntry): void => {
      if (!e.postUnknown) { e.postUnknown = true; changed = true; }
      if (e.kind !== 'modified') return;
      if (e.postHash !== undefined || e.postAbsent !== undefined) { delete e.postHash; delete e.postAbsent; changed = true; }
    };
    for (const e of m.entries) {
      if (!paths.has(e.path)) continue;
      // ⚠️ 每次写成功都刷新(**不能**见 postHash 就跳过):同一个 run 里「先 write_file 建、
      // 再 edit_file 改」是编码任务的常态,只记第一次的话回退会把 agent 自己的第二次改动
      // 误判成「用户改过」→ 该删的没删,还倒打一耙。
      let st: import('node:fs').Stats;
      try {
        st = await fs.stat(e.path);
      } catch (err: any) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
          // 工具把它删了:记「写后不存在」。modified 条目同时清掉旧指纹(created 的不动)。
          if (e.kind === 'modified') delete e.postHash;
          e.postAbsent = true;
          delete e.postUnknown;
          changed = true;
        } else forget(e);
        continue;
      }
      if (st.size > MAX_SNAP_BYTES) { forget(e); continue; } // 太大不取指纹:恢复侧无指纹 → 按旧语义删
      try {
        e.postHash = hashOf(await fs.readFile(e.path));
        delete e.postAbsent;
        delete e.postUnknown;
        changed = true;
      } catch { forget(e); /* 没写成/读不了:created 留空/留旧,恢复侧按旧语义处理 */ }
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
export async function restoreCodeSince(
  sessionId: string,
  at: number,
  /**
   * paths:只规划 / 恢复这些绝对路径(恢复前的安全快照也只拍它们);缺省 = 全部(既有行为)。
   * keepEdited:modified 条目若在「最后一次写它的那个 run」之后又被改过(写后指纹对不上 / 文件没了)
   *   → 不覆盖,报 conflicts。created 条目照旧走既有冲突判据。缺省 = 既有行为。
   */
  opts?: { paths?: string[]; keepEdited?: boolean },
): Promise<RestoreReport> {
  // ⚠️整段恢复必须和写类工具**同一把锁**(codex 2026-08-17 P1)。路由只检查「被恢复的这个会话」
  // 有没有在跑的 run;**别的**会话在同一个工作区里跑着的 run 照样在写盘。不加锁的话:
  //   ① 下面那句「把现状存成新检查点」会拍到一个写了一半的文件;
  //   ② 恢复的写盘会和对方在飞的 edit 交叠(读-改-写互相覆盖)。
  // 写锁可重入,所以里面调 snapshotBeforeWrite 之类不会死锁。
  return withWriteLock(() => restoreCodeSinceLocked(sessionId, at, opts));
}

async function restoreCodeSinceLocked(
  sessionId: string,
  at: number,
  opts?: { paths?: string[]; keepEdited?: boolean },
): Promise<RestoreReport> {
  const report: RestoreReport = { restored: [], deleted: [], skipped: [], conflicts: [], failed: [] };
  let runIds: string[];
  try {
    runIds = await fs.readdir(sessionDir(sessionId));
  } catch {
    return report;
  }
  const manifests: CpManifest[] = [];
  const all: CpManifest[] = []; // keepEdited 要找「最后一次写它的 run」,不限时刻
  for (const rid of runIds) {
    const m = await readManifest(sessionId, rid);
    if (m) { all.push(m); if (m.at >= at) manifests.push(m); continue; }
    // 文件在却读不出 = 「这个 run 的改动恢复不了」,不能静默跳过(报成功却少恢复最坏)。
    // 目录里根本没 manifest(半路被删 / 无关文件)则不吵。
    const mf = path.join(runDir(sessionId, rid), 'manifest.json');
    if (await fs.stat(mf).then(() => true, () => false)) {
      report.failed.push({ path: mf, error: 'manifest unreadable' });
    }
  }
  manifests.sort((a, b) => a.at - b.at);
  sortManifests(all);
  const only = opts?.paths ? new Set(opts.paths) : null;
  // 同一路径取最早那份 pre-image —— 那才是目标时刻的样子(只回滚最后一个 run 不叫回退)。
  const plan = new Map<string, { e: CpEntry; runId: string }>();
  for (const m of manifests) {
    for (const e of m.entries) {
      if (only && !only.has(e.path)) continue;
      if (!plan.has(e.path)) plan.set(e.path, { e, runId: m.runId });
    }
  }

  // 回退本身也要可回退:动手前把**现状**存成一个新检查点(用户回退错了/手改过的东西还能再捞回来)。
  const restoreRunId = `restore-${Date.now()}`;
  await snapshotBeforeWrite(sessionId, restoreRunId, [...plan.keys()], { prune: false });

  for (const { e, runId } of plan.values()) {
    if (e.skipped) {
      report.skipped.push(e.path);
      continue;
    }
    try {
      if (opts?.keepEdited) {
        // 最后一次写它之后又被改过 → 不覆盖 / 不删。读不了 / 判不出也按「改过」处理:保留是唯一安全方向 ——
        // 包括没记写后状态的条目(本功能之前的旧检查点、写到一半失败的那次):不知道 ≠ 没改过(读失败 ≠ 空)。
        // created 条目也先过这一关:它之后若还有别的 run 改过,该比的是最后那次写,不是建的时候。
        // 例外:created 且现在已经不在 → 目标状态(不存在)已经达成,交给下面的删除(no-op)。
        const goneCreated = e.kind === 'created' && (await diskSide(e.path)).t === 'absent';
        if (!goneCreated) {
          const last = lastWriteEntry(all, e.path);
          const known = !!last && !last.postUnknown && (!!last.postHash || !!last.postAbsent);
          if (!known || (await editedSinceWrite(last!, e.path)) !== false) {
            report.conflicts.push(e.path);
            continue;
          }
        }
      }
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
  // 恢复真写下 / 删掉的路径也记写后状态(只记这些:冲突 / 跳过的那些不是恢复写的)。
  // 否则「撤销过的文件」会被 editedLater / keepEdited 拿 agent 的旧指纹误判成「用户改过」。
  const wrote = [...report.restored, ...report.deleted];
  if (wrote.length) await recordPostWrite(sessionId, restoreRunId, wrote).catch(() => {});
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

// ───────────────────────── 文件改动记录(listChanges)─────────────────────────
// 「这轮改了哪些文件 / 加减多少行」直接从检查点算:每个 run 记着它首次碰每条路径前的 pre-image,
// 一个时间窗的「之前」= 窗内最早碰它的 agent run 的 pre-image,「之后」= 窗口之后第一个碰它的 run
// 的 pre-image(含 restore-*),没有就看磁盘现状。run_bash 改的东西同样不在内(与恢复同口径)。

export interface FileChange {
  /** 绝对路径(与 manifest 里存的一致)。 */
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  /** 真实增删行数;null = 比不了(见 reason)。 */
  adds: number | null;
  dels: number | null;
  /** 仅当 adds/dels 为 null 时给。 */
  reason?: 'binary' | 'toobig' | 'nosnap';
  /** 前后字节都已知且完全相同(撤销过 / 建了又删)。 */
  reverted?: boolean;
  /** 仅开放窗口(until=null):磁盘与「最后一次写它」之后的状态对不上 = 被别人改过。 */
  editedLater?: boolean;
  /** 本窗内碰过这条路径的 agent run 数。 */
  runs: number;
  /** 仅 diff 请求:统一 diff 的 hunk 部分(无 ---/+++ 头,真实行号,2 行上下文)。 */
  patch?: string;
  /** patch 超过上限被截断。 */
  truncated?: boolean;
}

/** [since, until) 的时间窗(ms);until=null = 到现在。 */
export interface ChangeWindow { since: number; until: number | null }

/** 行 diff 的上限:超过就只报 toobig(大文件多为生成物,diff 既慢又没人看)。 */
export const DIFF_MAX_BYTES = 1024 * 1024;
const DIFF_MAX_LINES = 20_000;
/** patch 总行数上限(含 @@ 行)。 */
export const PATCH_MAX_LINES = 2000;
/** 一次 /changes/diff 回应里所有 patch 加起来的上限(字符数)。 */
const RESPONSE_PATCH_MAX_BYTES = 4 * 1024 * 1024;
const PATCH_CONTEXT = 2;
/** 二进制嗅探:前 8000 字节里有 NUL(与 git 同口径)。 */
const BINARY_SNIFF_BYTES = 8000;

/**
 * 一侧的内容:absent = 不存在;unknown = 存在但内容不知道(没存快照 / 读不了);
 * large = 存在但太大没读(>4MB,不可能等于任何快照);bytes = 字节在手。
 */
type Side = { t: 'absent' } | { t: 'unknown' } | { t: 'large' } | { t: 'bytes'; buf: Buffer };

const isRestoreRun = (m: CpManifest): boolean => m.runId.startsWith('restore-');

/** at 升序;同 at 时 agent run 在 restore-* 之前(恢复只能发生在 run 之后),再按 runId,保证结果确定。 */
function sortManifests(list: CpManifest[]): CpManifest[] {
  return list.sort((a, b) => a.at - b.at
    || Number(isRestoreRun(a)) - Number(isRestoreRun(b))
    || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

async function loadAllManifests(sessionId: string): Promise<CpManifest[]> {
  let runIds: string[];
  try {
    runIds = await fs.readdir(sessionDir(sessionId));
  } catch {
    return [];
  }
  const out: CpManifest[] = [];
  for (const rid of runIds) {
    const m = await readManifest(sessionId, rid);
    if (m) out.push(m);
  }
  return sortManifests(out);
}

/** 磁盘现状。ENOENT/ENOTDIR = 不存在;其余读错误 / 目录 = 不知道。 */
async function diskSide(p: string): Promise<Side> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return { t: 'unknown' };
    if (st.size > MAX_SNAP_BYTES) return { t: 'large' };
    return { t: 'bytes', buf: await fs.readFile(p) };
  } catch (e: any) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { t: 'absent' } : { t: 'unknown' };
  }
}

/** 某个 run 碰这条路径**之前**的样子(= 它的 pre-image)。 */
async function entrySide(sessionId: string, m: CpManifest, e: CpEntry): Promise<Side> {
  if (e.kind === 'created') return { t: 'absent' };
  if (e.skipped || !e.snap) return e.reason === 'TOOBIG' ? { t: 'large' } : { t: 'unknown' };
  try {
    return { t: 'bytes', buf: await fs.readFile(path.join(runDir(sessionId, m.runId), e.snap)) };
  } catch {
    return { t: 'unknown' };
  }
}

/**
 * 最后一次**写**这条路径的条目:最晚碰它的 agent run;restore-* 只有带写后状态(= 恢复真写了它)时才算,
 * 否则(冲突 / 跳过 / 旧版恢复没记)往前找。listChanges 的 editedLater 与 keepEdited 共用这一份,不会各说各话。
 */
function lastWriteEntry(sortedAll: CpManifest[], p: string): CpEntry | null {
  for (let i = sortedAll.length - 1; i >= 0; i--) {
    const m = sortedAll[i];
    const e = m.entries.find((x) => x.path === p);
    if (!e) continue;
    if (!isRestoreRun(m)) return e;
    if (e.postAbsent || e.postHash || e.postUnknown) return e;
  }
  return null;
}

/** 磁盘现状 vs 该条目的写后状态:true = 被改过;false = 没改过 / 没记写后状态(不下结论);null = 判不出(读不了)。 */
function editedAgainst(e: CpEntry, disk: Side): boolean | null {
  if (e.postUnknown) return false;
  if (e.postAbsent) return disk.t !== 'absent';
  if (!e.postHash) return false;
  switch (disk.t) {
    case 'absent': return true;
    case 'large': return true; // 指纹只在 ≤4MB 时记,现在更大 = 必然变了
    case 'unknown': return null;
    default: return hashOf(disk.buf) !== e.postHash;
  }
}

async function editedSinceWrite(e: CpEntry, p: string): Promise<boolean | null> {
  if (e.postUnknown || (!e.postAbsent && !e.postHash)) return false;
  return editedAgainst(e, await diskSide(p));
}

/** 按 \n 切行(\r\n 视同 \n);末尾换行不单独算一行,所以「缺末尾换行」本身不算改动。 */
function splitLines(buf: Buffer): string[] {
  const s = buf.toString('utf8').replace(/\r\n/g, '\n');
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** 一段不一致:a[aStart, aStart+aLen) 换成 b[bStart, bStart+bLen)(0 基)。 */
interface DiffBlock { aStart: number; aLen: number; bStart: number; bLen: number }

/**
 * node-diff3 的 LCS(Hunt–Szymanski,候选表线性扫)在重复行很多时退化到 ~O(配对数 × LCS 长):
 * 两种行交替的 5000 行实测 20 秒,而且是同步的 —— 会把整个引擎卡死。所以只在「配对数」(a 的每行在 b 里出现的次数之和)
 * 不超过这个预算时直接交给它;超了先按 patience 的办法拿两边都只出现一次的行当锚点切段,逐段再判;一段里连锚点都没有
 * 才整段按「全删全加」报(只在大段重写 + 大量重复行时发生,数字偏大但有上界,不会卡住)。
 */
const LCS_PAIR_BUDGET = 100_000; // 约 1 秒以内的同步计算;超了按唯一行切段(Codex 评审:40 万对能卡 3–4 秒)

function matchPairs(a: string[], b: string[]): number {
  const cnt = new Map<string, number>();
  for (const l of b) cnt.set(l, (cnt.get(l) ?? 0) + 1);
  let e = 0;
  for (const l of a) e += cnt.get(l) ?? 0;
  return e;
}

/** 两边都只出现一次的行配成对,取 b 下标递增的最长子序列(patience 排序,O(k log k))。返回 [a 下标, b 下标] 升序。 */
function uniqueAnchors(a: string[], b: string[]): Array<[number, number]> {
  const ca = new Map<string, number>();
  for (const l of a) ca.set(l, (ca.get(l) ?? 0) + 1);
  const posB = new Map<string, number>();
  const cb = new Map<string, number>();
  b.forEach((l, j) => { cb.set(l, (cb.get(l) ?? 0) + 1); posB.set(l, j); });
  const pairs: Array<[number, number]> = [];
  a.forEach((l, i) => { if (ca.get(l) === 1 && cb.get(l) === 1) pairs.push([i, posB.get(l)!]); });
  // LIS on j
  const tails: number[] = []; // tails[k] = pairs 下标,长度 k+1 的递增子序列的最小结尾
  const prev: number[] = new Array(pairs.length).fill(-1);
  for (let p = 0; p < pairs.length; p++) {
    const j = pairs[p][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[p] = tails[lo - 1];
    tails[lo] = p;
  }
  const out: Array<[number, number]> = [];
  for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = prev[p]) out.push(pairs[p]);
  return out.reverse();
}

/** a[a0,a1) 对 b[b0,b1) 的不一致块(绝对下标),按顺序追加到 out。 */
function diffRange(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number, out: DiffBlock[]): void {
  // 先剥公共前后缀(绝大多数改动是局部的)
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; }
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; }
  if (a0 === a1 && b0 === b1) return;
  if (a0 === a1 || b0 === b1) { out.push({ aStart: a0, aLen: a1 - a0, bStart: b0, bLen: b1 - b0 }); return; }
  const am = a.slice(a0, a1);
  const bm = b.slice(b0, b1);
  if (matchPairs(am, bm) <= LCS_PAIR_BUDGET) {
    for (const d of diffIndices(am, bm)) {
      out.push({ aStart: a0 + d.buffer1[0], aLen: d.buffer1[1], bStart: b0 + d.buffer2[0], bLen: d.buffer2[1] });
    }
    return;
  }
  const anchors = uniqueAnchors(am, bm);
  if (!anchors.length) { out.push({ aStart: a0, aLen: a1 - a0, bStart: b0, bLen: b1 - b0 }); return; }
  let pa = a0;
  let pb = b0;
  for (const [i, j] of anchors) {
    diffRange(a, pa, a0 + i, b, pb, b0 + j, out);
    pa = a0 + i + 1;
    pb = b0 + j + 1;
  }
  diffRange(a, pa, a1, b, pb, b1, out);
}

/** 行级 diff:不一致块按顺序排列,块与块之间的相同行在两侧一一对应。 */
function diffBlocks(a: string[], b: string[]): DiffBlock[] {
  const out: DiffBlock[] = [];
  diffRange(a, 0, a.length, b, 0, b.length, out);
  return out;
}

/** hunk 头(aS / bS 为 0 基起点):计数为 0 时起始行写「前一行」(与 GNU diff 同口径,新建文件 = -0,0)。 */
export function hunkHeader(aS: number, bS: number, body: string[]): string {
  let aN = 0;
  let bN = 0;
  for (const l of body) {
    if (l[0] !== '+') aN++;
    if (l[0] !== '-') bN++;
  }
  return `@@ -${aN ? aS + 1 : aS},${aN} +${bN ? bS + 1 : bS},${bN} @@`;
}

/** 统一 diff 的 hunk 部分;上下文相距 ≤ 2×CONTEXT 的块并成一个 hunk。总行数封顶 PATCH_MAX_LINES。 */
function buildPatch(a: string[], b: string[], blocks: DiffBlock[]): { patch: string; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  let i = 0;
  while (i < blocks.length) {
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1].aStart - (blocks[j].aStart + blocks[j].aLen) <= 2 * PATCH_CONTEXT) j++;
    const first = blocks[i];
    const last = blocks[j];
    const pre = Math.min(PATCH_CONTEXT, first.aStart);
    const post = Math.min(PATCH_CONTEXT, a.length - (last.aStart + last.aLen));
    let ai = first.aStart - pre;
    let bi = first.bStart - pre;
    const aS = ai;
    const bS = bi;
    const body: string[] = [];
    for (let k = i; k <= j; k++) {
      const blk = blocks[k];
      while (ai < blk.aStart) { body.push(' ' + a[ai++]); bi++; }
      for (let x = 0; x < blk.aLen; x++) body.push('-' + a[ai++]);
      for (let x = 0; x < blk.bLen; x++) body.push('+' + b[bi++]);
    }
    for (let x = 0; x < post; x++) { body.push(' ' + a[ai++]); bi++; }
    const room = PATCH_MAX_LINES - out.length - 1;
    if (body.length > room) {
      // 截断:这一个 hunk 只留装得下的部分,头部计数按留下的行重算(前端照头渲染行号不会错位)。
      if (room > 0) {
        const cut = body.slice(0, room);
        out.push(hunkHeader(aS, bS, cut), ...cut);
      }
      truncated = true;
      break;
    }
    out.push(hunkHeader(aS, bS, body), ...body);
    i = j + 1;
  }
  return { patch: out.join('\n'), truncated };
}

export type LineStat =
  | { adds: number; dels: number; patch?: string; truncated?: boolean }
  | { adds: null; dels: null; reason: 'binary' | 'toobig' | 'nosnap' };

/** 两侧内容 → 增删行数(+ 可选 patch)。判定顺序:不知道 → 二进制 → 太大。 */
function lineStat(before: Side, after: Side, wantPatch: boolean): LineStat {
  if (before.t === 'unknown' || after.t === 'unknown') return { adds: null, dels: null, reason: 'nosnap' };
  const bufs = [before, after].flatMap((s) => (s.t === 'bytes' ? [s.buf] : []));
  if (bufs.some(isBinary)) return { adds: null, dels: null, reason: 'binary' };
  if (before.t === 'large' || after.t === 'large' || bufs.some((b) => b.byteLength > DIFF_MAX_BYTES)) {
    return { adds: null, dels: null, reason: 'toobig' };
  }
  const a = before.t === 'bytes' ? splitLines(before.buf) : [];
  const b = after.t === 'bytes' ? splitLines(after.buf) : [];
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return { adds: null, dels: null, reason: 'toobig' };
  return statFromLines(a, b, wantPatch);
}

/**
 * 新建文件(之前不存在)的行数统计,与 listChanges 同一套二进制 / 太大 / 切行口径。
 * git 范围的未跟踪文件走这里;buf=null 表示存在但读不了,'large' 表示太大没读。
 */
export function newFileStat(buf: Buffer | null | 'large', wantPatch: boolean): LineStat {
  const after: Side = buf === null ? { t: 'unknown' } : buf === 'large' ? { t: 'large' } : { t: 'bytes', buf };
  return lineStat({ t: 'absent' }, after, wantPatch);
}

/** 已切好行的两侧 → 增删行数(+ 可选 patch)。 */
function statFromLines(a: string[], b: string[], wantPatch: boolean): { adds: number; dels: number; patch?: string; truncated?: boolean } {
  const blocks = diffBlocks(a, b);
  let adds = 0;
  let dels = 0;
  for (const blk of blocks) { adds += blk.bLen; dels += blk.aLen; }
  if (!wantPatch) return { adds, dels };
  const { patch, truncated } = buildPatch(a, b, blocks);
  return { adds, dels, patch, ...(truncated ? { truncated } : {}) };
}

/**
 * 按时间窗列出 agent 改过的文件。每个窗口独立算「之前 / 之后」,返回与 windows 一一对应。
 * - agent run = runId 不以 restore- 开头;restore-* 只当「之后」的边界(它的 pre-image = 恢复那一刻的现状)。
 * - opts.path 只看这一条路径;opts.diff 附 patch(adds/dels 为 null 时没有 patch;0/0 时 patch = '')。
 */
export async function listChanges(
  sessionId: string,
  windows: ChangeWindow[],
  opts?: { diff?: boolean; path?: string },
): Promise<FileChange[][]> {
  const all = await loadAllManifests(sessionId);
  const agentRuns = all.filter((m) => !isRestoreRun(m));
  const out: FileChange[][] = [];
  // 一次回应里 patch 的总字节封顶:单个 patch 有行数上限,但几百个长行文件叠起来能把 JSON 撑爆。
  // 超了的文件只给增减、不带 patch,标 truncated(前端说「太多,打开文件看」)。
  let patchBudget = RESPONSE_PATCH_MAX_BYTES;
  for (const w of windows) {
    const inWin = agentRuns.filter((m) => m.at >= w.since && (w.until === null || m.at < w.until));
    // 路径 → 窗内最早碰它的 run 与条目、碰过它的 run 数。Map 保序 = 首次出现的顺序。
    const firsts = new Map<string, { m: CpManifest; e: CpEntry; runs: number }>();
    for (const m of inWin) {
      const seen = new Set<string>();
      for (const e of m.entries) {
        if (opts?.path !== undefined && e.path !== opts.path) continue;
        if (seen.has(e.path)) continue;
        seen.add(e.path);
        const hit = firsts.get(e.path);
        if (hit) hit.runs++;
        else firsts.set(e.path, { m, e, runs: 1 });
      }
    }
    const files: FileChange[] = [];
    for (const [p, { m, e, runs }] of firsts) {
      const before = await entrySide(sessionId, m, e);
      let after: Side;
      if (w.until === null) {
        after = await diskSide(p);
      } else {
        const until = w.until;
        let next: { m: CpManifest; e: CpEntry } | null = null;
        for (const nm of all) {
          if (nm.at < until) continue;
          const ne = nm.entries.find((x) => x.path === p);
          if (ne) { next = { m: nm, e: ne }; break; }
        }
        after = next ? await entrySide(sessionId, next.m, next.e) : await diskSide(p);
      }
      const fc = describeChange(p, before, after, runs, !!opts?.diff && patchBudget > 0, w.until === null ? lastWriteEntry(all, p) : undefined);
      if (opts?.diff) {
        const size = fc.patch?.length ?? 0;
        if (fc.adds !== null && (fc.adds || fc.dels) && (patchBudget <= 0 || size > patchBudget)) { delete fc.patch; fc.truncated = true; patchBudget = 0; }
        else patchBudget -= size;
      }
      files.push(fc);
      // 一个文件算完让一下事件循环:多个大文件不连成一整段同步阻塞
      await new Promise<void>((r) => setImmediate(r));
    }
    out.push(files);
  }
  return out;
}

/** 一条路径的前后两侧 → FileChange。lastWrite !== undefined 表示开放窗口(after 即磁盘),要算 editedLater。 */
function describeChange(p: string, before: Side, after: Side, runs: number, wantPatch: boolean, lastWrite: CpEntry | null | undefined): FileChange {
  const had = before.t !== 'absent';
  const has = after.t !== 'absent';
  const fc: FileChange = { path: p, kind: had ? (has ? 'modified' : 'deleted') : 'created', adds: null, dels: null, runs };
  if (!had && !has) {
    // 建了又删:净改动为零
    fc.adds = 0;
    fc.dels = 0;
    fc.reverted = true;
    if (wantPatch) fc.patch = '';
  } else {
    const st = lineStat(before, after, wantPatch);
    if (st.adds === null) {
      fc.reason = st.reason;
    } else {
      fc.adds = st.adds;
      fc.dels = st.dels;
      if (wantPatch) fc.patch = st.patch ?? '';
      if (st.truncated) fc.truncated = true;
    }
    if (before.t === 'bytes' && after.t === 'bytes' && before.buf.equals(after.buf)) fc.reverted = true;
  }
  if (lastWrite !== undefined) {
    // 判不出(磁盘读不了)不下结论:这里只是提示,真要覆盖时 keepEdited 会按「改过」保守处理。
    fc.editedLater = lastWrite ? editedAgainst(lastWrite, after) === true : false;
  }
  return fc;
}
