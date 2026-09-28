/**
 * 远端建出的持久条目台账(设备能力 MCP 方案 P1 · K2 §3.6,方案 §6.5「暂停远程条目」)。
 *
 * P0 已经让远程污点 run 建不出任何持久化后续执行(manage_schedule / manage_automation 硬拒、相应 HTTP 路由 deny-remote),
 * **唯一剩下**的一条是远端批准 Muse TODO(POST /agent/special/muse/todos/:id/approve,按 D1/D2 允许远端):它建一条此刻到期、
 * 无污点的 Muse 日程条目。这里记下它,急停时撤回:条目还没跑(lastRun === '')→ 删条目 + TODO 回 pending(CAS 只改 injected);
 * 已经跑过 / 已不在的直接出账(已在跑的 Muse 周期由急停按「无人值守」中止)。
 * 为什么撤回而不是「暂停」:日程条目没有暂停位(auto 就是执行开关),auto=false 会让 TODO 显示已注入却永不执行。
 *
 * 落盘:<tanguHome>/remote-created.json(引擎私有;在引擎 home 内 → 远程污点 run 写硬拒)。写入剪掉 7 天前的项。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import { query } from '../core/db.js';
import { loadSchedule, entriesOf, removeEntry } from './agentSchedule.js';

export interface RemoteCreatedItem {
  kind: 'muse-todo';
  slug: string;
  entryId: string;
  todoId: string;
  via?: string;
  callerUnit?: string;
  /** epoch ms */
  at: number;
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

/** 急停:撤回还没跑的远端批准条目(删条目 + TODO 回 pending)。返回撤回数。任何一项失败都留在账上,下次急停再试。 */
export function revertRemoteMuseEntries(): Promise<number> {
  return serial(async () => {
    const items = await readItems();
    if (!items.length) return 0;
    const keep: RemoteCreatedItem[] = [];
    let reverted = 0;
    for (const it of items) {
      try {
        const db = await loadSchedule(it.slug);
        const entry = db ? entriesOf(db).find((e) => e.id === it.entryId) : undefined;
        if (!entry || entry.lastRun !== '') continue; // 已跑过 / 已不在:出账
        await removeEntry(it.slug, it.entryId);
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
