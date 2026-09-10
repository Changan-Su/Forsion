/**
 * 本地优先的记忆/日志后端(standalone/desktop):运行时 deps().brain.memory 走这里,
 * 全本地文件 IO,网络不在热路径(快、离线可用、不登录 Forsion 也能用)。云端同步是 Part 2 的
 * out-of-band 服务(memorySync.ts),不经过此热路径。
 *
 * 落盘(~/.tangu/agents/<active-agent>/):
 *   .memory-state.json  版本、条目来源、遗忘事件与修订的权威事务
 *   MEMORY.md          可人工编辑的兼容投影(原子导出/中断恢复)
 *   LOG/<date>.md      按日日志,条目 `### HH:MM\n@<deviceId> <text>\n`(deviceId 进正文首行,
 *                      与服务端 `### time\n<body>` 格式逐字节一致 → 多端合并可按块去重)
 *   .sync.json         同步元数据(memory + 各 date 的 localUpdatedAt / lastCloudUpdatedAt)
 *
 * dedup/cap/日志格式复刻自 server/src/services/userDataService.ts(单一语义,行为对齐)。
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { currentAgentSlug } from '../../seams/runContext.js';
import { getDeviceId } from '../../core/deviceId.js';
import type { MemoryBrain } from '../../seams/cloudBrain.js';
import { createMemoryRepository, withMemoryDirectoryLock, readMemoryFile, atomicWriteMemoryFile, safeMemoryPath, memoryContentVersion, memoryVersionConflict, MemoryRepositoryError, normalizeMemoryFact, type MemorySnapshot } from '../../services/memoryRepository.js';

export const MEMORY_SOFT_CAP = 20_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nowHHMM(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function lineExists(content: string, candidate: string): boolean {
  if (!content) return false;
  const want = normalizeMemoryFact(candidate);
  if (!want) return false;
  return content.split('\n').some((l) => normalizeMemoryFact(l) === want);
}

export interface SyncMeta {
  memory: { localUpdatedAt: number; lastCloudUpdatedAt: number | null };
  logs: Record<string, { localUpdatedAt: number; lastCloudUpdatedAt: number | null }>;
}

/** 低层文件 IO(memorySync 与 brain 共用;绑定一个 baseDir,测试可注入临时目录)。 */
export interface LocalMemoryStore {
  baseDir: string;
  readMemory(): string;
  writeMemory(content: string, expectedVersion?: string): void;
  readMemorySnapshot?(): MemorySnapshot;
  readLog(date: string): string;
  writeLog(date: string, content: string, expectedVersion?: string): void;
  readLogSnapshot?(date: string): { version: string; content: string };
  listLogDates(): string[];
  readMeta(): SyncMeta;
  writeMeta(meta: SyncMeta): void;
  memoryLocalUpdatedAt(): number;
  logLocalUpdatedAt(date: string): number;
  /** 上次同步收敛点的记忆快照(.MEMORY.base.md,三方合并的 base);从未同步 → null。
   *  可选:测试 mock/旧实现缺位时 memorySync 自动降级为无基线 LWW。 */
  readMemoryBase?(): string | null;
  writeMemoryBase?(content: string): void;
  /** 冲突输方内容存档为 `MEMORY (conflict …).md`(不参与同步)。独占创建、同分钟撞名递增;
   *  返回是否保住——false 时调用方**必须放弃覆盖**。可选同上。 */
  archiveMemoryConflict?(content: string): boolean;
}

/** 当前 active agent 的记忆目录 ~/.tangu/agents/<slug>/(无 run 上下文时落默认 agent)。 */
function activeAgentDir(): string {
  const slug = currentAgentSlug() || DEFAULT_AGENT_SLUG;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid active agent slug.');
  return join(agentsDir(), slug);
}

/**
 * fixedBaseDir 显式传入(同步服务/测试/Historian)→ 固定目录;省略 → 每次调用按当前 run 上下文的
 * active agent 解析(MEMORY.md / LOG/<date>.md / .sync.json 落 ~/.tangu/agents/<slug>/)。
 */
export function validateMemoryLogDate(date: string): string {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    throw new MemoryRepositoryError('MEMORY_INVALID', 'Invalid date; use a real calendar date YYYY-MM-DD.');
  }
  return date;
}

export function createLocalMemoryStore(fixedBaseDir?: string, syncScope?: string): LocalMemoryStore {
  if (syncScope && !/^[A-Za-z0-9_-]{1,160}$/.test(syncScope)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid memory sync scope.');
  const base = (): string => fixedBaseDir ?? activeAgentDir();
  const repo = () => createMemoryRepository(base());
  const metaName = syncScope ? `.sync-${syncScope}.json` : '.sync.json';
  const baseName = syncScope ? `.MEMORY-${syncScope}.base.md` : '.MEMORY.base.md';
  const logName = (date: string) => `LOG/${validateMemoryLogDate(date)}.md`;
  const lock = <T>(fn: () => T): T => withMemoryDirectoryLock(base(), fn);
  const emptyMeta = (): SyncMeta => ({ memory: { localUpdatedAt: 0, lastCloudUpdatedAt: null }, logs: {} });
  function readMeta(): SyncMeta {
    const raw = readMemoryFile(base(), metaName);
    if (raw === null) return emptyMeta();
    let m: any;
    try { m = JSON.parse(raw); } catch { throw new MemoryRepositoryError('MEMORY_CORRUPT', 'Invalid memory sync metadata; refusing to reset it.'); }
    const validStamp = (x: any) => x && Number.isFinite(x.localUpdatedAt) && (x.lastCloudUpdatedAt === null || Number.isFinite(x.lastCloudUpdatedAt));
    if (!validStamp(m?.memory) || !m?.logs || Array.isArray(m.logs) || typeof m.logs !== 'object' || Object.entries(m.logs).some(([date, value]) => !DATE_RE.test(date) || !validStamp(value))) {
      throw new MemoryRepositoryError('MEMORY_CORRUPT', 'Invalid memory sync metadata; original file was preserved.');
    }
    return m;
  }
  function writeMeta(meta: SyncMeta): void { lock(() => atomicWriteMemoryFile(base(), metaName, JSON.stringify(meta, null, 2))); }
  return {
    get baseDir() { return base(); },
    readMemory: () => repo().snapshot().content,
    readMemorySnapshot: () => repo().snapshot(),
    writeMemory(content, expectedVersion) {
      lock(() => {
        const meta = readMeta(); // Detect damaged metadata BEFORE changing the document.
        const current = repo().snapshot();
        repo().commit({ expectedVersion: expectedVersion ?? current.version, content, source: { kind: 'sync' } });
        meta.memory.localUpdatedAt = Date.now();
        writeMeta(meta);
      });
    },
    readLog: (date) => readMemoryFile(base(), logName(date)) ?? '',
    readLogSnapshot(date) {
      return lock(() => { const raw = readMemoryFile(base(), logName(date)); return { content: raw ?? '', version: memoryContentVersion(raw) }; });
    },
    writeLog(date, content, expectedVersion) {
      lock(() => {
        const meta = readMeta();
        const name = logName(date);
        const old = readMemoryFile(base(), name);
        if (expectedVersion !== undefined && memoryContentVersion(old) !== expectedVersion) memoryVersionConflict();
        atomicWriteMemoryFile(base(), name, content);
        meta.logs[date] = { ...(meta.logs[date] ?? { lastCloudUpdatedAt: null }), localUpdatedAt: Date.now() };
        writeMeta(meta);
      });
    },
    listLogDates() {
      // Validate LOG as a directory without treating EIO or symlinks as an empty list.
      const probe = safeMemoryPath(base(), 'LOG/.path-probe');
      try {
        return readdirSync(join(probe, '..')).filter(f => f.endsWith('.md') && DATE_RE.test(f.slice(0, -3))).map(f => validateMemoryLogDate(f.slice(0, -3))).sort();
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    },
    readMeta,
    writeMeta,
    memoryLocalUpdatedAt: () => Math.max(readMeta().memory.localUpdatedAt, repo().snapshot().updatedAt),
    logLocalUpdatedAt: (date) => readMeta().logs[validateMemoryLogDate(date)]?.localUpdatedAt ?? 0,
    readMemoryBase: () => readMemoryFile(base(), baseName),
    writeMemoryBase(content) { lock(() => atomicWriteMemoryFile(base(), baseName, content)); },
    archiveMemoryConflict(content) {
      return lock(() => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (let n = 1; n <= 50; n++) {
          const file = safeMemoryPath(base(), `MEMORY (conflict ${stamp}-${n}).md`);
          try { writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return true; }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false; }
        }
        return false;
      });
    },
  };
}

export interface LocalMemoryBrain extends MemoryBrain {
  store: LocalMemoryStore;
  deviceId: string;
}

/** 构造本地 MemoryBrain(userId 忽略——本地库单用户/per-install)。 */
export function createLocalMemoryBrain(opts?: { baseDir?: string; deviceId?: string }): LocalMemoryBrain {
  const store = createLocalMemoryStore(opts?.baseDir);
  const deviceId = opts?.deviceId ?? getDeviceId();

  return {
    store,
    deviceId,
    async getMemorySnapshot() { return createMemoryRepository(store.baseDir).snapshot(); },
    async commitMemory(_userId, proposal) { return createMemoryRepository(store.baseDir).commit(proposal); },
    async mutateMemory(_userId, mutation) { return createMemoryRepository(store.baseDir).mutate(mutation); },
    async listMemoryRevisions() { return createMemoryRepository(store.baseDir).revisions(); },
    async restoreMemoryRevision(_userId, version, expectedVersion, signal) { return createMemoryRepository(store.baseDir).restore(version, expectedVersion, signal); },
    async getMemory(_userId, o) {
      o?.signal?.throwIfAborted();
      const snapshot = createMemoryRepository(store.baseDir).snapshot();
      return { content: snapshot.content, updatedAt: Math.max(snapshot.updatedAt, store.readMeta().memory.localUpdatedAt) || null };
    },
    async setMemory(_userId, content, o) {
      o?.signal?.throwIfAborted();
      store.writeMemory(content);
      return { content, updatedAt: store.memoryLocalUpdatedAt() };
    },
    async appendMemoryEntry(_userId, text, o) {
      o?.signal?.throwIfAborted();
      const dedup = o?.dedup ?? true;
      const cap = o?.cap ?? MEMORY_SOFT_CAP;
      const trimmed = String(text ?? '').trim();
      return withMemoryDirectoryLock(store.baseDir, () => {
      const existing = store.readMemory();
      if (!trimmed) return { appended: false, reason: 'empty', length: existing.length };
      if (dedup && lineExists(existing, trimmed)) return { appended: false, reason: 'duplicate', length: existing.length };
      if (cap > 0 && existing.length + trimmed.length + 1 > cap) return { appended: false, reason: 'full', length: existing.length };
      const next = createMemoryRepository(store.baseDir).add(trimmed, { source: { kind: 'explicit' }, cap, dedup });
      return { appended: true, length: next.content.length };
      });
    },
    async appendLogEntry(_userId, text, o) {
      o?.signal?.throwIfAborted();
      const trimmed = String(text ?? '').trim();
      if (!trimmed) throw new Error('text is required');
      const date = o?.date !== undefined ? validateMemoryLogDate(o.date) : todayLocal();
      const time = o?.time ?? nowHHMM();
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new MemoryRepositoryError('MEMORY_INVALID', 'Invalid time; use HH:MM.');
      // 条目格式:heading `### HH:MM`(服务端兼容)+ 正文首行 `@<deviceId> <text>`(打标且可合并去重)。
      const entry = `### ${time}\n@${deviceId} ${trimmed}\n`;
      return withMemoryDirectoryLock(store.baseDir, () => {
      const existing = store.readLog(date);
      const next = existing
        ? existing + (existing.endsWith('\n') ? '\n' : '\n\n') + entry
        : `# ${date}\n\n${entry}`;
      store.writeLog(date, next);
      return { date, time };
      });
    },
    async getLog(_userId, date, o) {
      o?.signal?.throwIfAborted();
      const d = date !== undefined ? validateMemoryLogDate(date) : todayLocal();
      return { date: d, content: store.readLog(d), updatedAt: store.logLocalUpdatedAt(d) || null };
    },
  };
}
