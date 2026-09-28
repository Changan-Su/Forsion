/**
 * confinedFs 的「判定与打开之间换链」竞态(P1 K10a)。竞态在真 fs 上靠时序撞不稳定,这里把 fs 操作注入成
 * 「在 open 前一刻把中间目录 / 末段换成指到根外的软链,open 之后再换回来」—— 也就是攻击者赢下时间窗的那一刻。
 * 修复前(P0)没有这一层:判完 realpath 就 readFile / writeFile,换链后跟着走出去。
 * 残余(写入输掉竞态时根外可能留下空文件 / 空目录)在对应用例里钉成现状,改动它要同步改 confinedFs.ts 头注释。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NODE_CONFINED_FS, readConfined, writeConfined, ConfinedPathError, type ConfinedFsOps,
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

  it('新建文件时父目录被换出去 → 拒写;残余:根外留下一个空文件,但内容写不进去', async () => {
    const ops = swapParentAroundOpen((p) => p.endsWith(join('sub', 'new.txt')), false);
    await expect(writeConfined(root, 'sub/new.txt', Buffer.from('PAYLOAD'), { fs: ops })).rejects.toBeInstanceOf(ConfinedPathError);
    expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe(''); // 残余钉成现状(见 confinedFs.ts 头注释)
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
