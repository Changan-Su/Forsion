/**
 * confinedFs 的「判定与打开之间换链」竞态(P1 K10a)。竞态在真 fs 上靠时序撞不稳定,这里把 fs 操作注入成
 * 「在 open 前一刻把中间目录 / 末段换成指到根外的软链,open 之后再换回来」—— 也就是攻击者赢下时间窗的那一刻。
 * 修复前(P0)没有这一层:判完 realpath 就 readFile / writeFile,换链后跟着走出去。
 *
 * 前两组钉的是「这一层挡得住的」:末段换链、中间目录单次换链(换出去、或换出去再换回)。
 * 最后一组「残余」钉的是「挡不住的」—— 攻击者按 链接 / 真目录 / 链接 三态赢下每个时间窗,复核照样通过:
 * 读到根外内容、截断并改写根外已有文件、在根外新建带内容的文件;删与列只要一次换链。这是现状,不是期望:
 * Node 没有 openat,要关掉得靠原生绑定(openat / RESOLVE_BENEATH)。哪天关上了,把这组断言翻过来,并同步改 confinedFs.ts 头注释。
 * 注入是确定性的;真 fs 上用并发换链循环(如 renamex_np(RENAME_SWAP))也撞得出来,只是按概率(P1 K10a 评审实测)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  NODE_CONFINED_FS, readConfined, writeConfined, unlinkConfined, listConfined, ConfinedPathError, type ConfinedFsOps,
} from '../src/sandbox/confinedFs.js';

const POSIX = process.platform !== 'win32';
let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tangu-k10a-race-root-'));
  outside = mkdtempSync(join(tmpdir(), 'tangu-k10a-race-out-'));
  mkdirSync(join(root, 'sub'));
});
afterEach(() => { for (const d of [root, outside]) rmSync(d, { recursive: true, force: true }); });

/** open(命中 when)之前把 root/sub 换成指到 outside 的软链;swapBack=true 时 open 之后的第一次 realpath 前再换回真目录。 */
function swapParentAroundOpen(when: (p: string) => boolean, swapBack: boolean): ConfinedFsOps & { swapped: () => boolean } {
  let state: 'idle' | 'swapped' | 'restored' = 'idle';
  const toLink = () => { renameSync(join(root, 'sub'), join(root, 'sub.real')); symlinkSync(outside, join(root, 'sub')); };
  const toReal = () => { unlinkSync(join(root, 'sub')); renameSync(join(root, 'sub.real'), join(root, 'sub')); };
  return {
    ...NODE_CONFINED_FS,
    open: async (p, flags, mode) => {
      if (state === 'idle' && when(p)) { toLink(); state = 'swapped'; }
      return NODE_CONFINED_FS.open(p, flags, mode);
    },
    realpath: async (p) => {
      if (state === 'swapped' && swapBack) { toReal(); state = 'restored'; }
      return NODE_CONFINED_FS.realpath(p);
    },
    swapped: () => state !== 'idle',
  };
}

describe.skipIf(!POSIX)('读:打开前一刻换链', () => {
  it('中间目录被换成指到根外的软链 → null,拿不到根外内容', async () => {
    writeFileSync(join(root, 'sub', 'f.txt'), 'INSIDE');
    writeFileSync(join(outside, 'f.txt'), 'SECRET');
    const ops = swapParentAroundOpen((p) => p.endsWith(join('sub', 'f.txt')), false);
    expect(await readConfined(root, 'sub/f.txt', { fs: ops })).toBeNull();
    expect(ops.swapped()).toBe(true);
  });

  it('换出去、打开、再换回来(复核时路径又在根内)→ inode 对不上,仍是 null', async () => {
    writeFileSync(join(root, 'sub', 'f.txt'), 'INSIDE');
    writeFileSync(join(outside, 'f.txt'), 'SECRET');
    const ops = swapParentAroundOpen((p) => p.endsWith(join('sub', 'f.txt')), true);
    expect(await readConfined(root, 'sub/f.txt', { fs: ops })).toBeNull();
    expect(ops.swapped()).toBe(true);
    expect(readFileSync(join(root, 'sub', 'f.txt'), 'utf8')).toBe('INSIDE'); // 换回来了,确实走的是「复核在根内」那条
  });

  it('末段被换成软链 → O_NOFOLLOW 打不开,null', async () => {
    writeFileSync(join(root, 'f.txt'), 'INSIDE');
    writeFileSync(join(outside, 'f.txt'), 'SECRET');
    let swapped = false;
    const ops: ConfinedFsOps = {
      ...NODE_CONFINED_FS,
      open: async (p, flags, mode) => {
        if (!swapped && p.endsWith('f.txt')) { swapped = true; unlinkSync(join(root, 'f.txt')); symlinkSync(join(outside, 'f.txt'), join(root, 'f.txt')); }
        return NODE_CONFINED_FS.open(p, flags, mode);
      },
    };
    expect(await readConfined(root, 'f.txt', { fs: ops })).toBeNull();
    expect(swapped).toBe(true);
  });

  it('无竞态时照常读到(正对照)', async () => {
    writeFileSync(join(root, 'sub', 'f.txt'), 'INSIDE');
    expect((await readConfined(root, 'sub/f.txt'))?.toString()).toBe('INSIDE');
  });
});

describe.skipIf(!POSIX)('写:打开前一刻换链', () => {
  it('覆盖已有文件时父目录被换出去再换回 → 拒写,根外同名文件一字不改(没被截断)', async () => {
    writeFileSync(join(root, 'sub', 'victim.txt'), 'old');
    writeFileSync(join(outside, 'victim.txt'), 'KEEP');
    const ops = swapParentAroundOpen((p) => p.endsWith(join('sub', 'victim.txt')), true);
    await expect(writeConfined(root, 'sub/victim.txt', Buffer.from('PAYLOAD'), { fs: ops })).rejects.toBeInstanceOf(ConfinedPathError);
    expect(ops.swapped()).toBe(true);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('KEEP');
    expect(readFileSync(join(root, 'sub', 'victim.txt'), 'utf8')).toBe('old');
  });

  it('新建文件时父目录单次被换出去(不换回)→ 拒写;根外留下一个空文件(三态换链能写进内容,见「残余」组)', async () => {
    const ops = swapParentAroundOpen((p) => p.endsWith(join('sub', 'new.txt')), false);
    await expect(writeConfined(root, 'sub/new.txt', Buffer.from('PAYLOAD'), { fs: ops })).rejects.toBeInstanceOf(ConfinedPathError);
    expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe(''); // O_CREAT 已在根外落地,复核拒了才没写内容
  });

  it('末段在判定后被换成指到根外的软链 → 拒写,根外文件不动', async () => {
    writeFileSync(join(root, 'f.txt'), 'old');
    writeFileSync(join(outside, 'f.txt'), 'KEEP');
    let swapped = false;
    const ops: ConfinedFsOps = {
      ...NODE_CONFINED_FS,
      open: async (p, flags, mode) => {
        if (!swapped && p.endsWith('f.txt')) { swapped = true; unlinkSync(join(root, 'f.txt')); symlinkSync(join(outside, 'f.txt'), join(root, 'f.txt')); }
        return NODE_CONFINED_FS.open(p, flags, mode);
      },
    };
    await expect(writeConfined(root, 'f.txt', Buffer.from('PAYLOAD'), { fs: ops })).rejects.toBeInstanceOf(ConfinedPathError);
    expect(swapped).toBe(true);
    expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('KEEP');
  });

  it('新建时末段抢先被种成软链(O_EXCL 撞 EEXIST)→ 重判后拒写,不跟着建到根外', async () => {
    let planted = false;
    const ops: ConfinedFsOps = {
      ...NODE_CONFINED_FS,
      open: async (p, flags, mode) => {
        if (!planted) { planted = true; symlinkSync(join(outside, 'planted.txt'), join(root, 'n.txt')); }
        return NODE_CONFINED_FS.open(p, flags, mode);
      },
    };
    await expect(writeConfined(root, 'n.txt', Buffer.from('PAYLOAD'), { fs: ops })).rejects.toBeInstanceOf(ConfinedPathError);
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
  });

  it('逐段建目录时中间段被换出去 → 拒写;残余:根外至多多出空目录', async () => {
    let swapped = false;
    const ops: ConfinedFsOps = {
      ...NODE_CONFINED_FS,
      mkdir: async (p) => {
        if (!swapped && p.endsWith(join('sub', 'deep'))) { swapped = true; renameSync(join(root, 'sub'), join(root, 'sub.real')); symlinkSync(outside, join(root, 'sub')); }
        return NODE_CONFINED_FS.mkdir(p);
      },
    };
    await expect(writeConfined(root, 'sub/deep/x.txt', Buffer.from('PAYLOAD'), { fs: ops })).rejects.toBeInstanceOf(ConfinedPathError);
    expect(swapped).toBe(true);
    expect(existsSync(join(outside, 'deep', 'x.txt'))).toBe(false);
  });

  it('无竞态时照常写(新建 + 覆盖截断,正对照)', async () => {
    await writeConfined(root, 'sub/a.txt', Buffer.from('a longer first version'));
    await writeConfined(root, 'sub/a.txt', 'v2');
    expect(readFileSync(join(root, 'sub', 'a.txt'), 'utf8')).toBe('v2');
  });
});

type Op = 'open' | 'realpath' | 'lstat' | 'unlink' | 'readdir' | 'mkdir';
interface Step { op: Op; match?: (p: string) => boolean; act?: () => void }

/** 按顺序在命中的 fs 调用之前执行动作 —— 攻击者在每个时间窗都赢了的那一次。 */
function scripted(steps: Step[]): ConfinedFsOps & { done: () => boolean } {
  let i = 0;
  const before = (op: Op, p: string) => {
    const s = steps[i];
    if (s && s.op === op && (!s.match || s.match(p))) { s.act?.(); i++; }
  };
  return {
    realpath: async (p) => { before('realpath', p); return NODE_CONFINED_FS.realpath(p); },
    lstat: async (p) => { before('lstat', p); return NODE_CONFINED_FS.lstat(p); },
    open: async (p, f, m) => { before('open', p); return NODE_CONFINED_FS.open(p, f, m); },
    mkdir: async (p) => { before('mkdir', p); return NODE_CONFINED_FS.mkdir(p); },
    unlink: async (p) => { before('unlink', p); return NODE_CONFINED_FS.unlink(p); },
    readdir: async (p) => { before('readdir', p); return NODE_CONFINED_FS.readdir(p); },
    done: () => i === steps.length,
  };
}
const subToLink = () => { renameSync(join(root, 'sub'), join(root, 'sub.real')); symlinkSync(outside, join(root, 'sub')); };
const subToReal = () => { unlinkSync(join(root, 'sub')); renameSync(join(root, 'sub.real'), join(root, 'sub')); };
const inSub = (name: string) => (p: string) => p.endsWith(join('sub', name));
/** open 时是链接、复核的 realpath 时是真目录、复核的 lstat 时又是链接:realpath 说「在根内」,lstat 跟着中间链接拿到根外 inode。 */
const threeState = (name: string): Step[] => [
  { op: 'open', match: inSub(name), act: subToLink },
  { op: 'realpath', act: subToReal },
  { op: 'lstat', act: subToLink },
];

describe.skipIf(!POSIX)('残余(现状,不是期望):中间目录三态换链 / 删与列的单次换链', () => {
  it('读:三态换链赢了 → 读到根外内容', async () => {
    writeFileSync(join(root, 'sub', 'f.txt'), 'INSIDE');
    writeFileSync(join(outside, 'f.txt'), 'SECRET');
    const ops = scripted(threeState('f.txt'));
    const got = await readConfined(root, 'sub/f.txt', { fs: ops });
    expect(ops.done()).toBe(true);
    expect(got?.toString()).toBe('SECRET');
  });

  it('写:三态换链赢了 → 根外已有文件被截断并改写', async () => {
    writeFileSync(join(root, 'sub', 'victim.txt'), 'old');
    writeFileSync(join(outside, 'victim.txt'), 'KEEP-OUTSIDE');
    const ops = scripted(threeState('victim.txt'));
    await writeConfined(root, 'sub/victim.txt', Buffer.from('PAYLOAD'), { fs: ops });
    expect(ops.done()).toBe(true);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('PAYLOAD');
    expect(readFileSync(join(root, 'sub.real', 'victim.txt'), 'utf8')).toBe('old');
  });

  it('写新建:三态换链赢了(真目录里放同名诱饵过 realpath)→ 根外新文件带内容', async () => {
    const ops = scripted([
      // 判存在时就是链接 → 根外不存在 → 走 O_CREAT|O_EXCL,在根外建出来
      { op: 'lstat', match: inSub('new.txt'), act: () => { subToLink(); writeFileSync(join(root, 'sub.real', 'new.txt'), 'decoy'); } },
      { op: 'realpath', act: subToReal },
      { op: 'lstat', act: subToLink },
    ]);
    await writeConfined(root, 'sub/new.txt', Buffer.from('PAYLOAD'), { fs: ops });
    expect(ops.done()).toBe(true);
    expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe('PAYLOAD');
  });

  it('删:realpath(父目录) 与 unlink 之间单次换链 → 删掉根外同名文件(重 hydrate 清理会在宿主侧自动走到这里)', async () => {
    writeFileSync(join(root, 'sub', 'id_rsa'), 'inside');
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE');
    const ops = scripted([{ op: 'unlink', match: inSub('id_rsa'), act: subToLink }]);
    expect(await unlinkConfined(root, 'sub/id_rsa', ops)).toBe(true);
    expect(ops.done()).toBe(true);
    expect(existsSync(join(outside, 'id_rsa'))).toBe(false);
    expect(existsSync(join(root, 'sub.real', 'id_rsa'))).toBe(true);
  });

  it('列:realpath(子目录) 与 readdir 之间单次换链 → 列出根外文件名 / 大小(只泄元数据;内容仍要过 readConfined)', async () => {
    writeFileSync(join(root, 'sub', 'a.txt'), 'a');
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE');
    const ops = scripted([{ op: 'readdir', match: (p) => p.endsWith(sep + 'sub'), act: subToLink }]);
    const entries = await listConfined(root, ops);
    expect(ops.done()).toBe(true);
    expect(entries.find((e) => e.rel === 'sub/id_rsa')?.size).toBe(7);
  });
});
