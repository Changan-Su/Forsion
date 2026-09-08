import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictCopyName, decide, runAgentFilesSync } from './agentFileSync.js';
import type { AgentFileContent, AgentFileMeta, AgentFilesBrain } from '../seams/cloudBrain.js';
import { agentSyncPermission, agentSyncScope, setAgentSyncPermission } from './cloudSyncAccount.js';

const slug = 'cloud-only';
const config = 'name = "Cloud Only"\ncloud_sync = true\nlibrary_order = ["reference.md"]\n';
const contents: Record<string, AgentFileContent> = {
  'config.toml': { content: config, isBinary: false, mtimeMs: 1000, deleted: false },
  'SOUL.md': { content: '云端人格', isBinary: false, mtimeMs: 1001, deleted: false },
  'Library/reference.md': { content: '# 云端资料\n已同步', isBinary: false, mtimeMs: 1002, deleted: false },
};
const metas: AgentFileMeta[] = Object.entries(contents).map(([relPath, f]) => ({
  relPath,
  mtimeMs: f.mtimeMs,
  size: Buffer.byteLength(f.content || ''),
  isBinary: f.isBinary,
  deleted: f.deleted,
}));

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-agent-file-sync-'));
  process.env.TANGU_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('runAgentFilesSync cloud-only bootstrap', () => {
  it('discovers cloud_sync agent from manifest and pulls its Library', async () => {
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: metas }],
      getFile: async (_userId, gotSlug, relPath) => gotSlug === slug ? contents[relPath] || null : null,
      putFile: async (_userId, _slug, _relPath, body) => ({ mtimeMs: body.mtimeMs }),
      deleteFile: async () => {},
    };

    const result = await runAgentFilesSync(cloud, 'user-1', { onlySlug: slug });

    expect(result.ok).toBe(true);
    expect(result.agents).toBe(1);
    expect(result.pulled).toBe(3);
    expect(readFileSync(path.join(home, 'agents', slug, 'config.toml'), 'utf8')).toBe(config);
    expect(readFileSync(path.join(home, 'agents', slug, 'Library', 'reference.md'), 'utf8')).toContain('已同步');
  });

  it('does not upload the previous account’s agent after switching accounts', async () => {
    mkdirSync(path.join(home, 'agents', slug), { recursive: true });
    writeFileSync(path.join(home, 'agents', slug, 'config.toml'), config);
    writeFileSync(path.join(home, 'agents', slug, 'SOUL.md'), '云端人格');
    const putFile = vi.fn(async (_uid, _slug, _path, body) => ({ mtimeMs: body.mtimeMs }));
    const cloud: AgentFilesBrain = {
      getManifest: async () => [],
      getFile: async () => null,
      putFile,
      deleteFile: async () => {},
    };
    await runAgentFilesSync(cloud, 'user-2', { onlySlug: slug });
    expect(putFile).not.toHaveBeenCalled();
    expect(readFileSync(path.join(home, 'agents', slug, 'SOUL.md'), 'utf8')).toBe('云端人格');
  });

  it('does not claim a local agent created while cloud discovery is awaiting its config', async () => {
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: AgentFileContent) => void;
    const configResponse = new Promise<AgentFileContent>((resolve) => { finish = resolve; });
    const putFile = vi.fn(async (_uid, _slug, _path, body) => ({ mtimeMs: body.mtimeMs }));
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: metas }],
      getFile: async (_uid, _slug, relPath) => {
        if (relPath === 'config.toml') { started(); return configResponse; }
        return contents[relPath] || null;
      },
      putFile, deleteFile: async () => {},
    };
    const pending = runAgentFilesSync(cloud, 'account-b', { onlySlug: slug });
    await requested;
    const dir = path.join(home, 'agents', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.toml'), 'name = "Private local agent"\n');
    writeFileSync(path.join(dir, 'SOUL.md'), 'Local data without upload consent');
    finish(contents['config.toml']);
    const result = await pending;
    expect(result.agents).toBe(0);
    expect(putFile).not.toHaveBeenCalled();
    expect(agentSyncPermission(slug, agentSyncScope(cloud, 'account-b')).enabled).toBe(false);
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('Local data without upload consent');
  });

  it('keeps another account’s deletion baseline out of a newly authorized account', async () => {
    const ownDir = path.join(home, 'agents', slug);
    mkdirSync(ownDir, { recursive: true });
    writeFileSync(path.join(ownDir, 'config.toml'), config);
    writeFileSync(path.join(ownDir, 'SOUL.md'), 'private content');
    const putFile = vi.fn(async (_uid, _slug, _path, body) => ({ mtimeMs: body.mtimeMs, seq: 1, hash: 'unused' }));
    const cloud: AgentFilesBrain = { getManifest: async () => [], getFile: async () => null, putFile, deleteFile: async () => {} };
    const scopeA = agentSyncScope(cloud, 'account-a')!;
    const scopeB = agentSyncScope(cloud, 'account-b')!;
    // Old account's shadow says the local file has already synced. Against an empty cloud this
    // shadow would propagate a remote deletion to the local file.
    const { createHash } = await import('node:crypto');
    const baseline = { files: { 'SOUL.md': { seq: 1, hash: createHash('sha256').update('private content').digest('hex') } } };
    writeFileSync(path.join(ownDir, `.cloudsync-${scopeA}.json`), JSON.stringify(baseline));
    setAgentSyncPermission(slug, scopeB, true);
    await runAgentFilesSync(cloud, 'account-b', { onlySlug: slug });
    expect(readFileSync(path.join(ownDir, 'SOUL.md'), 'utf8')).toBe('private content');
    expect(putFile.mock.calls.some((call) => call[2] === 'SOUL.md')).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ownDir, `.cloudsync-${scopeA}.json`), 'utf8'))).toEqual(baseline);
  });
});

// decide 是 desktop reconcile.ts 的移植(全表单测在那边);这里守住移植后的关键语义不漂移。
describe('decide(hash 三方对账移植)', () => {
  const sh = (seq: number, hash: string) => ({ seq, hash });
  const rm = (seq: number, hash: string | null) => ({ seq, hash });

  it('编辑胜删除(两方向)', () => {
    expect(decide('b', sh(3, 'a'), null)).toEqual({ kind: 'pushCreate' }); // 云端删了但本地改过 → 复活
    expect(decide(null, sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'pull' }); // 本地删了但云端改过 → 拉回
  });
  it('删除生效(两方向)', () => {
    expect(decide('a', sh(3, 'a'), null)).toEqual({ kind: 'deleteLocal' });
    expect(decide(null, sh(3, 'a'), rm(3, 'a'))).toEqual({ kind: 'pushDelete' });
  });
  it('单侧改动 → 定向传播(CAS 票据)', () => {
    expect(decide('b', sh(3, 'a'), rm(3, 'a'))).toEqual({ kind: 'push', baseSeq: 3 });
    expect(decide('a', sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'pull' });
  });
  it('双方都动:内容一致 adopt,不同 conflict(副本,绝不静默覆盖)', () => {
    expect(decide('b', sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'adopt' });
    expect(decide('c', sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'conflict' });
  });
  it('无基线首配:hash 未知(旧二进制行)永不视作相等', () => {
    expect(decide('a', null, rm(4, null))).toEqual({ kind: 'conflict' });
  });
});

describe('conflictCopyName', () => {
  const now = new Date(2026, 6, 19, 15, 32);
  it('带子目录与扩展名', () => {
    expect(conflictCopyName('Library/notes.md', now)).toBe('Library/notes (conflict 2026-07-19 1532).md');
  });
  it('根级 toml', () => {
    expect(conflictCopyName('config.toml', now)).toBe('config (conflict 2026-07-19 1532).toml');
  });
});
