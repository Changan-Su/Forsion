/** 每条记忆用了几次(11-09 记忆分层第二步,R6):召回每轮挑中了哪几条、详情整份被读过,记一笔「最近 30 天几次 + 最近一次哪天」。
 *  整理的模型拿它分「常用的留常驻、没用过的挪进详情」。只在本机、是个提示信号:不拿记忆目录锁(前台 remember 撞锁会直接 409),
 *  进程内按文件排队写,写不上就算了。条目按身份(normalizeMemoryFact)的哈希记,不存原文。 */
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { atomicWriteMemoryFile, readMemoryFile } from './memoryRepository.js';
import { ARCHIVE_TOPIC, normalizeMemoryFact } from '../contracts/entryMark.js';
import { parseTopicFile } from '../contracts/memoryLayers.js';
import { agentsDir, tanguHome } from '../core/tanguHome.js';

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
/** read_file 整份读了一份记忆详情:里面每条记一次(R6)。认两处 —— Agent 的 agents/<slug>/Library/memory/<主题>.md,
 *  项目记忆的 <TANGU_HOME>/project-memory/<目录>/Library/<主题>.md(11-09 2b)。归档不记;认不出路径就什么都不做,不抛。 */
export function noteDetailFileRead(abs: string, text: string): void {
  try {
    const at = resolve(abs);
    const note = (dir: string, file: string): void => {
      const m = /^([a-z][a-z0-9-]{0,31})\.md$/.exec(file);
      if (!m || m[1] === ARCHIVE_TOPIC) return;
      const facts = parseTopicFile(m[1], text).entries.map((e) => e.raw.split('\n')[0]);
      if (facts.length) noteMemoryUse(dir, AGENT_USAGE_FILE, facts);
    };
    const rel = relative(agentsDir(), at).split(sep);
    if (rel.length === 4 && !rel[0].startsWith('..') && rel[1] === 'Library' && rel[2] === 'memory') return note(join(agentsDir(), rel[0]), rel[3]);
    const projects = join(tanguHome(), 'project-memory');
    const prel = relative(projects, at).split(sep);
    if (prel.length === 3 && !prel[0].startsWith('..') && prel[0] && prel[1] === 'Library') note(join(projects, prel[0]), prel[2]);
  } catch { /* 提示信号:记不上就算了 */ }
}
