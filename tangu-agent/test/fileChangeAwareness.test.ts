import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { applyPatchProvider } from '../src/tools/builtin/applyPatch.js';
import {
  collectExternalChanges, noteRead, noteAgentWrite, __resetReadStateForTests, __snapshotCharsForTests,
  SNAPSHOT_FILE_MAX_CHARS, SNAPSHOT_SESSION_MAX_CHARS,
} from '../src/tools/readState.js';
import { fileChangeSection, lineDiff, renderFileChanges, wrapMidRunFileChanges, NOTICE_MAX_FILES, FILE_CHANGES_HEADING } from '../src/tools/fileChangeNotice.js';

// 变动感知(Agent 对变动文件的感知):读过 / 写过的文件被文件工具之外改了 → 下一次调模型前带 diff 报一次。
// 钉住:没变不报、外部改动只报一次、agent 自己的四种写永不报、删了 / 又出现、快照上限、通知不推写闸。

let dir: string;
let n = 0;
const ctxFor = (sessionId: string) => ({ cwd: dir, sessionId, userId: 'u', appId: 'a', execMode: 'host' as const }) as any;
const T = HOST_TOOLS;
const applyPatch = applyPatchProvider.tools()[0] as any;
const f = (name: string) => path.join(dir, name);
const disk = (name: string) => readFileSync(f(name), 'utf8');
/** 把 mtime 拨到过去,扫描才敢记 stat(刚改过 2 秒内的不记)。 */
const PAST = new Date(Date.now() - 60_000);
const age = (name: string, when = PAST) => utimesSync(f(name), when, when);

beforeEach(() => {
  __resetReadStateForTests();
  dir = mkdtempSync(path.join(os.tmpdir(), 'tangu-fchg-'));
  n += 1;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('collectExternalChanges', () => {
  it('读过没动:不报;同字节重写(mtime 变了)也不报', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('a.md'), 'one\ntwo\n');
    await T.read_file.execute({ path: 'a.md' }, ctx);
    expect(await collectExternalChanges(ctx)).toEqual([]);
    expect(await collectExternalChanges(ctx)).toEqual([]);
    writeFileSync(f('a.md'), 'one\ntwo\n'); // 编辑器原子保存同样的字节
    expect(await collectExternalChanges(ctx)).toEqual([]);
  });

  it('外部改动报一次(带前后快照),第二次扫描不再报', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('note.md'), '# Plan\n\nfirst line\n');
    await T.read_file.execute({ path: 'note.md' }, ctx);
    writeFileSync(f('note.md'), '# Plan\n\nfirst line\nuser added this\n');
    const changes = await collectExternalChanges(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ abs: f('note.md'), kind: 'modified', before: '# Plan\n\nfirst line\n', after: '# Plan\n\nfirst line\nuser added this\n' });
    expect(await collectExternalChanges(ctx)).toEqual([]);
  });

  it('stat 预检:mtime + size 没变就不读(记下 stat 之后,同大小同 mtime 的改动按设计漏掉)', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('a.txt'), 'aaaa\n');
    age('a.txt');
    await T.read_file.execute({ path: 'a.txt' }, ctx);
    expect(await collectExternalChanges(ctx)).toEqual([]); // 读后第一次:读一遍对上了,记 stat
    writeFileSync(f('a.txt'), 'bbbb\n');
    age('a.txt'); // 同大小、mtime 拨回同一刻 → 预检认为没变
    expect(await collectExternalChanges(ctx)).toEqual([]);
    age('a.txt', new Date(Date.now() - 30_000)); // mtime 一变就读,照样报
    expect((await collectExternalChanges(ctx)).map((c) => c.kind)).toEqual(['modified']);
  });

  it('agent 自己的写永不报:write_file / edit_file / multi_edit / apply_patch', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('a.txt'), 'one\ntwo\n');
    await T.read_file.execute({ path: 'a.txt' }, ctx);
    expect(await T.edit_file.execute({ path: 'a.txt', old_string: 'two', new_string: 'TWO' }, ctx)).toMatch(/^edited /);
    expect(await collectExternalChanges(ctx)).toEqual([]);
    expect(await T.multi_edit.execute({ path: 'a.txt', edits: [{ old_string: 'one', new_string: 'ONE' }] }, ctx)).toMatch(/^applied /);
    expect(await collectExternalChanges(ctx)).toEqual([]);
    expect(await applyPatch.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-ONE\n+uno\n*** End Patch' }, ctx)).toMatch(/^applied patch/);
    expect(disk('a.txt')).toBe('uno\nTWO\n');
    expect(await collectExternalChanges(ctx)).toEqual([]);
    expect(await T.write_file.execute({ path: 'a.txt', content: 'fresh\n' }, ctx)).toMatch(/^wrote /);
    expect(await T.write_file.execute({ path: 'new.txt', content: 'created by agent\n' }, ctx)).toMatch(/^wrote /);
    expect(await collectExternalChanges(ctx)).toEqual([]);
    // 自己写过的文件之后被外面改,照样报
    writeFileSync(f('new.txt'), 'created by agent\nthen the user\n');
    expect((await collectExternalChanges(ctx)).map((c) => [path.basename(c.abs), c.kind])).toEqual([['new.txt', 'modified']]);
  });

  it('局部改落盘前用户已经改过:那段外部改动单独报(beforeWrite),diff 里不含 agent 自己的改动', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('doc.md'), 'alpha\nbeta\n');
    await T.read_file.execute({ path: 'doc.md' }, ctx);
    writeFileSync(f('doc.md'), 'alpha\nbeta\nuser line\n'); // 模型生成期间用户在写
    expect(await T.edit_file.execute({ path: 'doc.md', old_string: 'alpha', new_string: 'ALPHA' }, ctx)).toMatch(/^edited /);
    expect(disk('doc.md')).toBe('ALPHA\nbeta\nuser line\n');
    const changes = await collectExternalChanges(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'beforeWrite', before: 'alpha\nbeta\n', after: 'alpha\nbeta\nuser line\n' });
    expect(await collectExternalChanges(ctx)).toEqual([]);
  });

  it('删了报一次;又出现按 created 再报一次', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('gone.txt'), 'bye\n');
    await T.read_file.execute({ path: 'gone.txt' }, ctx);
    unlinkSync(f('gone.txt'));
    expect((await collectExternalChanges(ctx)).map((c) => c.kind)).toEqual(['deleted']);
    expect(await collectExternalChanges(ctx)).toEqual([]);
    writeFileSync(f('gone.txt'), 'back again\n');
    const again = await collectExternalChanges(ctx);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ kind: 'created', before: '', after: 'back again\n' });
    expect(await collectExternalChanges(ctx)).toEqual([]);
  });

  it('agent 自己删 / 挪走的文件不报(forgetRead)', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('p.txt'), 'x\n');
    await T.read_file.execute({ path: 'p.txt' }, ctx);
    expect(await applyPatch.execute({ patch: '*** Begin Patch\n*** Delete File: p.txt\n*** End Patch' }, ctx)).toMatch(/^applied patch/);
    expect(await collectExternalChanges(ctx)).toEqual([]);
  });

  it('只看本会话:别的会话读过的文件不串报', async () => {
    writeFileSync(f('shared.md'), 'v1\n');
    await T.read_file.execute({ path: 'shared.md' }, ctxFor('other'));
    writeFileSync(f('shared.md'), 'v2\n');
    expect(await collectExternalChanges(ctxFor(`s${n}`))).toEqual([]);
    expect(await collectExternalChanges(ctxFor('other'))).toHaveLength(1);
  });

  it('二进制 / 超过单文件快照上限:照报但不带 diff;不让读的路径不带内容', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('bin.dat'), Buffer.from([1, 0, 2, 3]));
    noteRead(ctx, f('bin.dat'), readFileSync(f('bin.dat')));
    const big = 'x'.repeat(SNAPSHOT_FILE_MAX_CHARS + 10) + '\n';
    writeFileSync(f('big.txt'), big);
    await T.read_file.execute({ path: 'big.txt' }, ctx);
    writeFileSync(f('secret.txt'), 'a\n');
    await T.read_file.execute({ path: 'secret.txt' }, ctx);
    writeFileSync(f('bin.dat'), Buffer.from([1, 0, 9, 9]));
    writeFileSync(f('big.txt'), big + 'more\n');
    writeFileSync(f('secret.txt'), 'b\n');
    const changes = await collectExternalChanges(ctx, { canRead: (abs) => !abs.endsWith('secret.txt') });
    const by = Object.fromEntries(changes.map((c) => [path.basename(c.abs), c]));
    expect(by['bin.dat']).toMatchObject({ kind: 'modified', note: 'binary' });
    expect(by['bin.dat'].after).toBeUndefined();
    expect(by['big.txt']).toMatchObject({ kind: 'modified', note: 'large' });
    expect(by['secret.txt']).toMatchObject({ kind: 'modified', note: 'withheld' });
    expect(by['secret.txt'].after).toBeUndefined();
    expect(by['secret.txt'].before).toBeUndefined();
  });

  it('每会话快照总量封顶:最久没碰的先丢快照,指纹仍在、改动照报(只是没 diff)', async () => {
    const ctx = ctxFor(`s${n}`);
    const size = Math.floor(SNAPSHOT_FILE_MAX_CHARS * 0.9);
    const count = Math.ceil(SNAPSHOT_SESSION_MAX_CHARS / size) + 2;
    for (let i = 0; i < count; i++) noteAgentWrite(ctx, f(`f${i}.txt`), String(i % 10).repeat(size));
    for (let i = 0; i < count; i++) writeFileSync(f(`f${i}.txt`), String(i % 10).repeat(size));
    expect(__snapshotCharsForTests(ctx)).toBeLessThanOrEqual(SNAPSHOT_SESSION_MAX_CHARS);
    expect(await collectExternalChanges(ctx)).toEqual([]); // 指纹都在:没变的照样认得
    writeFileSync(f('f0.txt'), 'changed\n'); // 最早那个已经丢了快照
    writeFileSync(f(`f${count - 1}.txt`), 'changed\n'); // 最近那个快照还在
    const changes = await collectExternalChanges(ctx);
    const by = Object.fromEntries(changes.map((c) => [path.basename(c.abs), c]));
    expect(by['f0.txt']).toMatchObject({ kind: 'modified', note: 'large' });
    expect(by[`f${count - 1}.txt`].note).toBeUndefined();
    expect(by[`f${count - 1}.txt`].before).toHaveLength(size);
  });
});

describe('通知不推写闸(G3-02 不退化)', () => {
  it('外部改动通知过之后,write_file 整篇覆盖仍被拒,重读后才放行', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('note.md'), 'v1\n');
    await T.read_file.execute({ path: 'note.md' }, ctx);
    writeFileSync(f('note.md'), 'v1\nuser\n');
    expect(await collectExternalChanges(ctx)).toHaveLength(1);
    const r = await T.write_file.execute({ path: 'note.md', content: 'agent rewrite\n' }, ctx);
    expect(r).toMatch(/has changed on disk since you last read it/);
    expect(disk('note.md')).toBe('v1\nuser\n');
    await T.read_file.execute({ path: 'note.md' }, ctx);
    expect(await T.write_file.execute({ path: 'note.md', content: 'v1\nuser\nagent\n' }, ctx)).toMatch(/^wrote /);
    expect(await collectExternalChanges(ctx)).toEqual([]);
  });
});

describe('通知文本', () => {
  it('lineDiff:真实行号的 hunk,两行上下文', () => {
    const d = lineDiff('a\nb\nc\nd\ne\nf\n', 'a\nb\nc\nX\nd\ne\nf\n')!;
    expect(d).toMatchObject({ adds: 1, dels: 0, truncated: false });
    expect(d.patch).toBe('@@ -2,4 +2,5 @@\n b\n c\n+X\n d\n e');
  });

  it('lineDiff:超过行数上限截断并标出', () => {
    const before = '';
    const after = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const d = lineDiff(before, after)!;
    expect(d.truncated).toBe(true);
    expect(d.patch.split('\n').length).toBeLessThanOrEqual(60);
    expect(d.adds).toBe(200);
  });

  it('renderFileChanges:标题 + 说明 + 每个文件一段;多出来的只列名字', () => {
    const many = Array.from({ length: NOTICE_MAX_FILES + 3 }, (_, i) => ({ abs: path.join(dir, `n${i}.md`), kind: 'modified' as const, before: 'a\n', after: `a\nb${i}\n` }));
    const text = renderFileChanges([{ abs: path.join(dir, 'x.md'), kind: 'deleted' }, ...many], dir)!;
    expect(text.startsWith(FILE_CHANGES_HEADING)).toBe(true);
    expect(text).toContain('### x.md — deleted');
    expect(text).toContain('### n0.md — modified (+1 −0 lines)');
    expect(text).toContain('+b0');
    expect(text).toMatch(/Also changed: .*n\d+\.md \(modified\)/);
    expect(text).toContain('never write an older copy back over them');
    expect(renderFileChanges([], dir)).toBeNull();
  });

  it('fileChangeSection 端到端:外部编辑 → 一段通知(含用户写的那行)→ 再扫为空;mid-run 外层标明不是用户写的', async () => {
    const ctx = ctxFor(`s${n}`);
    writeFileSync(f('draft.md'), '# Draft\n\nIntro.\n');
    await T.read_file.execute({ path: 'draft.md' }, ctx);
    writeFileSync(f('draft.md'), '# Draft\n\nIntro.\n\nA paragraph the user typed.\n');
    const section = await fileChangeSection({ sessionId: ctx.sessionId, cwd: dir, runId: 'r1' }, 'mid-run');
    expect(section).toContain('### draft.md — modified');
    expect(section).toContain('+A paragraph the user typed.');
    expect(await fileChangeSection({ sessionId: ctx.sessionId, cwd: dir }, 'mid-run')).toBeNull();
    const wrapped = wrapMidRunFileChanges(section!);
    expect(wrapped).toMatch(/^<file_changes>\n/);
    expect(wrapped).toContain('NOT written by the user');
  });
});
