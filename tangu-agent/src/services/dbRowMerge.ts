/** Amadeus 数据库文件(DbFile JSON,日历 CALENDAR.db / Calendar.db 就是它)的三方合并:按 id 对齐行(列、视图同理),
 *  两边改了不同的行 = 都留下;同一行两边改得不一样 = 冲突,取 theirs 那份并报 conflict(调用方把 ours 整份另存副本)。
 *  一边改、一边删 = 留改过的(和同步的「编辑胜删除」一个口径);一边删、另一边没动 = 删。
 *  base 为 null(第一次见面,不知道上次一致时是什么样)= 取并集:谁有的都留下,不把「对方没有」当成「对方删了」。
 *  两台设备各自播种的日历列 id 是随机的:第一次见面先把 ours 的列按「同类型同名」(其次「该类型两边各只剩一列」)对到 theirs 的 id 上,
 *  否则并出来是两套列、日历视图只认其中一套日期列,一半日程看不见。
 *  任何一份解析不了、或同一份里 id 重复 → 返回 null,调用方退回整份冲突副本(不冒险合)。 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isIdList = (v: unknown): v is Obj[] => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string');

/** 键序无关的比较:两台设备写出同一份数据、键的先后不同,不算改动。 */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return v === undefined ? 'undefined' : JSON.stringify(v);
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

function parse(text: string | null): Obj | null {
  if (text === null) return null;
  try { const v = JSON.parse(text); return isObj(v) && isIdList(v.rows) ? v : null; } catch { return null; }
}
function byId(list: Obj[]): Map<string, Obj> | null {
  const m = new Map<string, Obj>();
  for (const x of list) { if (m.has(x.id as string)) return null; m.set(x.id as string, x); }
  return m;
}

export interface DbMergeResult { content: string; conflict: boolean }

/** ours 里 theirs 没有的列,能对上就换成 theirs 的 id(cells 的键、视图里的引用一起换)。按「同类型同名」对;
 *  没有基线(第一次见面)时再按「该类型两边各只剩一列」对 —— 有基线时不这么猜:两边各自新加的两列同类型不同名,是两列。
 *  有基线也要对:第一次见面对齐之后,那段时间里用旧列 id 写进来的行(桌面重放挂起的改动)还会带着旧 id 回来。 */
function columnMap(O: Obj, T: Obj, firstContact: boolean): Map<string, string> {
  const oc = Array.isArray(O.columns) ? (O.columns as Obj[]) : [];
  const tc = Array.isArray(T.columns) ? (T.columns as Obj[]) : [];
  const oIds = new Set(oc.map((c) => c.id)), tIds = new Set(tc.map((c) => c.id));
  const freeO = oc.filter((c) => !tIds.has(c.id)), freeT = tc.filter((c) => !oIds.has(c.id));
  const map = new Map<string, string>();
  const take = (match: (o: Obj, t: Obj) => boolean): void => {
    for (const o of freeO) {
      if (map.has(o.id as string)) continue;
      const hits = freeT.filter((t) => ![...map.values()].includes(t.id as string) && match(o, t));
      const rivals = freeO.filter((x) => !map.has(x.id as string) && hits.length === 1 && match(x, hits[0]));
      if (hits.length === 1 && rivals.length === 1) map.set(o.id as string, hits[0].id as string);
    }
  };
  take((o, t) => o.type === t.type && o.name === t.name);
  if (firstContact) take((o, t) => o.type === t.type);
  return map;
}
/** 按文本换 `"id"`:列 id 是 8 位随机串,撞上别的值的概率可以忽略。 */
const remap = (text: string, map: Map<string, string>): string => {
  let out = text;
  for (const [from, to] of map) out = out.split(JSON.stringify(from)).join(JSON.stringify(to));
  return out;
};
const ids = (v: unknown): Set<unknown> => new Set(isIdList(v) ? v.map((x) => x.id) : []);
/** 和基线一个行 id、一个列 id 都对不上 = 整份换掉了(删了又重新播种、换了个库),不是「把原来的都删了」:按第一次见面合。 */
function replaced(X: Obj, B: Obj): boolean {
  const overlap = (a: Set<unknown>, b: Set<unknown>): boolean => [...a].some((x) => b.has(x));
  const br = ids(B.rows), bc = ids(B.columns);
  return (br.size > 0 || bc.size > 0) && !overlap(ids(X.rows), br) && !overlap(ids(X.columns), bc);
}
/** 新装机首启播种、一点没动过的「我的日历」(desktop schema.ts seedCalendarDb):第一次见面时它就是「空的」,用另一边,
 *  不然每多一台设备,三条欢迎日程就在所有人的日历里多一份。日期相对播种当天,不比。 */
const SEED_ROWS = ['欢迎使用 Calendar Space', '整理本周任务', '项目评审'];
function untouchedSeed(X: Obj): boolean {
  const cols = Array.isArray(X.columns) ? (X.columns as Obj[]) : [];
  const rows = X.rows as Obj[];
  if (X.name !== '我的日历' || X.views !== undefined || cols.length !== 3 || rows.length !== SEED_ROWS.length) return false;
  if (cols.map((c) => `${c.type}:${c.name}`).join('|') !== 'text:名称|calendarDate:日期|checkbox:完成') return false;
  const [n] = cols.map((c) => c.id as string);
  const known = new Set(cols.map((c) => c.id));
  return rows.every((r, i) => isObj(r.cells) && r.cells[n] === SEED_ROWS[i] && r.body === undefined && Object.keys(r.cells).every((k) => known.has(k)));
}

export function mergeDbFile(ours: string, base: string | null, theirs: string): DbMergeResult | null {
  const T = parse(theirs), O0 = parse(ours);
  if (!O0 || !T) return null;
  let B = parse(base);
  if (B && (replaced(O0, B) || replaced(T, B))) B = null;
  if (!B && untouchedSeed(O0)) return { content: theirs, conflict: false };
  if (!B && untouchedSeed(T)) return { content: ours, conflict: false };
  const map = columnMap(O0, T, !B);
  const O = parse(remap(ours, map));
  if (B) B = parse(remap(base!, map));
  if (!O) return null;
  let conflict = false;
  const pick = (o: unknown, b: unknown, t: unknown, hasBase: boolean): unknown => {
    if (same(o, t)) return t;
    if (hasBase && same(o, b)) return t;
    if (hasBase && same(t, b)) return o;
    conflict = true;
    return t;
  };
  const mergeList = (o: Obj[], b: Obj[] | null, t: Obj[]): Obj[] | null => {
    const om = byId(o), tm = byId(t), bm = b ? byId(b) : new Map<string, Obj>();
    if (!om || !tm || !bm) return null;
    const one = (id: string): Obj | undefined => {
      const ov = om.get(id), tv = tm.get(id), bv = bm.get(id);
      if (ov && tv) return pick(ov, bv, tv, bv !== undefined) as Obj;
      const only = (ov ?? tv)!;
      return bv !== undefined && same(only, bv) ? undefined : only; // 对面删了、这边没动 → 删;这边改过 / 新加的 → 留
    };
    // ponytail: 顺序 = theirs 的顺序,ours 独有的接在末尾;要保留插入位置再按前驱插
    const order = [...tm.keys(), ...[...om.keys()].filter((id) => !tm.has(id))];
    return order.map(one).filter((x): x is Obj => x !== undefined);
  };
  const out: Obj = {};
  for (const k of [...Object.keys(T), ...Object.keys(O).filter((k) => !(k in T))]) {
    const o = O[k], t = T[k], b = B?.[k];
    if (isIdList(o) && isIdList(t) && (b === undefined || isIdList(b))) {
      const merged = mergeList(o, (b as Obj[] | undefined) ?? null, t);
      if (!merged) return null;
      out[k] = merged;
      continue;
    }
    const v = pick(o, b, t, !!B);
    if (v !== undefined) out[k] = v;
  }
  return { content: `${JSON.stringify(out, null, 2)}\n`, conflict };
}

/** 没有基线的两份文本取并集:theirs 原样,再接上 ours 里 theirs 没有的行(按 ours 的顺序)。一行都不丢;
 *  同一件事两边写法不同会两种都在,留给人收拾 —— 比整份二选一、把另一份藏进本机副本好。 */
export function unionLines(ours: string, theirs: string): string {
  const have = new Set(theirs.split('\n'));
  const extra = ours.split('\n').filter((line) => line.trim() && !have.has(line));
  if (!extra.length) return theirs;
  const head = theirs.replace(/\n+$/, '');
  return `${head}${head ? '\n' : ''}${extra.join('\n')}${theirs.endsWith('\n') || (!theirs && ours.endsWith('\n')) ? '\n' : ''}`;
}
