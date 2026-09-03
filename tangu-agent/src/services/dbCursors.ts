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

/** 落盘游标的形状版本。**读端硬闸**(museTriggers.cursorMismatch):版本不等一律判不符 → 只重播种不触发。
 *  v1 → v2(2026-09-02):新增自证身份三件套 path/event/vault。旧 v1 游标各重播种一次(fail-closed)。 */
export const CURSOR_V = 2;

/**
 * 一条 db_changed 规则的游标。
 *
 * **path / event / vault 是必填的自证身份**,不是装饰:游标文件按 triggerId 索引,而 triggerId 说不出
 * 这份快照是「哪个库的哪张表的哪种事件」的。规则换表(cond.path A.db → B.db)时,写端那道 dropCursors 与
 * drain 的 `loadCursors() → … → setCursors()` 读-改-写窗口是并发的,而 setCursors 是 Object.assign **合并**,
 * 会把刚删掉的键原样写回 —— 于是下一 tick 拿 A 表的 rowIds 基线去比 B 表,B 表满表现有行全被当成「刚加的」,
 * 纯 DB 动作链同 tick 全表执行。读端自证与时序无关:游标自己说得清它是谁的,拿错就是拿错。
 * 必填(而非可选)是为了让 tsc 把每一个写入点都指出来 —— 少写一个字段就是少一份身份,静默退回旧 bug。
 */
export interface DbCursor {
  v: typeof CURSOR_V;
  /** 快照来自哪张表(vault 相对路径,与 cond.path 同经 normalizeVaultRel 归一后逐字比)。 */
  path: string;
  /** 快照记的是哪种事件(row_added 的 rowIds 与 cell_changed 的 cells 语义完全不同,混用=满表误触发)。 */
  event: 'row_added' | 'cell_changed';
  /** 快照来自哪个库(cond.vault 逐字;规则文件是全局的,path 却是库内相对路径)。 */
  vault: string;
  /** row_added:上次见过的全部行 id。 */
  rowIds?: string[];
  /** cell_changed:rowId → 该列值的稳定字符串(cellKey);多列监听时是各列 key 按 cols 顺序用 U+001F 拼的复合串。 */
  cells?: Record<string, string>;
  /** cell_changed 的监听列 id(**一律写,n=1 也写**;多列时同时是复合 key 的列序)。
   *  评估侧(cursorMismatch)拿它与规则当前监听列逐字比对,不符 = 视为未播种重新播种。
   *  n=1 也带的原因:`manage_automation` 改列不清游标,若单列游标不自证是哪一列,把 A 改成 B 之后
   *  B 的当前值 × A 的历史值逐行比 → 满表误触发。 */
  cols?: string[];
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
