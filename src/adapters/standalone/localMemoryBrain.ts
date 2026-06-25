/**
 * 本地优先的记忆/日志后端(standalone/desktop):运行时 deps().brain.memory 走这里,
 * 全本地文件 IO,网络不在热路径(快、离线可用、不登录 Forsion 也能用)。云端同步是 Part 2 的
 * out-of-band 服务(memorySync.ts),不经过此热路径。
 *
 * 落盘(~/.tangu/memory/,Hermes 风格、可人工查看):
 *   MEMORY.md          单 blob 长期记忆(对齐云端单 blob)
 *   log/<date>.md      按日日志,条目 `### HH:MM\n@<deviceId> <text>\n`(deviceId 进正文首行,
 *                      与服务端 `### time\n<body>` 格式逐字节一致 → 多端合并可按块去重)
 *   .sync.json         同步元数据(memory + 各 date 的 localUpdatedAt / lastCloudUpdatedAt)
 *
 * dedup/cap/日志格式复刻自 server/src/services/userDataService.ts(单一语义,行为对齐)。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDir as defaultMemoryDir } from '../../core/tanguHome.js';
import { getDeviceId } from '../../core/deviceId.js';
import type { MemoryBrain } from '../../seams/cloudBrain.js';

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
function normalizeLine(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
function lineExists(content: string, candidate: string): boolean {
  if (!content) return false;
  const want = normalizeLine(candidate);
  if (!want) return false;
  return content.split('\n').some((l) => normalizeLine(l) === want);
}

interface SyncMeta {
  memory: { localUpdatedAt: number; lastCloudUpdatedAt: number | null };
  logs: Record<string, { localUpdatedAt: number; lastCloudUpdatedAt: number | null }>;
}

/** 低层文件 IO(memorySync 与 brain 共用;绑定一个 baseDir,测试可注入临时目录)。 */
export interface LocalMemoryStore {
  baseDir: string;
  readMemory(): string;
  writeMemory(content: string): void; // 写 + bump memory.localUpdatedAt
  readLog(date: string): string;
  writeLog(date: string, content: string): void; // 写 + bump logs[date].localUpdatedAt
  listLogDates(): string[];
  readMeta(): SyncMeta;
  writeMeta(meta: SyncMeta): void;
  memoryLocalUpdatedAt(): number;
  logLocalUpdatedAt(date: string): number;
}

export function createLocalMemoryStore(baseDir: string = defaultMemoryDir()): LocalMemoryStore {
  const memFile = join(baseDir, 'MEMORY.md');
  const metaFile = join(baseDir, '.sync.json');
  const logDir = join(baseDir, 'log');
  const logFile = (date: string): string => join(logDir, `${date}.md`);

  const ensureDir = (d: string): void => { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } };
  const readText = (f: string): string => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

  function readMeta(): SyncMeta {
    try {
      const m = JSON.parse(readFileSync(metaFile, 'utf8'));
      return { memory: m.memory ?? { localUpdatedAt: 0, lastCloudUpdatedAt: null }, logs: m.logs ?? {} };
    } catch {
      return { memory: { localUpdatedAt: 0, lastCloudUpdatedAt: null }, logs: {} };
    }
  }
  function writeMeta(meta: SyncMeta): void {
    ensureDir(baseDir);
    try { writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8'); } catch { /* best-effort */ }
  }

  return {
    baseDir,
    readMemory: () => readText(memFile),
    writeMemory(content: string) {
      ensureDir(baseDir);
      writeFileSync(memFile, content, 'utf8');
      const meta = readMeta();
      meta.memory.localUpdatedAt = Date.now();
      writeMeta(meta);
    },
    readLog: (date: string) => readText(logFile(date)),
    writeLog(date: string, content: string) {
      ensureDir(logDir);
      writeFileSync(logFile(date), content, 'utf8');
      const meta = readMeta();
      meta.logs[date] = { ...(meta.logs[date] ?? { lastCloudUpdatedAt: null }), localUpdatedAt: Date.now() };
      writeMeta(meta);
    },
    listLogDates() {
      try {
        return readdirSync(logDir)
          .filter((f) => f.endsWith('.md') && DATE_RE.test(f.slice(0, -3)))
          .map((f) => f.slice(0, -3))
          .sort();
      } catch {
        return [];
      }
    },
    readMeta,
    writeMeta,
    memoryLocalUpdatedAt: () => readMeta().memory.localUpdatedAt,
    logLocalUpdatedAt: (date: string) => readMeta().logs[date]?.localUpdatedAt ?? 0,
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
    async getMemory() {
      return { content: store.readMemory(), updatedAt: store.memoryLocalUpdatedAt() || null };
    },
    async setMemory(_userId: string, content: string) {
      store.writeMemory(content);
      return { content, updatedAt: store.memoryLocalUpdatedAt() };
    },
    async appendMemoryEntry(_userId, text, o) {
      const dedup = o?.dedup ?? true;
      const cap = o?.cap ?? MEMORY_SOFT_CAP;
      const trimmed = String(text ?? '').trim();
      const existing = store.readMemory();
      if (!trimmed) return { appended: false, reason: 'empty', length: existing.length };
      if (dedup && lineExists(existing, trimmed)) return { appended: false, reason: 'duplicate', length: existing.length };
      if (cap > 0 && existing.length + trimmed.length + 1 > cap) return { appended: false, reason: 'full', length: existing.length };
      const next = existing ? existing + '\n' + trimmed : trimmed;
      store.writeMemory(next);
      return { appended: true, length: next.length };
    },
    async appendLogEntry(_userId, text, o) {
      const trimmed = String(text ?? '').trim();
      if (!trimmed) throw new Error('text is required');
      const date = o?.date && DATE_RE.test(o.date) ? o.date : todayLocal();
      const time = o?.time && /^\d{2}:\d{2}$/.test(o.time) ? o.time : nowHHMM();
      // 条目格式:heading `### HH:MM`(服务端兼容)+ 正文首行 `@<deviceId> <text>`(打标且可合并去重)。
      const entry = `### ${time}\n@${deviceId} ${trimmed}\n`;
      const existing = store.readLog(date);
      const next = existing
        ? existing + (existing.endsWith('\n') ? '\n' : '\n\n') + entry
        : `# ${date}\n\n${entry}`;
      store.writeLog(date, next);
      return { date, time };
    },
    async getLog(_userId, date) {
      const d = date && DATE_RE.test(date) ? date : todayLocal();
      return { date: d, content: store.readLog(d), updatedAt: store.logLocalUpdatedAt(d) || null };
    },
  };
}
