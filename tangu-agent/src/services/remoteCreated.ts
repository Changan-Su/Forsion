/**
 * 远端建出的持久条目台账(设备能力 MCP 方案 P1 · K2 §3.6,方案 §6.5「暂停远程条目」)。
 *
 * P0 已经让远程污点 run 建不出任何持久化后续执行(manage_schedule / manage_automation 硬拒、相应 HTTP 路由 deny-remote),
 * **唯一剩下**的一条是远端批准 Muse TODO(POST /agent/special/muse/todos/:id/approve,按 D1/D2 允许远端):它建一条此刻到期、
 * 无污点的 Muse 日程条目。这里记下它,急停时撤回:条目还没跑(lastRun === '')→ 删条目 + TODO 回 pending(CAS 只改 injected);
 * **带着它的 Muse 周期被中止了**(lastRun 在周期起跑时就写了,不代表做完 —— 独立评审 P2)→ 同样撤回;
 * 已经跑完 / 已不在的直接出账(已在跑的 Muse 周期由急停按「无人值守」中止)。
 * 「带着它的周期」= Muse 周期起跑、写 lastRun 之前经 noteRemoteEntriesCarried 记下的 carrier runId;急停把本次中止的 run id 传进来比对,
 * 另外 carrier 行已是 aborted 的(锁定时被 dispatchRun 拒跑 / 之前被停掉)也算没做完。
 * 为什么撤回而不是「暂停」:日程条目没有暂停位(auto 就是执行开关),auto=false 会让 TODO 显示已注入却永不执行。
 *
 * 落盘:<tanguHome>/remote-created.json(引擎私有;在引擎 home 内 → 远程污点 run 写硬拒)。写入剪掉 7 天前的项。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import { query } from '../core/db.js';
import { loadSchedule, entriesOf, removeEntry } from './agentSchedule.js';
import { getRun } from './runStore.js';

export interface RemoteCreatedItem {
  kind: 'muse-todo';
  slug: string;
  entryId: string;
  todoId: string;
  via?: string;
  callerUnit?: string;
  /** epoch ms */
  at: number;
  /** 带着这条条目起跑的 Muse 周期 run(周期起跑、写 lastRun 之前记)。 */
  runId?: string;
}

const KEEP_MS = 7 * 24 * 3600_000;
export const remoteCreatedFile = (): string => join(tanguHome(), 'remote-created.json');

// 串行:读改写不交错(批准路由与急停可能同时到)。
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function readItems(): Promise<RemoteCreatedItem[]> {
  try {
    const o = JSON.parse(await readFile(remoteCreatedFile(), 'utf8'));
    return Array.isArray(o?.items) ? o.items.filter((x: any) => x && x.kind === 'muse-todo' && typeof x.entryId === 'string' && typeof x.todoId === 'string' && typeof x.slug === 'string') : [];
  } catch {
    return [];
  }
}

async function writeItems(items: RemoteCreatedItem[]): Promise<void> {
  const file = remoteCreatedFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ v: 1, items }, null, 1), { mode: 0o600 });
  await rename(tmp, file);
}

export function recordRemoteCreated(item: Omit<RemoteCreatedItem, 'at'> & { at?: number }): Promise<void> {
  return serial(async () => {
    const now = Date.now();
    const items = (await readItems()).filter((x) => now - x.at < KEEP_MS && !(x.slug === item.slug && x.entryId === item.entryId));
    items.push({ ...item, at: item.at ?? now });
    await writeItems(items);
  });
}

export function listRemoteCreated(): Promise<RemoteCreatedItem[]> {
  return serial(readItems);
}

/**
 * Muse 周期起跑、把到期条目交给 runId 之后、写回 lastRun **之前**调:台账里对应的项记下 carrier。
 * 台账里没有这些条目(绝大多数周期)= 不写盘。
 */
export function noteRemoteEntriesCarried(slug: string, entryIds: string[], runId: string): Promise<void> {
  if (!entryIds.length || !runId) return Promise.resolve();
  return serial(async () => {
    const items = await readItems();
    let hit = false;
    for (const it of items) {
      if (it.slug === slug && entryIds.includes(it.entryId)) { it.runId = runId; hit = true; }
    }
    if (hit) await writeItems(items);
  });
}

async function carrierAborted(runId: string): Promise<boolean> {
  try { return (await getRun(runId))?.status === 'aborted'; } catch { return false; }
}

/**
 * 急停:撤回还没做完的远端批准条目(删条目 + TODO 回 pending)。返回撤回数。任何一项失败都留在账上,下次急停再试。
 * abortedRunIds = 本次急停中止的 run:带着条目的周期在里面(或 carrier 行已 aborted)→ 哪怕 lastRun 已写、条目已被 Muse 删掉,也撤回。
 */
export function revertRemoteMuseEntries(abortedRunIds: ReadonlySet<string> = new Set()): Promise<number> {
  return serial(async () => {
    const items = await readItems();
    if (!items.length) return 0;
    const keep: RemoteCreatedItem[] = [];
    let reverted = 0;
    for (const it of items) {
      try {
        const db = await loadSchedule(it.slug);
        const entry = db ? entriesOf(db).find((e) => e.id === it.entryId) : undefined;
        const interrupted = !!it.runId && (abortedRunIds.has(it.runId) || (await carrierAborted(it.runId)));
        if (!interrupted && (!entry || entry.lastRun !== '')) continue; // 已跑完 / 已不在:出账
        if (entry) await removeEntry(it.slug, it.entryId);
        await query(`UPDATE muse_todos SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'injected'`, [it.todoId]).catch(() => {});
        reverted++;
      } catch {
        keep.push(it);
      }
    }
    await writeItems(keep);
    return reverted;
  });
}
