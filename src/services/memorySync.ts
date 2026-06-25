/**
 * 本地 ↔ Forsion Brain 记忆/日志同步(out-of-band,不在 agent 热路径)。默认手动触发(隐私优先),
 * 设置可开自动。云端是统一 per-user 中心(AI Studio 网页与 Tangu 共享同一份)。
 *
 *   Memory:单 blob,**LWW(更新者覆盖)**——比较本地 localUpdatedAt 与云端 updatedAt(信任大致同步的时钟,
 *           即用户选定的「更新的内容覆盖」)。同步后把两个水位都对齐到云端 ts,避免来回 ping-pong。
 *   Log:   按日,**带 deviceId 的追加合并**——两边条目块取并集、按块去重,各自补齐缺失的。不丢条目。
 *
 * 未登录 / 离线:云端调用失败 → 整体 no-op(catch),本地记忆照常工作。
 */
import type { MemoryBrain } from '../seams/cloudBrain.js';
import type { LocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';

export interface SyncResult {
  ok: boolean;
  memory: 'pushed' | 'pulled' | 'in-sync' | 'skipped';
  logs: Array<{ date: string; pushed: number; pulled: number }>;
  error?: string;
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
function parseBlock(block: string): { time: string; body: string } {
  const nl = block.indexOf('\n');
  const heading = nl === -1 ? block : block.slice(0, nl);
  const body = nl === -1 ? '' : block.slice(nl + 1);
  const m = /^###\s+(\d{2}:\d{2})/.exec(heading);
  return { time: m ? m[1] : '00:00', body };
}

/** 合并日志块:union + 按归一化块串去重,按 time 升序。 */
function mergeBlocks(a: string[], b: string[]): { merged: string[]; onlyInA: string[]; onlyInB: string[] } {
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
  const localContent = store.readMemory();
  const localTs = meta.memory.localUpdatedAt;
  const cloudTs = toEpoch(cloudMem.updatedAt);

  // 两边都空 → 无事
  if (!localContent && !cloudMem.content) return 'in-sync';

  // 内容相同 → 仅对齐水位
  if (localContent === cloudMem.content) {
    meta.memory.lastCloudUpdatedAt = cloudTs;
    if (cloudTs) meta.memory.localUpdatedAt = cloudTs;
    store.writeMeta(meta);
    return 'in-sync';
  }

  // LWW:本地更新 → 推;云端更新(或本地为空)→ 拉。
  const localNewer = localContent && localTs >= cloudTs;
  if (localNewer) {
    if (!cloud.setMemory) return 'skipped'; // 旧云端无整体覆盖能力
    const res = await cloud.setMemory(userId, localContent);
    const newTs = toEpoch(res.updatedAt) || Date.now();
    const m = store.readMeta();
    m.memory.localUpdatedAt = newTs;
    m.memory.lastCloudUpdatedAt = newTs;
    store.writeMeta(m);
    return 'pushed';
  }
  // 拉:云端覆盖本地,水位对齐云端 ts(writeMemory 会把 localUpdatedAt 顶到 now,随后改回)
  store.writeMemory(cloudMem.content);
  const m = store.readMeta();
  m.memory.localUpdatedAt = cloudTs || m.memory.localUpdatedAt;
  m.memory.lastCloudUpdatedAt = cloudTs;
  store.writeMeta(m);
  return 'pulled';
}

async function syncLogDate(
  store: LocalMemoryStore, cloud: MemoryBrain, userId: string, date: string,
): Promise<{ date: string; pushed: number; pulled: number }> {
  const cloudLog = await cloud.getLog(userId, date);
  const local = splitLogBlocks(store.readLog(date));
  const remote = splitLogBlocks(cloudLog.content || '');
  const { merged, onlyInA: localOnly, onlyInB: cloudOnly } = mergeBlocks(local.blocks, remote.blocks);

  // 推:本地独有块 → 经 appendLogEntry(带 date/time)写云端,云端按 `### time\n<body>` 重建,与本地块一致
  for (const block of localOnly) {
    const { time, body } = parseBlock(block);
    try { await cloud.appendLogEntry(userId, body, { date, time }); } catch { /* 单条失败不阻断 */ }
  }

  // 拉/写回本地:若有云端独有块,本地文件改写为合并结果(header 优先用本地,空则用云端)
  if (cloudOnly.length) {
    const header = (local.header || remote.header || `# ${date}\n\n`).replace(/\s+$/, '');
    const content = `${header}\n\n${merged.map((b) => b + '\n').join('\n')}`;
    store.writeLog(date, content);
  }

  const m = store.readMeta();
  m.logs[date] = { localUpdatedAt: store.logLocalUpdatedAt(date) || Date.now(), lastCloudUpdatedAt: toEpoch(cloudLog.updatedAt) };
  store.writeMeta(m);
  return { date, pushed: localOnly.length, pulled: cloudOnly.length };
}

/**
 * 跑一次完整同步:memory(LWW)+ 指定日期(或本地已有日期 + 今天)的日志(追加合并)。
 * 任一云端调用失败 → 返回 { ok:false, error };本地数据不被破坏。
 */
export async function runMemorySync(
  store: LocalMemoryStore,
  cloud: MemoryBrain,
  opts?: { userId?: string; dates?: string[] },
): Promise<SyncResult> {
  const userId = opts?.userId ?? '';
  try {
    const memory = await syncMemoryBlob(store, cloud, userId);
    const today = (() => { const d = new Date(); const p = (n: number): string => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
    const dates = opts?.dates ?? Array.from(new Set([...store.listLogDates(), today]));
    const logs: SyncResult['logs'] = [];
    for (const date of dates) logs.push(await syncLogDate(store, cloud, userId, date));
    return { ok: true, memory, logs };
  } catch (e: any) {
    return { ok: false, memory: 'skipped', logs: [], error: String(e?.message || e) };
  }
}
