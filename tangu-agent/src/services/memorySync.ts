/**
 * 本地 ↔ Forsion Brain 记忆/日志同步(out-of-band,不在 agent 热路径)。默认手动触发(隐私优先),
 * 设置可开自动。云端是统一 per-user 中心(AI Studio 网页与 Tangu 共享同一份)。
 *
 *   Memory:单 blob,**基线三方**(2026-07 起):本地存上次收敛点快照(.MEMORY.base.md),
 *           单侧变更定向传播(与时钟无关);双侧都变 → diff3 三方合并,干净则推合并结果('merged'),
 *           有冲突块 → 退回 LWW 定胜负,但**输方内容先存档**为 `MEMORY (conflict …).md`,绝不静默丢。
 *           无基线(首次升级)→ 旧 LWW,pull 覆盖前若本地有内容也先存档。
 *   Log:   按日,**带 deviceId 的追加合并**——两边条目块取并集、按块去重,各自补齐缺失的。不丢条目。
 *
 * 未登录 / 离线:云端调用失败 → 整体 no-op(catch),本地记忆照常工作。
 */
import { diff3Merge } from 'node-diff3';
import { validLogDate } from './agentSyncPaths.js';
import { withMemoryDirectoryLock } from './memoryRepository.js';
import type { MemoryBrain } from '../seams/cloudBrain.js';
import type { LocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';

export interface SyncResult {
  ok: boolean;
  memory: 'pushed' | 'pulled' | 'merged' | 'in-sync' | 'skipped';
  logs: Array<{ date: string; pushed: number; pulled: number }>;
  error?: string;
}

/** diff3 行级三方合并;有冲突块 → null(与 desktop reconcile.ts 的 mergeText3 同款)。 */
export function mergeText3(ours: string, base: string, theirs: string): string | null {
  const regions = diff3Merge(ours.split('\n'), base.split('\n'), theirs.split('\n'), { excludeFalseConflicts: true });
  const out: string[] = [];
  for (const r of regions as Array<{ ok?: string[]; conflict?: unknown }>) {
    if (r.conflict) return null;
    if (r.ok) out.push(...r.ok);
  }
  return out.join('\n');
}

/** 任意时间表示 → epoch ms(Date / ISO 串 / null)。无效 → 0。 */
function toEpoch(v: any): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 把一天的日志正文切成 { header, blocks }:header=首个 `### ` 之前(`# date` 头),blocks=各 `### …` 条目块。 */
export function splitLogBlocks(content: string): { header: string; blocks: string[] } {
  if (!content) return { header: '', blocks: [] };
  const idx = content.indexOf('### ');
  if (idx === -1) return { header: content, blocks: [] };
  const header = content.slice(0, idx);
  const rest = content.slice(idx);
  // 按行首的 `### ` 切分(保留分隔标记)
  const blocks = rest.split(/\n(?=### )/).map((b) => b.replace(/\s+$/, '')).filter(Boolean);
  return { header, blocks };
}

/** 从块里取 time + body(heading 之后的全部行,含 `@deviceId` 前缀)。 */
export function parseBlock(block: string): { time: string; body: string } {
  const nl = block.indexOf('\n');
  const heading = nl === -1 ? block : block.slice(0, nl);
  const body = nl === -1 ? '' : block.slice(nl + 1);
  const m = /^###\s+(\d{2}:\d{2})/.exec(heading);
  return { time: m ? m[1] : '00:00', body };
}

/** 合并日志块:union + 按归一化块串去重,按 time 升序。 */
export function mergeBlocks(a: string[], b: string[]): { merged: string[]; onlyInA: string[]; onlyInB: string[] } {
  const norm = (s: string): string => s.replace(/\s+$/, '');
  const setB = new Set(b.map(norm));
  const setA = new Set(a.map(norm));
  const onlyInA = a.filter((x) => !setB.has(norm(x)));
  const onlyInB = b.filter((x) => !setA.has(norm(x)));
  const all = [...a];
  for (const x of onlyInB) all.push(x);
  // 去重 + 按 time 排序(稳定:同 time 保持插入序)
  const seen = new Set<string>();
  const dedup = all.filter((x) => { const k = norm(x); if (seen.has(k)) return false; seen.add(k); return true; });
  dedup.sort((x, y) => parseBlock(x).time.localeCompare(parseBlock(y).time));
  return { merged: dedup, onlyInA, onlyInB };
}

async function syncMemoryBlob(store: LocalMemoryStore, cloud: MemoryBrain, userId: string): Promise<SyncResult['memory']> {
  const cloudMem = await cloud.getMemory(userId);
  const meta = store.readMeta();
  const localSnapshot = store.readMemorySnapshot?.();
  const localContent = localSnapshot?.content ?? store.readMemory();
  const cloudContent = cloudMem.content ?? '';
  const localTs = meta.memory.localUpdatedAt;
  const cloudTs = toEpoch(cloudMem.updatedAt);
  const setBase = store.writeMemoryBase?.bind(store); // 旧 store 实现无此方法时安静降级

  // 两边都空 → 无事
  if (!localContent && !cloudContent) return 'in-sync';

  // 内容相同 → 仅对齐水位 + 落基线
  if (localContent === cloudContent) {
    meta.memory.lastCloudUpdatedAt = cloudTs;
    if (cloudTs) meta.memory.localUpdatedAt = cloudTs;
    store.writeMeta(meta);
    setBase?.(localContent);
    return 'in-sync';
  }

  const alignAfterPush = (updatedAt: any, content: string): void => {
    const newTs = toEpoch(updatedAt) || Date.now();
    const m = store.readMeta();
    if (store.readMemory() === content) m.memory.localUpdatedAt = newTs;
    m.memory.lastCloudUpdatedAt = newTs;
    store.writeMeta(m);
    setBase?.(content);
  };
  const push = async (content: string): Promise<SyncResult['memory']> => {
    if (!cloud.setMemory) return 'skipped'; // 旧云端无整体覆盖能力
    const res = await cloud.setMemory(userId, content);
    alignAfterPush(res.updatedAt, content);
    return content === localContent ? 'pushed' : 'merged';
  };
  const pull = (): SyncResult['memory'] => {
    store.writeMemory(cloudContent, localSnapshot?.version);
    const m = store.readMeta();
    m.memory.localUpdatedAt = cloudTs || m.memory.localUpdatedAt;
    m.memory.lastCloudUpdatedAt = cloudTs;
    store.writeMeta(m);
    setBase?.(cloudContent);
    return 'pulled';
  };

  // 基线三方:单侧变更定向传播(时钟无关);双侧都变 → diff3;脏 → LWW + 输者存档。
  const base = store.readMemoryBase?.() ?? null;
  if (base !== null) {
    const localChanged = localContent !== base;
    const cloudChanged = cloudContent !== base;
    if (localChanged && !cloudChanged) return push(localContent);
    if (!localChanged && cloudChanged) return pull();
    if (localChanged && cloudChanged) {
      if (!cloud.setMemory) return 'skipped'; // 旧云端推不了任何结果:不合并不存档不覆盖,原样等待
      const merged = mergeText3(localContent, base, cloudContent);
      if (merged !== null) {
        store.writeMemory(merged, localSnapshot?.version);
        return push(store.readMemory()); // repository may have filtered forgotten facts
      }
      // 合不干净:LWW 定胜负,输方先存档;**存档失败绝不覆盖**。
      if (localContent && localTs >= cloudTs) {
        if (store.archiveMemoryConflict?.(cloudContent) === false) return 'skipped';
        return push(localContent);
      }
      if (localContent && store.archiveMemoryConflict?.(localContent) === false) return 'skipped';
      return pull();
    }
    // base 相同但内容不同不可能同时 !localChanged && !cloudChanged(上面 equal 已返回);兜底拉。
    return pull();
  }

  // 无基线(首次升级/旧 store):旧 LWW;pull 覆盖前本地有内容先存档(可能是分叉编辑,保守不丢),
  // 存档失败绝不覆盖。
  const localNewer = localContent && localTs >= cloudTs;
  if (localNewer) return push(localContent);
  if (localContent && store.archiveMemoryConflict?.(localContent) === false) return 'skipped';
  return pull();
}

async function syncLogDate(
  store: LocalMemoryStore, cloud: MemoryBrain, userId: string, date: string,
  progress: { date: string; pushed: number; pulled: number },
): Promise<void> {
  if (!validLogDate(date)) throw new Error('invalid log date');
  const cloudLog = await cloud.getLog(userId, date);
  const local = splitLogBlocks(store.readLog(date));
  const remote = splitLogBlocks(cloudLog.content || '');
  const { onlyInA: localOnly } = mergeBlocks(local.blocks, remote.blocks);
  const errors: string[] = [];
  for (const block of localOnly) {
    const { time, body } = parseBlock(block);
    try { await cloud.appendLogEntry(userId, body, { date, time }); progress.pushed++; }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  // Re-read AFTER uploads: remember/log_event may have appended while the request was pending.
  withMemoryDirectoryLock(store.baseDir, () => {
    const snapshot = store.readLogSnapshot?.(date);
    const latest = splitLogBlocks(snapshot?.content ?? store.readLog(date));
    const { merged, onlyInB } = mergeBlocks(latest.blocks, remote.blocks);
    if (onlyInB.length) {
      const header = (latest.header || remote.header || `# ${date}`).trimEnd();
      store.writeLog(date, `${header}\n\n${merged.map((b) => b + '\n').join('\n')}`, snapshot?.version);
      progress.pulled += onlyInB.length;
    }
    if (!errors.length) {
      const m = store.readMeta();
      m.logs[date] = { localUpdatedAt: store.logLocalUpdatedAt(date) || Date.now(), lastCloudUpdatedAt: toEpoch(cloudLog.updatedAt) };
      store.writeMeta(m);
    }
  });
  if (errors.length) throw new Error(`log ${date}: ${errors.join('; ')}`);
}

export interface MemorySyncOptions { userId?: string; dates?: string[]; signal?: AbortSignal; assertActive?: () => void }
/** Failed/cancelled calls retain truthful partial counters. No detached local writes continue after return. */
export async function runMemorySync(store: LocalMemoryStore, cloud: MemoryBrain, opts: MemorySyncOptions = {}): Promise<SyncResult> {
  const result: SyncResult = { ok: true, memory: 'skipped', logs: [] };
  const guard = (): void => { opts.signal?.throwIfAborted(); opts.assertActive?.(); };
  // Every store operation and request checks the captured account/consent, including after await.
  const guardedStore = new Proxy(store, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? (...args: unknown[]) => { guard(); return value.apply(target, args); } : value;
  } });
  const io: MemoryBrain = {
    ...cloud,
    getMemory: async (uid) => { guard(); const r = await cloud.getMemory(uid, { signal: opts.signal }); guard(); return r; },
    setMemory: cloud.setMemory ? async (uid, content) => { guard(); const r = await cloud.setMemory!(uid, content, { signal: opts.signal }); guard(); return r; } : undefined,
    getLog: async (uid, date) => { guard(); const r = await cloud.getLog(uid, date, { signal: opts.signal }); guard(); return r; },
    appendLogEntry: async (uid, text, o) => { guard(); const r = await cloud.appendLogEntry(uid, text, { ...o, signal: opts.signal }); guard(); return r; },
  };
  try {
    guard();
    // Validate dates before the first request, not after other memory has already synced.
    if (opts.dates?.some((date) => !validLogDate(date))) throw new Error('invalid log date');
    result.memory = await syncMemoryBlob(guardedStore, io, opts.userId ?? '');
    const d = new Date(); const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    for (const date of opts.dates ?? [...new Set([...store.listLogDates(), today])]) {
      const progress = { date, pushed: 0, pulled: 0 };
      result.logs.push(progress);
      await syncLogDate(guardedStore, io, opts.userId ?? '', date, progress);
    }
  } catch (e) { result.ok = false; result.error = e instanceof Error ? e.message : String(e); }
  return result;
}
