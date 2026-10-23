import { beforeEach, describe, it, expect, vi } from 'vitest';
import { memoryFactFingerprint } from '../services/memoryRepository.js';

// 网页 / 手机的 Agent 详情读写的是桌面同步上来的那几份文件(以前这几条接口在云端一律 404,面板只剩「记忆暂不可用」)。
type Row = { content?: string; deleted?: boolean; mtimeMs?: number; seq: number };
let rows: Record<string, Row> = {};
const seed = (): Record<string, Row> => ({
  'scout/config.toml': { content: 'name = "Scout"\nshare_default_memory = true\n', seq: 1 },
  'solo/config.toml': { content: 'name = "Solo"\n', seq: 1 },
  'xyra/MEMORY.md': { content: 'Likes tea\n\nWorks in London\n', mtimeMs: 5, seq: 3 },
  'xyra/LOG/2026-10-21.md': { content: '- 10:00 met', seq: 1 },
  'xyra/LOG/2026-10-20.md': { content: 'gone', deleted: true, seq: 2 },
  'scout/HARNESS.md': { content: '', seq: 1 },
});
const hash = (r: Row) => `h${r.seq}`;
// 与服务端 tanguAgentFiles.putFile 同一个 CAS 口径:baseSeq 0 = 只建;>0 = 期望当前 seq;不符 → 409(进程内 seam 抛 status + body)
const agentFiles = {
  getFile: vi.fn(async (_u: string, slug: string, rel: string) => {
    const r = rows[`${slug}/${rel}`];
    return r ? { content: r.content, isBinary: false, mtimeMs: r.mtimeMs ?? 1, deleted: !!r.deleted, seq: r.seq, hash: hash(r) } : null;
  }),
  getManifest: vi.fn(async () => {
    const by: Record<string, any[]> = {};
    for (const [k, r] of Object.entries(rows)) { const [slug, ...rest] = k.split('/'); (by[slug] ??= []).push({ relPath: rest.join('/'), deleted: !!r.deleted, mtimeMs: 1, size: 1, isBinary: false }); }
    return Object.entries(by).map(([slug, files]) => ({ slug, files }));
  }),
  putFile: vi.fn(async (_u: string, slug: string, rel: string, body: { content: string; baseSeq?: number }) => {
    const key = `${slug}/${rel}`, cur = rows[key], live = cur && !cur.deleted ? cur.seq : 0;
    if (body.baseSeq !== undefined && body.baseSeq !== live) throw Object.assign(new Error('conflict'), { status: 409, body: { seq: live } });
    rows[key] = { content: body.content, seq: (cur?.seq ?? 0) + 1, mtimeMs: 9 };
    return { mtimeMs: 9, seq: rows[key].seq };
  }),
  deleteFile: vi.fn(),
};
const getMemory = vi.fn(async () => ({ content: 'Old global fact\n', updatedAt: '2026-01-01T00:00:00Z' }));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { capabilities: { hostExec: false } }, brain: { agentFiles, memory: { getMemory } } }) }));

const { cloudReadMemory, cloudWriteMemory, cloudMutateMemory, cloudLogDates, cloudReadLog, cloudReadHarness } = await import('./cloudAgentStore.js');
beforeEach(() => { rows = seed(); vi.clearAllMocks(); });

describe('cloud agent file reads', () => {
  it('reads the shared memory bucket an agent actually uses, with a CAS version', async () => {
    const m = await cloudReadMemory('u', 'scout');
    expect(m).toMatchObject({ cloud: true, content: 'Likes tea\n\nWorks in London\n', updatedAt: 5, version: '3:h3' });
    expect(m!.entries.map((e) => e.content)).toEqual(['Likes tea', 'Works in London']);
    expect((await cloudReadMemory('u', 'scout'))!.entries.map((e) => e.id)).toEqual(m!.entries.map((e) => e.id)); // 同一版本 id 稳定
  });
  it('lists live log days only and reads one, read-only', async () => {
    expect(await cloudLogDates('u', 'scout')).toEqual(['2026-10-21']);
    expect(await cloudReadLog('u', 'scout', '2026-10-21')).toMatchObject({ content: '- 10:00 met', readonly: true });
    expect((await cloudReadLog('u', 'scout', '../SOUL'))!.content).toBe('');
  });
  it('null for an unknown agent; a read failure is not shown as empty', async () => {
    expect(await cloudReadMemory('u', 'Bad Slug')).toBeNull();
    agentFiles.getFile.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('EIO')); // config.toml 缺 → 内置 xyra;再读 HARNESS.md 失败
    await expect(cloudReadHarness('u', 'xyra')).rejects.toThrow('EIO');
    agentFiles.getFile.mockRejectedValueOnce(new Error('EIO')); // 配置读失败不许落回内置预设、读错记忆桶
    await expect(cloudReadMemory('u', 'scout')).rejects.toThrow('EIO');
  });
});

describe('cloud agent memory writes', () => {
  it('a stale version is rejected instead of overwriting what desktop just pushed', async () => {
    const m = (await cloudReadMemory('u', 'scout'))!;
    rows['xyra/MEMORY.md'] = { content: 'Pushed from desktop\n', seq: 4 };
    await expect(cloudWriteMemory('u', 'scout', 'mine', m.version)).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    expect(rows['xyra/MEMORY.md'].content).toBe('Pushed from desktop\n');
    // 版本对上了、却在读和写之间被抢先:服务端 CAS 409 也映射成同一个冲突
    agentFiles.putFile.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, body: { seq: 5 } }));
    await expect(cloudWriteMemory('u', 'scout', 'mine', '4:h4')).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
  });
  it('add, update and forget one entry; forgetting leaves a tombstone desktop understands', async () => {
    let m = (await cloudMutateMemory('u', 'scout', { action: 'add', fact: 'Has a cat', expectedVersion: '3:h3' }))!;
    expect(m.content).toBe('Likes tea\n\nWorks in London\nHas a cat\n');
    const london = m.entries.find((e) => e.content === 'Works in London')!;
    m = (await cloudMutateMemory('u', 'scout', { action: 'update', id: london.id, fact: 'Works in Paris', expectedVersion: m.version }))!;
    expect(m.content).toBe('Likes tea\n\nWorks in Paris\nHas a cat\n');
    const tea = m.entries.find((e) => e.content === 'Likes tea')!;
    m = (await cloudMutateMemory('u', 'scout', { action: 'forget', id: tea.id, expectedVersion: m.version }))!;
    expect(m.content).toBe('\nWorks in Paris\nHas a cat\n');
    const t = JSON.parse(rows['xyra/.memory-tombstones.json'].content!);
    expect(t.schemaVersion).toBe(1);
    // 忘掉的那条、被改掉的旧说法都记了墓碑(桌面第一次见面取并集时不会带回来)
    expect(t.tombstones.map((x: any) => x.content).sort()).toEqual(['Likes tea', 'Works in London']);
    expect(t.tombstones.find((x: any) => x.content === 'Likes tea')).toMatchObject({ fingerprint: memoryFactFingerprint('Likes tea'), evidenceIds: [] });
  });
  it('adding a forgotten fact again restores it, so desktop does not filter it out', async () => {
    let m = (await cloudReadMemory('u', 'scout'))!;
    m = (await cloudMutateMemory('u', 'scout', { action: 'forget', id: m.entries[0].id, expectedVersion: m.version }))!;
    await cloudMutateMemory('u', 'scout', { action: 'add', fact: 'Likes tea', expectedVersion: m.version });
    const [t] = JSON.parse(rows['xyra/.memory-tombstones.json'].content!).tombstones;
    expect(t.restoredAt).toBeGreaterThan(t.forgottenAt);
  });
  it('a forget whose memory write loses the race leaves no tombstone behind', async () => {
    const m = (await cloudReadMemory('u', 'scout'))!;
    agentFiles.putFile.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, body: { seq: 4 } }));
    await expect(cloudMutateMemory('u', 'scout', { action: 'forget', id: m.entries[0].id, expectedVersion: m.version })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    expect(rows['xyra/.memory-tombstones.json']).toBeUndefined();
  });
  it('an entry id from another version is refused', async () => {
    const m = (await cloudReadMemory('u', 'scout'))!;
    await expect(cloudMutateMemory('u', 'scout', { action: 'forget', id: '0:nothash', expectedVersion: m.version })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
  });
  it('default agent with nothing synced yet shows the global memory; the first edit creates the synced copy', async () => {
    delete rows['xyra/MEMORY.md'];
    const m = (await cloudReadMemory('u', 'xyra'))!;
    expect(m).toMatchObject({ content: 'Old global fact\n' });
    expect(m.version.startsWith('0:')).toBe(true);
    // 编辑器开着时云端运行改了全局那份:旧草稿保存 = 409,不丢掉中间的改动
    getMemory.mockResolvedValueOnce({ content: 'Old global fact\nWritten by a cloud run\n', updatedAt: '2026-01-02T00:00:00Z' });
    await expect(cloudWriteMemory('u', 'xyra', 'stale draft', m.version)).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    expect(rows['xyra/MEMORY.md']).toBeUndefined();
    const w = (await cloudWriteMemory('u', 'xyra', 'Old global fact\nNew fact\n', m.version))!;
    expect(rows['xyra/MEMORY.md']).toMatchObject({ content: 'Old global fact\nNew fact\n', seq: 1 });
    expect(w.version).toBe('1:h1');
    // 非默认 agent 没有这份文件 = 空,不去读全局
    expect((await cloudReadMemory('u', 'solo'))!.content).toBe('');
  });
});
