/**
 * P1 K10a · 云存储模式下「发附件 / 下载产物」的本地两段:hydrate(云 → 会话目录)与 snapshot(会话目录 → 云)。
 * 引擎登录了云端时工作区路由走云存储(isCloudStorageUp:httpBrain.storage 打 /api/brain/storage/*),手机传的附件先落云,
 * run 开始时 hydrate 进本地会话目录;run 结束 snapshot 回云,手机再从云下载。两段都在宿主侧碰会话目录:
 *  - hydrate 以前 path.join + mkdir(recursive) + writeFile —— 跟着会话目录里种的软链写到外面(附件内容写进 ~/.zshrc);
 *  - snapshot 以前 readdir(srcDir) —— 会话目录自身换成指向家目录的软链时,把家目录的文件整批传上云。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage = vi.hoisted(() => {
  // sessionSandbox 的 BASE_DIR 在模块加载时定:必须早于 import(重 hydrate 的清理用例走真 getSessionDir)。
  process.env.AGENT_SANDBOX_SESSION_DIR = `${process.env.TMPDIR || '/tmp'}/tangu-k10a-hyd-sessions-${process.pid}`;
  return { listDirectory: vi.fn(), getFileContent: vi.fn(), createDirectory: vi.fn(), uploadFile: vi.fn(), updateFileContent: vi.fn() };
});
vi.mock('../src/seams/runtime.js', () => ({ deps: () => ({ brain: { storage } }) }));

import { hydrateWorkspaceToDir, snapshotDirToWorkspace } from '../src/tools/fileWorkspace.js';
import { getSessionDir, refreshSessionWorkspace } from '../src/sandbox/sessionSandbox.js';
import { renameSync } from 'node:fs';

const POSIX = process.platform !== 'win32';
let parent: string; // 会话目录的上一级:恶意 `..` 名会落到这里
let dest: string;
let home: string;
const tmp: string[] = [];
const mk = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };

/** 云端树:workspace/S/{report.txt, ok.txt, sub/new.txt, ../../.zshrc(恶意名)} */
function cloudTree(): void {
  const dirs: Record<string, any[]> = {
    ROOT: [{ id: 'ws', name: 'workspace', fileType: 'directory' }],
    ws: [{ id: 'sess', name: 'S', fileType: 'directory' }],
    sess: [
      { id: 'f-report', name: 'report.txt', fileType: 'file', fileSize: 6 },
      { id: 'f-ok', name: 'ok.txt', fileType: 'file', fileSize: 2 },
      { id: 'd-sub', name: 'sub', fileType: 'directory' },
      { id: 'd-dotdot', name: '..', fileType: 'directory' },
    ],
    'd-sub': [{ id: 'f-new', name: 'new.txt', fileType: 'file', fileSize: 3 }],
    'd-dotdot': [{ id: 'f-rc', name: '.zshrc', fileType: 'file', fileSize: 6 }],
  };
  const files: Record<string, string> = { 'f-report': 'pwned\n', 'f-ok': 'ok', 'f-new': 'new', 'f-rc': 'pwned\n' };
  storage.listDirectory.mockImplementation(async (id: string) => dirs[id] ?? []);
  storage.getFileContent.mockImplementation(async (id: string) => ({ content: Buffer.from(files[id]), mimeType: 'text/plain' }));
}

beforeEach(() => {
  vi.resetAllMocks();
  parent = mk('tangu-k10a-hyd-');
  dest = join(parent, 'sess');
  mkdirSync(dest);
  home = mk('tangu-k10a-hyd-home-');
  writeFileSync(join(home, '.zshrc'), 'export SAFE=1\n');
  mkdirSync(join(home, 'Documents'));
});
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });
afterAll(() => { rmSync(process.env.AGENT_SANDBOX_SESSION_DIR!, { recursive: true, force: true }); });

describe.skipIf(!POSIX)('hydrate:不跟会话目录里的软链写出去', () => {
  it('末段链 / 目录链 / 恶意 `..` 名都写不出去;普通文件照常落地;这一轮不算权威快照', async () => {
    cloudTree();
    symlinkSync(join(home, '.zshrc'), join(dest, 'report.txt')); // 沙箱里的代码种的(宿主绝对路径)
    symlinkSync(join(home, 'Documents'), join(dest, 'sub'));
    const r = await hydrateWorkspaceToDir('u', 'tangu', { sessionId: 'S' }, dest);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('export SAFE=1\n');
    expect(existsSync(join(home, 'Documents', 'new.txt'))).toBe(false);
    expect(existsSync(join(parent, '.zshrc'))).toBe(false); // 云端条目名是 `..`:词法越界
    expect(readFileSync(join(dest, 'ok.txt'), 'utf8')).toBe('ok');
    expect([...r.manifest.keys()].sort()).toEqual(['ok.txt']);
    expect(r.complete).toBe(false); // 有文件没落地:缺席不能当「云端已删」
  });

  it('会话目录自身是软链 → 一个文件都不写', async () => {
    cloudTree();
    const link = join(mk('tangu-k10a-hyd-parent-'), 'sess');
    symlinkSync(home, link);
    const r = await hydrateWorkspaceToDir('u', 'tangu', { sessionId: 'S' }, link);
    expect(existsSync(join(home, 'ok.txt'))).toBe(false);
    expect(existsSync(join(home, 'report.txt'))).toBe(false);
    expect(r.manifest.size).toBe(0);
    expect(r.complete).toBe(false);
  });

  it('无软链时与原来一致:全部落地、manifest 全、complete', async () => {
    const dirs: Record<string, any[]> = {
      ROOT: [{ id: 'ws', name: 'workspace', fileType: 'directory' }],
      ws: [{ id: 'sess', name: 'S', fileType: 'directory' }],
      sess: [{ id: 'f1', name: 'a.txt', fileType: 'file' }, { id: 'd1', name: 'd', fileType: 'directory' }],
      d1: [{ id: 'f2', name: 'b.txt', fileType: 'file' }, { id: 'd2', name: 'empty', fileType: 'directory' }],
    };
    storage.listDirectory.mockImplementation(async (id: string) => dirs[id] ?? []);
    storage.getFileContent.mockImplementation(async (id: string) => ({ content: Buffer.from(id), mimeType: 'text/plain' }));
    writeFileSync(join(dest, 'a.txt'), 'stale longer content');
    const r = await hydrateWorkspaceToDir('u', 'tangu', { sessionId: 'S' }, dest);
    expect(r.complete).toBe(true);
    expect([...r.manifest.keys()].sort()).toEqual(['a.txt', 'd/b.txt']);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('f1');
    expect(readFileSync(join(dest, 'd', 'b.txt'), 'utf8')).toBe('f2');
    expect(existsSync(join(dest, 'd', 'empty'))).toBe(true);
  });
});

describe.skipIf(!POSIX)('snapshot:不把会话目录外的文件传上云', () => {
  function cloudSink(): Map<string, string> {
    const uploaded = new Map<string, string>();
    storage.listDirectory.mockResolvedValue([]);
    storage.createDirectory.mockImplementation(async (_u: string, _a: string, parent: string, name: string) => ({ id: `${parent}/${name}` }));
    storage.uploadFile.mockImplementation(async (_u: string, _a: string, parent: string, name: string, content: Buffer) => {
      uploaded.set(`${parent}/${name}`.replace(/^ROOT\/workspace\/S\//, ''), content.toString());
      return { id: name };
    });
    return uploaded;
  }

  it('会话目录自身是指向家目录的软链 → 什么都不传', async () => {
    const uploaded = cloudSink();
    writeFileSync(join(home, 'Documents', 'tax-return.pdf'), 'PRIVATE');
    writeFileSync(join(home, 'notes.txt'), 'PRIVATE');
    const link = join(mk('tangu-k10a-snap-parent-'), 'sess');
    symlinkSync(home, link);
    const changed = await snapshotDirToWorkspace('u', 'tangu', { sessionId: 'S' }, link, new Map());
    expect(changed).toEqual([]);
    expect([...uploaded.keys()]).toEqual([]);
  });

  it('工作区里的文件链 / 目录链不传(P0 起 walkLocal 就跳软链,这里钉住);普通产物照传', async () => {
    const uploaded = cloudSink();
    writeFileSync(join(home, 'secret.txt'), 'PRIVATE');
    writeFileSync(join(dest, 'result.csv'), 'a,b');
    symlinkSync(join(home, 'secret.txt'), join(dest, 'leak.txt'));
    symlinkSync(home, join(dest, 'h'));
    const changed = await snapshotDirToWorkspace('u', 'tangu', { sessionId: 'S' }, dest, new Map());
    expect(changed).toEqual(['result.csv']);
    expect([...uploaded.values()]).toEqual(['a,b']);
  });
});

describe.skipIf(!POSIX)('重 hydrate 清理「云端已删」:不删会话目录外的文件', () => {
  it('中间目录被换成指到外面的软链,外面恰好有同内容的同名文件 → 不删它', async () => {
    const tree: Record<string, any[]> = {
      ROOT: [{ id: 'ws', name: 'workspace', fileType: 'directory' }],
      ws: [{ id: 'sess', name: 'CLEAN', fileType: 'directory' }],
      sess: [{ id: 'd-a', name: 'a', fileType: 'directory' }],
      'd-a': [{ id: 'f-x', name: 'x.txt', fileType: 'file' }],
    };
    storage.listDirectory.mockImplementation(async (id: string) => tree[id] ?? []);
    storage.getFileContent.mockImplementation(async () => ({ content: Buffer.from('SAME'), mimeType: 'text/plain' }));
    const key = { userId: 'u', appId: 'tangu', sessionId: 'CLEAN', wsProject: null };
    const dir = await getSessionDir(key);
    expect(readFileSync(join(dir, 'a', 'x.txt'), 'utf8')).toBe('SAME');
    // 会话里的代码把 a 换成指到外面的软链;外面有一份同内容的 x.txt
    writeFileSync(join(home, 'x.txt'), 'SAME');
    renameSync(join(dir, 'a'), join(dir, 'a.bak'));
    symlinkSync(home, join(dir, 'a'));
    tree['d-a'] = []; // 云端删了 x.txt(权威完整快照)
    refreshSessionWorkspace(key);
    await getSessionDir(key);
    expect(existsSync(join(home, 'x.txt'))).toBe(true);
  });
});
