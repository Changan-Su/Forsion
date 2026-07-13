/**
 * 每-agent 日程:到期判定(锚点算术)纯函数矩阵 + 校验 + 盘面读写(TANGU_HOME 重定向)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dueEntries, upcomingScheduleLines, parseLocalCalStart, validateEntryInput,
  loadSchedule, saveSchedule, ensureScheduleDb, upsertEntry, removeEntry, markEntryFired, entriesOf,
  scheduleFile, MAX_ENTRIES, type ScheduleEntry,
} from './agentSchedule.js';

function entry(over: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    id: 's-test01', name: 'task', date: '2026-07-10T09:00', repeat: '', auto: true,
    prompt: 'do it', description: '', todo: false, lastRun: '',
    ...over,
  };
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi);

describe('parseLocalCalStart', () => {
  it('all-day = 本地 00:00(绝不 UTC 午夜);带时刻按本地;取 start 侧;非法 null', () => {
    expect(parseLocalCalStart('2026-07-10')!.getTime()).toBe(at(2026, 7, 10).getTime());
    expect(parseLocalCalStart('2026-07-10T09:30')!.getTime()).toBe(at(2026, 7, 10, 9, 30).getTime());
    expect(parseLocalCalStart('2026-07-10T09:00/2026-07-10T10:00')!.getTime()).toBe(at(2026, 7, 10, 9).getTime());
    expect(parseLocalCalStart('bogus')).toBeNull();
    expect(parseLocalCalStart('2026-7-1')).toBeNull();
  });
});

describe('dueEntries — once', () => {
  it('未到点不触;过点且无 lastRun 触;auto=false/无日期永不触', () => {
    const e = entry({});
    expect(dueEntries([e], at(2026, 7, 10, 8, 59))).toHaveLength(0);
    expect(dueEntries([e], at(2026, 7, 10, 9, 1))).toHaveLength(1);
    expect(dueEntries([entry({ auto: false })], at(2026, 7, 11))).toHaveLength(0);
    expect(dueEntries([entry({ date: '' })], at(2026, 7, 11))).toHaveLength(0);
  });
  it('触发后不复触;改期到未来自动复活', () => {
    const fired = entry({ lastRun: at(2026, 7, 10, 9, 5).toISOString() });
    expect(dueEntries([fired], at(2026, 7, 12))).toHaveLength(0);
    // 改期到 07-15(lastRun < 新锚点)→ 过点即再触
    const moved = entry({ date: '2026-07-15T09:00', lastRun: at(2026, 7, 10, 9, 5).toISOString() });
    expect(dueEntries([moved], at(2026, 7, 14))).toHaveLength(0);
    expect(dueEntries([moved], at(2026, 7, 15, 9, 30))).toHaveLength(1);
  });
});

describe('dueEntries — repeat 锚点滚动', () => {
  const daily = entry({ date: '2026-07-10T09:00', repeat: '1d' });
  it('锚点在未来:一次都不触;首个过点 tick 补一次', () => {
    expect(dueEntries([daily], at(2026, 7, 9, 12))).toHaveLength(0);
    expect(dueEntries([daily], at(2026, 7, 10, 9, 3))).toHaveLength(1);
  });
  it('停机一周只补最近一次;同日 fired 后不复触,次日再触', () => {
    const e = entry({ ...daily, lastRun: at(2026, 7, 10, 9, 3).toISOString() });
    // 停机到 07-17 15:00:latest=07-17 09:00 > lastRun → 触(且只这一条,不狂补 7 天)
    expect(dueEntries([e], at(2026, 7, 17, 15))).toHaveLength(1);
    const firedToday = entry({ ...daily, lastRun: at(2026, 7, 17, 15).toISOString() });
    expect(dueEntries([firedToday], at(2026, 7, 17, 23, 59))).toHaveLength(0);
    expect(dueEntries([firedToday], at(2026, 7, 18, 9, 1))).toHaveLength(1);
  });
  it('每小时/每3天滚动;repeat 改小后按新节奏;时钟回拨静默', () => {
    const hourly = entry({ date: '2026-07-10T09:00', repeat: '1h', lastRun: at(2026, 7, 10, 12).toISOString() });
    expect(dueEntries([hourly], at(2026, 7, 10, 12, 30))).toHaveLength(0);
    expect(dueEntries([hourly], at(2026, 7, 10, 13, 2))).toHaveLength(1);
    const e3d = entry({ date: '2026-07-01', repeat: '3d', lastRun: at(2026, 7, 10).toISOString() });
    expect(dueEntries([e3d], at(2026, 7, 12, 23))).toHaveLength(0); // 下一格 07-13
    expect(dueEntries([e3d], at(2026, 7, 13, 0, 1))).toHaveLength(1);
    // 3d→1d 改小:latest(07-12 09:00 模型换算)重算,> lastRun 即触
    const shrunk = entry({ date: '2026-07-10T09:00', repeat: '1d', lastRun: at(2026, 7, 10, 9, 1).toISOString() });
    expect(dueEntries([shrunk], at(2026, 7, 11, 10))).toHaveLength(1);
    // 时钟回拨:lastRun(07-12) > latest(07-11 09:00) → 不触
    const rollback = entry({ ...daily, lastRun: at(2026, 7, 12, 9, 1).toISOString() });
    expect(dueEntries([rollback], at(2026, 7, 11, 10))).toHaveLength(0);
  });
  it('非法 repeat/非法 lastRun 容错', () => {
    expect(dueEntries([entry({ repeat: 'weekly' })], at(2026, 7, 12))).toHaveLength(0);
    expect(dueEntries([entry({ lastRun: 'garbage' })], at(2026, 7, 12))).toHaveLength(1); // 解析失败按「无」
  });
});

describe('validateEntryInput', () => {
  it('name 必填+cap;date 格式;repeat 需 date 且 ≥1h ≤365d', () => {
    expect(validateEntryInput({}).ok).toBe(false);
    expect(validateEntryInput({ name: 'x', date: '07-10' }).ok).toBe(false);
    expect(validateEntryInput({ name: 'x', date: '2026-07-10T09:00/2026-07-10T10:00' }).ok).toBe(true);
    expect(validateEntryInput({ name: 'x', repeat: '1d' }).ok).toBe(false); // 无锚点
    expect(validateEntryInput({ name: 'x', date: '2026-07-10', repeat: '30m' as any }).ok).toBe(false);
    expect(validateEntryInput({ name: 'x', date: '2026-07-10', repeat: '400d' }).ok).toBe(false);
    const v = validateEntryInput({ name: ` ${'n'.repeat(200)} `, date: '2026-07-10', repeat: '3d' });
    expect(v.ok && v.value.name.length).toBe(120);
  });
  it('auto 需 date+prompt;muse 拒 auto 但允许纯规划', () => {
    expect(validateEntryInput({ name: 'x', auto: true, prompt: 'p' }).ok).toBe(false);
    expect(validateEntryInput({ name: 'x', auto: true, date: '2026-07-10' }).ok).toBe(false);
    expect(validateEntryInput({ name: 'x', auto: true, date: '2026-07-10', prompt: 'p' }).ok).toBe(true);
    expect(validateEntryInput({ name: 'x', auto: true, date: '2026-07-10', prompt: 'p' }, { slug: 'muse' }).ok).toBe(false);
    expect(validateEntryInput({ name: 'x', date: '2026-07-10' }, { slug: 'muse' }).ok).toBe(true);
  });
});

describe('upcomingScheduleLines', () => {
  const NOW = at(2026, 7, 11, 15, 30);
  it('窗口内排序输出;once 过期不列;repeat 滚到下一次;超窗不列;cap 生效', () => {
    const lines = upcomingScheduleLines([
      entry({ id: 'a', name: 'past once', date: '2026-07-09T10:00' }),
      entry({ id: 'b', name: 'daily standup', date: '2026-07-01T09:00', repeat: '1d', auto: true }),
      entry({ id: 'c', name: 'ship report', date: '2026-07-12', auto: false }),
      entry({ id: 'd', name: 'far away', date: '2026-09-01' }),
    ], NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('07-11 09:00 daily standup'); // 今天的场次(以今天 0 点为锚,文本一天内稳定)
    expect(lines[0]).toContain('every 1d, auto');
    expect(lines[1]).toContain('07-12 ship report');
    expect(lines[1]).not.toContain('auto');
    const many = Array.from({ length: 12 }, (_, i) => entry({ id: `m${i}`, name: `t${i}`, date: '2026-07-12' }));
    expect(upcomingScheduleLines(many, NOW)).toHaveLength(8);
  });
});

describe('盘面读写(TANGU_HOME 重定向)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tangu-home-'));
    process.env.TANGU_HOME = home;
  });
  afterEach(() => {
    delete process.env.TANGU_HOME;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('ensure 建 8 列骨架;upsert 新建/更新保留 lastRun 与未知 cells;remove;markEntryFired 只改一格', async () => {
    const db = await ensureScheduleDb('alpha', 'Alpha');
    expect(db.columns.map((c) => c.id)).toEqual(['name', 'date', 'repeat', 'auto', 'prompt', 'description', 'todo', 'lastRun']);
    expect(db.columns.find((c) => c.id === 'date')!.type).toBe('calendarDate');

    const v = validateEntryInput({ name: 'brief', date: '2026-07-12T09:00', repeat: '1d', auto: true, prompt: 'do' });
    expect(v.ok).toBe(true);
    const r1 = await upsertEntry('alpha', (v as any).value);
    expect(r1.ok && r1.created).toBe(true);
    const id = (r1 as any).entry.id as string;

    // 模拟引擎写回 + 桌面/未来版本写入未知列
    await markEntryFired('alpha', id, at(2026, 7, 12, 9, 1));
    const onDisk = JSON.parse(readFileSync(scheduleFile('alpha'), 'utf8'));
    onDisk.rows[0].cells.customCol = 'keep me';
    writeFileSync(scheduleFile('alpha'), JSON.stringify(onDisk));

    const v2 = validateEntryInput({ name: 'brief v2', date: '2026-07-12T10:00', repeat: '1d', auto: true, prompt: 'do2' });
    const r2 = await upsertEntry('alpha', (v2 as any).value, id);
    expect(r2.ok && !(r2 as any).created).toBe(true);
    const db2 = (await loadSchedule('alpha'))!;
    const row = db2.rows.find((rw) => rw.id === id)!;
    expect(row.cells.name).toBe('brief v2');
    expect(row.cells.customCol).toBe('keep me'); // 未知 cells 保留
    expect(String(row.cells.lastRun)).toBe(at(2026, 7, 12, 9, 1).toISOString()); // lastRun 保留
    expect(entriesOf(db2).find((e) => e.id === id)!.lastRun).not.toBe('');

    expect(await removeEntry('alpha', 'nope')).toBe(false);
    expect(await removeEntry('alpha', id)).toBe(true);
    expect((await loadSchedule('alpha'))!.rows).toHaveLength(0);
  });

  it('损坏文件:load 回 null,ensure 拒绝覆盖(保数据);MAX_ENTRIES 帽', async () => {
    mkdirSync(join(home, 'agents', 'beta'), { recursive: true });
    writeFileSync(scheduleFile('beta'), '{broken');
    expect(await loadSchedule('beta')).toBeNull();
    await expect(ensureScheduleDb('beta')).rejects.toThrow(/not valid JSON/);

    await ensureScheduleDb('gamma');
    const v = validateEntryInput({ name: 'n', date: '2026-07-12' });
    const db = (await loadSchedule('gamma'))!;
    db.rows = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ id: `s-${i}`, cells: { name: `e${i}` } }));
    await saveSchedule('gamma', db);
    const r = await upsertEntry('gamma', (v as any).value);
    expect(r.ok).toBe(false);
  });
});
