/**
 * 文件改动记录契约(listChanges / recordPostWrite 写后指纹 / restoreCodeSince 的 paths 与 keepEdited):
 * 真临时目录、真 snapshotBeforeWrite + recordPostWrite + 写盘,与 checkpoints.test 同一套 home 隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotBeforeWrite,
  recordPostWrite,
  listCheckpoints,
  listChanges,
  restoreCodeSince,
} from './checkpoints.js';

let home = '';
let work = '';
const prevHome = process.env.TANGU_HOME;

const f = (name: string): string => join(work, name);
const write = (name: string, body: string | Buffer): void => writeFileSync(f(name), body);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const lines = (n: number, tag = 'L'): string => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';

/** 模拟一次 agent 写:先快照、再写盘、再记写后指纹(与 registry.ts 的顺序一致)。 */
async function agentWrite(sid: string, rid: string, name: string, body: string | Buffer | null): Promise<void> {
  await snapshotBeforeWrite(sid, rid, [f(name)]);
  if (body === null) rmSync(f(name), { force: true });
  else write(name, body);
  await recordPostWrite(sid, rid, [f(name)]);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cpc-home-'));
  work = mkdtempSync(join(tmpdir(), 'cpc-work-'));
  process.env.TANGU_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('listChanges', () => {
  it('modified:20 行里插一行 → +1 −0,hunk 头带真实行号', async () => {
    const before = lines(20);
    write('a.txt', before);
    const arr = before.split('\n');
    arr.splice(10, 0, 'NEW'); // 插在第 10 行之后 → 新文件第 11 行
    await agentWrite('s1', 'r1', 'a.txt', arr.join('\n'));

    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    expect(fc).toMatchObject({ path: f('a.txt'), kind: 'modified', adds: 1, dels: 0, runs: 1, editedLater: false });
    expect(fc.reason).toBeUndefined();
    expect(fc.patch).toBe(['@@ -9,4 +9,5 @@', ' L9', ' L10', '+NEW', ' L11', ' L12'].join('\n'));

    // 不要 diff 时不带 patch
    const [[plain]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(plain.patch).toBeUndefined();
  });

  it('修改与删除混合、相距远的两处改动分成两个 hunk', async () => {
    write('m.txt', lines(30));
    const arr = lines(30).split('\n');
    arr[0] = 'L1x'; // 第 1 行改
    arr.splice(24, 1); // 删第 25 行
    await agentWrite('s1', 'r1', 'm.txt', arr.join('\n'));
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    expect(fc).toMatchObject({ adds: 1, dels: 2 });
    expect(fc.patch!.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,3 +1,3 @@', '@@ -23,5 +23,4 @@']);
  });

  it('末尾换行有无、\\r\\n 不算改动', async () => {
    write('nl.txt', 'a\nb\n');
    await agentWrite('s1', 'r1', 'nl.txt', 'a\r\nb');
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(fc).toMatchObject({ kind: 'modified', adds: 0, dels: 0 });
    expect(fc.reverted).toBeUndefined(); // 字节不同,不是「撤销过」
  });

  it('created / deleted:新建全算 +,删除全算 −', async () => {
    write('gone.txt', 'x\ny\nz\n');
    await agentWrite('s1', 'r1', 'new.txt', 'one\ntwo\n');
    await agentWrite('s1', 'r1', 'gone.txt', null);

    const [files] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    const byPath = Object.fromEntries(files.map((x) => [x.path, x]));
    expect(files.map((x) => x.path)).toEqual([f('new.txt'), f('gone.txt')]); // 首次出现的顺序
    expect(byPath[f('new.txt')]).toMatchObject({ kind: 'created', adds: 2, dels: 0, editedLater: false });
    expect(byPath[f('new.txt')].patch).toBe('@@ -0,0 +1,2 @@\n+one\n+two');
    expect(byPath[f('gone.txt')]).toMatchObject({ kind: 'deleted', adds: 0, dels: 3, editedLater: false });
    expect(byPath[f('gone.txt')].patch).toBe('@@ -1,3 +0,0 @@\n-x\n-y\n-z');
  });

  it('两个窗口都改同一文件:窗 1 的「之后」= 窗 2 的 pre-image;整会话窗合并成一份', async () => {
    write('a.txt', 'v0\n');
    await agentWrite('s1', 'r1', 'a.txt', 'v0\nv1\n');
    await tick();
    await agentWrite('s1', 'r2', 'a.txt', 'v0\nv1\nv2a\nv2b\n');
    const [c1, c2] = await listCheckpoints('s1');

    const [w1, w2] = await listChanges('s1', [{ since: c1.at, until: c2.at }, { since: c2.at, until: null }]);
    expect(w1).toHaveLength(1);
    expect(w1[0]).toMatchObject({ adds: 1, dels: 0, runs: 1 });
    expect(w1[0].editedLater).toBeUndefined(); // 封闭窗口不算 editedLater
    expect(w2[0]).toMatchObject({ adds: 2, dels: 0, runs: 1, editedLater: false });

    const [[all]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(all).toMatchObject({ kind: 'modified', adds: 3, dels: 0, runs: 2 });
  });

  it('restore-* 不算改动来源,但作「之后」的边界;撤销后 reverted 且不算「别人改过」', async () => {
    write('a.txt', 'orig\n');
    await agentWrite('s1', 'r1', 'a.txt', 'orig\nagent\n');
    const t1 = (await listCheckpoints('s1'))[0].at;
    await tick();
    const t2 = Date.now();
    await tick();
    const rep = await restoreCodeSince('s1', t1); // 生成 restore-* 运行,其 pre-image = agent 写的版本
    expect(rep.restored).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('orig\n');

    // 整会话:restore-* 不进 runs、不当「之前」;之后 = 磁盘 = 原样 → reverted
    const [[all]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(all).toMatchObject({ kind: 'modified', adds: 0, dels: 0, runs: 1, reverted: true, editedLater: false });

    // 窗 [t1, t2):之后取 t2 之后第一个碰它的 run = restore-*,它的 pre-image 是 agent 版本
    const [[w1]] = await listChanges('s1', [{ since: t1, until: t2 }]);
    expect(w1).toMatchObject({ adds: 1, dels: 0, runs: 1 });
    expect(w1.reverted).toBeUndefined();

    // 只有 restore-* 的窗口:没有 agent 改动
    const [after] = await listChanges('s1', [{ since: t2, until: null }]);
    expect(after).toEqual([]);
  });

  it('建了又删(同窗)→ created + reverted,0/0', async () => {
    await agentWrite('s1', 'r1', 'tmp.txt', 'scratch\n');
    await tick();
    await agentWrite('s1', 'r2', 'tmp.txt', null);
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    expect(fc).toMatchObject({ kind: 'created', adds: 0, dels: 0, reverted: true, runs: 2, patch: '', editedLater: false });
  });

  it('二进制与超大:adds/dels 为 null 并给原因,不带 patch', async () => {
    write('bin.dat', Buffer.from([1, 2, 3]));
    await agentWrite('s1', 'r1', 'bin.dat', Buffer.from([1, 0, 2, 3]));
    write('big.txt', 'x\n');
    await agentWrite('s1', 'r1', 'big.txt', lines(20_001));
    write('fat.txt', 'y\n');
    await agentWrite('s1', 'r1', 'fat.txt', 'z'.repeat(1024 * 1024 + 1));

    const [files] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    const byPath = Object.fromEntries(files.map((x) => [x.path, x]));
    expect(byPath[f('bin.dat')]).toMatchObject({ kind: 'modified', adds: null, dels: null, reason: 'binary' });
    expect(byPath[f('bin.dat')].patch).toBeUndefined();
    expect(byPath[f('big.txt')]).toMatchObject({ adds: null, dels: null, reason: 'toobig' });
    expect(byPath[f('fat.txt')]).toMatchObject({ adds: null, dels: null, reason: 'toobig' });
  });

  it('pre-image 没存下(skipped)→ nosnap', async () => {
    // 目录 → stat 成功但读失败(EISDIR)→ skipped modified
    const { mkdirSync } = await import('node:fs');
    mkdirSync(f('adir'));
    await snapshotBeforeWrite('s1', 'r1', [f('adir')]);
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(fc).toMatchObject({ adds: null, dels: null, reason: 'nosnap' });
  });

  it('patch 超 2000 行截断,头部计数与留下的行一致', async () => {
    await agentWrite('s1', 'r1', 'huge.txt', lines(2500));
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    expect(fc).toMatchObject({ kind: 'created', adds: 2500, truncated: true });
    const pl = fc.patch!.split('\n');
    expect(pl).toHaveLength(2000);
    expect(pl[0]).toBe('@@ -0,0 +1,1999 @@');
  });

  it('editedLater:手改过磁盘 → true;没动 → false;path 过滤只回这一条', async () => {
    write('a.txt', 'a0\n');
    write('b.txt', 'b0\n');
    await agentWrite('s1', 'r1', 'a.txt', 'a1\n');
    await agentWrite('s1', 'r1', 'b.txt', 'b1\n');
    write('a.txt', 'a1\nmine\n'); // 用户手改

    const [files] = await listChanges('s1', [{ since: 0, until: null }]);
    const byPath = Object.fromEntries(files.map((x) => [x.path, x]));
    expect(byPath[f('a.txt')]).toMatchObject({ editedLater: true, adds: 2, dels: 1 });
    expect(byPath[f('b.txt')]).toMatchObject({ editedLater: false });

    const [only] = await listChanges('s1', [{ since: 0, until: null }], { path: f('b.txt') });
    expect(only.map((x) => x.path)).toEqual([f('b.txt')]);
  });

  it('同一 run 里先改后删:写后状态记「不存在」,不拿过期指纹判「别人改过」', async () => {
    write('a.txt', 'a0\n');
    await agentWrite('s1', 'r1', 'a.txt', 'a1\n');
    await agentWrite('s1', 'r1', 'a.txt', null);
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(fc).toMatchObject({ kind: 'deleted', editedLater: false });

    // keepEdited 也不能把它当冲突:被 agent 删掉的文件照样能撤销回来
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { keepEdited: true });
    expect(rep.conflicts).toEqual([]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a0\n');
  });

  it('重复行极多的整段重写不卡住(LCS 配对预算),超预算时靠唯一行锚点仍给准数', async () => {
    // 两种行交替 20000 行、整体错开一位:node-diff3 直接跑要几分钟(同步卡死引擎)
    const alt = (n: number, first: string, second: string): string => Array.from({ length: n }, (_, i) => (i % 2 ? second : first)).join('\n') + '\n';
    write('alt.txt', alt(20_000, '', '}'));
    await agentWrite('s1', 'r1', 'alt.txt', alt(20_000, '}', ''));
    // 重复行很多,但每三行有一行唯一:首尾都改 + 中间插一行,中段整段都要比
    const body = Array.from({ length: 6000 }, (_, i) => (i % 3 === 0 ? `u${i}` : i % 3 === 1 ? '' : '}'));
    write('anch.txt', body.join('\n') + '\n');
    const edited = [...body];
    edited[0] = 'first changed';
    edited[5999] = 'last changed';
    edited.splice(3000, 0, 'inserted');
    await agentWrite('s1', 'r1', 'anch.txt', edited.join('\n') + '\n');

    const t0 = Date.now();
    const [files] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    expect(Date.now() - t0).toBeLessThan(3000);
    const by = Object.fromEntries(files.map((x) => [x.path, x]));
    expect(by[f('alt.txt')].adds).toEqual(expect.any(Number)); // 有上界的近似,不是 null
    expect(by[f('anch.txt')]).toMatchObject({ adds: 3, dels: 2 });
    expect(by[f('anch.txt')].patch!.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(3);
  });

  it('没有检查点的会话 → 每个窗口都是空列表', async () => {
    expect(await listChanges('nope', [{ since: 0, until: 5 }, { since: 5, until: null }])).toEqual([[], []]);
  });
});

describe('recordPostWrite / restoreCodeSince 选项', () => {
  it('modified 条目也记写后指纹', async () => {
    write('a.txt', 'a0');
    await agentWrite('s1', 'r1', 'a.txt', 'a1');
    const m = JSON.parse(readFileSync(join(home, 'checkpoints', 's1', 'r1', 'manifest.json'), 'utf8'));
    expect(m.entries[0]).toMatchObject({ kind: 'modified', postHash: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it('paths 只恢复这些(安全快照也只拍它们)', async () => {
    write('a.txt', 'a0');
    write('b.txt', 'b0');
    await agentWrite('s1', 'r1', 'a.txt', 'a1');
    await agentWrite('s1', 'r1', 'b.txt', 'b1');
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { paths: [f('a.txt')] });
    expect(rep.restored).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a0');
    expect(readFileSync(f('b.txt'), 'utf8')).toBe('b1');
    const restoreCp = (await listCheckpoints('s1')).find((c) => c.runId.startsWith('restore-'))!;
    expect(restoreCp.files).toEqual([f('a.txt')]);
  });

  it('keepEdited:手改过的 modified 文件报冲突且原样不动,其余照常恢复', async () => {
    write('a.txt', 'a0');
    write('b.txt', 'b0');
    await agentWrite('s1', 'r1', 'a.txt', 'a1');
    await agentWrite('s1', 'r1', 'b.txt', 'b1');
    await agentWrite('s1', 'r1', 'c.txt', 'c1'); // created,无人改 → 照删
    write('a.txt', 'a1 + mine');
    const at = (await listCheckpoints('s1'))[0].at;

    const rep = await restoreCodeSince('s1', at, { keepEdited: true });
    expect(rep.conflicts).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a1 + mine');
    expect(rep.restored).toEqual([f('b.txt')]);
    expect(readFileSync(f('b.txt'), 'utf8')).toBe('b0');
    expect(rep.deleted).toEqual([f('c.txt')]);
    expect(existsSync(f('c.txt'))).toBe(false);
  });

  it('keepEdited:用户删掉了 agent 改过的文件 → 冲突,不写回', async () => {
    write('a.txt', 'a0');
    await agentWrite('s1', 'r1', 'a.txt', 'a1');
    rmSync(f('a.txt'));
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { keepEdited: true });
    expect(rep.conflicts).toEqual([f('a.txt')]);
    expect(existsSync(f('a.txt'))).toBe(false);
  });

  it('keepEdited:旧检查点没记写后状态 → 判不出就不覆盖,报冲突(读失败 ≠ 空)', async () => {
    write('a.txt', 'a0');
    await snapshotBeforeWrite('s1', 'r1', [f('a.txt')]); // 本功能之前的引擎:只有 pre-image,没有 recordPostWrite
    write('a.txt', 'a1');
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { keepEdited: true });
    expect(rep.conflicts).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a1');
    // 不带 keepEdited(消息菜单的「回退」)照旧覆盖
    const rep2 = await restoreCodeSince('s1', at);
    expect(rep2.restored).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a0');
  });

  it('keepEdited:新建后又被别的 run 改过、用户改回建时的内容 → 比的是最后那次写,不删', async () => {
    await agentWrite('s1', 'r1', 'n.txt', 'A'); // 建
    await tick();
    await agentWrite('s1', 'r2', 'n.txt', 'B'); // 别的 run 改
    write('n.txt', 'A'); // 用户改回 A
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { paths: [f('n.txt')], keepEdited: true });
    expect(rep.conflicts).toEqual([f('n.txt')]);
    expect(readFileSync(f('n.txt'), 'utf8')).toBe('A');
  });

  it('keepEdited:旧检查点里没指纹的「新建」条目 → 判不出,不删', async () => {
    await snapshotBeforeWrite('s1', 'r1', [f('n.txt')]);
    write('n.txt', 'made by an old engine');
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { keepEdited: true });
    expect(rep.conflicts).toEqual([f('n.txt')]);
    expect(existsSync(f('n.txt'))).toBe(true);
  });

  it('keepEdited:新建的文件已经不在了 → 目标已达成,照常算删除(no-op),不报冲突', async () => {
    await agentWrite('s1', 'r1', 'n.txt', 'A');
    rmSync(f('n.txt'));
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at, { keepEdited: true });
    expect(rep.conflicts).toEqual([]);
    expect(rep.deleted).toEqual([f('n.txt')]);
  });

  it('keepEdited:恢复写过但写后状态说不清(postUnknown)→ 不退回去拿更早的过期指纹', async () => {
    write('a.txt', 'A');
    await agentWrite('s1', 'r1', 'a.txt', 'B');
    const at = (await listCheckpoints('s1'))[0].at;
    const r1 = await restoreCodeSince('s1', at, { paths: [f('a.txt')], keepEdited: true });
    expect(r1.restored).toEqual([f('a.txt')]);
    // 模拟「恢复写下后读不出指纹」:把 restore-* 条目的写后状态改成说不清
    const { readdirSync } = await import('node:fs');
    const { checkpointsDir } = await import('../core/tanguHome.js');
    const dir = join(checkpointsDir(), 's1');
    const rid = readdirSync(dir).find((x) => x.startsWith('restore-'))!;
    const mf = join(dir, rid, 'manifest.json');
    const man = JSON.parse(readFileSync(mf, 'utf8'));
    for (const e of man.entries) { delete e.postHash; e.postUnknown = true; }
    writeFileSync(mf, JSON.stringify(man));
    write('a.txt', 'B'); // 用户自己写回 B(恰好等于 agent 那次写的内容)
    const r2 = await restoreCodeSince('s1', at, { paths: [f('a.txt')], keepEdited: true });
    expect(r2.conflicts).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('B');
  });

  it('一次回应的 patch 总量封顶:超了的文件只给增减、标 truncated', async () => {
    const long = (c: string) => c.repeat(900 * 1024) + '\n';
    for (const n of ['p1', 'p2', 'p3']) write(`${n}.txt`, long('a'));
    for (const n of ['p1', 'p2', 'p3']) await agentWrite('s1', 'r1', `${n}.txt`, long('b'));
    const [files] = await listChanges('s1', [{ since: 0, until: null }], { diff: true });
    expect(files.map((x) => [x.adds, x.dels])).toEqual([[1, 1], [1, 1], [1, 1]]);
    const total = files.reduce((n, x) => n + (x.patch?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(files.some((x) => x.truncated && x.patch === undefined)).toBe(true);
  });

  it('keepEdited:先撤销一次再撤销更早那轮 → 认恢复写下的内容,不误报冲突', async () => {
    write('a.txt', 'a0');
    await agentWrite('s1', 'r1', 'a.txt', 'a1');
    await tick();
    await agentWrite('s1', 'r2', 'a.txt', 'a2');
    const [c1, c2] = await listCheckpoints('s1');
    const r2 = await restoreCodeSince('s1', c2.at, { paths: [f('a.txt')], keepEdited: true });
    expect(r2.restored).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a1');
    // 撤销之后 editedLater 不亮(磁盘 = 恢复写下的内容)
    const [[fc]] = await listChanges('s1', [{ since: 0, until: null }]);
    expect(fc.editedLater).toBe(false);
    const r1 = await restoreCodeSince('s1', c1.at, { paths: [f('a.txt')], keepEdited: true });
    expect(r1.conflicts).toEqual([]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a0');
  });

  it('不带 opts:手改过的 modified 文件照旧覆盖(既有行为不变)', async () => {
    write('a.txt', 'a0');
    await agentWrite('s1', 'r1', 'a.txt', 'a1');
    write('a.txt', 'a1 + mine');
    const at = (await listCheckpoints('s1'))[0].at;
    const rep = await restoreCodeSince('s1', at);
    expect(rep.conflicts).toEqual([]);
    expect(rep.restored).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a0');
  });
});
