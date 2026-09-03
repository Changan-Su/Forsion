/**
 * DB 动作(db_row_add / db_row_edit)的纯执行逻辑 —— 从 automation.ts 抽出来,读写走注入的 io,
 * 单测用内存表就能覆盖 rowFrom/match/skipIfEmpty/盖章,不必起 SQLite 与真 vault。
 *
 * 写入仍走 amadeusDb.mutateDb(io.mutateDb):**每路径串行 + 写前重读 + 原子落位**
 * (渲染端那一半的护栏是 desktop 的 db:write-cas 比对交换 + 冲突重放,两边合起来才闭合)。
 * 列找不到/类型不符/目标行不存在 → 抛错 → 动作链失败即停并进账本。**绝不"报成功但什么都没改"**。
 *
 * 目标行的三档(与 museTriggers.ActionSpec 注释一致,互斥优先级 rowId > rowFrom > match > 触发行):
 *   rowFrom —— 触发行的关联列。**信任边界**:执行时读触发表(ctx.dbPath)schema,rowFrom 必须解析到
 *              type='rowlink' 的列,且其 refDb 归一后 == 动作 path;否则抛。从前任何 string/string[] 值都当行 id,
 *              一个 text 列里的字串就能指挥自动化去改另一张表的任意行。id 去重;cell 空/指向的行不存在 → 抛
 *              (用户让沿一条不存在的关联改表,是数据线索,不吞);
 *   match   —— 目标表里 column == value 的全部行;0 行 → 不落盘、报 "matched 0 rows"(空集是诚实的查询结果);
 *   逐目标行各自物化一次(lookup/formula),`{{target.X}}` / `{{= {target.X} }}` 取的就是它。
 * 模板展开放在 mutate 回调**里面**做:落盘的快照与模板读到的目标行是同一份(先展开再进锁会读到旧值)。
 * 目标表的 lookup 依赖缺/坏 → preloadLookupDbs 抛 → 本步失败即停(与评估侧「失败即关」同口径)。
 *
 * 返回**精确因果**(DbTouch):本步新增的行 id、改过的 (rowId, colId, 写后 cellKey)。调用方(runActions →
 * automation.advanceSelfCursors)据此**合并**推进本规则自己的游标,而不是整表重读 —— 整表重读会把同批别的
 * 规则/用户并发写进的行也吞进本规则游标(对它隐形)。
 *
 * **可编辑投影列**(lookup + lookupKind='links',真双向关联的反向侧;纯逻辑 dbBacklink.ts,vendor 自 desktop):
 * 它的真值只在对侧表(refDb)的 lookupBackCol 那列 rowlink cell 里,本表磁盘永远没有它的 cell。cells 里写到它 =
 * **翻译成对侧表一次 mutateDb**(整格赋值:让指回本行的目标行集合恰好 = 给的 id 列表,逗号分隔;空串 = 全摘)——
 * 先把本表那次 mutate 跑完(锁释放),再按 refDb 分组**顺序**各调一次 mutateDb,绝不在回调里嵌套持锁。
 * 对侧写的因果单独回报(DbActionResult.mirrors,DbTouch 上标 mirror:true),runActions 把它并进 touched[对侧表] ——
 * 自游标合并照常吃掉,否则「规则盯对侧 backCol → 写投影 → 对侧变 → 自己再触发」就是一条回环。
 */
import { resolveColumn, coerceCell, dbRowId, cellKey, type DbFile, type DbRow, type CellValue } from './amadeusDb.js';
import {
  materializeRowSync, preloadLookupDbs, triggerRowOf, resolveLikeColumn, normalizeVaultRel, cellKeyOf,
  type ActionSpec, type TriggerContext, type DbLike,
} from './museTriggers.js';
import { expandCells, expandTemplate } from './automationTemplate.js';
import { backLinkSet, isLinksProjection } from './dbBacklink.js';

export type DbActionSpec = Extract<ActionSpec, { type: 'db_row_add' } | { type: 'db_row_edit' }>;

export interface DbActionIo {
  /** 读一张表(vault 相对路径);不存在/坏了 → null。 */
  readDb: (rel: string) => Promise<DbLike | null>;
  /** 读-改-写;fn 返回 false = 不落盘。 */
  mutateDb: (rel: string, fn: (db: DbFile) => boolean | void) => Promise<void>;
}

/** 一步 DB 动作对一张表的精确因果(自游标合并推进的输入)。 */
export interface DbTouch {
  /** db_row_add 新增的行 id。 */
  addedIds: string[];
  /** db_row_edit 改过的格:写后(coerce 之后)的游标 key —— **必须**用 museTriggers.cellKeyOf(与 cursorFor 同函数);
   *  amadeusDb.cellKey 只用于「有没有真变」的比对,它拼数组的分隔符与游标不同。 */
  edited: Array<{ rowId: string; colId: string; key: string }>;
  /** true = 这份因果**全部**来自投影列翻译(写的是对侧表的 rowlink cell,不是动作 path 指的那张表);
   *  合并进 touched 后自游标照常吃掉,标记只给账本/测试辨认来源。 */
  mirror?: boolean;
}

export function emptyTouch(): DbTouch {
  return { addedIds: [], edited: [] };
}

/** 合并因果(同一规则同一表多步累积;addedIds 去重)。mirror 只在两边都是投影翻译时保留(空 into 视为「还没来源」)。 */
export function mergeTouch(into: DbTouch, from: DbTouch): DbTouch {
  const fresh = !into.addedIds.length && !into.edited.length;
  const mirror = (fresh || !!into.mirror) && !!from.mirror;
  for (const id of from.addedIds) if (!into.addedIds.includes(id)) into.addedIds.push(id);
  into.edited.push(...from.edited);
  if (mirror) into.mirror = true;
  else delete into.mirror;
  return into;
}

export interface DbActionResult {
  summary: string;
  /** skipIfEmpty 命中:本步没写任何东西(账本记 skipped,不算失败,也不算「碰过这张表」)。 */
  skipped?: boolean;
  /** 本步真写了什么(skipped / match 0 行 → 空)。 */
  touch: DbTouch;
  /** 投影列翻译落到**对侧表**的因果(每张对侧表一条,path 已归一;没写到投影列 / 对侧没变 → 缺)。 */
  mirrors?: Array<{ path: string; touch: DbTouch }>;
}

/** 一格投影写(在本表回调里收集,回调结束后才落到对侧):本表行 → 对侧表里应指回它的行 id 集合。 */
interface PendingMirror {
  refDb: string;
  backCol: string;
  rowId: string;
  targetIds: string[];
}

/** 模板展开出的投影值 → 目标行 id 列表(逗号分隔,与多选关联列 coerceCell 同口径;去重;空串 = 空集 = 全摘)。 */
const mirrorIds = (raw: string): string[] => [...new Set(String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean))];

/**
 * 把收集到的投影写按对侧表分组,**顺序**各 mutateDb 一次(本表那次 mutate 已经结束,不嵌套持锁)。
 * 对侧 backCol 必须是 rowlink 列、每个目标行必须存在 —— 否则抛(与本表写的口径一致:绝不报成功但什么都没改)。
 * 变了的行盖 updated 章并进 mirror touch(盯着对侧 updated 列的规则不该把自己的章当成别人的改动)。
 */
async function applyMirrors(pending: PendingMirror[], io: DbActionIo, now: Date): Promise<Array<{ path: string; touch: DbTouch }>> {
  const out: Array<{ path: string; touch: DbTouch }> = [];
  const byPath = new Map<string, PendingMirror[]>();
  for (const p of pending) {
    const key = normalizeVaultRel(p.refDb);
    byPath.set(key, [...(byPath.get(key) ?? []), p]);
  }
  for (const [path, list] of byPath) {
    const touch: DbTouch = { addedIds: [], edited: [], mirror: true };
    await io.mutateDb(path, (db) => {
      let wrote = false;
      for (const p of list) {
        const bc = db.columns.find((c) => c.id === p.backCol);
        if (!bc || bc.type !== 'rowlink') throw new Error(`projection target column "${p.backCol}" in ${path} is not a relation (rowlink) column`);
        for (const id of p.targetIds) if (!db.rows.some((r) => r.id === id)) throw new Error(`row ${id} not found in ${path} (projection target)`);
        const rows = backLinkSet(db, p.backCol, p.rowId, p.targetIds);
        if (!rows) continue; // 幂等:对侧已是目标态
        for (let i = 0; i < rows.length; i++) {
          if (rows[i] === db.rows[i]) continue;
          touch.edited.push({ rowId: rows[i].id, colId: p.backCol, key: cellKeyOf(rows[i].cells[p.backCol]) });
          stampUpdatedRow(db, rows[i], true, now, touch);
        }
        db.rows = rows;
        wrote = true;
      }
      return wrote;
    });
    if (touch.edited.length) out.push({ path, touch });
  }
  return out;
}

/** 本地 'YYYY-MM-DDTHH:mm'(与 calendarDate 的 start 串同款,渲染层 created 列同口径)。 */
function localMinute(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 新行盖章:列 type 为 `autonumber`(现有行该列最大值 + 1,从 1 起)/ `created` / `updated`(本地 'YYYY-MM-DDTHH:mm')。
 * ⚠️ 与渲染层 propertyTypes.builtins 的三个内置类型是**同名契约**(那边 initialValue 同算法;STAMPED_TYPES):
 * 类型名硬编码在这里,那边改名这边必须同改。显式给了 cells 的列以显式为准(与渲染层 `{...newRowCells, ...initial}` 同序)。
 */
export function stampNewRow(db: DbFile, now: Date): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const col of db.columns) {
    if (col.type === 'autonumber') {
      let max = 0;
      for (const r of db.rows) {
        const n = Number(r.cells?.[col.id]);
        if (Number.isFinite(n) && n > max) max = n;
      }
      out[col.id] = max + 1;
    } else if (col.type === 'created' || col.type === 'updated') {
      out[col.id] = localMinute(now);
    }
  }
  return out;
}

/**
 * 改行盖章:`updated` 列 = 本地 'YYYY-MM-DDTHH:mm',**只在这一行有格真变了**(coerce 后 cellKey 不同)时盖 ——
 * 与渲染层 dbStore.mutate 的 stampUpdatedRows 同款;规则把同值写回去不算修改。盖的格也进 touch.edited:
 * 盯着 updated 列的规则不该把自己的章当成别人的改动。
 */
export function stampUpdatedRow(db: DbFile, row: DbRow, changed: boolean, now: Date, touch: DbTouch): void {
  if (!changed) return;
  for (const col of db.columns) {
    if (col.type !== 'updated') continue;
    row.cells[col.id] = localMinute(now);
    touch.edited.push({ rowId: row.id, colId: col.id, key: cellKeyOf(row.cells[col.id]) });
  }
}

/**
 * 触发行的关联列 → 目标行 id 列表(string = 一行;string[] = 逐行;去重;空 → 抛)。
 * 信任边界:先读触发表 schema,`key` 必须解析到 rowlink 列且 refDb 归一后 == 动作 path —— 只有 schema 说
 * 「这列指向那张表」的值才当行 id 用(automationTemplate.ts 头部不变量:目标由列定,数据只决定指向哪行)。
 */
async function idsFromRowFrom(tctx: TriggerContext | undefined, key: string, targetPath: string, io: DbActionIo): Promise<string[]> {
  const row = tctx?.row;
  if (!row) throw new Error(`db_row_edit rowFrom "${key}" needs a trigger row`);
  if (!tctx?.dbPath) throw new Error(`db_row_edit rowFrom "${key}" needs the trigger table (ctx.dbPath)`);
  const src = await io.readDb(tctx.dbPath);
  if (!src) throw new Error(`trigger table ${tctx.dbPath} not found (rowFrom "${key}")`);
  const col = resolveLikeColumn(src, key);
  if (col.type !== 'rowlink') throw new Error(`rowFrom column "${key}" is a ${col.type ?? 'text'} column, not a relation (rowlink)`);
  if (normalizeVaultRel(String(col.refDb ?? '')) !== normalizeVaultRel(targetPath)) {
    throw new Error(`rowFrom column "${key}" links to "${col.refDb ?? ''}", not to the action's table "${targetPath}"`);
  }
  // 按解析出的列 id 取值(不按用户写的键):typed 图优先(string[] 保真),退回字符串图。
  const v = row.typed && Object.hasOwn(row.typed, col.id) ? row.typed[col.id] : Object.hasOwn(row.cells, col.id) ? row.cells[col.id] : undefined;
  if (v === undefined) throw new Error(`rowFrom column "${key}" not found on the trigger row`);
  const raw = typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
  const ids = [...new Set(raw)];
  if (!ids.length) throw new Error(`rowFrom column "${key}" is empty on the trigger row`);
  return ids;
}

/** match 比对:string 逐字等;string[](多选关联)含即中;其余按稳定字符串比。 */
function cellMatches(v: unknown, want: string): boolean {
  if (typeof v === 'string') return v === want;
  if (Array.isArray(v)) return v.includes(want);
  return cellKey(v as CellValue) === want;
}

export async function applyDbAction(
  a: DbActionSpec,
  tctx: TriggerContext | undefined,
  io: DbActionIo,
  now: Date = new Date(),
): Promise<DbActionResult> {
  const touch = emptyTouch();
  const pending: PendingMirror[] = []; // 投影列写:本表回调里只收集,回调结束(锁释放)后才落到对侧
  const mirrorSummary = (m: Array<{ path: string; touch: DbTouch }>): string =>
    m.length ? `; mirrored ${m.reduce((n, x) => n + x.touch.edited.length, 0)} link cell(s) to ${m.map((x) => x.path).join(', ')}` : '';
  if (a.type === 'db_row_add') {
    const cells = expandCells(a.cells, tctx, now); // 模板白名单之二:单元格值(路径/rowId 一律不插值)
    if (a.skipIfEmpty && String(cells[a.skipIfEmpty] ?? '').trim() === '') {
      return { summary: `skipped: "${a.skipIfEmpty}" is empty`, skipped: true, touch };
    }
    let summary = '';
    await io.mutateDb(a.path, (db) => {
      const row: DbRow = { id: dbRowId(), cells: stampNewRow(db, now) };
      for (const [key, raw] of Object.entries(cells)) {
        const col = resolveColumn(db, key); // 找不到即抛
        if (isLinksProjection(col)) { // 投影列:本表不落 cell,翻译成对侧写
          pending.push({ refDb: col.refDb as string, backCol: col.lookupBackCol as string, rowId: row.id, targetIds: mirrorIds(raw) });
          continue;
        }
        row.cells[col.id] = coerceCell(col, raw);
      }
      db.rows.push(row);
      touch.addedIds.push(row.id); // 因果只能在回调里收:id 在这儿才生
      summary = `added row to ${a.path} (${Object.keys(cells).length} field(s))`;
      return true;
    });
    const mirrors = await applyMirrors(pending, io, now);
    return { summary: summary + mirrorSummary(mirrors), touch, ...(mirrors.length ? { mirrors } : {}) };
  }

  // edit:先算出目标行 id(rowId / rowFrom / 触发行),match 要看目标表得进回调里算。
  let ids: string[] | null = null;
  if (a.rowId) ids = [a.rowId];
  else if (a.rowFrom) ids = await idsFromRowFrom(tctx, a.rowFrom, a.path, io);
  else if (!a.match) {
    const rid = tctx?.row?.id;
    if (!rid) throw new Error('db_row_edit needs rowId / rowFrom / match (or a trigger that provides the changed row)');
    ids = [rid];
  }
  const matchValue = a.match ? expandTemplate(a.match.value, tctx, now) : '';
  // 目标表的 lookup 依赖先读进缓存(回调是同步的,不能在里面 await);目标表本身在回调里由 mutateDb 重读。
  const shape = await io.readDb(a.path);
  const cache = shape ? await preloadLookupDbs(shape, io.readDb) : new Map<string, DbLike | null>();
  const getDb = (p: string): DbLike | null => cache.get(p) ?? null;

  let summary = '';
  await io.mutateDb(a.path, (db) => {
    let targets: DbRow[];
    if (ids) {
      targets = ids.map((id) => {
        const row = db.rows.find((r) => r.id === id);
        if (!row) throw new Error(`row ${id} not found in ${a.path}`);
        return row;
      });
    } else {
      const m = a.match as { column: string; value: string };
      const col = resolveColumn(db, m.column); // 找不到即抛
      const computed = col.type === 'formula' || col.type === 'lookup';
      // ponytail: match 逐行物化只在比对列是计算列时才做(O(n·lookup));普通列直接比磁盘 cell
      targets = db.rows.filter((r) =>
        cellMatches(computed ? materializeRowSync(db, r, getDb)[col.id] : r.cells?.[col.id], matchValue),
      );
      if (!targets.length) {
        summary = `matched 0 rows in ${a.path} (${m.column} == "${matchValue}")`;
        return false;
      }
    }
    let wrote = false; // 只写了投影列 → 本表磁盘一格没动,不落盘(投影 cell 永不进本表)
    for (const row of targets) {
      const mat = materializeRowSync(db, row, getDb);
      const ctx: TriggerContext = { ...(tctx ?? {}), target: triggerRowOf(db, row.id, mat) };
      const cells = expandCells(a.cells, ctx, now);
      let changed = false;
      for (const [key, raw] of Object.entries(cells)) {
        const col = resolveColumn(db, key);
        if (isLinksProjection(col)) {
          pending.push({ refDb: col.refDb as string, backCol: col.lookupBackCol as string, rowId: row.id, targetIds: mirrorIds(raw) });
          continue;
        }
        const before = cellKey(row.cells[col.id]);
        row.cells[col.id] = coerceCell(col, raw);
        // 写后 key(coerce 之后)才是游标要比的那个串;变没变用 cellKey 比,进游标的 key 用 cellKeyOf(两函数拼数组的分隔符不同)
        const after = cellKey(row.cells[col.id]);
        if (after !== before) changed = true;
        touch.edited.push({ rowId: row.id, colId: col.id, key: cellKeyOf(row.cells[col.id]) });
        wrote = true;
      }
      stampUpdatedRow(db, row, changed, now, touch);
    }
    summary = targets.length === 1
      ? `edited row ${targets[0].id} in ${a.path} (${Object.keys(a.cells).length} field(s))`
      : `edited ${targets.length} rows in ${a.path} (${Object.keys(a.cells).length} field(s))`;
    return wrote;
  });
  const mirrors = await applyMirrors(pending, io, now);
  return { summary: summary + mirrorSummary(mirrors), touch, ...(mirrors.length ? { mirrors } : {}) };
}
