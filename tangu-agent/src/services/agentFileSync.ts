/**
 * 每-agent 云文件镜像(Phase 2,out-of-band,不在 agent 热路径)。把开了 cloudSync 的 agent 的全部文件
 * (config.toml / SOUL.md / MEMORY.md / LOG/<date>.md / Library/*)与 Forsion 云 `tangu_agent_files`
 * **完全镜像**。
 *
 * 2026-07 起对账算法升级为 **hash 三方对账 + CAS + 冲突副本**(对齐 Amadeus vault 引擎,时钟无关):
 *   - 判定核 decide() 移植自 desktop/electron/amadeus/sync/reconcile.ts(正典,改语义两处同改);
 *   - 基线存 `<agentDir>/.cloudsync.json`(per-file {seq, hash, size, mtimeMs});
 *   - 双方都动且内容不同 → 本地版本改名冲突副本(`Name (conflict …)`),云端版本落原路径,绝不静默丢;
 *   - 写云端带 baseSeq(CAS),409 兜并发;删除同理(编辑胜删除:409 → 改拉);
 *   - 旧服务端(manifest 无 seq)/旧二进制行(hash=null)→ 该文件回退旧 mtime-LWW,写入后自动升级。
 * LOG 例外仍是块并集合并(绝不 LWW —— 两端同日离线各加条目不丢)。二进制走 base64。
 *
 * 分桶(D6):config/SOUL/Library 落 agent 自己 slug;MEMORY/LOG 落 resolveMemorySlug(def)
 * (共用默认的 agent → 记忆桶是 xyra,多个共用者每趟只同步一次)。
 * 云端不可达/未登录 → 抛错,调用方 no-op。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { deps } from '../seams/runtime.js';
import { agentsDir, userMdFile } from '../core/tanguHome.js';
import { getDeviceId } from '../core/deviceId.js';
import { listAgents, parseAgentConfig, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';
import { splitLogBlocks, mergeBlocks } from './memorySync.js';
import { AgentFileConflictError, type AgentFilesBrain, type AgentFileMeta } from '../seams/cloudBrain.js';

const TEXT_EXTS = new Set(['.md', '.toml', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.xml', '.js', '.ts', '.py']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const USER_SENTINEL = '__user__';
const LOG_RE = /^LOG\/\d{4}-\d{2}-\d{2}\.md$/;

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

type Category = 'DEF' | 'MEM';
function categoryOf(relPath: string): Category {
  return relPath === 'MEMORY.md' || relPath.startsWith('LOG/') ? 'MEM' : 'DEF';
}
function isBinaryPath(relPath: string): boolean {
  return !TEXT_EXTS.has(extname(relPath).toLowerCase());
}
/** 仅同步这些:config.toml / SOUL.md / HARNESS.md / MEMORY.md / LOG/<date>.md / Library/**
 *  (排除点文件/同步元数据;HARNESS 的快照史 .harness-refinements.jsonl 是点文件 → 只留本机)。 */
function isSyncable(relPath: string): boolean {
  if (relPath.split('/').some((seg) => seg.startsWith('.'))) return false;
  return (
    relPath === 'config.toml' || relPath === 'SOUL.md' || relPath === 'MEMORY.md' ||
    relPath === 'HARNESS.md' ||
    (relPath.startsWith('LOG/') && relPath.endsWith('.md')) ||
    relPath.startsWith('Library/')
  );
}

interface LocalStat { mtimeMs: number; size: number; isBinary: boolean }
/** 枚举 agent 目录下可同步文件 → relPath(posix)→ 本地 stat(mtime floor 到整数 ms,与云端 BIGINT 对齐避免 ping-pong)。 */
function enumerateLocal(dir: string, categories: Set<Category>): Map<string, LocalStat> {
  const out = new Map<string, LocalStat>();
  const walk = (abs: string, rel: string): void => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else if (e.isFile() && isSyncable(childRel) && categories.has(categoryOf(childRel))) {
        try {
          const st = statSync(join(abs, e.name));
          out.set(childRel, { mtimeMs: Math.floor(st.mtimeMs), size: st.size, isBinary: isBinaryPath(childRel) });
        } catch { /* ignore */ }
      }
    }
  };
  walk(dir, '');
  return out;
}

/** per-file 基线:seq+hash = 三方对账(2026-07+);仅 lastCloudMtimeMs = 旧 mtime-LWW 时代的水位(渐进升级)。 */
interface PrevEntry { seq?: number; hash?: string; size?: number; mtimeMs?: number; lastCloudMtimeMs?: number }
interface PrevState { files: Record<string, PrevEntry>; lastSyncAt?: number }
function prevFile(dir: string): string { return join(dir, '.cloudsync.json'); }
function readPrev(dir: string): PrevState {
  try {
    const j = JSON.parse(readFileSync(prevFile(dir), 'utf8'));
    return { files: j.files ?? {}, lastSyncAt: j.lastSyncAt };
  } catch { return { files: {} }; }
}
function writePrev(dir: string, st: PrevState): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(prevFile(dir), JSON.stringify(st, null, 2), 'utf8'); } catch { /* best-effort */ }
}

function nowMs(): number { return Math.floor(Date.now()); }
function rebuildLog(header: string, blocks: string[]): string {
  const h = (header || '').replace(/\s+$/, '');
  return `${h}\n\n${blocks.map((b) => b + '\n').join('\n')}`;
}

// ── 三方对账判定核(移植自 desktop/electron/amadeus/sync/reconcile.ts,语义正典在那边)────────────
interface ShadowVer { seq: number; hash: string }
interface RemoteVer { seq: number; hash: string | null }
type Decision =
  | { kind: 'none' } | { kind: 'adopt' } | { kind: 'pull' }
  | { kind: 'push'; baseSeq: number } | { kind: 'pushCreate' } | { kind: 'pushDelete' }
  | { kind: 'deleteLocal' } | { kind: 'dropShadow' } | { kind: 'conflict' };

export function decide(local: string | null, shadow: ShadowVer | null, remote: RemoteVer | null): Decision {
  if (local === null && shadow === null && remote === null) return { kind: 'none' };
  if (remote === null) {
    if (local === null) return shadow ? { kind: 'dropShadow' } : { kind: 'none' };
    if (!shadow) return { kind: 'pushCreate' };
    return local === shadow.hash ? { kind: 'deleteLocal' } : { kind: 'pushCreate' }; // 本地未动=删除生效;改过=编辑胜删除
  }
  if (local === null) {
    if (!shadow) return { kind: 'pull' };
    return remote.seq === shadow.seq ? { kind: 'pushDelete' } : { kind: 'pull' }; // 服务端未动=本地删生效;动过=编辑胜删除
  }
  if (!shadow) return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' };
  const localDirty = local !== shadow.hash;
  const remoteMoved = remote.seq !== shadow.seq;
  if (!localDirty && !remoteMoved) return { kind: 'none' };
  if (!localDirty) return { kind: 'pull' };
  if (!remoteMoved) return { kind: 'push', baseSeq: shadow.seq };
  return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' };
}

/** 取不存在的冲突副本名(同分钟第二次冲突 → `…-2` 递增,绝不覆盖先前副本)。 */
function uniqueConflictName(baseDir: string, relPath: string): string {
  const first = conflictCopyName(relPath, new Date());
  const dot = first.lastIndexOf('.');
  const hasExt = dot > first.lastIndexOf('/');
  const stem = hasExt ? first.slice(0, dot) : first;
  const ext = hasExt ? first.slice(dot) : '';
  let cand = first;
  for (let n = 2; existsSync(join(baseDir, cand)); n++) cand = `${stem}-${n}${ext}`;
  return cand;
}

/** 冲突副本名:`Library/a.md` → `Library/a (conflict 2026-07-19 1532).md`(与 Amadeus 引擎同款)。 */
export function conflictCopyName(relPath: string, now: Date): string {
  const slash = relPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relPath.slice(0, slash + 1);
  const base = slash < 0 ? relPath : relPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
  return `${dir}${stem} (conflict ${stamp})${ext}`;
}

export interface AgentFileSyncResult { ok: boolean; agents: number; pushed: number; pulled: number; deleted: number; skipped: number; conflicts: number; error?: string }

/**
 * 后台跑一次双向镜像(fire-and-forget)。挂两类时机:① run 结束后(推本轮 Historian/工具写的
 * MEMORY/LOG/Library 上云——此前只有下一次 run 的 pre-run sync 或手动同步才推,云端/他端的记忆
 * 视图在窗口期看不到新记忆);② 记忆/日志视图打开时(拉云端 worker 侧写的新记忆下来)。
 * 幂等(hash/清单比较),未开 cloudSync 的 agent 零开销;仅本地形态(hostExec)有文件可动。
 */
export function scheduleAgentFilesSync(userId: string, slug?: string): void {
  try {
    const d = deps();
    if (!d.profile.capabilities.hostExec) return;
    const af = d.brain.agentFiles;
    if (!af) return;
    void runAgentFilesSync(af, userId, slug ? { onlySlug: slug } : undefined).catch((e: any) => {
      console.warn('[agent-core] post-run agent files sync failed:', e?.message || e);
    });
  } catch {
    /* deps 未装配(测试等)→ no-op */
  }
}

export async function runAgentFilesSync(
  cloud: AgentFilesBrain,
  userId: string,
  opts?: { onlySlug?: string },
): Promise<AgentFileSyncResult> {
  const deviceId = getDeviceId();
  const agg: AgentFileSyncResult = { ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: 0 };
  const onlySlug = typeof opts?.onlySlug === 'string' && opts.onlySlug ? opts.onlySlug : undefined;

  // 云端清单一次拉全,按 slug 索引。
  const manifest = await cloud.getManifest(userId);
  const cloudBySlug = new Map<string, AgentFileMeta[]>();
  for (const m of manifest) cloudBySlug.set(m.slug, m.files);

  // 本地已存在的 cloudSync agent 之外，还要发现「只存在云端」的 agent。否则全新的
  // standalone worker 本地只有内置 agent，永远不会进入后面的 bucket，自然也拉不到 Library。
  // 以云端 config.toml 的 cloud_sync=true 为 opt-in；特殊哨兵桶没有 config，自动跳过。
  const agents: NormalAgentDef[] = (await listAgents()).filter((a) => a.cloudSync && (!onlySlug || a.slug === onlySlug));
  const known = new Set(agents.map((a) => a.slug));
  for (const [slug, files] of cloudBySlug) {
    if ((onlySlug && slug !== onlySlug) || known.has(slug) || slug.startsWith('__')) continue;
    const cfgMeta = files.find((f) => f.relPath === 'config.toml' && !f.deleted);
    if (!cfgMeta) continue;
    try {
      const cfg = await cloud.getFile(userId, slug, 'config.toml');
      if (!cfg || cfg.deleted || cfg.isBinary || !cfg.content) continue;
      const def = parseAgentConfig(slug, cfg.content, '');
      if (!def.cloudSync) continue;
      agents.push(def);
      known.add(slug);
    } catch (e: any) {
      console.warn(`[agentFileSync] 云端 agent ${slug} 引导失败:`, e?.message || e);
    }
  }
  agg.agents = agents.length;

  // 分桶:slug → 要同步的 category 集(D6 去重)。
  const buckets = new Map<string, Set<Category>>();
  const add = (slug: string, cat: Category): void => {
    const s = buckets.get(slug) ?? new Set<Category>();
    s.add(cat); buckets.set(slug, s);
  };
  for (const a of agents) { add(a.slug, 'DEF'); add(resolveMemorySlug(a), 'MEM'); }

  for (const [slug, cats] of buckets) {
    await syncBucket(slug, join(agentsDir(), slug), cats, cloudBySlug.get(slug) ?? [], cloud, userId, deviceId, agg);
  }

  // USER.md(全局,所有同步 agent 可见)。基线存 agents/.cloudsync.json(不属于任何 agent 目录)。
  if (agents.length) {
    await syncGlobalFile(USER_SENTINEL, 'USER.md', userMdFile(), cloudBySlug.get(USER_SENTINEL) ?? [], cloud, userId, deviceId, agg);
  }
  return agg;
}

/** 同步一个云端 slug 桶(只处理 categories 内的 relPath)。 */
async function syncBucket(
  cloudSlug: string, localDir: string, categories: Set<Category>, cloudFiles: AgentFileMeta[],
  cloud: AgentFilesBrain, userId: string, deviceId: string, agg: AgentFileSyncResult,
): Promise<void> {
  const prev = readPrev(localDir);
  const local = enumerateLocal(localDir, categories);
  const cloudByPath = new Map<string, AgentFileMeta>();
  for (const f of cloudFiles) if (categories.has(categoryOf(f.relPath))) cloudByPath.set(f.relPath, f);

  const allPaths = new Set<string>([
    ...local.keys(),
    ...cloudByPath.keys(),
    ...Object.keys(prev.files).filter((p) => categories.has(categoryOf(p))),
  ]);

  for (const p of allPaths) {
    try {
      if (LOG_RE.test(p)) await reconcileLog(cloudSlug, localDir, p, local.get(p), cloudByPath.get(p), cloud, userId, deviceId, prev, agg);
      else await reconcileFile(cloudSlug, localDir, p, local.get(p), cloudByPath.get(p), cloud, userId, deviceId, prev, agg);
    } catch (e: any) {
      console.warn(`[agentFileSync] ${cloudSlug}/${p} 失败:`, e?.message || e);
    }
  }
  prev.lastSyncAt = nowMs();
  writePrev(localDir, prev);
}

/** 该云端条目是否具备三方对账所需版本信息(旧服务端/迁移前二进制行 → 否,回退 mtime-LWW)。 */
function casReady(C: AgentFileMeta | undefined): boolean {
  if (!C) return true; // 无云端行:创建路径,不需要版本信息
  if (typeof C.seq !== 'number') return false; // 旧服务端
  if (C.deleted) return true; // 墓碑 → remote=null,不需要 hash
  return C.hash != null; // 迁移前的二进制行 hash 为 null
}

/** 单文件三方对账 + CAS + 冲突副本。p 非 LOG。 */
async function reconcileFile(
  slug: string, localDir: string, p: string, L: LocalStat | undefined, C: AgentFileMeta | undefined,
  cloud: AgentFilesBrain, userId: string, deviceId: string, prev: PrevState, agg: AgentFileSyncResult,
): Promise<void> {
  if (!casReady(C)) { await reconcileFileLegacy(slug, localDir, p, L, C, cloud, userId, deviceId, prev, agg); return; }

  const abs = join(localDir, p);
  const pe = prev.files[p];

  // 本地内容 hash(基线 stat 一致 → 免读文件直接用基线 hash)。
  let buf: Buffer | null = null;
  let localHash: string | null = null;
  if (L) {
    if (pe?.hash != null && pe.size === L.size && pe.mtimeMs === L.mtimeMs) {
      localHash = pe.hash;
    } else {
      try { buf = await fsp.readFile(abs); localHash = sha256(buf); } catch { localHash = null; }
    }
  }
  const readBuf = async (): Promise<Buffer> => buf ?? (buf = await fsp.readFile(abs));

  // 基线:新版 {seq,hash};旧 mtime 水位可安全升格的唯一情形 —— 云端自那次同步后未动
  // (C.mtimeMs === lastCloudMtimeMs),此时云端内容就是基线。否则视为无基线(诚实进 conflict)。
  const live = C && !C.deleted ? C : undefined;
  let shadow: ShadowVer | null = pe?.hash != null && pe.seq != null ? { seq: pe.seq, hash: pe.hash } : null;
  if (!shadow && pe?.lastCloudMtimeMs != null && live && live.mtimeMs === pe.lastCloudMtimeMs && live.hash != null) {
    shadow = { seq: live.seq!, hash: live.hash };
  }
  const remote: RemoteVer | null = live ? { seq: live.seq!, hash: live.hash ?? null } : null;

  const record = (seq: number | undefined, hash: string | null | undefined, cloudMtime?: number): void => {
    let st: { size: number; mtimeMs: number } | null = null;
    try { const s = statSync(abs); st = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) }; } catch { /* absent */ }
    prev.files[p] = {
      ...(typeof seq === 'number' && hash != null ? { seq, hash } : {}),
      ...(st ? { size: st.size, mtimeMs: st.mtimeMs } : {}),
      ...(cloudMtime != null ? { lastCloudMtimeMs: cloudMtime } : {}),
    };
  };

  const pull = async (): Promise<void> => {
    const f = await cloud.getFile(userId, slug, p); // 以 getFile 为权威(清单快照可能已过时)
    if (!f || f.deleted) return; // 竞态:下趟收敛
    const bytes = f.isBinary ? Buffer.from(f.contentBase64 || '', 'base64') : Buffer.from(f.content || '', 'utf8');
    if (f.hash != null && sha256(bytes) !== f.hash) {
      // 传输/存储层给了与登记 hash 不符的字节(如损坏/截断):拒收,保住本地。
      console.warn(`[agentFileSync] ${slug}/${p} 拉取内容 hash 不符,跳过本轮`);
      agg.skipped++;
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    await fsp.writeFile(abs, bytes);
    await fsp.utimes(abs, new Date(f.mtimeMs), new Date(f.mtimeMs)).catch(() => {});
    record(f.seq, f.hash ?? sha256(bytes), f.mtimeMs);
    agg.pulled++;
  };

  /** 本地当前内容 → 冲突副本(rename,保留原字节);副本下趟按新文件推上云(Library/*)。
   *  同分钟撞名递增后缀;非 ENOENT 失败抛错中止本文件(绝不在副本没保住时继续 pull 覆盖)。 */
  const materializeConflictCopy = async (): Promise<void> => {
    const copyRel = uniqueConflictName(localDir, p);
    try {
      await fsp.rename(abs, join(localDir, copyRel));
      agg.conflicts++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; // 本地已不在:无可保
      throw e;
    }
  };

  const push = async (baseSeq: number): Promise<void> => {
    if (!L) return;
    const bytes = await readBuf();
    if (bytes.length > MAX_FILE_BYTES) { console.warn(`[agentFileSync] 跳过超限文件 ${slug}/${p} (${bytes.length}B)`); agg.skipped++; return; }
    const body = L.isBinary
      ? { contentBase64: bytes.toString('base64'), isBinary: true as const, size: bytes.length, mtimeMs: L.mtimeMs, deviceId, baseSeq }
      : { content: bytes.toString('utf8'), isBinary: false as const, size: bytes.length, mtimeMs: L.mtimeMs, deviceId, baseSeq };
    try {
      const r = await cloud.putFile(userId, slug, p, body);
      record(r.seq, typeof r.seq === 'number' ? localHash : undefined, r.mtimeMs);
      agg.pushed++;
    } catch (e) {
      if (e instanceof AgentFileConflictError) {
        if (e.info.hash !== null && e.info.hash === localHash) { record(e.info.seq, localHash, e.info.mtimeMs); return; } // 两端写了相同内容
        if (e.info.seq === 0) {
          // 服务端行没了(被删/墓碑):编辑胜删除,按创建重推一次。
          if (baseSeq !== 0) { delete prev.files[p]; await push(0); }
          else { console.warn(`[agentFileSync] ${slug}/${p} 创建持续 409,跳过`); agg.skipped++; }
          return;
        }
        await materializeConflictCopy(); // 真并发冲突:本地进副本,云端版本落原路径
        await pull();
        return;
      }
      throw e;
    }
  };

  const d = decide(localHash, shadow, remote);
  switch (d.kind) {
    case 'none':
      if (pe?.hash != null && L) record(pe.seq, pe.hash, pe.lastCloudMtimeMs); // 刷新 stat 缓存
      break;
    case 'adopt':
      record(remote!.seq, localHash, live!.mtimeMs);
      break;
    case 'pull':
      await pull();
      break;
    case 'push':
      await push(d.baseSeq);
      break;
    case 'pushCreate':
      await push(0);
      break;
    case 'pushDelete':
      try {
        await cloud.deleteFile(userId, slug, p, nowMs(), deviceId, shadow!.seq);
        delete prev.files[p];
        agg.deleted++;
      } catch (e) {
        if (e instanceof AgentFileConflictError) { await pull(); return; } // 编辑胜删除:拉回
        throw e;
      }
      break;
    case 'deleteLocal':
      await fsp.rm(abs, { force: true }).catch(() => {});
      delete prev.files[p];
      agg.deleted++;
      break;
    case 'dropShadow':
      delete prev.files[p];
      break;
    case 'conflict':
      await materializeConflictCopy();
      await pull();
      break;
  }
}

/** 旧 mtime-LWW + 墓碑(仅当云端条目缺 seq/hash:旧服务端或迁移前二进制行)。写入成功即升级三方基线。 */
async function reconcileFileLegacy(
  slug: string, localDir: string, p: string, L: LocalStat | undefined, C: AgentFileMeta | undefined,
  cloud: AgentFilesBrain, userId: string, deviceId: string, prev: PrevState, agg: AgentFileSyncResult,
): Promise<void> {
  const abs = join(localDir, p);
  const hadPrev = !!prev.files[p];
  const push = async (mtimeMs: number, isBinary: boolean): Promise<void> => {
    const buf = await fsp.readFile(abs);
    if (buf.length > MAX_FILE_BYTES) { console.warn(`[agentFileSync] 跳过超限文件 ${slug}/${p} (${buf.length}B)`); agg.skipped++; return; }
    const body = isBinary
      ? { contentBase64: buf.toString('base64'), isBinary: true as const, size: buf.length, mtimeMs, deviceId }
      : { content: buf.toString('utf8'), isBinary: false as const, size: buf.length, mtimeMs, deviceId };
    const r = await cloud.putFile(userId, slug, p, body);
    prev.files[p] = typeof r.seq === 'number'
      ? { seq: r.seq, hash: r.hash ?? sha256(buf), lastCloudMtimeMs: r.mtimeMs } // 新服务端:升级三方基线
      : { lastCloudMtimeMs: r.mtimeMs };
    agg.pushed++;
  };
  const pull = async (meta: AgentFileMeta): Promise<void> => {
    const f = await cloud.getFile(userId, slug, p);
    if (!f || f.deleted) return;
    mkdirSync(dirname(abs), { recursive: true });
    const buf = f.isBinary ? Buffer.from(f.contentBase64 || '', 'base64') : Buffer.from(f.content || '', 'utf8');
    await fsp.writeFile(abs, buf);
    await fsp.utimes(abs, new Date(meta.mtimeMs), new Date(meta.mtimeMs)).catch(() => {}); // 本地 mtime 对齐云端 → 下次 in-sync
    prev.files[p] = typeof f.seq === 'number' && f.hash != null
      ? { seq: f.seq, hash: f.hash, lastCloudMtimeMs: meta.mtimeMs }
      : { lastCloudMtimeMs: meta.mtimeMs };
    agg.pulled++;
  };
  const rmLocal = async (): Promise<void> => { await fsp.rm(abs, { force: true }).catch(() => {}); delete prev.files[p]; agg.deleted++; };

  if (!L) {
    // 本地无该文件
    if (hadPrev && C && !C.deleted) {
      // 上次同步过、现已本地删 + 云端仍 live:云端在我上次同步后又更新 → 拉回;否则我的删除是更新事件 → 传播墓碑
      if (C.mtimeMs > (prev.files[p].lastCloudMtimeMs ?? 0)) await pull(C);
      else { await cloud.deleteFile(userId, slug, p, nowMs(), deviceId); delete prev.files[p]; agg.deleted++; }
    } else if (C && !C.deleted) {
      await pull(C); // 别处新增 → 本地拉
    } else {
      delete prev.files[p]; // 都没了
    }
    return;
  }
  // 本地有该文件
  if (C?.deleted) {
    if (L.mtimeMs > C.mtimeMs) await push(L.mtimeMs, L.isBinary); // 本地改动比墓碑新 → 复活
    else await rmLocal();                                          // 墓碑胜 → 删本地
  } else if (!C) {
    await push(L.mtimeMs, L.isBinary); // 新本地 → 推
  } else if (C.mtimeMs > L.mtimeMs) {
    await pull(C);                      // 云端新 → 拉
  } else if (L.mtimeMs > C.mtimeMs) {
    await push(L.mtimeMs, L.isBinary);  // 本地新 → 推
  } else {
    prev.files[p] = { lastCloudMtimeMs: C.mtimeMs }; // 相等 → in-sync,记水位
  }
}

/** LOG 块并集合并(additive,绝不 LWW/墓碑;日志只增不删,跨端各加条目都保留)。 */
async function reconcileLog(
  slug: string, localDir: string, p: string, L: LocalStat | undefined, C: AgentFileMeta | undefined,
  cloud: AgentFilesBrain, userId: string, deviceId: string, prev: PrevState, agg: AgentFileSyncResult,
): Promise<void> {
  const abs = join(localDir, p);
  const liveCloud = C && !C.deleted;
  if (L && liveCloud) {
    const localContent = await fsp.readFile(abs, 'utf8').catch(() => '');
    const cf = await cloud.getFile(userId, slug, p);
    const localBlk = splitLogBlocks(localContent);
    const remoteBlk = splitLogBlocks(cf?.content || '');
    const { merged, onlyInA: localOnly, onlyInB: cloudOnly } = mergeBlocks(localBlk.blocks, remoteBlk.blocks);
    if (cloudOnly.length) {
      await fsp.writeFile(abs, rebuildLog(localBlk.header || remoteBlk.header, merged));
      agg.pulled++;
    }
    if (localOnly.length) {
      const content = cloudOnly.length ? rebuildLog(localBlk.header || remoteBlk.header, merged) : localContent;
      const r = await cloud.putFile(userId, slug, p, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: nowMs(), deviceId });
      prev.files[p] = { lastCloudMtimeMs: r.mtimeMs };
      agg.pushed++;
    }
    if (!cloudOnly.length && !localOnly.length) prev.files[p] = { lastCloudMtimeMs: C!.mtimeMs };
  } else if (L && !liveCloud) {
    const content = await fsp.readFile(abs, 'utf8').catch(() => '');
    const r = await cloud.putFile(userId, slug, p, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: nowMs(), deviceId });
    prev.files[p] = { lastCloudMtimeMs: r.mtimeMs }; agg.pushed++;
  } else if (!L && liveCloud) {
    const cf = await cloud.getFile(userId, slug, p);
    if (cf && !cf.deleted) {
      mkdirSync(dirname(abs), { recursive: true });
      await fsp.writeFile(abs, cf.content || '');
      prev.files[p] = { lastCloudMtimeMs: C!.mtimeMs }; agg.pulled++;
    }
  }
}

/** 全局单文件(USER.md)三方对账镜像(基线存 agents/.cloudsync.json;冲突副本落在同目录)。 */
async function syncGlobalFile(
  slug: string, relPath: string, absPath: string, cloudFiles: AgentFileMeta[],
  cloud: AgentFilesBrain, userId: string, deviceId: string, agg: AgentFileSyncResult,
): Promise<void> {
  const C = cloudFiles.find((f) => f.relPath === relPath);
  const stateDir = agentsDir();
  const prev = readPrev(stateDir);
  const key = `${slug}/${relPath}`;
  const pe = prev.files[key];
  try {
    if (!casReady(C)) {
      // 旧服务端:维持旧 mtime-LWW(无基线可用)。
      await syncGlobalFileLegacy(slug, relPath, absPath, C, cloud, userId, deviceId, agg);
      return;
    }
    let buf: Buffer | null = null;
    let localHash: string | null = null;
    if (existsSync(absPath)) {
      try { buf = await fsp.readFile(absPath); localHash = sha256(buf); } catch { localHash = null; }
    }
    const live = C && !C.deleted ? C : undefined;
    let shadow: ShadowVer | null = pe?.hash != null && pe.seq != null ? { seq: pe.seq, hash: pe.hash } : null;
    if (!shadow && pe?.lastCloudMtimeMs != null && live && live.mtimeMs === pe.lastCloudMtimeMs && live.hash != null) {
      shadow = { seq: live.seq!, hash: live.hash };
    }
    const remote: RemoteVer | null = live ? { seq: live.seq!, hash: live.hash ?? null } : null;

    const pull = async (): Promise<void> => {
      const f = await cloud.getFile(userId, slug, relPath);
      if (!f || f.deleted) return;
      mkdirSync(dirname(absPath), { recursive: true });
      const bytes = Buffer.from(f.content || '', 'utf8');
      await fsp.writeFile(absPath, bytes);
      await fsp.utimes(absPath, new Date(f.mtimeMs), new Date(f.mtimeMs)).catch(() => {});
      prev.files[key] = { seq: f.seq, hash: f.hash ?? sha256(bytes), lastCloudMtimeMs: f.mtimeMs };
      agg.pulled++;
    };
    const conflictCopy = async (): Promise<void> => {
      const copyAbs = join(dirname(absPath), uniqueConflictName(dirname(absPath), relPath));
      try {
        await fsp.rename(absPath, copyAbs);
        agg.conflicts++;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; // 本地已不在
        throw e; // 副本没保住 → 抛错中止,外层 catch 记日志,本轮不 pull
      }
    };
    const push = async (baseSeq: number): Promise<void> => {
      const bytes = buf ?? (await fsp.readFile(absPath));
      const content = bytes.toString('utf8');
      try {
        const r = await cloud.putFile(userId, slug, relPath, {
          content, isBinary: false, size: bytes.length, mtimeMs: Math.floor(statSync(absPath).mtimeMs), deviceId, baseSeq,
        });
        if (typeof r.seq === 'number') prev.files[key] = { seq: r.seq, hash: localHash ?? sha256(bytes), lastCloudMtimeMs: r.mtimeMs };
        else prev.files[key] = { lastCloudMtimeMs: r.mtimeMs };
        agg.pushed++;
      } catch (e) {
        if (e instanceof AgentFileConflictError) {
          if (e.info.hash !== null && e.info.hash === localHash) { prev.files[key] = { seq: e.info.seq, hash: localHash!, lastCloudMtimeMs: e.info.mtimeMs }; return; }
          if (e.info.seq === 0) { if (baseSeq !== 0) { delete prev.files[key]; await push(0); } return; }
          await conflictCopy();
          await pull();
          return;
        }
        throw e;
      }
    };

    const d = decide(localHash, shadow, remote);
    switch (d.kind) {
      case 'adopt': prev.files[key] = { seq: remote!.seq, hash: localHash!, lastCloudMtimeMs: live!.mtimeMs }; break;
      case 'pull': await pull(); break;
      case 'push': await push(d.baseSeq); break;
      case 'pushCreate': await push(0); break;
      case 'pushDelete':
        try { await cloud.deleteFile(userId, slug, relPath, nowMs(), deviceId, shadow!.seq); delete prev.files[key]; agg.deleted++; }
        catch (e) { if (e instanceof AgentFileConflictError) { await pull(); break; } throw e; }
        break;
      case 'deleteLocal': await fsp.rm(absPath, { force: true }).catch(() => {}); delete prev.files[key]; agg.deleted++; break;
      case 'dropShadow': delete prev.files[key]; break;
      case 'conflict': await conflictCopy(); await pull(); break;
      case 'none': break;
    }
  } catch (e: any) {
    console.warn(`[agentFileSync] ${slug}/${relPath} 失败:`, e?.message || e);
  } finally {
    writePrev(stateDir, prev);
  }
}

/** USER.md 旧路径(mtime-LWW,无墓碑)—— 仅对旧服务端保留。 */
async function syncGlobalFileLegacy(
  slug: string, relPath: string, absPath: string, C: AgentFileMeta | undefined,
  cloud: AgentFilesBrain, userId: string, deviceId: string, agg: AgentFileSyncResult,
): Promise<void> {
  const liveC = C && !C.deleted ? C : undefined;
  const localExists = existsSync(absPath);
  const L = localExists ? Math.floor(statSync(absPath).mtimeMs) : 0;
  if (!liveC && localExists) {
    const content = await fsp.readFile(absPath, 'utf8');
    await cloud.putFile(userId, slug, relPath, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: L, deviceId });
    agg.pushed++;
  } else if (liveC && (!localExists || liveC.mtimeMs > L)) {
    const f = await cloud.getFile(userId, slug, relPath);
    if (f && !f.deleted) {
      mkdirSync(dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, f.content || '');
      await fsp.utimes(absPath, new Date(liveC.mtimeMs), new Date(liveC.mtimeMs)).catch(() => {});
      agg.pulled++;
    }
  } else if (liveC && localExists && L > liveC.mtimeMs) {
    const content = await fsp.readFile(absPath, 'utf8');
    await cloud.putFile(userId, slug, relPath, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: L, deviceId });
    agg.pushed++;
  }
}
