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

/** ours 里 theirs 没有的列,能对上就改成 theirs 的 id(cells 的键、视图里的引用一起换)。按文本换 `"id"`:列 id 是 8 位随机串,撞上别的值的概率可以忽略。 */
function alignColumns(ours: string, theirs: Obj): string {
  const O = parse(ours);
  const oc = O && Array.isArray(O.columns) ? (O.columns as Obj[]) : [];
  const tc = Array.isArray(theirs.columns) ? (theirs.columns as Obj[]) : [];
  const oIds = new Set(oc.map((c) => c.id)), tIds = new Set(tc.map((c) => c.id));
  const freeO = oc.filter((c) => !tIds.has(c.id)), freeT = tc.filter((c) => !oIds.has(c.id));
  const map = new Map<string, string>();
  const take = (match: (o: Obj, t: Obj) => boolean): void => {
    for (const o of freeO) {
      if (map.has(o.id as string)) continue;
      const left = freeT.filter((t) => ![...map.values()].includes(t.id as string));
      const hits = left.filter((t) => match(o, t));
      const rivals = freeO.filter((x) => !map.has(x.id as string) && hits.length === 1 && match(x, hits[0]));
      if (hits.length === 1 && rivals.length === 1) map.set(o.id as string, hits[0].id as string);
    }
  };
  take((o, t) => o.type === t.type && o.name === t.name);
  take((o, t) => o.type === t.type);
  let out = ours;
  for (const [from, to] of map) out = out.split(JSON.stringify(from)).join(JSON.stringify(to));
  return out;
}

export function mergeDbFile(ours: string, base: string | null, theirs: string): DbMergeResult | null {
  const T = parse(theirs), B = parse(base);
  const O = parse(B || !T ? ours : alignColumns(ours, T));
  if (!O || !T) return null;
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
    const ids = [...tm.keys(), ...[...om.keys()].filter((id) => !tm.has(id))];
    return ids.map(one).filter((x): x is Obj => x !== undefined);
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
