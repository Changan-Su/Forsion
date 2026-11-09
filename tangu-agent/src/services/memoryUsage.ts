/** 每条记忆用了几次(11-09 记忆分层第二步,R6):召回每轮挑中了哪几条、详情整份被读过,记一笔「最近 30 天几次 + 最近一次哪天」。
 *  整理的模型拿它分「常用的留常驻、没用过的挪进详情」。只在本机、是个提示信号:不拿记忆目录锁(前台 remember 撞锁会直接 409),
 *  进程内按文件排队写,写不上就算了。条目按身份(normalizeMemoryFact)的哈希记,不存原文。 */
import { createHash } from 'node:crypto';
import { atomicWriteMemoryFile, readMemoryFile } from './memoryRepository.js';
import { normalizeMemoryFact } from '../contracts/entryMark.js';

const DAYS = 30;
interface UseItem { d: Record<string, number>; last: string }
interface UseFile { v: 1; items: Record<string, UseItem> }
export interface UseStat { uses30: number; lastUsed: string | null }

const keyOf = (identity: string): string => createHash('sha256').update(identity).digest('hex').slice(0, 16);
const day = (t = Date.now()): string => { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function read(dir: string, file: string): UseFile {
  let raw: string | null = null;
  try { raw = readMemoryFile(dir, file); } catch { return { v: 1, items: {} }; }
  try { const v = raw ? JSON.parse(raw) : null; return v?.v === 1 && v.items && typeof v.items === 'object' ? v : { v: 1, items: {} }; } catch { return { v: 1, items: {} }; }
}
const queues = new Map<string, Promise<void>>();

/** 记一笔:这几条(原文或身份都行)今天用了一次。不等、不抛。 */
export function noteMemoryUse(dir: string, file: string, facts: string[]): void {
  const keys = [...new Set(facts.map((f) => normalizeMemoryFact(f)).filter(Boolean).map(keyOf))];
  if (!keys.length) return;
  const at = `${dir}\n${file}`;
  const run = (queues.get(at) ?? Promise.resolve()).then(() => {
    const s = read(dir, file); const today = day(); const cutoff = day(Date.now() - DAYS * 86_400_000);
    for (const k of keys) { const it = s.items[k] ?? (s.items[k] = { d: {}, last: today }); it.d[today] = (it.d[today] ?? 0) + 1; it.last = today; }
    for (const [k, it] of Object.entries(s.items)) {
      for (const d of Object.keys(it.d)) if (d < cutoff) delete it.d[d];
      if (!Object.keys(it.d).length && it.last < cutoff) delete s.items[k];
    }
    atomicWriteMemoryFile(dir, file, JSON.stringify(s));
  }).catch(() => { /* 提示信号:记不上就算了 */ });
  queues.set(at, run);
  void run.finally(() => { if (queues.get(at) === run) queues.delete(at); });
}
/** 读:身份 → 最近 30 天几次、最近一次哪天。没记过 = 0 / null。 */
export function readMemoryUse(dir: string, file: string): (fact: string) => UseStat {
  const s = read(dir, file); const cutoff = day(Date.now() - DAYS * 86_400_000);
  return (fact) => {
    const it = s.items[keyOf(normalizeMemoryFact(fact))];
    if (!it) return { uses30: 0, lastUsed: null };
    return { uses30: Object.entries(it.d).filter(([d]) => d >= cutoff).reduce((n, [, c]) => n + c, 0), lastUsed: it.last };
  };
}
/** 测试用:等排队的写完。 */
export async function flushMemoryUseForTests(): Promise<void> { await Promise.all([...queues.values()]); }
export const AGENT_USAGE_FILE = '.memory-usage.json';
export const PORTRAIT_USAGE_FILE = 'portrait-usage.json';
