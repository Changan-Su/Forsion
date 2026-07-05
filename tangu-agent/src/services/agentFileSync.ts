/**
 * 每-agent 云文件镜像(Phase 2,out-of-band,不在 agent 热路径)。把开了 cloudSync 的 agent 的全部文件
 * (config.toml / SOUL.md / MEMORY.md / LOG/<date>.md / Library/*)与 Forsion 云 `tangu_agent_files`
 * **完全镜像**:per-file LWW(本地 fs mtime 为时钟,新者覆盖,含跨设备删除墓碑),LOG 例外用块并集合并
 * (绝不 LWW —— 两端同日离线各加条目不丢)。二进制(头像/图片)走 base64。
 *
 * 分桶(D6):config/SOUL/Library 落 agent 自己 slug;MEMORY/LOG 落 resolveMemorySlug(def)
 * (共用默认的 agent → 记忆桶是 xyra,多个共用者每趟只同步一次)。
 *
 * 本地同步态 `<agentDir>/.cloudsync.json` = { files:{[relPath]:{lastCloudMtimeMs}}, lastSyncAt } —— prev-state
 * 用来检测「本地删除」(在 prev 里、本地已无 → 传播墓碑)。云端不可达/未登录 → 抛错,调用方 no-op。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { agentsDir, userMdFile } from '../core/tanguHome.js';
import { getDeviceId } from '../core/deviceId.js';
import { listAgents, parseAgentConfig, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';
import { splitLogBlocks, mergeBlocks } from './memorySync.js';
import type { AgentFilesBrain, AgentFileMeta } from '../seams/cloudBrain.js';

const TEXT_EXTS = new Set(['.md', '.toml', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.xml', '.js', '.ts', '.py']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const USER_SENTINEL = '__user__';
const LOG_RE = /^LOG\/\d{4}-\d{2}-\d{2}\.md$/;

type Category = 'DEF' | 'MEM';
function categoryOf(relPath: string): Category {
  return relPath === 'MEMORY.md' || relPath.startsWith('LOG/') ? 'MEM' : 'DEF';
}
function isBinaryPath(relPath: string): boolean {
  return !TEXT_EXTS.has(extname(relPath).toLowerCase());
}
/** 仅同步这些:config.toml / SOUL.md / MEMORY.md / LOG/<date>.md / Library/**(排除点文件/同步元数据)。 */
function isSyncable(relPath: string): boolean {
  if (relPath.split('/').some((seg) => seg.startsWith('.'))) return false;
  return (
    relPath === 'config.toml' || relPath === 'SOUL.md' || relPath === 'MEMORY.md' ||
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

interface PrevState { files: Record<string, { lastCloudMtimeMs: number }>; lastSyncAt?: number }
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

export interface AgentFileSyncResult { ok: boolean; agents: number; pushed: number; pulled: number; deleted: number; skipped: number; error?: string }

/** 跑一次文件镜像。手动同步缺省全量；run 前可用 onlySlug 只同步当前 Agent，避免无关大文件拖慢对话。 */
export async function runAgentFilesSync(
  cloud: AgentFilesBrain,
  userId: string,
  opts?: { onlySlug?: string },
): Promise<AgentFileSyncResult> {
  const deviceId = getDeviceId();
  const agg: AgentFileSyncResult = { ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0 };
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

  // USER.md(全局,所有同步 agent 可见;单文件 LWW)。
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

/** 单文件 LWW + 墓碑。p 非 LOG。 */
async function reconcileFile(
  slug: string, localDir: string, p: string, L: LocalStat | undefined, C: AgentFileMeta | undefined,
  cloud: AgentFilesBrain, userId: string, deviceId: string, prev: PrevState, agg: AgentFileSyncResult,
): Promise<void> {
  const abs = join(localDir, p);
  const hadPrev = !!prev.files[p];
  const push = async (mtimeMs: number, isBinary: boolean): Promise<void> => {
    const buf = await fsp.readFile(abs);
    if (buf.length > MAX_FILE_BYTES) { console.warn(`[agentFileSync] 跳过超限文件 ${slug}/${p} (${buf.length}B)`); agg.skipped++; return; }
    const body = isBinary
      ? { contentBase64: buf.toString('base64'), isBinary: true, size: buf.length, mtimeMs, deviceId }
      : { content: buf.toString('utf8'), isBinary: false, size: buf.length, mtimeMs, deviceId };
    const r = await cloud.putFile(userId, slug, p, body);
    prev.files[p] = { lastCloudMtimeMs: r.mtimeMs };
    agg.pushed++;
  };
  const pull = async (meta: AgentFileMeta): Promise<void> => {
    const f = await cloud.getFile(userId, slug, p);
    if (!f || f.deleted) return;
    mkdirSync(dirname(abs), { recursive: true });
    const buf = f.isBinary ? Buffer.from(f.contentBase64 || '', 'base64') : Buffer.from(f.content || '', 'utf8');
    await fsp.writeFile(abs, buf);
    await fsp.utimes(abs, new Date(meta.mtimeMs), new Date(meta.mtimeMs)).catch(() => {}); // 本地 mtime 对齐云端 → 下次 in-sync
    prev.files[p] = { lastCloudMtimeMs: meta.mtimeMs };
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

/** 全局单文件(USER.md)的 LWW 镜像(无墓碑,内容简单 LWW)。 */
async function syncGlobalFile(
  slug: string, relPath: string, absPath: string, cloudFiles: AgentFileMeta[],
  cloud: AgentFilesBrain, userId: string, deviceId: string, agg: AgentFileSyncResult,
): Promise<void> {
  const C = cloudFiles.find((f) => f.relPath === relPath && !f.deleted);
  const localExists = existsSync(absPath);
  const L = localExists ? Math.floor(statSync(absPath).mtimeMs) : 0;
  try {
    if (!C && localExists) {
      const content = await fsp.readFile(absPath, 'utf8');
      await cloud.putFile(userId, slug, relPath, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: L, deviceId });
      agg.pushed++;
    } else if (C && (!localExists || C.mtimeMs > L)) {
      const f = await cloud.getFile(userId, slug, relPath);
      if (f && !f.deleted) {
        mkdirSync(dirname(absPath), { recursive: true });
        await fsp.writeFile(absPath, f.content || '');
        await fsp.utimes(absPath, new Date(C.mtimeMs), new Date(C.mtimeMs)).catch(() => {});
        agg.pulled++;
      }
    } else if (C && localExists && L > C.mtimeMs) {
      const content = await fsp.readFile(absPath, 'utf8');
      await cloud.putFile(userId, slug, relPath, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: L, deviceId });
      agg.pushed++;
    }
  } catch (e: any) {
    console.warn(`[agentFileSync] ${slug}/${relPath} 失败:`, e?.message || e);
  }
}
