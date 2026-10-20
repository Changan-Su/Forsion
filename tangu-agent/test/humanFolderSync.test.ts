/**
 * human/ 整个上云(第 2 步,10-20)的双设备台架:两个 TANGU_HOME 共用一个内存云端(seq / hash / CAS 和服务端一致),
 * 各自「断网」改日历和 MEMORY.md,再轮流同步,看合并后有没有丢行、两边和旧位置(USER.md、笔记库 Calendar.db)是否收敛。
 * 日历照今天的界面走:改的是默认笔记库里的 Calendar.db,由镜像带进 human/CALENDAR.db。
 * 第 3 步(10-20)加:服务端说「没有旧客户端在用 USER.md」时镜像停、旧客户端再出现就恢复;Agent 的日历(原 SCHEDULE.db)跟着 Agent 上云,
 * 两台的行按 id 合并,到点执行只在排它的那台。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runAgentFilesSync } from '../src/services/agentFileSync.js';
import { agentSyncScope, setAgentSyncPermission } from '../src/services/cloudSyncAccount.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { readHuman, writeHuman } from '../src/agents/humanStore.js';
import { mirrorLegacyHuman } from '../src/agents/humanFolder.js';
import { withDbLock } from '../src/services/amadeusDb.js';
import { humanDir, USER_MD_TEMPLATE, userMdFile } from '../src/core/tanguHome.js';
import { AgentFileConflictError, type AgentFilesBrain } from '../src/seams/cloudBrain.js';
import { dueHere, entriesOf, loadSchedule, markEntryFired, removeEntry, saveSchedule, upsertEntry, validateEntryInput } from '../src/services/agentSchedule.js';

// 同一进程里轮流扮演两台:设备号跟着当前扮演的那台走(生产里一个进程只有一个家目录)
vi.mock('../src/core/deviceId.js', () => ({ getDeviceId: () => process.env.TANGU_TEST_DEVICE ?? 'x' }));

function fakeCloud(paths?: string[]) {
  const rows = new Map<string, any>();
  const key = (s: string, p: string) => `${s}\0${p}`;
  const brain: AgentFilesBrain & { _rows: typeof rows; legacy?: string[] } = {
    _rows: rows,
    async getManifest() {
      const bySlug = new Map<string, any[]>();
      for (const [k, r] of rows) {
        const [slug, relPath] = k.split('\0');
        bySlug.set(slug, [...(bySlug.get(slug) ?? []), { relPath, mtimeMs: r.mtimeMs, size: 0, isBinary: !!r.isBinary, deleted: !!r.deleted, seq: r.seq, hash: r.hash }]);
      }
      return Object.assign([...bySlug.entries()].map(([slug, files]) => ({ slug, files })), paths ? { paths } : {},
        brain.legacy ? { legacy: brain.legacy, legacySeenAt: 1 } : {}); // 服务端对「还有没有旧客户端在用 USER.md」的回答
    },
    async getFile(_u, slug, relPath) {
      const r = rows.get(key(slug, relPath));
      if (!r) return null;
      if (r.deleted) return { isBinary: false, mtimeMs: r.mtimeMs, deleted: true, seq: r.seq, hash: null };
      return { content: r.content, isBinary: false, mtimeMs: r.mtimeMs, deleted: false, seq: r.seq, hash: r.hash };
    },
    async putFile(_u, slug, relPath, body) {
      if (body.isBinary) throw new Error(`human files travel as text: ${slug}/${relPath}`);
      const ex = rows.get(key(slug, relPath));
      const seq = ex && !ex.deleted ? ex.seq : 0;
      if (body.baseSeq !== undefined && body.baseSeq !== seq) throw new AgentFileConflictError({ code: body.baseSeq === 0 ? 'EXISTS' : 'CONFLICT', seq, hash: ex?.hash ?? null, mtimeMs: ex?.mtimeMs ?? 0, deleted: !!ex?.deleted });
      const hash = createHash('sha256').update(body.content ?? '').digest('hex');
      const next = { ...body, seq: (ex?.seq ?? 0) + 1, hash, deleted: false };
      rows.set(key(slug, relPath), next);
      return { mtimeMs: next.mtimeMs, seq: next.seq, hash };
    },
    async deleteFile(_u, slug, relPath, mtimeMs, _device, baseSeq) {
      const ex = rows.get(key(slug, relPath));
      if (baseSeq !== undefined && ex && !ex.deleted && baseSeq !== ex.seq) throw new AgentFileConflictError({ code: 'CONFLICT', seq: ex.seq, hash: ex.hash, mtimeMs: ex.mtimeMs, deleted: false });
      rows.set(key(slug, relPath), { mtimeMs, deleted: true, seq: (ex?.seq ?? 0) + 1, hash: null });
    },
  };
  return brain;
}
const cloudText = (cloud: ReturnType<typeof fakeCloud>, slug: string, p: string): string | undefined => cloud._rows.get(`${slug}\0${p}`)?.content;

/** 默认日历;列 id 可以给不同的(两台各自首启播种时列 id 是随机的)。 */
const CAL = (rows: Array<[string, string]>, n = 'n', d = 'd') =>
  `${JSON.stringify({ version: 2, name: '我的日历', columns: [{ id: n, name: '名称', type: 'text' }, { id: d, name: '日期', type: 'calendarDate' }], rows: rows.map(([id, name]) => ({ id, cells: { [n]: name, [d]: '2026-10-21' } })) }, null, 2)}\n`;
/** 行 = id:名称;按第一列(名称列)取,合并后列 id 没对齐的话这里会读出 undefined。 */
const rowNames = (text: string) => { const db = JSON.parse(text); const n = db.columns[0].id; return db.rows.map((r: any) => `${r.id}:${r.cells[n]}`).sort(); };

/** 一台设备 = 一个引擎家目录 + 一个默认笔记库。use() 切到它(同一进程里轮流扮演两台)。 */
function device(name: string) {
  const root = mkdtempSync(join(tmpdir(), `tangu-human-${name}-`));
  const home = join(root, 'tangu'); const vault = join(root, 'Amadeus');
  mkdirSync(home, { recursive: true }); mkdirSync(vault, { recursive: true });
  const d = {
    root, home, vault, calendar: join(vault, 'Calendar.db'),
    use() { process.env.TANGU_HOME = home; process.env.FORSION_DEFAULT_CALENDAR = d.calendar; process.env.TANGU_TEST_DEVICE = name; return d; },
    async enroll(cloud: AgentFilesBrain) {
      d.use();
      await saveAgent({ slug: `agent-${name}`, name, systemPrompt: 'fixture', cloudSync: true });
      setAgentSyncPermission(`agent-${name}`, agentSyncScope(cloud, 'u')!, true, true); // shared:账号级数据(USER.md / human/)跟着同步
    },
    async sync(cloud: AgentFilesBrain) { d.use(); const r = await runAgentFilesSync(cloud, 'u'); expect(r.error ?? '').toBe(''); return r; },
    human: (f: string) => readFileSync(join(home, 'human', f), 'utf8'),
    conflictCopies: () => readdirSync(join(home, 'human')).filter((f) => f.includes('(conflict')),
    async editMemory(next: (s: string) => string) {
      d.use();
      const doc = await readHuman({ kind: 'human', file: 'MEMORY.md' });
      await writeHuman({ kind: 'human', file: 'MEMORY.md' }, { content: next(doc.content), summary: 'Edit', expectedVersion: doc.version }, 'user');
    },
    editCalendar(next: (rows: any[]) => any[]) { const db = JSON.parse(readFileSync(d.calendar, 'utf8')); db.rows = next(db.rows); writeFileSync(d.calendar, `${JSON.stringify(db, null, 2)}\n`); },
  };
  return d;
}
const row = (id: string, name: string) => ({ id, cells: { n: name, d: '2026-10-22' } });
/** 下一次推 __human__/CALENDAR.db 失败一次:landed = 云端已经收下、只是回执丢了;否则请求根本没到服务端。 */
function failNextCalendarPut(cloud: ReturnType<typeof fakeCloud>, landed: boolean) {
  const put = cloud.putFile.bind(cloud);
  cloud.putFile = async (...args: Parameters<typeof put>) => {
    if (args[1] !== '__human__' || args[2] !== 'CALENDAR.db') return put(...args);
    cloud.putFile = put;
    if (landed) await put(...args);
    throw new Error('socket hang up');
  };
}

let made: Array<ReturnType<typeof device>> = [];
const prevHome = process.env.TANGU_HOME;
beforeEach(() => { made = []; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  delete process.env.FORSION_DEFAULT_CALENDAR;
  delete process.env.TANGU_TEST_DEVICE;
  for (const d of made) rmSync(d.root, { recursive: true, force: true });
});
const two = () => { const a = device('a'); const b = device('b'); made.push(a, b); return [a, b] as const; };

describe('human/ in the cloud — two devices', () => {
  it('one edits the calendar, the other MEMORY.md (and both edit both), offline, then merge without losing a line', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a, b] = two();
    writeFileSync(join(a.home, 'USER.md'), 'Name: Lin\nLikes: tea\nGoal: ship');
    writeFileSync(a.calendar, CAL([['r1', 'Dentist'], ['r2', 'Review']]));
    await a.enroll(cloud);
    await a.sync(cloud); // 第一台新版设备搬家:human/ 上云,写搬家标记
    expect(cloudText(cloud, '__human__', '.layout')).toBe('2\n');
    expect(rowNames(cloudText(cloud, '__human__', 'CALENDAR.db')!)).toEqual(['r1:Dentist', 'r2:Review']);

    writeFileSync(b.calendar, readFileSync(a.calendar, 'utf8')); // B 用云端笔记库:默认日历和 A 是同一份
    await b.enroll(cloud);
    await b.sync(cloud);
    expect(b.human('MEMORY.md')).toBe('Name: Lin\nLikes: tea\nGoal: ship');
    expect(b.conflictCopies()).toEqual([]);

    // —— 断网:A 加一条日程、改 MEMORY 第一行;B 删一条、加一条、改 MEMORY 最后一行 ——
    a.use(); a.editCalendar((rows) => [...rows, row('r3', 'Gym')]);
    await a.editMemory((s) => s.replace('Name: Lin', 'Name: Lin Xia'));
    b.use(); b.editCalendar((rows) => [...rows.filter((r) => r.id !== 'r2'), row('r4', 'Flight')]);
    await b.editMemory((s) => s.replace('Goal: ship', 'Goal: ship the phone app'));

    for (const d of [a, b, a, b, a]) await d.sync(cloud);

    const memory = 'Name: Lin Xia\nLikes: tea\nGoal: ship the phone app';
    for (const d of [a, b]) {
      d.use();
      expect(d.human('MEMORY.md')).toBe(memory);
      expect(readFileSync(userMdFile(), 'utf8')).toBe(memory); // 旧版设备读的旧位置也跟上了
      expect(rowNames(d.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r3:Gym', 'r4:Flight']);
      expect(rowNames(readFileSync(d.calendar, 'utf8'))).toEqual(['r1:Dentist', 'r3:Gym', 'r4:Flight']);
      expect(d.conflictCopies()).toEqual([]);
    }
    expect(cloudText(cloud, '__human__', 'MEMORY.md')).toBe(memory);
    expect(cloudText(cloud, '__user__', 'USER.md')).toBe(memory);
    expect(rowNames(cloudText(cloud, '__human__', 'CALENDAR.db')!)).toEqual(['r1:Dentist', 'r3:Gym', 'r4:Flight']);
  });

  it('the same event changed on both devices keeps one version in the calendar and the other in a conflict copy', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a, b] = two();
    writeFileSync(a.calendar, CAL([['r1', 'Dentist']]));
    writeFileSync(b.calendar, CAL([['r1', 'Dentist']]));
    await a.enroll(cloud); await a.sync(cloud);
    await b.enroll(cloud); await b.sync(cloud);
    a.use(); a.editCalendar(() => [row('r1', 'Dentist 9:00')]);
    b.use(); b.editCalendar(() => [row('r1', 'Dentist 10:00')]);
    await a.sync(cloud); await b.sync(cloud);
    b.use();
    const kept = rowNames(b.human('CALENDAR.db'));
    expect(kept).toEqual(['r1:Dentist 9:00']); // 先到云端的那份留在日历里
    const copies = b.conflictCopies();
    expect(copies).toHaveLength(1);
    expect(rowNames(readFileSync(join(humanDir(), copies[0]), 'utf8'))).toEqual(['r1:Dentist 10:00']); // 另一份没丢
  });

  it('calendars that started apart on two devices are joined on first contact, never deleted', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a, b] = two();
    writeFileSync(a.calendar, CAL([['a1', 'Seeded on A'], ['a2', 'Meeting']], 'na', 'da'));
    writeFileSync(b.calendar, CAL([['b1', 'Seeded on B'], ['b2', 'Gym']], 'nb', 'db')); // 两台各用本机笔记库:各自首启播种,列 id 也不同
    await a.enroll(cloud); await a.sync(cloud);
    await b.enroll(cloud); await b.sync(cloud); await a.sync(cloud);
    for (const d of [a, b]) {
      d.use();
      expect(rowNames(d.human('CALENDAR.db'))).toEqual(['a1:Seeded on A', 'a2:Meeting', 'b1:Seeded on B', 'b2:Gym']);
      expect(rowNames(readFileSync(d.calendar, 'utf8'))).toEqual(['a1:Seeded on A', 'a2:Meeting', 'b1:Seeded on B', 'b2:Gym']);
      expect(JSON.parse(d.human('CALENDAR.db')).columns).toHaveLength(2); // 一套列,不是两套叠在一起(日历视图只认一个日期列)
      expect(JSON.parse(d.human('CALENDAR.db')).rows.every((r: any) => r.cells.da === '2026-10-21')).toBe(true);
    }
  });

  it('two profiles that never met are joined line by line, and a fresh device\'s empty template never leaks in', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a, b] = two();
    writeFileSync(join(a.home, 'USER.md'), 'Name: Lin\nLikes: tea');
    writeFileSync(join(b.home, 'USER.md'), 'Name: Lin\nGoal: ship'); // B 之前没开账号同步:两份各写各的
    await a.enroll(cloud); await a.sync(cloud);
    await b.enroll(cloud); await b.sync(cloud); await a.sync(cloud); await b.sync(cloud);
    for (const d of [a, b]) {
      d.use();
      expect(d.human('MEMORY.md')).toBe('Name: Lin\nLikes: tea\nGoal: ship');
      expect(readFileSync(userMdFile(), 'utf8')).toBe('Name: Lin\nLikes: tea\nGoal: ship');
    }
    const c = device('c'); made.push(c);
    writeFileSync(join(c.home, 'USER.md'), USER_MD_TEMPLATE); // 新装机:引擎启动时播了空模板(同一进程里只播一次,这里手动补)
    await c.enroll(cloud);
    await c.sync(cloud);
    expect(c.human('MEMORY.md')).toBe('Name: Lin\nLikes: tea\nGoal: ship');
    expect(c.conflictCopies()).toEqual([]);
  });

  it('a USER.md deleted in the cloud by an old device never empties MEMORY.md; the old location is rebuilt', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a] = two();
    writeFileSync(join(a.home, 'USER.md'), 'Name: Lin');
    await a.enroll(cloud); await a.sync(cloud);
    const seq = cloud._rows.get('__user__\0USER.md').seq;
    await cloud.deleteFile('u', '__user__', 'USER.md', Date.now(), 'old-device', seq);
    await a.sync(cloud); // 同步按「云端删了、本机没动」删掉本机 USER.md,随后镜像从 MEMORY.md 重建
    a.use();
    expect(a.human('MEMORY.md')).toBe('Name: Lin');
    expect(readFileSync(userMdFile(), 'utf8')).toBe('Name: Lin');
    await a.sync(cloud);
    expect(cloudText(cloud, '__user__', 'USER.md')).toBe('Name: Lin');
  });

  it('a vault calendar deleted and re-seeded later never wipes the rows kept in human/', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a] = two();
    writeFileSync(a.calendar, CAL([['r1', 'Dentist'], ['r2', 'Review']]));
    await a.enroll(cloud); await a.sync(cloud);
    rmSync(a.calendar); await a.sync(cloud); // 用户在笔记库里删了 Calendar.db:不传删除
    a.use(); expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r2:Review']);
    writeFileSync(a.calendar, CAL([['s1', 'Welcome']], 'n2', 'd2')); // 桌面重新播种(行 id、列 id 都是新的)
    await a.sync(cloud);
    a.use(); expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r2:Review', 's1:Welcome']);
    rmSync(a.calendar); writeFileSync(a.calendar, CAL([['t1', 'Again']], 'n3', 'd3')); // 这次删了马上重播,中间没跑同步
    await a.sync(cloud);
    a.use(); expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r2:Review', 's1:Welcome', 't1:Again']);
    expect(rowNames(cloudText(cloud, '__human__', 'CALENDAR.db')!)).toEqual(['r1:Dentist', 'r2:Review', 's1:Welcome', 't1:Again']);
  });

  it('an upload the cloud took but never acknowledged does not make the next merge delete what another device restored', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a, b] = two();
    writeFileSync(a.calendar, CAL([['r1', 'Dentist'], ['r2', 'Review']]));
    writeFileSync(b.calendar, readFileSync(a.calendar, 'utf8'));
    await a.enroll(cloud); await a.sync(cloud);
    await b.enroll(cloud); await b.sync(cloud);
    // A 删了 r2;推 CALENDAR.db 时云端收下了,回执在路上丢了(断网 / 进程被杀)
    a.use(); a.editCalendar((rows) => rows.filter((r) => r.id !== 'r2'));
    failNextCalendarPut(cloud, true);
    a.use(); expect((await runAgentFilesSync(cloud, 'u')).error).toMatch(/socket hang up/);
    expect(rowNames(cloudText(cloud, '__human__', 'CALENDAR.db')!)).toEqual(['r1:Dentist']);
    // B 收到删除,又把 r2 原样加回来(撤销删除),另加一条 r3
    const r2 = JSON.parse(readFileSync(b.calendar, 'utf8')).rows.find((r: any) => r.id === 'r2');
    await b.sync(cloud);
    b.use(); b.editCalendar((rows) => [...rows, r2, row('r3', 'Gym')]);
    await b.sync(cloud);
    // A 再同步:旧原文 {r1,r2} 当基线会把 B 加回来的 r2 当成「A 这边删了」再删一次
    await a.sync(cloud);
    for (const d of [a, b]) { await d.sync(cloud); d.use(); expect(rowNames(d.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r2:Review', 'r3:Gym']); }
    expect(rowNames(readFileSync(a.calendar, 'utf8'))).toEqual(['r1:Dentist', 'r2:Review', 'r3:Gym']);
  });

  it('after an unacknowledged upload, undoing the change locally is not mistaken for "untouched" and overwritten by the cloud', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a] = two();
    const original = CAL([['r1', 'Dentist'], ['r2', 'Review']]);
    writeFileSync(a.calendar, original);
    await a.enroll(cloud); await a.sync(cloud);
    a.use(); a.editCalendar((rows) => rows.filter((r) => r.id !== 'r2'));
    failNextCalendarPut(cloud, true); // 删除上了云,回执丢了
    a.use(); expect((await runAgentFilesSync(cloud, 'u')).error).toMatch(/socket hang up/);
    writeFileSync(a.calendar, original); // 撤销删除:本机又回到上次同步一致时的样子(和旧影子哈希一样)
    await a.sync(cloud);
    a.use();
    expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r2:Review']);
    expect(rowNames(readFileSync(a.calendar, 'utf8'))).toEqual(['r1:Dentist', 'r2:Review']);
    expect(rowNames(cloudText(cloud, '__human__', 'CALENDAR.db')!)).toEqual(['r1:Dentist', 'r2:Review']);
  });

  it('an upload that never reached the server keeps the old baseline, so a deleted row does not come back', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a, b] = two();
    writeFileSync(a.calendar, CAL([['r1', 'Dentist'], ['r2', 'Review']]));
    writeFileSync(b.calendar, readFileSync(a.calendar, 'utf8'));
    await a.enroll(cloud); await a.sync(cloud);
    await b.enroll(cloud); await b.sync(cloud);
    a.use(); a.editCalendar((rows) => rows.filter((r) => r.id !== 'r2'));
    failNextCalendarPut(cloud, false); // 网络抖了一下,请求没到服务端
    a.use(); expect((await runAgentFilesSync(cloud, 'u')).error).toMatch(/socket hang up/);
    b.use(); b.editCalendar((rows) => [...rows, row('r3', 'Gym')]); await b.sync(cloud); // 期间 B 加了一条
    for (const d of [a, b, a]) await d.sync(cloud);
    for (const d of [a, b]) { d.use(); expect(rowNames(d.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r3:Gym']); }
  });

  it('waits for the desktop\'s write lock on the vault calendar instead of writing under it', async () => {
    const [a] = two();
    a.use();
    writeFileSync(a.calendar, CAL([['r1', 'Dentist']]));
    await mirrorLegacyHuman(); // 搬家:human/ 里有了一份,基线记下
    writeFileSync(join(humanDir(), 'CALENDAR.db'), CAL([['r1', 'Dentist'], ['r2', 'From the cloud']])); // 同步拉下来一条新的
    let mirrored: Promise<unknown> | undefined;
    await withDbLock(a.calendar, async () => { // 桌面的比对交换写:读 → 比对 → 写,整段拿着这把锁
      mirrored = mirrorLegacyHuman();
      await new Promise((r) => setTimeout(r, 150));
      expect(rowNames(readFileSync(a.calendar, 'utf8'))).toEqual(['r1:Dentist']); // 持锁期间镜像没动库里那份
      a.editCalendar((rows) => [...rows, row('r3', 'Typed in the calendar')]);
    });
    await mirrored;
    expect(rowNames(readFileSync(a.calendar, 'utf8'))).toEqual(['r1:Dentist', 'r2:From the cloud', 'r3:Typed in the calendar']);
    expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist', 'r2:From the cloud', 'r3:Typed in the calendar']);
  });

  it('after upgrading, both devices editing USER.md before their first sync still merge line by line, not as a union', async () => {
    const cloud = fakeCloud(['human']); // 老服务端:只有 USER.md 在同步,和升级前一样
    const [a, b] = two();
    writeFileSync(join(a.home, 'USER.md'), 'Name: Lin\nLikes: tea\nGoal: ship');
    await a.enroll(cloud); await a.sync(cloud);
    await b.enroll(cloud); await b.sync(cloud);
    for (const d of [a, b]) { // 升级前的引擎写的影子只有哈希、没有原文
      const f = readdirSync(d.home).find((n) => n.startsWith('.cloudsync-'))!;
      const state = JSON.parse(readFileSync(join(d.home, f), 'utf8'));
      delete state.files['USER.md'].base;
      writeFileSync(join(d.home, f), JSON.stringify(state));
    }
    for (const d of [a, b]) { d.use(); await mirrorLegacyHuman(); } // 升级后第一次启动
    // 在设置里改画像:保存路由写完 MEMORY.md 当场镜像一遍,第一次同步前 USER.md 就已经变了
    await a.editMemory((s) => s.replace('Name: Lin', 'Name: Lin Xia')); await mirrorLegacyHuman();
    await b.editMemory((s) => s.replace('Goal: ship', 'Goal: ship the app')); await mirrorLegacyHuman();
    for (const d of [a, b, a, b, a]) await d.sync(cloud);
    for (const d of [a, b]) { d.use(); expect(d.human('MEMORY.md')).toBe('Name: Lin Xia\nLikes: tea\nGoal: ship the app'); }
  });

  it('a corrupt human/CALENDAR.db never overwrites the vault calendar', async () => {
    const [a] = two();
    a.use();
    writeFileSync(a.calendar, CAL([['r1', 'Dentist']]));
    await mirrorLegacyHuman();
    writeFileSync(join(humanDir(), 'CALENDAR.db'), '{ half written');
    expect((await mirrorLegacyHuman()).conflicts).toBe(1);
    expect(rowNames(readFileSync(a.calendar, 'utf8'))).toEqual(['r1:Dentist']);
    expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist']);
    expect(a.conflictCopies()).toHaveLength(1); // 坏的那份留着
  });

  it('against a server without the human slot it only mirrors locally and never writes __human__', async () => {
    const cloud = fakeCloud(['human']);
    const [a] = two();
    writeFileSync(join(a.home, 'USER.md'), 'Name: Lin');
    writeFileSync(a.calendar, CAL([['r1', 'Dentist']]));
    await a.enroll(cloud); await a.sync(cloud);
    expect([...cloud._rows.keys()].some((k) => k.startsWith('__human__'))).toBe(false);
    a.use();
    expect(rowNames(a.human('CALENDAR.db'))).toEqual(['r1:Dentist']); // 默认日历照样搬进 human/(只复制,库里那份不动)
    expect(existsSync(a.calendar)).toBe(true);
  });

  it('stops mirroring USER.md only when the server says no old client uses it, and resumes with a three-way merge', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a] = two();
    writeFileSync(join(a.home, 'USER.md'), 'Name: Lin\nLikes: tea\nCity: Hangzhou\n');
    await a.enroll(cloud);
    await a.sync(cloud); // 服务端没回答 = 不知道:照旧镜像
    expect(a.human('MEMORY.md')).toBe('Name: Lin\nLikes: tea\nCity: Hangzhou\n');

    cloud.legacy = []; // 30 天里没见过旧版桌面、账户中心、Echo
    await a.editMemory((s) => `${s}Goal: ship\n`);
    await a.sync(cloud);
    expect(readFileSync(join(a.home, 'USER.md'), 'utf8')).toBe('Name: Lin\nLikes: tea\nCity: Hangzhou\n'); // 停着:旧位置是不再更新的快照
    expect(cloudText(cloud, '__user__', 'USER.md')).toBe('Name: Lin\nLikes: tea\nCity: Hangzhou\n');
    expect(cloudText(cloud, '__human__', 'MEMORY.md')).toBe('Name: Lin\nLikes: tea\nCity: Hangzhou\nGoal: ship\n');
    a.use(); await mirrorLegacyHuman(); // 启动 / 改画像这些不经过同步的镜像也认上次的回答
    expect(readFileSync(join(a.home, 'USER.md'), 'utf8')).toBe('Name: Lin\nLikes: tea\nCity: Hangzhou\n');

    // 一台旧版设备又出现,改了云端 USER.md;服务端看到了它
    const base = cloud._rows.get('__user__\0USER.md');
    await cloud.putFile('u', '__user__', 'USER.md', { content: 'Name: Lin Xia\nLikes: tea\nCity: Hangzhou\n', isBinary: false, size: 0, mtimeMs: Date.now(), baseSeq: base.seq });
    cloud.legacy = ['user-md'];
    await a.sync(cloud); // 拉下旧设备的改动,镜像恢复:拿停之前的基线三方合并,两边的改动都在
    const merged = 'Name: Lin Xia\nLikes: tea\nCity: Hangzhou\nGoal: ship\n';
    expect(a.human('MEMORY.md')).toBe(merged);
    expect(readFileSync(join(a.home, 'USER.md'), 'utf8')).toBe(merged);
    await a.sync(cloud);
    expect(cloudText(cloud, '__user__', 'USER.md')).toBe(merged); // 旧设备下次同步就拿到新的
    expect(a.conflictCopies()).toEqual([]);

    cloud.legacy = undefined; // 服务端不再回答(回滚到老版本 / 查失败):照旧镜像
    await a.editMemory((s) => `${s}Tz: +8\n`);
    await a.sync(cloud);
    expect(readFileSync(join(a.home, 'USER.md'), 'utf8')).toBe(`${merged}Tz: +8\n`);
  });

  it('an agent\'s calendar travels with the agent: SCHEDULE.db is renamed, rows from two devices merge, auto entries run only where scheduled', async () => {
    const cloud = fakeCloud(['human', 'human-folder', 'agent-calendar']);
    const [a, b] = two();
    const sched = (rows: Array<[string, string]>) => `${JSON.stringify({ version: 1, name: 'Shared Schedule', columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }, { id: 'repeat', name: 'Repeat', type: 'text' }, { id: 'auto', name: 'Auto', type: 'checkbox' }, { id: 'prompt', name: 'Prompt', type: 'text' }], rows: rows.map(([id, name]) => ({ id, cells: { name, date: '2026-10-20T09:00', repeat: '1d', auto: true, prompt: name } })) }, null, 2)}\n`;
    // 升级前两台都有这个 Agent,各自一份本机日程(2.13.4 不同步它)
    for (const [d, rows] of [[a, [['s-a1', 'Brief A']]], [b, [['s-b1', 'Brief B']]]] as const) {
      await d.enroll(cloud);
      await saveAgent({ slug: 'shared', name: 'Shared', systemPrompt: 'fixture', cloudSync: true });
      setAgentSyncPermission('shared', agentSyncScope(cloud, 'u')!, true, false);
      writeFileSync(join(d.home, 'agents', 'shared', 'SCHEDULE.db'), sched(rows as any));
    }
    await a.sync(cloud);
    await b.sync(cloud); // B 改名后第一次见到云端那份:按行并集,不整份二选一
    await a.sync(cloud);
    for (const d of [a, b]) {
      d.use();
      expect(existsSync(join(d.home, 'agents', 'shared', 'SCHEDULE.db'))).toBe(false);
      expect(entriesOf((await loadSchedule('shared'))!).map((e) => `${e.id}@${e.device}`).sort()).toEqual(['s-a1@a', 's-b1@b']);
      expect(readdirSync(join(d.home, 'agents', 'shared')).filter((f) => f.startsWith('CALENDAR (conflict'))).toEqual([]); // config 的副本是两台各自建 Agent 的夹具痕迹
    }

    // 断网各加一条,再同步:两条都在,归属各是新建它的那台
    for (const d of [a, b]) {
      d.use();
      const v = validateEntryInput({ name: `Note ${d === a ? 'A' : 'B'}`, date: '2026-10-21' });
      expect((await upsertEntry('shared', (v as any).value)).ok).toBe(true);
    }
    await a.sync(cloud); await b.sync(cloud); await a.sync(cloud);
    a.use(); const onA = entriesOf((await loadSchedule('shared'))!);
    b.use(); const onB = entriesOf((await loadSchedule('shared'))!);
    expect(onA.map((e) => `${e.name}@${e.device}`).sort()).toEqual(['Brief A@a', 'Brief B@b', 'Note A@a', 'Note B@b']);
    expect(onB.map((e) => e.id).sort()).toEqual(onA.map((e) => e.id).sort());
    expect(JSON.parse(cloudText(cloud, 'shared', 'CALENDAR.db')!).rows).toHaveLength(4);

    // 到点:两台都看得见两条自动条目,但各只跑自己排的那条(上云前就是这样)
    const nine = new Date(2026, 9, 22, 9, 30);
    a.use(); expect(dueHere(onA, nine).map((e) => e.name)).toEqual(['Brief A']);
    b.use(); expect(dueHere(onB, nine).map((e) => e.name)).toEqual(['Brief B']);
  });

  it('against a server that does not know agent-calendar it neither pushes nor shadows the agent calendar, then catches up', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    const [a] = two();
    await a.enroll(cloud);
    const v = validateEntryInput({ name: 'Plan', date: '2026-10-21' });
    a.use(); expect((await upsertEntry('agent-a', (v as any).value)).ok).toBe(true);
    await a.sync(cloud);
    expect(cloud._rows.has('agent-a\0CALENDAR.db')).toBe(false);
    const shadow = readdirSync(join(a.home, 'agents', 'agent-a')).find((f) => f.startsWith('.cloudsync-') && f !== '.cloudsync-accounts.json')!;
    expect(Object.keys(JSON.parse(readFileSync(join(a.home, 'agents', 'agent-a', shadow), 'utf8')).files)).not.toContain('CALENDAR.db');
    const upgraded = Object.assign(cloud, { getManifest: async () => Object.assign(await fakeCloud().getManifest.call(cloud), { paths: ['human', 'human-folder', 'agent-calendar'] }) });
    await a.sync(upgraded);
    expect(entriesOf(JSON.parse(cloudText(cloud, 'agent-a', 'CALENDAR.db')!)).map((e) => e.name)).toEqual(['Plan']);
  });

  it('a schedule write waits for the agent folder lock the sync commits under, instead of writing beside it', async () => {
    const cloud = fakeCloud(['human', 'human-folder', 'agent-calendar']);
    const [a] = two();
    await a.enroll(cloud);
    const lock = join(a.home, 'agents', 'agent-a', '.memory.lock');
    writeFileSync(lock, JSON.stringify({ pid: 0, createdAt: Date.now() })); // 别的写入方(同步落盘)正拿着锁
    let done = false;
    const v = validateEntryInput({ name: 'Plan', date: '2026-10-21' });
    a.use(); const pending = upsertEntry('agent-a', (v as any).value).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    expect(existsSync(join(a.home, 'agents', 'agent-a', 'CALENDAR.db'))).toBe(false);
    rmSync(lock);
    expect((await pending).ok).toBe(true);
    expect(entriesOf((await loadSchedule('agent-a'))!).map((e) => e.name)).toEqual(['Plan']);
  });

  it('a first new device on an account last used by an old desktop still imports USER.md before any pause', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    // 旧版桌面 40 天前最后一次同步:云端只有 __user__/USER.md,没有 human/
    await cloud.putFile('u', '__user__', 'USER.md', { content: 'Name: Lin\nLikes: tea\n', isBinary: false, size: 0, mtimeMs: 1, baseSeq: 0 });
    cloud.legacy = []; // 服务端:30 天里没见过旧客户端
    const [a] = two();
    await a.enroll(cloud);
    await a.sync(cloud);
    expect(a.human('MEMORY.md')).toBe('Name: Lin\nLikes: tea\n'); // 云端还没有 human/ 时不停:先搬进来
    expect(cloudText(cloud, '__human__', 'MEMORY.md')).toBe('Name: Lin\nLikes: tea\n');
    expect(cloudText(cloud, '__human__', '.layout')).toBe('2\n');
  });

  it('an auto entry fired on its own device is not run again after another device edited the same row', async () => {
    const cloud = fakeCloud(['human', 'human-folder', 'agent-calendar']);
    const [a, b] = two();
    for (const d of [a, b]) {
      await d.enroll(cloud);
      await saveAgent({ slug: 'shared', name: 'Shared', systemPrompt: 'fixture', cloudSync: true });
      setAgentSyncPermission('shared', agentSyncScope(cloud, 'u')!, true, false);
    }
    a.use();
    const v = validateEntryInput({ name: 'Brief', date: '2026-10-20T09:00', repeat: '1d', auto: true, prompt: 'brief' });
    const created = await upsertEntry('shared', (v as any).value);
    const id = (created as any).entry.id as string;
    await a.sync(cloud); await b.sync(cloud);
    const nine = new Date(2026, 9, 22, 9, 30);
    a.use(); await markEntryFired('shared', id, nine); // A 到点跑了这一次
    b.use(); // B 断网时拿旧的那份改了描述,先推上去
    const edit = validateEntryInput({ name: 'Brief', date: '2026-10-20T09:00', repeat: '1d', auto: true, prompt: 'brief', description: 'from B' });
    expect((await upsertEntry('shared', (edit as any).value, id)).ok).toBe(true);
    await b.sync(cloud);
    await a.sync(cloud); // 同一行两边都改了:整行取 B 的,lastRun 不能跟着回到空
    a.use(); const onA = entriesOf((await loadSchedule('shared'))!);
    expect(onA.find((e) => e.id === id)!.lastRun).toBe(nine.toISOString());
    expect(dueHere(onA, new Date(2026, 9, 22, 9, 35))).toEqual([]);
  });

  it('a USER.md download that failed on the first sync is still imported later, even with the mirror paused', async () => {
    const cloud = fakeCloud(['human', 'human-folder']);
    await cloud.putFile('u', '__user__', 'USER.md', { content: 'Name: Lin\nLikes: tea\n', isBinary: false, size: 0, mtimeMs: 1, baseSeq: 0 });
    cloud.legacy = [];
    const [a] = two();
    await a.enroll(cloud);
    const get = cloud.getFile.bind(cloud);
    cloud.getFile = async (...args: Parameters<typeof get>) => { if (args[1] === '__user__') { cloud.getFile = get; throw new Error('socket hang up'); } return get(...args); };
    a.use(); expect((await runAgentFilesSync(cloud, 'u')).error).toMatch(/socket hang up/); // 第一次没拉成:human/ 先带着空模板上云、写了搬家标记
    expect(cloudText(cloud, '__human__', '.layout')).toBe('2\n');
    await a.sync(cloud); // 这次拉到了:旧位置变了,停着也并进 human/
    expect(a.human('MEMORY.md')).toBe('Name: Lin\nLikes: tea\n');
    expect(cloudText(cloud, '__human__', 'MEMORY.md')).toBe('Name: Lin\nLikes: tea\n');
  });

  it('an agent calendar upload the cloud took but never acknowledged does not make the next merge delete a row another device restored', async () => {
    const cloud = fakeCloud(['human', 'human-folder', 'agent-calendar']);
    const [a, b] = two();
    for (const d of [a, b]) {
      await d.enroll(cloud);
      await saveAgent({ slug: 'shared', name: 'Shared', systemPrompt: 'fixture', cloudSync: true });
      setAgentSyncPermission('shared', agentSyncScope(cloud, 'u')!, true, false);
    }
    a.use();
    for (const name of ['One', 'Two']) await upsertEntry('shared', (validateEntryInput({ name, date: '2026-10-21' }) as any).value);
    await a.sync(cloud); await b.sync(cloud);
    a.use(); const two_ = entriesOf((await loadSchedule('shared'))!).find((e) => e.name === 'Two')!;
    await removeEntry('shared', two_.id);
    // 推 CALENDAR.db 时云端收下了,回执在路上丢了
    const put = cloud.putFile.bind(cloud);
    cloud.putFile = async (...args: Parameters<typeof put>) => { if (args[1] === 'shared' && args[2] === 'CALENDAR.db') { cloud.putFile = put; await put(...args); throw new Error('socket hang up'); } return put(...args); };
    a.use(); expect((await runAgentFilesSync(cloud, 'u')).error).toMatch(/socket hang up/);
    // B 收到删除,又把那一行原样加回来,另加一条
    await b.sync(cloud);
    b.use();
    expect(JSON.parse(cloudText(cloud, 'shared', 'CALENDAR.db')!).rows).toHaveLength(1);
    const onB = (await loadSchedule('shared'))!;
    const same = { id: two_.id, cells: { name: 'Two', date: '2026-10-21', repeat: '', auto: false, prompt: '', description: '', todo: false, lastRun: '', device: 'a' } };
    await saveSchedule('shared', { ...onB, rows: [...onB.rows, same] });
    await upsertEntry('shared', (validateEntryInput({ name: 'Three', date: '2026-10-22' }) as any).value);
    await b.sync(cloud);
    await a.sync(cloud); // 拿旧基线合并会把 B 加回来的那行当成「A 这边删了」再删一次
    for (const d of [a, b]) { await d.sync(cloud); d.use(); expect(entriesOf((await loadSchedule('shared'))!).map((e) => e.name).sort()).toEqual(['One', 'Three', 'Two']); }
  });
});
