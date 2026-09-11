/**
 * 每-agent 云文件镜像引擎(agentFileSync)。用 TANGU_HOME 临时目录 + 内存 fake AgentFilesBrain
 * (seq/hash/CAS 与当前服务端一致)验证 push/pull/LWW/墓碑/LOG 合并/共用记忆去重/5MB 跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentFilesSync } from '../src/services/agentFileSync.js';
import { agentSyncScope, setAgentSyncPermission } from '../src/services/cloudSyncAccount.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { agentsDir } from '../src/core/tanguHome.js';
import { createHash } from 'node:crypto';
import { AgentFileConflictError, type AgentFilesBrain } from '../src/seams/cloudBrain.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tangu-afs-')); process.env.TANGU_HOME = home; });
afterEach(() => { delete process.env.TANGU_HOME; try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

/** 内存 fake：行为镜像当前 server tanguAgentFilesService 的 CAS 和旧调用 mtime 守卫。 */
function fakeCloud(enabledSlugs: string[] = []) {
  const rows = new Map<string, any>();
  const puts = new Map<string, number>(); // 计数 putFile(键=slug/relPath),验证「去重一次」
  const key = (s: string, p: string) => `${s}\0${p}`;
  const brain: AgentFilesBrain & { _rows: typeof rows; _puts: typeof puts } = {
    _rows: rows, _puts: puts,
    async getManifest() {
      const bySlug = new Map<string, any[]>();
      for (const [k, r] of rows) {
        const [slug, relPath] = k.split('\0');
        const arr = bySlug.get(slug) ?? [];
        arr.push({ relPath, mtimeMs: r.mtimeMs, size: r.size ?? 0, isBinary: !!r.isBinary, deleted: !!r.deleted, seq: r.seq, hash: r.hash });
        bySlug.set(slug, arr);
      }
      return [...bySlug.entries()].map(([slug, files]) => ({ slug, files }));
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
      const k = key(slug, relPath);
      puts.set(`${slug}/${relPath}`, (puts.get(`${slug}/${relPath}`) ?? 0) + 1);
      const ex = rows.get(k);
      const seq = ex && !ex.deleted ? ex.seq : 0;
      if (body.baseSeq !== undefined && body.baseSeq !== seq) throw new AgentFileConflictError({ code: 'CONFLICT', seq, hash: ex?.hash ?? null, mtimeMs: ex?.mtimeMs ?? 0, deleted: !!ex?.deleted });
      if (body.baseSeq !== undefined || !ex || ex.mtimeMs < body.mtimeMs) {
        const hash = createHash('sha256').update(body.isBinary ? Buffer.from(body.contentBase64 ?? '', 'base64') : body.content ?? '').digest('hex');
        const next = { ...body, seq: (ex?.seq ?? 0) + 1, hash, deleted: false };
        rows.set(k, next);
        return { mtimeMs: next.mtimeMs, seq: next.seq, hash };
      }
      return { mtimeMs: ex.mtimeMs, seq: ex.seq, hash: ex.hash };
    },
    async deleteFile(_u, slug, relPath, mtimeMs, _device, baseSeq) {
      const k = key(slug, relPath);
      const ex = rows.get(k);
      if (baseSeq !== undefined && ex && !ex.deleted && baseSeq !== ex.seq) throw new AgentFileConflictError({ code: 'CONFLICT', seq: ex.seq, hash: ex.hash, mtimeMs: ex.mtimeMs, deleted: false });
      if (baseSeq !== undefined || !ex || ex.mtimeMs < mtimeMs) rows.set(k, { isBinary: false, size: 0, mtimeMs, deleted: true, seq: (ex?.seq ?? 0) + 1, hash: null });
    },
  };
  // Mirror the account-specific consent recorded by the agent settings route.
  // A legacy config.toml cloud_sync bit alone does not enroll an existing local folder.
  for (const slug of enabledSlugs) setAgentSyncPermission(slug, agentSyncScope(brain, 'u')!, true, true);
  return brain;
}

const tDir = (slug: string) => join(agentsDir(), slug);
const future = () => Date.now() + 5_000_000;

describe('agentFileSync — push / pull', () => {
  it('pushes a cloudSync agent definition + memory to cloud', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'be helpful', cloudSync: true });
    writeFileSync(join(tDir('tester'), 'MEMORY.md'), 'mem line');
    const cloud = fakeCloud(['tester']);
    const r = await runAgentFilesSync(cloud, 'u');
    expect(r.agents).toBe(1);
    expect((await cloud.getFile('u', 'tester', 'MEMORY.md'))!.content).toBe('mem line');
    expect((await cloud.getFile('u', 'tester', 'config.toml'))!.content).toContain('Tester');
    expect((await cloud.getFile('u', 'tester', 'SOUL.md'))).not.toBeNull();
  });

  it('pulls a cloud-only Library file down to local', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    const cloud = fakeCloud(['tester']);
    await cloud.putFile('u', 'tester', 'Library/notes.md', { content: 'cloud notes', isBinary: false, size: 11, mtimeMs: future() });
    await runAgentFilesSync(cloud, 'u');
    expect(readFileSync(join(tDir('tester'), 'Library', 'notes.md'), 'utf8')).toBe('cloud notes');
  });

  it('does not sync agents with cloudSync off', async () => {
    await saveAgent({ slug: 'local-only', name: 'Local', systemPrompt: 'x' }); // no cloudSync
    const cloud = fakeCloud();
    const r = await runAgentFilesSync(cloud, 'u');
    expect(r.agents).toBe(0);
    expect(cloud._rows.size).toBe(0);
  });

  it('does not adopt legacy cloudSync without this account’s explicit registration', async () => {
    await saveAgent({ slug: 'unregistered', name: 'Unregistered', systemPrompt: 'private local content', cloudSync: true });
    writeFileSync(join(tDir('unregistered'), 'SOUL.md'), 'private local content');
    const cloud = fakeCloud();
    const r = await runAgentFilesSync(cloud, 'u');
    expect(r.agents).toBe(0);
    expect(cloud._rows.size).toBe(0);
    expect(readFileSync(join(tDir('unregistered'), 'SOUL.md'), 'utf8')).toContain('private local content');
  });
});

describe('agentFileSync — LWW', () => {
  it('cloud newer wins (pull overwrites local)', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    writeFileSync(join(tDir('tester'), 'MEMORY.md'), 'old local');
    const cloud = fakeCloud(['tester']);
    await runAgentFilesSync(cloud, 'u'); // push old local
    await cloud.putFile('u', 'tester', 'MEMORY.md', { content: 'cloud wins', isBinary: false, size: 10, mtimeMs: future() });
    await runAgentFilesSync(cloud, 'u'); // pull
    expect(readFileSync(join(tDir('tester'), 'MEMORY.md'), 'utf8')).toBe('cloud wins');
  });
});

describe('agentFileSync — tombstones', () => {
  it('local delete propagates a tombstone to cloud', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    mkdirSync(join(tDir('tester'), 'Library'), { recursive: true });
    writeFileSync(join(tDir('tester'), 'Library/note.md'), 'mem');
    const cloud = fakeCloud(['tester']);
    await runAgentFilesSync(cloud, 'u'); // push → prev-state records it
    rmSync(join(tDir('tester'), 'Library/note.md'));
    const r = await runAgentFilesSync(cloud, 'u'); // local gone + prev exists → tombstone
    expect((await cloud.getFile('u', 'tester', 'Library/note.md'))!.deleted).toBe(true);
    expect(r.deleted).toBeGreaterThan(0);
  });

  it('cloud tombstone (newer) removes the local file', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    mkdirSync(join(tDir('tester'), 'Library'), { recursive: true });
    const mem = join(tDir('tester'), 'Library/note.md');
    writeFileSync(mem, 'mem');
    utimesSync(mem, new Date(1000), new Date(1000)); // 本地很旧
    const cloud = fakeCloud(['tester']);
    await runAgentFilesSync(cloud, 'u'); // establish a shared baseline before the cloud deletion
    await cloud.deleteFile('u', 'tester', 'Library/note.md', future()); // 云端墓碑更新
    await runAgentFilesSync(cloud, 'u');
    expect(existsSync(mem)).toBe(false);
  });
});

describe('agentFileSync — LOG block-merge (additive, not LWW)', () => {
  it('unions same-day entries from both sides', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    mkdirSync(join(tDir('tester'), 'LOG'), { recursive: true });
    writeFileSync(join(tDir('tester'), 'LOG', '2026-06-25.md'), '# 2026-06-25\n\n### 09:00\n@devLocal local-entry\n');
    const cloud = fakeCloud(['tester']);
    await cloud.putFile('u', 'tester', 'LOG/2026-06-25.md', { content: '# 2026-06-25\n\n### 08:00\n@devCloud cloud-entry\n', isBinary: false, size: 50, mtimeMs: Date.now() });
    await runAgentFilesSync(cloud, 'u');
    const localLog = readFileSync(join(tDir('tester'), 'LOG', '2026-06-25.md'), 'utf8');
    expect(localLog).toContain('@devLocal local-entry');
    expect(localLog).toContain('@devCloud cloud-entry');
    expect((await cloud.getFile('u', 'tester', 'LOG/2026-06-25.md'))!.content).toContain('@devLocal local-entry');
  });
});

describe('agentFileSync — shareDefaultMemory dedup', () => {
  it('two agents sharing xyra memory push the xyra MEMORY bucket once', async () => {
    await saveAgent({ slug: 'a1', name: 'A1', systemPrompt: 'x', cloudSync: true, shareDefaultMemory: true });
    await saveAgent({ slug: 'a2', name: 'A2', systemPrompt: 'x', cloudSync: true, shareDefaultMemory: true });
    mkdirSync(tDir('xyra'), { recursive: true });
    writeFileSync(join(tDir('xyra'), 'MEMORY.md'), 'shared mem'); // xyra 记忆桶(a1/a2 共用)
    const cloud = fakeCloud(['a1', 'a2']);
    await runAgentFilesSync(cloud, 'u');
    expect((await cloud.getFile('u', 'xyra', 'MEMORY.md'))!.content).toBe('shared mem');
    expect(cloud._puts.get('xyra/MEMORY.md')).toBe(1); // 只推一次(去重)
    // a1/a2 自己的 config 各推一次(DEF 桶),但它们 MEMORY 不落自己 slug
    expect(await cloud.getFile('u', 'a1', 'MEMORY.md')).toBeNull();
  });
});

describe('agentFileSync — size cap', () => {
  it('skips a Library file over 5MB', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    mkdirSync(join(tDir('tester'), 'Library'), { recursive: true });
    writeFileSync(join(tDir('tester'), 'Library', 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1));
    const cloud = fakeCloud(['tester']);
    const r = await runAgentFilesSync(cloud, 'u');
    expect(r.skipped).toBeGreaterThan(0);
    expect(await cloud.getFile('u', 'tester', 'Library/big.bin')).toBeNull();
  });
});
