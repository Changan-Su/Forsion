import { describe, expect, it } from 'vitest';
import { mergeDbFile } from './dbRowMerge.js';

const db = (rows: Array<[string, string]>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ version: 2, name: '我的日历', columns: [{ id: 'n', name: '名称', type: 'text' }], rows: rows.map(([id, name]) => ({ id, cells: { n: name } })), ...extra }, null, 2)}\n`;
const names = (text: string) => JSON.parse(text).rows.map((r: any) => `${r.id}:${r.cells.n}`);

describe('mergeDbFile', () => {
  const base = db([['a', 'A'], ['b', 'B'], ['c', 'C']]);
  it('keeps rows added, edited and deleted on different sides', () => {
    const ours = db([['a', 'A1'], ['b', 'B'], ['c', 'C'], ['x', 'ours new']]); // 改 a、加 x
    const theirs = db([['a', 'A'], ['c', 'C'], ['y', 'theirs new']]); // 删 b、加 y
    const r = mergeDbFile(ours, base, theirs)!;
    expect(r.conflict).toBe(false);
    expect(names(r.content)).toEqual(['a:A1', 'c:C', 'y:theirs new', 'x:ours new']);
  });
  it('an edit beats a delete on the other side', () => {
    const r = mergeDbFile(db([['a', 'A'], ['b', 'B edited'], ['c', 'C']]), base, db([['a', 'A'], ['c', 'C']]))!;
    expect(names(r.content)).toContain('b:B edited');
    expect(r.conflict).toBe(false);
  });
  it('the same row changed differently is a conflict: theirs wins, caller keeps ours as a copy', () => {
    const r = mergeDbFile(db([['a', 'ours'], ['b', 'B'], ['c', 'C']]), base, db([['a', 'theirs'], ['b', 'B'], ['c', 'C']]))!;
    expect(r.conflict).toBe(true);
    expect(names(r.content)).toEqual(['a:theirs', 'b:B', 'c:C']);
  });
  it('without a base takes the union instead of reading "missing" as "deleted"', () => {
    const r = mergeDbFile(db([['a', 'A'], ['p', 'only here']]), null, db([['a', 'A'], ['q', 'only there']]))!;
    expect(r.conflict).toBe(false);
    expect(names(r.content)).toEqual(['a:A', 'q:only there', 'p:only here']);
  });
  it('merges columns and views by id too, and ignores key order', () => {
    const o = JSON.parse(base); o.columns.push({ id: 'd', name: '日期', type: 'calendarDate' });
    const t = { rows: JSON.parse(base).rows, columns: JSON.parse(base).columns, name: '我的日历', version: 2, views: [{ id: 'v1', name: 'Week', type: 'calendar' }] };
    const r = mergeDbFile(JSON.stringify(o), base, JSON.stringify(t))!;
    const out = JSON.parse(r.content);
    expect(r.conflict).toBe(false);
    expect(out.columns.map((c: any) => c.id)).toEqual(['n', 'd']);
    expect(out.views.map((v: any) => v.id)).toEqual(['v1']);
  });
  it('first contact lines up independently seeded columns instead of stacking two calendars side by side', () => {
    const seed = (n: string, d: string, k: string, rows: Array<[string, string]>) => JSON.stringify({
      version: 2, name: '我的日历',
      columns: [{ id: n, name: '名称', type: 'text' }, { id: d, name: '日期', type: 'calendarDate' }, { id: k, name: '完成', type: 'checkbox' }],
      rows: rows.map(([id, name]) => ({ id, cells: { [n]: name, [d]: '2026-10-21' } })),
      views: [{ id: 'v1', name: 'Cal', type: 'calendar', calendar: { dateCol: d } }],
    });
    const r = mergeDbFile(seed('a1', 'a2', 'a3', [['p', 'on A']]), null, seed('b1', 'b2', 'b3', [['q', 'on B']]))!;
    const out = JSON.parse(r.content);
    expect(out.columns.map((c: any) => c.id)).toEqual(['b1', 'b2', 'b3']);
    expect(out.rows.map((row: any) => [row.cells.b1, row.cells.b2])).toEqual([['on B', '2026-10-21'], ['on A', '2026-10-21']]);
    expect(out.views).toEqual([{ id: 'v1', name: 'Cal', type: 'calendar', calendar: { dateCol: 'b2' } }]);
  });
  it('a file replaced wholesale (no row or column id in common with the base) is first contact, not "delete everything"', () => {
    const reseeded = JSON.stringify({ version: 2, name: '我的日历', columns: [{ id: 'z', name: '名称', type: 'text' }], rows: [{ id: 's1', cells: { z: 'Welcome' } }] });
    const r = mergeDbFile(reseeded, base, base)!;
    expect(names(r.content)).toEqual(['a:A', 'b:B', 'c:C', 's1:Welcome']);
  });
  it('keeps lining up columns after first contact, so rows written with the old ids stay visible', () => {
    const old = (rows: Array<[string, string]>) => JSON.stringify({ version: 2, name: 'Cal', columns: [{ id: 'nb', name: '名称', type: 'text' }, { id: 'db', name: '日期', type: 'calendarDate' }], rows: rows.map(([id, n]) => ({ id, cells: { nb: n, db: '2026-10-21' } })) });
    const aligned = JSON.stringify({ version: 2, name: 'Cal', columns: [{ id: 'na', name: '名称', type: 'text' }, { id: 'da', name: '日期', type: 'calendarDate' }], rows: [{ id: 'b1', cells: { na: 'B1', da: '2026-10-21' } }, { id: 'a1', cells: { na: 'A1', da: '2026-10-21' } }] });
    const r = mergeDbFile(old([['b1', 'B1'], ['b2', 'typed meanwhile']]), old([['b1', 'B1']]), aligned)!;
    const out = JSON.parse(r.content);
    expect(r.conflict).toBe(false);
    expect(out.columns.map((c: any) => c.id)).toEqual(['na', 'da']);
    expect(out.rows.map((row: any) => `${row.id}:${row.cells.na}:${row.cells.da}`)).toEqual(['b1:B1:2026-10-21', 'a1:A1:2026-10-21', 'b2:typed meanwhile:2026-10-21']);
  });
  it('an untouched fresh-install seed counts as empty on first contact', () => {
    const seed = JSON.stringify({ version: 2, name: '我的日历', columns: [{ id: 'x', name: '名称', type: 'text' }, { id: 'y', name: '日期', type: 'calendarDate' }, { id: 'z', name: '完成', type: 'checkbox' }],
      rows: [{ id: 'r1', cells: { x: '欢迎使用 Calendar Space', y: '2026-10-20T10:00/2026-10-20T11:00', z: true } }, { id: 'r2', cells: { x: '整理本周任务', y: '2026-10-21' } }, { id: 'r3', cells: { x: '项目评审', y: '2026-10-22T14:00/2026-10-22T15:30' } }] });
    expect(mergeDbFile(seed, null, base)!.content).toBe(base);
    expect(mergeDbFile(base, null, seed)!.content).toBe(base);
    const touched = JSON.parse(seed); touched.rows[1].cells.x = '整理本周任务和周报';
    expect(names(mergeDbFile(JSON.stringify(touched), null, base)!.content)).toHaveLength(6); // 动过就不是种子:照常并
  });
  it('refuses to guess on unparsable files or duplicate ids', () => {
    expect(mergeDbFile('not json', base, base)).toBeNull();
    expect(mergeDbFile(db([['a', 'A'], ['a', 'again']]), base, base)).toBeNull();
  });
});
