/**
 * 随账号走的设置文件 human/Settings/<name>.db(可选族 settings)在旧同步里的行为:
 * 两个 TANGU_HOME 临时目录当两台设备,共用一份内存里的假云(seq / hash / CAS 和服务端一致)。
 * 这个族和 human/ 里别的文件不一样的地方:任何情况下都有确定的赢家,不出冲突副本。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { diff3Merge } from 'node-diff3';
import { runAgentFilesSync } from '../src/services/agentFileSync.js';
import { agentSyncScope, setAgentSyncDefault, setAgentSyncPermission } from '../src/services/cloudSyncAccount.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { humanDir } from '../src/core/tanguHome.js';
import { mergeAgentSyncContent } from '../src/contracts/agentSyncRules.js';
import { AgentFileConflictError, type AgentFilesBrain } from '../src/seams/cloudBrain.js';

const FAMILIES = ['human', 'human-folder', 'agent-calendar', 'widget-data', 'settings'];
const OLD_SERVER = ['human', 'human-folder', 'agent-calendar', 'widget-data'];
const REL = 'Settings/calendar.db';
const sha = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
/** 行 id 由键确定性推出:两台设备给同一项设置生成同一个行 id。 */
const rowId = (k: string): string => `s${createHash('sha1').update(k).digest('hex').slice(0, 16)}`;
const settingsDb = (items: Record<string, string>): string => `${JSON.stringify({
  version: 2, name: 'calendar-settings',
  columns: [{ id: 'k', name: 'key', type: 'text' }, { id: 'v', name: 'value', type: 'text' }],
  rows: Object.entries(items).map(([k, v]) => ({ id: rowId(k), cells: { k, v } })),
}, null, 2)}\n`;
const itemsOf = (text: string): Record<string, string> => Object.fromEntries((JSON.parse(text).rows as Array<{ cells: { k: string; v: string } }>).map((r) => [r.cells.k, r.cells.v]));

/** 内存假云:CAS 行为照 server tanguAgentFilesService(baseSeq 0 = 只建;>0 = 期望当前 seq)。 */
function fakeCloud(paths: string[] | undefined = FAMILIES) {
  const rows = new Map<string, any>();
  const puts: string[] = [];
  const key = (s: string, p: string) => `${s}\0${p}`;
  const brain: AgentFilesBrain & { _rows: typeof rows; _puts: string[]; _paths?: string[] } = {
    _rows: rows, _puts: puts, _paths: paths,
    async getManifest() {
      const bySlug = new Map<string, any[]>();
      for (const [k, r] of rows) {
        const [slug, relPath] = k.split('\0');
        bySlug.set(slug, [...(bySlug.get(slug) ?? []), { relPath, mtimeMs: r.mtimeMs, size: r.size ?? 0, isBinary: !!r.isBinary, deleted: !!r.deleted, seq: r.seq, hash: r.hash }]);
      }
      return Object.assign([...bySlug.entries()].map(([slug, files]) => ({ slug, files })), brain._paths ? { paths: brain._paths } : {});
    },
    async getFile(_u, slug, relPath) {
      const r = rows.get(key(slug, relPath));
      if (!r) return null;
      if (r.deleted) return { isBinary: false, mtimeMs: r.mtimeMs, deleted: true, seq: r.seq, hash: null };
      return r.isBinary
        ? { contentBase64: r.contentBase64, isBinary: true, mtimeMs: r.mtimeMs, deleted: false, seq: r.seq, hash: r.hash }
        : { content: r.content, isBinary: false, mtimeMs: r.mtimeMs, deleted: false, seq: r.seq, hash: r.hash };
    },
    async putFile(_u, slug, relPath, body) {
      puts.push(`${slug}/${relPath}`);
      const ex = rows.get(key(slug, relPath));
      const seq = ex && !ex.deleted ? ex.seq : 0;
      if (body.baseSeq !== undefined && body.baseSeq !== seq) throw new AgentFileConflictError({ code: 'CONFLICT', seq, hash: ex?.hash ?? null, mtimeMs: ex?.mtimeMs ?? 0, deleted: !!ex?.deleted });
      const hash = sha(body.isBinary ? Buffer.from(body.contentBase64 ?? '', 'base64') : body.content ?? '');
      const next = { ...body, seq: (ex?.seq ?? 0) + 1, hash, deleted: false };
      rows.set(key(slug, relPath), next);
      return { mtimeMs: next.mtimeMs, seq: next.seq, hash };
    },
    async deleteFile(_u, slug, relPath, mtimeMs, _device, baseSeq) {
      const ex = rows.get(key(slug, relPath));
      if (baseSeq !== undefined && ex && !ex.deleted && baseSeq !== ex.seq) throw new AgentFileConflictError({ code: 'CONFLICT', seq: ex.seq, hash: ex.hash, mtimeMs: ex.mtimeMs, deleted: false });
      rows.set(key(slug, relPath), { isBinary: false, size: 0, mtimeMs, deleted: true, seq: (ex?.seq ?? 0) + 1, hash: null });
    },
  };
  return brain;
}
type Cloud = ReturnType<typeof fakeCloud>;

let homeA: string, homeB: string;
const on = (h: string): void => { process.env.TANGU_HOME = h; };
beforeEach(() => {
  homeA = mkdtempSync(join(tmpdir(), 'tangu-settings-a-'));
  homeB = mkdtempSync(join(tmpdir(), 'tangu-settings-b-'));
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  for (const h of [homeA, homeB]) { try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/** 一台设备:有一个开了同步的 Agent,账号总闸开着(human/ 才上云)。 */
async function enroll(cloud: Cloud, h: string): Promise<void> {
  on(h);
  await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'be helpful', cloudSync: true });
  const scope = agentSyncScope(cloud, 'u')!;
  setAgentSyncPermission('tester', scope, true, true);
  setAgentSyncDefault(scope, true);
}
const file = (rel = REL): string => join(humanDir(), rel);
const write = (h: string, text: string, rel = REL): void => { on(h); mkdirSync(join(humanDir(), 'Settings'), { recursive: true }); writeFileSync(file(rel), text); };
const read = (h: string, rel = REL): string => { on(h); return readFileSync(file(rel), 'utf8'); };
const copies = (h: string): string[] => { on(h); const dir = join(humanDir(), 'Settings'); return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('conflict')) : []; };
const sync = async (cloud: Cloud, h: string) => { on(h); return runAgentFilesSync(cloud, 'u', { onlySlug: 'tester' }); };
const cloudText = (cloud: Cloud, rel = REL): string | undefined => cloud._rows.get(`__human__\0${rel}`)?.content;

describe('first contact: two devices each created Settings/calendar.db, no baseline', () => {
  const A = { 'sync|color|tasks.db': 'red', 'sync|hidden|only-a.db': '1' };
  const B = { 'sync|color|tasks.db': 'blue', 'sync|default|': 'only-b' };

  it('contract: rows are a union, the cloud copy wins the shared row, and no conflict is reported', () => {
    // ours = 这台(B),theirs = 云端(A 先同步上去的那份)
    const merged = mergeAgentSyncContent(`human/${REL}`, settingsDb(B), null, settingsDb(A), { diff3: diff3Merge });
    expect(merged).not.toBeNull();
    expect(itemsOf(merged!.content)).toEqual({ 'sync|color|tasks.db': 'red', 'sync|hidden|only-a.db': '1', 'sync|default|': 'only-b' });
    expect(merged!.conflict).toBe(false);
  });

  it('old sync: both devices converge on the union, the first one up wins the shared row, no conflict copy anywhere', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA); await enroll(cloud, homeB);
    write(homeA, settingsDb(A)); write(homeB, settingsDb(B));
    const results = [];
    for (const h of [homeA, homeB, homeA, homeB]) results.push(await sync(cloud, h));
    for (const r of results) expect(r).toMatchObject({ ok: true, conflicts: 0 });
    const want = { 'sync|color|tasks.db': 'red', 'sync|hidden|only-a.db': '1', 'sync|default|': 'only-b' };
    for (const h of [homeA, homeB]) { expect(itemsOf(read(h))).toEqual(want); expect(copies(h)).toEqual([]); }
    expect(itemsOf(cloudText(cloud)!)).toEqual(want);
    // 收敛了:再跑一轮谁都不推
    for (const h of [homeA, homeB]) expect((await sync(cloud, h)).pushed).toBe(0);
  });
});

describe('with a baseline: both devices synced the same file, then each changed it', () => {
  /** 两台都同步到同一份 base,返回云。 */
  async function synced(base: Record<string, string>): Promise<Cloud> {
    const cloud = fakeCloud();
    await enroll(cloud, homeA); await enroll(cloud, homeB);
    write(homeA, settingsDb(base));
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true });
    expect(itemsOf(read(homeB))).toEqual(base);
    return cloud;
  }
  const settle = async (cloud: Cloud, order: string[]) => { for (const h of order) expect(await sync(cloud, h)).toMatchObject({ ok: true, conflicts: 0 }); };

  it('merges by rows: a delete on one side holds, edits to different rows both land, the same row goes to the cloud copy', async () => {
    const cloud = await synced({ same: '0', gone: 'x', mine: '0', theirs: '0', still: 'kept' });
    write(homeA, settingsDb({ same: 'A', mine: '0', theirs: 'A-edit', still: 'kept', addedA: '1' })); // 删了 gone
    write(homeB, settingsDb({ same: 'B', gone: 'x', mine: 'B-edit', theirs: '0', still: 'kept', addedB: '1' }));
    await settle(cloud, [homeA, homeB, homeA, homeB]); // A 先同步上去 = 云端那份
    const want = { same: 'A', mine: 'B-edit', theirs: 'A-edit', still: 'kept', addedA: '1', addedB: '1' };
    for (const h of [homeA, homeB]) { expect(itemsOf(read(h))).toEqual(want); expect(copies(h)).toEqual([]); }
    expect(itemsOf(cloudText(cloud)!)).toEqual(want);
    for (const h of [homeA, homeB]) expect((await sync(cloud, h)).pushed).toBe(0);
  });

  it('a row deleted on one device stays deleted when the other device did not touch it', async () => {
    const cloud = await synced({ a: '1', b: '2' });
    write(homeB, settingsDb({ a: '1' }));
    await settle(cloud, [homeB, homeA, homeB]);
    for (const h of [homeA, homeB]) expect(itemsOf(read(h))).toEqual({ a: '1' });
  });

  it('a row one device deleted and the other edited goes to whichever reached the cloud first, without a copy', async () => {
    // 删的那台先同步上去 = 云端那份是「删」:另一台的改动输给它(两边都动了同一行且不一样 → 云端那份;没有这一行也是一个值)
    let cloud = await synced({ a: '1', b: '2' });
    write(homeA, settingsDb({ a: '1' }));
    write(homeB, settingsDb({ a: '1', b: 'edited' }));
    await settle(cloud, [homeA, homeB, homeA, homeB]);
    for (const h of [homeA, homeB]) { expect(itemsOf(read(h))).toEqual({ a: '1' }); expect(copies(h)).toEqual([]); }
    expect(itemsOf(cloudText(cloud)!)).toEqual({ a: '1' });
    for (const h of [homeA, homeB]) expect((await sync(cloud, h)).pushed).toBe(0);
    // 反过来:改的那台先上去,删的那台输
    for (const h of [homeA, homeB]) rmSync(h, { recursive: true, force: true });
    homeA = mkdtempSync(join(tmpdir(), 'tangu-settings-a-')); homeB = mkdtempSync(join(tmpdir(), 'tangu-settings-b-'));
    cloud = await synced({ a: '1', b: '2' });
    write(homeA, settingsDb({ a: '1' }));
    write(homeB, settingsDb({ a: '1', b: 'edited' }));
    await settle(cloud, [homeB, homeA, homeB, homeA]);
    for (const h of [homeA, homeB]) { expect(itemsOf(read(h))).toEqual({ a: '1', b: 'edited' }); expect(copies(h)).toEqual([]); }
  });

  it('review: this device reset the file to no columns and no rows while the other kept r and added s — r stays deleted, and the next round pushes nothing', async () => {
    const cloud = await synced({ r: '1' });
    write(homeB, settingsDb({ r: '1', s: '2' }));
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, pushed: 1 });
    write(homeA, `${JSON.stringify({ version: 2, name: 'calendar-settings', columns: [], rows: [] })}\n`);
    await settle(cloud, [homeA, homeB]);
    for (const h of [homeA, homeB]) { expect(itemsOf(read(h))).toEqual({ s: '2' }); expect(copies(h)).toEqual([]); }
    expect(itemsOf(cloudText(cloud)!)).toEqual({ s: '2' });
    for (const h of [homeA, homeB, homeA]) expect(await sync(cloud, h)).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
  });

  it('after a three-way merge both devices hold the same bytes and another round on either side pushes nothing', async () => {
    const cloud = await synced({ a: '1', b: '1', c: '1' });
    write(homeA, settingsDb({ c: 'A', a: '1', z: 'A' })); // 删了 b、改了 c、加了 z,行顺序也和对面不一样
    write(homeB, settingsDb({ a: 'B', b: '1', c: 'B', y: 'B' }));
    await settle(cloud, [homeA, homeB, homeA]);
    expect(read(homeA)).toBe(read(homeB));
    expect(read(homeA)).toBe(cloudText(cloud));
    expect(itemsOf(read(homeA))).toEqual({ a: 'B', c: 'A', y: 'B', z: 'A' });
    for (const h of [homeA, homeB, homeA, homeB]) expect(await sync(cloud, h)).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
  });

  it('a column definition that differs takes the cloud copy', async () => {
    const cloud = await synced({ a: '1' });
    const renamed = (name: string, extra: Record<string, string>) => { const db = JSON.parse(settingsDb({ a: '1', ...extra })); db.columns[1].name = name; return `${JSON.stringify(db, null, 2)}\n`; };
    write(homeA, renamed('valueA', { fromA: '1' }));
    write(homeB, renamed('valueB', { fromB: '1' }));
    await settle(cloud, [homeA, homeB, homeA, homeB]);
    for (const h of [homeA, homeB]) {
      expect(JSON.parse(read(h)).columns[1].name).toBe('valueA');
      expect(itemsOf(read(h))).toEqual({ a: '1', fromA: '1', fromB: '1' });
      expect(copies(h)).toEqual([]);
    }
  });
});

describe('never a conflict copy, whatever the two sides look like', () => {
  const good = { a: '1', b: '2' };
  async function pair(): Promise<Cloud> { const cloud = fakeCloud(); await enroll(cloud, homeA); await enroll(cloud, homeB); return cloud; }

  it('this device holds an unreadable file: the cloud copy replaces it', async () => {
    const cloud = await pair();
    write(homeA, settingsDb(good)); expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    write(homeB, '{ not json');
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, conflicts: 0 });
    expect(itemsOf(read(homeB))).toEqual(good);
    expect(copies(homeB)).toEqual([]);
    expect(itemsOf(cloudText(cloud)!)).toEqual(good);
  });

  it('the cloud holds an unreadable file: the readable local one wins and repairs it', async () => {
    const cloud = await pair();
    const junk = '{ not json';
    cloud._rows.set(`__human__\0${REL}`, { content: junk, isBinary: false, size: junk.length, mtimeMs: Date.now(), seq: 1, hash: sha(junk), deleted: false });
    write(homeA, junk); expect(await sync(cloud, homeA)).toMatchObject({ ok: true }); // A 和云端是同一份坏的
    write(homeB, settingsDb(good));
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, conflicts: 0 });
    expect(itemsOf(read(homeB))).toEqual(good);
    expect(itemsOf(cloudText(cloud)!)).toEqual(good);
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0 }); // A 那份没动过:直接拉
    expect(itemsOf(read(homeA))).toEqual(good);
    for (const h of [homeA, homeB]) expect(copies(h)).toEqual([]);
  });

  it('duplicate row ids on this device count as unreadable: the cloud copy wins', async () => {
    const cloud = await pair();
    write(homeA, settingsDb(good)); await sync(cloud, homeA);
    const dup = JSON.parse(settingsDb({ a: 'local' })); dup.rows.push({ ...dup.rows[0] });
    write(homeB, JSON.stringify(dup));
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, conflicts: 0 });
    expect(itemsOf(read(homeB))).toEqual(good);
    expect(copies(homeB)).toEqual([]);
  });

  it('a cloud row flagged binary is still merged by rows', async () => {
    const cloud = await pair();
    const text = settingsDb({ shared: 'cloud', onlyCloud: '1' });
    cloud._rows.set(`__human__\0${REL}`, { contentBase64: Buffer.from(text).toString('base64'), isBinary: true, size: text.length, mtimeMs: Date.now(), seq: 1, hash: sha(text), deleted: false });
    write(homeB, settingsDb({ shared: 'local', onlyLocal: '1' }));
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, conflicts: 0 });
    expect(itemsOf(read(homeB))).toEqual({ shared: 'cloud', onlyCloud: '1', onlyLocal: '1' });
    expect(copies(homeB)).toEqual([]);
    expect(cloud._rows.get(`__human__\0${REL}`)).toMatchObject({ isBinary: false }); // 合好的那份按文本推回去
  });

  it('a server row without a version (pre-CAS server) takes the cloud copy, still without a copy', async () => {
    const cloud = await pair();
    const text = settingsDb({ shared: 'cloud' });
    cloud._rows.set(`__human__\0${REL}`, { content: text, isBinary: false, size: text.length, mtimeMs: Date.now() + 60_000, deleted: false }); // 没有 seq / hash
    write(homeB, settingsDb({ shared: 'local' }));
    expect(await sync(cloud, homeB)).toMatchObject({ conflicts: 0 });
    expect(itemsOf(read(homeB))).toEqual({ shared: 'cloud' });
    expect(copies(homeB)).toEqual([]);
    expect(cloud._puts.filter((k) => k.includes('Settings'))).toEqual([]); // 没有版本号就没有比对交换写:不推
  });
});

describe('review: a server entry without seq / hash (old metadata) does not bypass the settings rules', () => {
  /** 云端那一行没有 seq / hash(旧元数据):modern 为假,只能按 mtime 判。 */
  const legacyRow = (cloud: Cloud, text: string, mtimeMs: number): void => { cloud._rows.set(`__human__\0${REL}`, { content: text, isBinary: false, size: Buffer.byteLength(text), mtimeMs, deleted: false }); };
  const settingsPuts = (cloud: Cloud): string[] => cloud._puts.filter((k) => k.includes('Settings'));

  it('an unreadable newer cloud copy does not overwrite the readable local file', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    const good = settingsDb({ a: '1' });
    write(homeA, good);
    legacyRow(cloud, '{ half', Date.now() + 60_000);
    for (let i = 0; i < 2; i++) expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0 });
    expect(read(homeA)).toBe(good);
    expect(copies(homeA)).toEqual([]);
    expect(settingsPuts(cloud)).toEqual([]);
    expect(cloudText(cloud)).toBe('{ half');
  });

  it('two valid copies: rows only this device has are kept, the cloud wins a shared row, the result lands locally only and is not pushed', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    write(homeA, settingsDb({ shared: 'local', onlyLocal: '1' }));
    const cloudCopy = settingsDb({ shared: 'cloud', onlyCloud: '1' });
    legacyRow(cloud, cloudCopy, Date.now() + 60_000);
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0 });
    expect(itemsOf(read(homeA))).toEqual({ shared: 'cloud', onlyLocal: '1', onlyCloud: '1' });
    expect(settingsPuts(cloud)).toEqual([]);
    expect(cloudText(cloud)).toBe(cloudCopy);
    // 下一轮:什么都不写、不推
    const before = read(homeA);
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0, pulled: 0 });
    expect(read(homeA)).toBe(before);
    expect(settingsPuts(cloud)).toEqual([]);
    on(homeA);
    const shadowFile = join(humanDir(), `.cloudsync-${agentSyncScope(cloud, 'u')}.json`);
    const shadow = existsSync(shadowFile) ? JSON.parse(readFileSync(shadowFile, 'utf8')) : { files: {} };
    expect(shadow.files[REL]).toBeUndefined(); // 拿不准就不记基线
  });

  it('a local copy newer than the cloud one is still not pushed without a version', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    legacyRow(cloud, settingsDb({ shared: 'cloud', onlyCloud: '1' }), Date.now() - 600_000);
    write(homeA, settingsDb({ shared: 'local', onlyLocal: '1' }));
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0 });
    expect(settingsPuts(cloud)).toEqual([]);
    expect(itemsOf(read(homeA))).toEqual({ shared: 'cloud', onlyLocal: '1', onlyCloud: '1' });
  });

  it('no local file and an unreadable cloud copy: nothing is written', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    legacyRow(cloud, '{ half', Date.now());
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    on(homeA);
    expect(existsSync(file())).toBe(false);
  });
});

describe('a server that does not know the settings family', () => {
  it('is treated as having no cloud copy: nothing is pushed or pulled, the local file stays, the sync does not fail', async () => {
    const cloud = fakeCloud(OLD_SERVER);
    await enroll(cloud, homeA);
    const text = settingsDb({ a: '1' });
    write(homeA, text);
    const r = await sync(cloud, homeA);
    expect(r).toMatchObject({ ok: true, conflicts: 0 });
    expect(r.error).toBeUndefined();
    expect(cloud._puts.filter((k) => k.includes('Settings'))).toEqual([]);
    expect(cloud._puts).toContain('__human__/.layout'); // human/ 别的照常同步
    expect(read(homeA)).toBe(text);
    on(homeA);
    const shadowFile = join(humanDir(), `.cloudsync-${agentSyncScope(cloud, 'u')}.json`);
    const shadow = existsSync(shadowFile) ? JSON.parse(readFileSync(shadowFile, 'utf8')) : { files: {} };
    expect(Object.keys(shadow.files).filter((k) => k.startsWith('Settings/'))).toEqual([]); // 不记影子:升级后按第一次见面合
  });

  it('a server with no path families at all behaves the same', async () => {
    const cloud = fakeCloud(undefined);
    cloud._paths = undefined;
    await enroll(cloud, homeA);
    write(homeA, settingsDb({ a: '1' }));
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    expect(cloud._puts.filter((k) => k.includes('Settings'))).toEqual([]);
    expect(itemsOf(read(homeA))).toEqual({ a: '1' });
  });

  it('once the server starts declaring it, the two devices merge as a first contact', async () => {
    const cloud = fakeCloud(OLD_SERVER);
    await enroll(cloud, homeA); await enroll(cloud, homeB);
    write(homeA, settingsDb({ shared: 'A', onlyA: '1' })); write(homeB, settingsDb({ shared: 'B', onlyB: '1' }));
    for (const h of [homeA, homeB]) expect(await sync(cloud, h)).toMatchObject({ ok: true });
    cloud._paths = FAMILIES;
    for (const h of [homeA, homeB, homeA, homeB]) expect(await sync(cloud, h)).toMatchObject({ ok: true, conflicts: 0 });
    for (const h of [homeA, homeB]) { expect(itemsOf(read(h))).toEqual({ shared: 'A', onlyA: '1', onlyB: '1' }); expect(copies(h)).toEqual([]); }
  });
});

describe('which files belong to the family', () => {
  it('only Settings/<name>.db syncs: other names stay local, and unknown cloud paths are ignored instead of failing the sync', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    write(homeA, settingsDb({ a: '1' }));
    for (const rel of ['Settings/notes.json', 'Settings/Upper.db', 'Settings/calendar (conflict 2026-11-10 0900).db', 'Settings/.hidden.db']) write(homeA, 'local only', rel);
    on(homeA); mkdirSync(join(humanDir(), 'Settings', 'nested'), { recursive: true }); writeFileSync(join(humanDir(), 'Settings', 'nested', 'deep.db'), settingsDb({ x: '1' }));
    for (const rel of ['Settings/Other Name.db', 'Settings/x/y.db', 'Settings/readme.md']) cloud._rows.set(`__human__\0${rel}`, { content: 'cloud only', isBinary: false, size: 10, mtimeMs: Date.now(), seq: 1, hash: sha('cloud only'), deleted: false });
    const r = await sync(cloud, homeA);
    expect(r).toMatchObject({ ok: true });
    expect(cloud._puts.filter((k) => k.includes('Settings')).sort()).toEqual([`__human__/${REL}`]);
    on(homeA);
    expect(readdirSync(join(humanDir(), 'Settings')).sort()).toEqual(['.hidden.db', 'Upper.db', 'calendar (conflict 2026-11-10 0900).db', 'calendar.db', 'nested', 'notes.json']);
  });

  it('syncs every settings file in the family, not just the calendar one', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA); await enroll(cloud, homeB);
    write(homeA, settingsDb({ a: '1' })); write(homeA, settingsDb({ theme: 'dark' }), 'Settings/appearance-2.db');
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true });
    expect(itemsOf(read(homeB, 'Settings/appearance-2.db'))).toEqual({ theme: 'dark' });
    expect(itemsOf(read(homeB))).toEqual({ a: '1' });
  });

  it('a local file over 256 KB is held back before upload: not pushed, not a sync failure, logged once, and it goes up once it fits', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    write(homeA, settingsDb({ big: 'x'.repeat(260 * 1024) }));
    write(homeA, settingsDb({ small: '1' }), 'Settings/small.db');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let round = 0; round < 3; round++) {
        const r = await sync(cloud, homeA);
        expect(r).toMatchObject({ ok: true, conflicts: 0 });
        expect(r.error).toBeUndefined();
      }
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('human/Settings/calendar.db'))).toHaveLength(1); // 不每轮刷一遍
    } finally { warn.mockRestore(); }
    expect(cloud._puts.filter((k) => k.includes('Settings'))).toEqual(['__human__/Settings/small.db']);
    expect(itemsOf(read(homeA)).big.length).toBe(260 * 1024);
    write(homeA, settingsDb({ big: 'now it fits' }));
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true, pushed: 1 });
    expect(itemsOf(cloudText(cloud)!)).toEqual({ big: 'now it fits' });
  });

  it('a merge that would exceed 256 KB is not written or pushed: both sides stay as they were and the sync still succeeds', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA); await enroll(cloud, homeB);
    const a = settingsDb({ onlyA: 'a'.repeat(150 * 1024) }), b = settingsDb({ onlyB: 'b'.repeat(150 * 1024) }); // 各自没超,并集超了
    write(homeA, a); write(homeB, b);
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let round = 0; round < 3; round++) {
        const r = await sync(cloud, homeB);
        expect(r).toMatchObject({ ok: true, conflicts: 0 });
        expect(r.error).toBeUndefined();
      }
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('human/Settings/calendar.db'))).toHaveLength(1);
      expect(cloud._puts.filter((k) => k.includes('Settings'))).toHaveLength(1); // 只有 A 最初那一次
    } finally { warn.mockRestore(); }
    expect(read(homeB)).toBe(b);
    expect(cloudText(cloud)).toBe(a);
    expect(copies(homeB)).toEqual([]);
  });
});

describe('an unreadable file never rides a fast-forward (power loss left zero bytes, a half-written file)', () => {
  const good = { a: '1', b: '2' };
  /** 两台都同步到同一份好的。 */
  async function synced(): Promise<Cloud> {
    const cloud = fakeCloud();
    await enroll(cloud, homeA); await enroll(cloud, homeB);
    write(homeA, settingsDb(good));
    for (const h of [homeA, homeB]) expect(await sync(cloud, h)).toMatchObject({ ok: true });
    return cloud;
  }
  for (const [what, junk] of [['zero bytes', ''], ['half a file', settingsDb(good).slice(0, 40)], ['valid JSON of the wrong shape', '{"rows":[]}']] as const) {
    it(`this device's copy became ${what}: it is not pushed, the cloud copy repairs it, the other device never sees it`, async () => {
      const cloud = await synced();
      const before = JSON.stringify(cloud._rows.get(`__human__\0${REL}`));
      write(homeA, junk);
      expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0 });
      expect(itemsOf(read(homeA))).toEqual(good);
      expect(JSON.stringify(cloud._rows.get(`__human__\0${REL}`))).toBe(before); // 云端那份没被碰
      expect(copies(homeA)).toEqual([]);
      expect(await sync(cloud, homeB)).toMatchObject({ ok: true });
      expect(itemsOf(read(homeB))).toEqual(good);
    });
  }

  it('an unreadable local file with nothing in the cloud is left where it is, not pushed', async () => {
    const cloud = fakeCloud();
    await enroll(cloud, homeA);
    write(homeA, '');
    for (let i = 0; i < 2; i++) expect(await sync(cloud, homeA)).toMatchObject({ ok: true, conflicts: 0 });
    expect(cloud._puts.filter((k) => k.includes('Settings'))).toEqual([]);
    expect(read(homeA)).toBe('');
  });

  it('the cloud copy became unreadable while this device did not change its own: the local copy stays and repairs the cloud', async () => {
    const cloud = await synced();
    const row = cloud._rows.get(`__human__\0${REL}`);
    cloud._rows.set(`__human__\0${REL}`, { ...row, content: '{ half', size: 6, seq: row.seq + 1, hash: sha('{ half') }); // 别的写入方把坏字节传了上去
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, conflicts: 0 });
    expect(itemsOf(read(homeB))).toEqual(good);
    expect(itemsOf(cloudText(cloud)!)).toEqual(good);
    expect(copies(homeB)).toEqual([]);
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true });
    expect(itemsOf(read(homeA))).toEqual(good);
  });

  it('a normal fast-forward is untouched: an edit on one device is pushed as is and pulled byte for byte', async () => {
    const cloud = await synced();
    const compact = JSON.stringify(JSON.parse(settingsDb({ a: 'edited', b: '2' }))); // 别的写入方的排版(不带缩进)
    write(homeA, compact);
    expect(await sync(cloud, homeA)).toMatchObject({ ok: true, pushed: 1 });
    expect(cloudText(cloud)).toBe(compact);
    expect(await sync(cloud, homeB)).toMatchObject({ ok: true, pushed: 0 });
    expect(read(homeB)).toBe(compact);
  });
});
