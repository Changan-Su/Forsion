import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { applyPatchProvider } from '../src/tools/builtin/applyPatch.js';

// G3-02(Amadeus 编辑器评审 2026-09-27):write_file 不看「读后盘上有没有被改过」,Agent 拿读取时的旧快照
// 整篇覆盖,用户在编辑器里接着写的那段静默消失。修复 = 按会话记读后指纹,整篇覆盖前比对,不一致拒写让模型重读。
// 第一条就是评审探针 v02-writefile.mjs 的原场景;其余钉住「agent 自己的写不许误拒」与「过期视图不许被局部改洗白」。

let dir: string;
let n = 0;
const ctxFor = (sessionId: string) => ({ cwd: dir, sessionId, userId: 'u', appId: 'a', execMode: 'host' as const }) as any;
const T = HOST_TOOLS;
const applyPatch = applyPatchProvider.tools()[0] as any;
const disk = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const STALE = /has changed on disk since you last read it/;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tangu-g302-'));
  n += 1;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('write_file 读后指纹闸(G3-02)', () => {
  it('读到 A → 用户改成 A′ → 模型写 B:拒写、盘上保留 A′;重读后再写才放行', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(path.join(dir, 'note.md'), '# 笔记\n\n版本A 原文。\n');
    await T.read_file.execute({ path: 'note.md' }, ctx);
    const userEdit = '# 笔记\n\n版本A 原文。\n\n用户在 t0 之后新写的一段。\n';
    writeFileSync(path.join(dir, 'note.md'), userEdit);

    const r = await T.write_file.execute({ path: 'note.md', content: '# 笔记\n\n版本B。\n' }, ctx);
    expect(r).toMatch(/^Error: /); // registry 靠 'Error' 前缀判失败、撤检查点快照
    expect(r).toMatch(STALE);
    expect(r).toContain('read_file');
    expect(disk('note.md')).toBe(userEdit);

    await T.read_file.execute({ path: 'note.md' }, ctx);
    const r2 = await T.write_file.execute({ path: 'note.md', content: userEdit + '\nAgent 追加。\n' }, ctx);
    expect(r2).toMatch(/^wrote /);
    expect(disk('note.md')).toContain('用户在 t0 之后新写的一段。');
  });

  it('agent 自己的写刷新指纹:read → write → write、read → edit_file → write_file、read → multi_edit → write_file 都不误拒', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    await T.read_file.execute({ path: 'a.txt' }, ctx);
    expect(await T.write_file.execute({ path: 'a.txt', content: 'v1\n' }, ctx)).toMatch(/^wrote /);
    expect(await T.write_file.execute({ path: 'a.txt', content: 'v2\n' }, ctx)).toMatch(/^wrote /);
    expect(await T.edit_file.execute({ path: 'a.txt', old_string: 'v2', new_string: 'v3' }, ctx)).toMatch(/^edited /);
    expect(await T.multi_edit.execute({ path: 'a.txt', edits: [{ old_string: 'v3', new_string: 'v4' }] }, ctx)).toMatch(/^applied /);
    expect(await T.write_file.execute({ path: 'a.txt', content: 'v5\n' }, ctx)).toMatch(/^wrote /);
    expect(disk('a.txt')).toBe('v5\n');
  });

  it('read → apply_patch → write_file 不误拒(补丁落盘同样刷新指纹)', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(path.join(dir, 'p.txt'), 'alpha\nbeta\n');
    await T.read_file.execute({ path: 'p.txt' }, ctx);
    const patch = '*** Begin Patch\n*** Update File: p.txt\n alpha\n-beta\n+BETA\n*** End Patch';
    expect(await applyPatch.execute({ patch }, ctx)).toMatch(/^applied patch/);
    expect(await T.write_file.execute({ path: 'p.txt', content: 'gamma\n' }, ctx)).toMatch(/^wrote /);
  });

  it('过期视图不被局部改洗白:读后用户改了 → edit_file 成功(保住用户那段)→ 接着整篇 write_file 仍要求重读', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(path.join(dir, 'e.md'), 'title\nbody\n');
    await T.read_file.execute({ path: 'e.md' }, ctx);
    writeFileSync(path.join(dir, 'e.md'), 'title\nbody\nuser line\n');
    expect(await T.edit_file.execute({ path: 'e.md', old_string: 'title', new_string: 'TITLE' }, ctx)).toMatch(/^edited /);
    expect(await T.write_file.execute({ path: 'e.md', content: 'TITLE\nbody\n' }, ctx)).toMatch(STALE);
    expect(disk('e.md')).toBe('TITLE\nbody\nuser line\n');
  });

  it('没读过不设闸;读后被删 = 新建放行;会话之间互不背书', async () => {
    const a = ctxFor(`s${n}-a`);
    const b = ctxFor(`s${n}-b`);
    writeFileSync(path.join(dir, 'x.txt'), 'orig\n');
    // b 从没读过 x:照旧放行(新建 / 模型经别的途径拿到内容的写不在本闸范围)
    await T.read_file.execute({ path: 'x.txt' }, a);
    expect(await T.write_file.execute({ path: 'x.txt', content: 'from b\n' }, b)).toMatch(/^wrote /);
    // a 读到的是 orig,b 的写不替 a 背书
    expect(await T.write_file.execute({ path: 'x.txt', content: 'from a\n' }, a)).toMatch(STALE);
    expect(disk('x.txt')).toBe('from b\n');
    // 读后文件被删:写 = 新建
    await T.read_file.execute({ path: 'x.txt' }, a);
    unlinkSync(path.join(dir, 'x.txt'));
    expect(await T.write_file.execute({ path: 'x.txt', content: 'recreated\n' }, a)).toMatch(/^wrote /);
    expect(existsSync(path.join(dir, 'x.txt'))).toBe(true);
  });
});
