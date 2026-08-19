/**
 * 代码检查点契约:pre-image 只记首次、恢复=回到该时刻(不是撤销一个 run)、
 * 墓碑恢复成删除、撤销只摘真没落盘的那些。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotBeforeWrite, listCheckpoints, restoreCodeSince, removeSessionCheckpoints } from './checkpoints.js';

let home = '';
let work = '';
const prevHome = process.env.TANGU_HOME;

const f = (name: string): string => join(work, name);
const write = (name: string, body: string): void => writeFileSync(f(name), body, 'utf8');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cp-home-'));
  work = mkdtempSync(join(tmpdir(), 'cp-work-'));
  process.env.TANGU_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('checkpoints', () => {
  it('记 pre-image 并按 at 恢复;同一 run 同一路径只记首次', async () => {
    write('a.txt', 'v1');
    await snapshotBeforeWrite('s1', 'r1', [f('a.txt')]);
    write('a.txt', 'v2');
    await snapshotBeforeWrite('s1', 'r1', [f('a.txt')]); // 第二次不该覆盖 pre-image
    write('a.txt', 'v3');

    const cps = await listCheckpoints('s1');
    expect(cps).toHaveLength(1);
    expect(cps[0].files).toEqual([f('a.txt')]);

    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.restored).toEqual([f('a.txt')]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('v1');
  });

  it('恢复到 run1 = 回到那一刻:run2 之后改的文件一并回去,同路径取最早 pre-image', async () => {
    write('a.txt', 'a1');
    write('b.txt', 'b1');
    await snapshotBeforeWrite('s1', 'r1', [f('a.txt')]);
    write('a.txt', 'a2');
    const at1 = (await listCheckpoints('s1'))[0].at;

    await new Promise((r) => setTimeout(r, 5));
    await snapshotBeforeWrite('s1', 'r2', [f('a.txt'), f('b.txt')]);
    write('a.txt', 'a3');
    write('b.txt', 'b2');

    const rep = await restoreCodeSince('s1', at1);
    expect(rep.restored.sort()).toEqual([f('a.txt'), f('b.txt')].sort());
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('a1'); // 最早那份,不是 r2 记的 a2
    expect(readFileSync(f('b.txt'), 'utf8')).toBe('b1');
  });

  it('只恢复目标时刻之后的检查点(更早的 run 不动)', async () => {
    write('old.txt', 'o1');
    await snapshotBeforeWrite('s1', 'r1', [f('old.txt')]);
    write('old.txt', 'o2');
    await new Promise((r) => setTimeout(r, 5));
    write('new.txt', 'n1');
    await snapshotBeforeWrite('s1', 'r2', [f('new.txt')]);
    write('new.txt', 'n2');

    const cps = await listCheckpoints('s1');
    const rep = await restoreCodeSince('s1', cps[1].at);
    expect(rep.restored).toEqual([f('new.txt')]);
    expect(readFileSync(f('old.txt'), 'utf8')).toBe('o2'); // 早于目标时刻 → 保持现状
  });

  it('原本不存在的文件 = 墓碑,恢复即删除(含新建的子目录文件)', async () => {
    mkdirSync(f('sub'), { recursive: true });
    await snapshotBeforeWrite('s1', 'r1', [f('sub/created.txt')]);
    write('sub/created.txt', 'brand new');

    const cps = await listCheckpoints('s1');
    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.deleted).toEqual([f('sub/created.txt')]);
    expect(existsSync(f('sub/created.txt'))).toBe(false);
  });

  it('撤销:工具真没落盘 → 摘掉条目;写了一半才失败 → pre-image 必须留下', async () => {
    write('untouched.txt', 'same');
    write('halfwritten.txt', 'before');
    const undo1 = await snapshotBeforeWrite('s1', 'r1', [f('untouched.txt')]);
    await undo1();
    expect(await listCheckpoints('s1')).toEqual([]); // 没改 → 不该出现在时间线里

    const undo2 = await snapshotBeforeWrite('s1', 'r2', [f('halfwritten.txt')]);
    write('halfwritten.txt', 'partial garbage'); // 工具写了,然后抛错
    await undo2();
    const cps = await listCheckpoints('s1');
    expect(cps).toHaveLength(1);
    await restoreCodeSince('s1', cps[0].at);
    expect(readFileSync(f('halfwritten.txt'), 'utf8')).toBe('before');
  });

  it('⚠️读不了的文件绝不能记成墓碑(否则回退会删掉一个本来就在的文件)', async () => {
    write('locked.txt', 'precious');
    chmodSync(f('locked.txt'), 0o000);
    try {
      await snapshotBeforeWrite('s1', 'r1', [f('locked.txt')]);
      const cps = await listCheckpoints('s1');
      expect(cps[0].skipped).toEqual([f('locked.txt')]); // 如实报「存不下」
      const rep = await restoreCodeSince('s1', cps[0].at);
      expect(rep.deleted).toEqual([]); // 绝不删
      expect(rep.skipped).toEqual([f('locked.txt')]);
    } finally {
      chmodSync(f('locked.txt'), 0o644);
    }
    expect(readFileSync(f('locked.txt'), 'utf8')).toBe('precious');
  });

  it('目录路径不当墓碑(EISDIR 同理:回退不许删目录)', async () => {
    mkdirSync(f('adir'), { recursive: true });
    await snapshotBeforeWrite('s1', 'r1', [f('adir')]);
    const cps = await listCheckpoints('s1');
    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.deleted).toEqual([]);
    expect(existsSync(f('adir'))).toBe(true);
  });

  it('恢复保留权限位(被删的可执行脚本回来还能执行)', async () => {
    write('run.sh', '#!/bin/sh\necho hi');
    chmodSync(f('run.sh'), 0o755);
    await snapshotBeforeWrite('s1', 'r1', [f('run.sh')]);
    rmSync(f('run.sh')); // 工具把它删了
    const cps = await listCheckpoints('s1');
    await restoreCodeSince('s1', cps[0].at);
    expect(statSync(f('run.sh')).mode & 0o777).toBe(0o755);
  });

  it('回退本身可回退:恢复前把现状也存成检查点', async () => {
    write('a.txt', 'v1');
    await snapshotBeforeWrite('s1', 'r1', [f('a.txt')]);
    write('a.txt', 'v2');
    const t1 = (await listCheckpoints('s1'))[0].at;
    await restoreCodeSince('s1', t1);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('v1');

    const cps = await listCheckpoints('s1');
    expect(cps).toHaveLength(2); // 多出一个「回退前」的检查点
    await restoreCodeSince('s1', cps[1].at);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('v2'); // 把回退撤回来
  });

  it('撤销后快照文件名不重用(否则后一个文件的 pre-image 会覆盖前一个,静默毁数据)', async () => {
    write('x.txt', 'x1');
    write('y.txt', 'y1');
    const undo = await snapshotBeforeWrite('s1', 'r1', [f('x.txt'), f('y.txt')]);
    write('y.txt', 'y2'); // 同一次工具调用里只有 y 真落了盘
    await undo(); // x 的条目被摘掉(含它的快照文件),y 的保留
    write('z.txt', 'z1');
    await snapshotBeforeWrite('s1', 'r1', [f('z.txt')]);
    write('z.txt', 'z2');

    const cps = await listCheckpoints('s1');
    await restoreCodeSince('s1', cps[0].at);
    expect(readFileSync(f('y.txt'), 'utf8')).toBe('y1'); // 不能被 z 的快照写坏
    expect(readFileSync(f('z.txt'), 'utf8')).toBe('z1');
  });

  it('⚠️到了上限时恢复不能被自己的修剪吃掉(回退到最旧那个检查点仍要成功)', async () => {
    // 攒满 100 个检查点,再回退到**最旧**那一个:恢复前的现状快照若照常修剪,
    // 101 → 删最旧 = 亲手删掉正要恢复的那份 pre-image,且无法重试。
    write('a.txt', 'gen0');
    for (let i = 0; i < 100; i++) {
      await snapshotBeforeWrite('s1', `r${i}`, [f('a.txt')]);
      write('a.txt', `gen${i + 1}`);
      await new Promise((r) => setTimeout(r, 1)); // 让 at 单调,修剪顺序才确定
    }
    const cps = await listCheckpoints('s1');
    expect(cps).toHaveLength(100);
    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.failed).toEqual([]);
    expect(readFileSync(f('a.txt'), 'utf8')).toBe('gen0');
  });

  it('⚠️agent 建的文件被用户改过 → 回退不删它,报冲突(回退可以撤 agent 的活,不能抹用户的)', async () => {
    const { recordPostWrite } = await import('./checkpoints.js');
    await snapshotBeforeWrite('s1', 'r1', [f('made.txt'), f('kept.txt')]);
    write('made.txt', 'agent 写的');
    write('kept.txt', 'agent 也写了这个');
    await recordPostWrite('s1', 'r1', [f('made.txt'), f('kept.txt')]);
    write('made.txt', 'agent 写的 + 我后来改的'); // 用户接着编辑了其中一个

    const cps = await listCheckpoints('s1');
    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.conflicts).toEqual([f('made.txt')]);
    expect(readFileSync(f('made.txt'), 'utf8')).toBe('agent 写的 + 我后来改的'); // 原样保留
    expect(rep.deleted).toEqual([f('kept.txt')]);                              // 没人动过的照删
    expect(existsSync(f('kept.txt'))).toBe(false);
  });

  it('⚠️同一 run 里先建后改(编码任务常态)→ 回退照删,不能误判成「用户改过」', async () => {
    const { recordPostWrite } = await import('./checkpoints.js');
    await snapshotBeforeWrite('s1', 'r1', [f('twice.txt')]);
    write('twice.txt', 'agent 第一版');            // write_file
    await recordPostWrite('s1', 'r1', [f('twice.txt')]);
    await snapshotBeforeWrite('s1', 'r1', [f('twice.txt')]); // 同 run 同路径:不再记条目
    write('twice.txt', 'agent 第二版');            // edit_file
    await recordPostWrite('s1', 'r1', [f('twice.txt')]);      // 指纹必须刷新成第二版

    const cps = await listCheckpoints('s1');
    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.conflicts).toEqual([]);
    expect(rep.deleted).toEqual([f('twice.txt')]);
    expect(existsSync(f('twice.txt'))).toBe(false);
  });

  it('⚠️指纹核不了(文件读不了)→ 保留不删(同「读不了不记墓碑」那条防线)', async () => {
    const { recordPostWrite } = await import('./checkpoints.js');
    await snapshotBeforeWrite('s1', 'r1', [f('locked-new.txt')]);
    write('locked-new.txt', 'agent 建的');
    await recordPostWrite('s1', 'r1', [f('locked-new.txt')]);
    chmodSync(f('locked-new.txt'), 0o000);
    try {
      const cps = await listCheckpoints('s1');
      const rep = await restoreCodeSince('s1', cps[0].at);
      expect(rep.deleted).toEqual([]);
      expect(rep.conflicts).toEqual([f('locked-new.txt')]);
      expect(existsSync(f('locked-new.txt'))).toBe(true);
    } finally {
      chmodSync(f('locked-new.txt'), 0o644);
    }
  });

  it('没有写后指纹的旧检查点仍按老语义删(否则对存量检查点整个空转)', async () => {
    await snapshotBeforeWrite('s1', 'r1', [f('legacy.txt')]);
    write('legacy.txt', '建了但没记指纹');
    const cps = await listCheckpoints('s1');
    const rep = await restoreCodeSince('s1', cps[0].at);
    expect(rep.deleted).toEqual([f('legacy.txt')]);
    expect(rep.conflicts).toEqual([]);
  });

  it('相对路径与非法 session 段不写盘;会话清盘可用', async () => {
    await snapshotBeforeWrite('s1', 'r1', ['relative/path.txt']);
    expect(await listCheckpoints('s1')).toEqual([]);

    write('x.txt', 'x');
    await snapshotBeforeWrite('../evil', 'r1', [f('x.txt')]);
    expect(existsSync(join(home, 'checkpoints', '.._evil'))).toBe(true); // 段被消毒,没穿出 home

    await removeSessionCheckpoints('../evil');
    expect(existsSync(join(home, 'checkpoints', '.._evil'))).toBe(false);
  });
});
