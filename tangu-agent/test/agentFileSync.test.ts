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
  const gets: string[] = []; // 每次 getFile 的 slug/relPath,验证「没变的日志不取」
  const key = (s: string, p: string) => `${s}\0${p}`;
  const brain: AgentFilesBrain & { _rows: typeof rows; _puts: typeof puts; _gets: typeof gets; _paths?: string[] } = {
    _rows: rows, _puts: puts, _gets: gets, // _paths:服务端回带的可选路径族;不设 = 老服务端
    async getManifest() {
      const bySlug = new Map<string, any[]>();
      for (const [k, r] of rows) {
        const [slug, relPath] = k.split('\0');
        const arr = bySlug.get(slug) ?? [];
        arr.push({ relPath, mtimeMs: r.mtimeMs, size: r.size ?? 0, isBinary: !!r.isBinary, deleted: !!r.deleted, seq: r.seq, hash: r.hash });
        bySlug.set(slug, arr);
      }
      return Object.assign([...bySlug.entries()].map(([slug, files]) => ({ slug, files })), brain._paths ? { paths: brain._paths } : {});
    },
    async getFile(_u, slug, relPath) {
      gets.push(`${slug}/${relPath}`);
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

  const logFile = (date: string) => join(tDir('tester'), 'LOG', `${date}.md`);
  const putsTotal = (cloud: ReturnType<typeof fakeCloud>) => [...cloud._puts.values()].reduce((a, b) => a + b, 0);
  const seedLog = async (date: string, text: string) => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    mkdirSync(join(tDir('tester'), 'LOG'), { recursive: true });
    writeFileSync(logFile(date), text);
  };

  it('keeps cloud-only text written above the first entry instead of overwriting it with the local copy', async () => {
    // 10-05 复现的丢数据:两边的块一样,云端在首个 ### 之前多一段手写文字 → 旧逻辑把本地那份整份推上去,云端和本地都不再有那段。
    const block = '### 10:00\n@dev entry\n';
    await seedLog('2026-10-05', `# 2026-10-05\n\n${block}`);
    const cloud = fakeCloud(['tester']);
    const cloudText = `# 2026-10-05\n\nCLOUD-ONLY NOTE\n\n${block}`;
    await cloud.putFile('u', 'tester', 'LOG/2026-10-05.md', { content: cloudText, isBinary: false, size: cloudText.length, mtimeMs: Date.now() });
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true);
    expect(cloud._rows.get('tester\0LOG/2026-10-05.md').content).toBe(cloudText); // 云端原样,没被推
    expect(readFileSync(logFile('2026-10-05'), 'utf8')).toBe(cloudText); // 本地原样采用云端那份
    expect(cloud._puts.get('tester/LOG/2026-10-05.md')).toBe(1); // 只有上面那次播种
  });

  it('unions header lines when both sides wrote some, and pulls a log that has no entries at all', async () => {
    await seedLog('2026-10-05', '# 2026-10-05\n\nlocal note\n\n### 10:00\n@dev entry\n');
    const cloud = fakeCloud(['tester']);
    const put = (date: string, content: string) => cloud.putFile('u', 'tester', `LOG/${date}.md`, { content, isBinary: false, size: content.length, mtimeMs: Date.now() });
    await put('2026-10-05', '# 2026-10-05\n\ncloud note\n\n### 10:00\n@dev entry\n');
    await put('2026-10-04', '# 2026-10-04\n\nhand-written day, no entries\n');
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true);
    const local = readFileSync(logFile('2026-10-05'), 'utf8');
    for (const text of [local, cloud._rows.get('tester\0LOG/2026-10-05.md').content]) {
      expect(text).toContain('local note'); expect(text).toContain('cloud note'); expect(text.match(/### 10:00/g)).toHaveLength(1);
    }
    expect(cloud._rows.get('tester\0LOG/2026-10-05.md').content).toBe(local);
    expect(readFileSync(logFile('2026-10-04'), 'utf8')).toBe('# 2026-10-04\n\nhand-written day, no entries\n'); // 旧逻辑:没有块就什么都不拉
  });

  it('does not fetch log files whose content already matches the manifest hash', async () => {
    await seedLog('2026-10-01', '# 2026-10-01\n\n### 09:00\n@dev a\n');
    for (const d of ['2026-10-02', '2026-10-03']) writeFileSync(logFile(d), `# ${d}\n\n### 09:00\n@dev b\n`);
    const cloud = fakeCloud(['tester']);
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true); // 首次:全量推上去
    const puts = putsTotal(cloud); cloud._gets.length = 0;
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true); // 稳态:什么都没变
    expect(cloud._gets).toEqual(['tester/.memory-tombstones.json']); // 旧逻辑:每个日志文件再各取一次
    expect(putsTotal(cloud)).toBe(puts);
    // 云端变了(哈希对不上)才取那一个文件
    const next = '# 2026-10-02\n\n### 09:00\n@dev b\n\n### 11:00\n@other c\n';
    await cloud.putFile('u', 'tester', 'LOG/2026-10-02.md', { content: next, isBinary: false, size: next.length, mtimeMs: Date.now() });
    cloud._gets.length = 0;
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true);
    expect(cloud._gets.filter((g) => g.includes('/LOG/'))).toEqual(['tester/LOG/2026-10-02.md']);
    expect(readFileSync(logFile('2026-10-02'), 'utf8')).toBe(next);
  });

  it('two devices with same-minute entries and their own header notes converge and then stop pushing', async () => {
    // 旧逻辑:同分钟的块各设备按「本地在前」排,页眉各用各的 → 两台设备轮流把自己的排法推上去,永远不停。
    const homeA = home, homeB = mkdtempSync(join(tmpdir(), 'tangu-afs-b-'));
    const on = (h: string) => { process.env.TANGU_HOME = h; };
    try {
      await seedLog('2026-10-05', '# 2026-10-05\n\nnote A\n\n### 10:00\n@devA from A\n');
      const cloud = fakeCloud(['tester']);
      on(homeB);
      await seedLog('2026-10-05', '# 2026-10-05\n\nnote B\n\n### 10:00\n@devB from B\n');
      setAgentSyncPermission('tester', agentSyncScope(cloud, 'u')!, true, true);
      for (const h of [homeA, homeB, homeA, homeB]) { on(h); expect((await runAgentFilesSync(cloud, 'u', { onlySlug: 'tester' })).ok).toBe(true); }
      const texts = [homeA, homeB].map((h) => { on(h); return readFileSync(logFile('2026-10-05'), 'utf8'); });
      expect(texts[0]).toBe(texts[1]);
      expect(texts[0]).toBe(cloud._rows.get('tester\0LOG/2026-10-05.md').content);
      for (const marker of ['note A', 'note B', 'from A', 'from B']) expect(texts[0]).toContain(marker);
      const puts = cloud._puts.get('tester/LOG/2026-10-05.md'); cloud._gets.length = 0;
      for (const h of [homeA, homeB, homeA, homeB]) { on(h); expect((await runAgentFilesSync(cloud, 'u', { onlySlug: 'tester' })).ok).toBe(true); }
      expect(cloud._puts.get('tester/LOG/2026-10-05.md')).toBe(puts);
      expect(cloud._gets.filter((g) => g.includes('/LOG/'))).toEqual([]);
    } finally { on(homeA); rmSync(homeB, { recursive: true, force: true }); }
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

describe('agentFileSync — HUMAN.md (agent 级协作手册)', () => {
  it('syncs with the owning agent, never with the shared memory bucket', async () => {
    await saveAgent({ slug: 'a1', name: 'A1', systemPrompt: 'x', cloudSync: true, shareDefaultMemory: true });
    writeFileSync(join(tDir('a1'), 'HUMAN.md'), '# Together\nShow options first.');
    const cloud = fakeCloud(['a1']); cloud._paths = ['human'];
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true);
    expect((await cloud.getFile('u', 'a1', 'HUMAN.md'))!.content).toBe('# Together\nShow options first.');
    expect(await cloud.getFile('u', 'xyra', 'HUMAN.md')).toBeNull(); // 记忆共用默认桶,手册仍归 a1 自己
    // 别的设备改了 → 拉下来
    const base = cloud._rows.get('a1\0HUMAN.md').seq;
    await cloud.putFile('u', 'a1', 'HUMAN.md', { content: '# Together\nEdited elsewhere.', isBinary: false, size: 28, mtimeMs: future(), baseSeq: base });
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true);
    expect(readFileSync(join(tDir('a1'), 'HUMAN.md'), 'utf8')).toBe('# Together\nEdited elsewhere.');
  });

  it('leaves it alone until the server says it accepts the path, then syncs it', async () => {
    await saveAgent({ slug: 'tester', name: 'Tester', systemPrompt: 'x', cloudSync: true });
    writeFileSync(join(tDir('tester'), 'HUMAN.md'), '# Together');
    const cloud = fakeCloud(['tester']); // 老服务端:清单不回带 paths,推 HUMAN.md 只会 400
    const r = await runAgentFilesSync(cloud, 'u');
    expect(r.ok).toBe(true);
    expect(cloud._puts.has('tester/HUMAN.md')).toBe(false);
    expect((await cloud.getFile('u', 'tester', 'config.toml'))).not.toBeNull(); // 其余文件照常
    expect(readFileSync(join(tDir('tester'), 'HUMAN.md'), 'utf8')).toBe('# Together');
    cloud._paths = ['human']; // 服务端升级后
    expect((await runAgentFilesSync(cloud, 'u')).ok).toBe(true);
    expect((await cloud.getFile('u', 'tester', 'HUMAN.md'))!.content).toBe('# Together');
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
