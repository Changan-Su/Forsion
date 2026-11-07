import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictCopyName, decide, runAgentFilesSync } from './agentFileSync.js';
import type { AgentFileContent, AgentFileMeta, AgentFilesBrain } from '../seams/cloudBrain.js';
import { agentSyncScope, setAgentSyncDefault, setAgentSyncPermission } from './cloudSyncAccount.js';

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

describe('runAgentFilesSync on an archived account (old accounts B, 11-06)', () => {
  // 云端那份进了存档、在线那份清空:旧同步看到「影子里有、清单里没有」会当成别处删了,把本机没改过的文件删掉。
  // 清单带 agentArchive 时一个 Agent 都不碰;负对照:同一份空清单不带标记,本机文件确实会被删(证明这里看得见那条路)。
  // 带 seq / hash 的清单(现在的服务端):影子记下版本,「清单里没有」才会被当成别处删了
  const modern: AgentFileMeta[] = metas.map((m) => ({ ...m, seq: 1, hash: createHash('sha256').update(contents[m.relPath]!.content || '').digest('hex') }));
  const pulled = async (): Promise<{ cloud: AgentFilesBrain; dir: string }> => {
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: modern }],
      getFile: async (_userId, gotSlug, relPath) => { const m = modern.find((x) => x.relPath === relPath); return gotSlug === slug && m ? { ...contents[relPath]!, seq: m.seq, hash: m.hash } : null; },
      putFile: async (_userId, _slug, _relPath, body) => ({ mtimeMs: body.mtimeMs }),
      deleteFile: async () => {},
    };
    const dir = path.join(home, 'agents', slug);
    mkdirSync(dir, { recursive: true });
    setAgentSyncPermission(slug, agentSyncScope(cloud, 'user-1')!, true);
    expect((await runAgentFilesSync(cloud, 'user-1', { onlySlug: slug })).pulled).toBe(3);
    return { cloud, dir };
  };
  const emptied = (archived: boolean): AgentFilesBrain & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      getManifest: async () => Object.assign([], archived ? { agentArchive: { state: 'done', at: 1 } } : {}),
      getFile: async () => null,
      putFile: async (_u, s, p, body) => { calls.push(`put ${s}/${p}`); return { mtimeMs: body.mtimeMs }; },
      deleteFile: async (_u, s, p) => { calls.push(`delete ${s}/${p}`); },
    };
  };

  it('leaves every local agent file alone and sends nothing', async () => {
    const { dir } = await pulled();
    const cloud = emptied(true);
    const result = await runAgentFilesSync(cloud, 'user-1');
    expect(result.ok).toBe(true);
    expect(cloud.calls).toEqual([]);
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('云端人格');
    expect(readFileSync(path.join(dir, 'Library', 'reference.md'), 'utf8')).toContain('已同步');
  });

  it('negative control: the same empty manifest without the archive mark deletes the unmodified local copy', async () => {
    const { dir } = await pulled();
    expect(existsSync(path.join(dir, 'SOUL.md'))).toBe(true);
    await runAgentFilesSync(emptied(false), 'user-1');
    expect(existsSync(path.join(dir, 'SOUL.md'))).toBe(false);
  });
});

describe('runAgentFilesSync cloud-only bootstrap', () => {
  // 11-05 Agent 逐个选:云端有、本机没有的 Agent 不再自动建出来(原来 cloud_sync = true / 账号总闸开着就建,一台设备的选择替所有设备做了)
  it('does not create a cloud_sync agent this device never picked', async () => {
    const getFile = vi.fn(async (_userId: string, gotSlug: string, relPath: string) => gotSlug === slug ? contents[relPath] || null : null);
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: metas }],
      getFile,
      putFile: async (_userId, _slug, _relPath, body) => ({ mtimeMs: body.mtimeMs }),
      deleteFile: async () => {},
    };
    const result = await runAgentFilesSync(cloud, 'user-1', { onlySlug: slug });
    expect(result.ok).toBe(true);
    expect(result.agents).toBe(0);
    expect(getFile).not.toHaveBeenCalled();
    expect(existsSync(path.join(home, 'agents', slug))).toBe(false);
  });

  it('does not create a cloud agent even while the account switch is on', async () => {
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: metas }],
      getFile: async (_userId, gotSlug, relPath) => gotSlug === slug ? contents[relPath] || null : null,
      putFile: async (_userId, _slug, _relPath, body) => ({ mtimeMs: body.mtimeMs }),
      deleteFile: async () => {},
    };
    setAgentSyncDefault(agentSyncScope(cloud, 'user-1')!, true);
    expect((await runAgentFilesSync(cloud, 'user-1', { onlySlug: slug })).agents).toBe(0);
    expect(existsSync(path.join(home, 'agents', slug))).toBe(false);
  });

  it('pulls a cloud agent whose folder and permission this device already has', async () => {
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: metas }],
      getFile: async (_userId, gotSlug, relPath) => gotSlug === slug ? contents[relPath] || null : null,
      putFile: async (_userId, _slug, _relPath, body) => ({ mtimeMs: body.mtimeMs }),
      deleteFile: async () => {},
    };
    mkdirSync(path.join(home, 'agents', slug), { recursive: true });
    setAgentSyncPermission(slug, agentSyncScope(cloud, 'user-1')!, true);
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
