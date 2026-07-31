/**
 * `db_changed` 触发的消费游标 —— `<TANGU_HOME>/agents/muse/db-cursors.json`。
 *
 * 为什么不塞进 triggers.json:游标是**全表规模**的派生数据(row_added 要记住所有行 id,
 * cell_changed 要记住每行那一格的值)。规则文件是人和 agent 都会读会改的小配置,把 50 条规则
 * × 每条一份全表副本压进去,它会从几 KB 涨到接近一兆,还把真正的配置淹了。
 *
 * 落盘纪律与 triggers.json 同款:整文件读-改-写走同一条 promise 链(防并发交错丢更新)、
 * tmp+rename 原子落位、坏文件挪备份后空启(读空即重建,派生数据丢了最多是「重新播种一次」)。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from '../core/tanguHome.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';

/** 一条 db_changed 规则的游标。带 v 是为了将来换形状时能认出旧的直接丢弃重播种。 */
export interface DbCursor {
  v: 1;
  /** row_added:上次见过的全部行 id。 */
  rowIds?: string[];
  /** cell_changed:rowId → 该列值的稳定字符串(cellKey)。 */
  cells?: Record<string, string>;
}

type CursorMap = Record<string, DbCursor>;

const cursorsFile = (): string => join(agentsDir(), MUSE_AGENT_SLUG, 'db-cursors.json');

let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

export async function loadCursors(): Promise<CursorMap> {
  let raw: string;
  try {
    raw = await fs.readFile(cursorsFile(), 'utf8');
  } catch {
    return {};
  }
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as CursorMap) : {};
  } catch {
    await fs.rename(cursorsFile(), `${cursorsFile()}.bad-${Date.now()}`).catch(() => {});
    return {};
  }
}

async function save(map: CursorMap): Promise<void> {
  const dir = join(agentsDir(), MUSE_AGENT_SLUG);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.db-cursors.json.tmp-${process.pid}`);
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await fs.rename(tmp, cursorsFile());
}

/** 批量写回(评估后随 markTriggersFired 一并落)。 */
export async function setCursors(patch: Record<string, DbCursor>): Promise<void> {
  if (!Object.keys(patch).length) return;
  await withLock(async () => {
    const map = await loadCursors();
    Object.assign(map, patch);
    await save(map);
  });
}

/** 规则删除时顺手清理(否则 id 复用会捡到别人的游标)。 */
export async function dropCursors(triggerIds: string[]): Promise<void> {
  if (!triggerIds.length) return;
  await withLock(async () => {
    const map = await loadCursors();
    let hit = false;
    for (const id of triggerIds) if (map[id]) { delete map[id]; hit = true; }
    if (hit) await save(map);
  });
}

/** 只保留仍存在的规则的游标(启动/评估时顺手做,防文件无限长)。 */
export async function pruneCursors(aliveIds: string[]): Promise<void> {
  await withLock(async () => {
    const map = await loadCursors();
    const alive = new Set(aliveIds);
    let hit = false;
    for (const id of Object.keys(map)) if (!alive.has(id)) { delete map[id]; hit = true; }
    if (hit) await save(map);
  });
}
