import { describe, it, expect, vi } from 'vitest';

// 网页 / 手机的 Agent 详情读的是桌面同步上来的那几份文件(以前这几条接口在云端一律 404,面板只剩「记忆暂不可用」)。
const rows: Record<string, { content?: string; deleted?: boolean; mtimeMs?: number }> = {
  'scout/config.toml': { content: 'name = "Scout"\nshare_default_memory = true\n' },
  'xyra/MEMORY.md': { content: 'Likes tea\n\nWorks in London\n', mtimeMs: 5 },
  'xyra/LOG/2026-10-21.md': { content: '- 10:00 met' },
  'xyra/LOG/2026-10-20.md': { content: 'gone', deleted: true },
  'scout/HARNESS.md': { content: '' },
};
const agentFiles = {
  getFile: vi.fn(async (_u: string, slug: string, rel: string) => {
    const r = rows[`${slug}/${rel}`];
    return r ? { content: r.content, isBinary: false, mtimeMs: r.mtimeMs ?? 1, deleted: !!r.deleted } : null;
  }),
  getManifest: vi.fn(async () => {
    const by: Record<string, any[]> = {};
    for (const [k, r] of Object.entries(rows)) { const [slug, ...rest] = k.split('/'); (by[slug] ??= []).push({ relPath: rest.join('/'), deleted: !!r.deleted, mtimeMs: 1, size: 1, isBinary: false }); }
    return Object.entries(by).map(([slug, files]) => ({ slug, files }));
  }),
  putFile: vi.fn(), deleteFile: vi.fn(),
};
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { capabilities: { hostExec: false } }, brain: { agentFiles } }) }));

const { cloudReadMemory, cloudLogDates, cloudReadLog, cloudReadHarness } = await import('./cloudAgentStore.js');

describe('cloud agent file reads', () => {
  it('reads the shared memory bucket an agent actually uses, read-only', async () => {
    const m = await cloudReadMemory('u', 'scout');
    expect(m).toMatchObject({ readonly: true, content: 'Likes tea\n\nWorks in London\n', updatedAt: 5 });
    expect(m!.entries.map((e) => e.content)).toEqual(['Likes tea', 'Works in London']);
    expect(agentFiles.putFile).not.toHaveBeenCalled();
  });
  it('lists live log days only and reads one', async () => {
    expect(await cloudLogDates('u', 'scout')).toEqual(['2026-10-21']);
    expect(await cloudReadLog('u', 'scout', '2026-10-21')).toMatchObject({ content: '- 10:00 met', readonly: true });
    expect((await cloudReadLog('u', 'scout', '../SOUL'))!.content).toBe('');
  });
  it('null for an unknown agent; a read failure is not shown as empty', async () => {
    expect(await cloudReadMemory('u', 'Bad Slug')).toBeNull();
    agentFiles.getFile.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('EIO')) // config.toml 缺 → 内置 xyra;再读 HARNESS.md 失败
    await expect(cloudReadHarness('u', 'xyra')).rejects.toThrow('EIO');
    agentFiles.getFile.mockRejectedValueOnce(new Error('EIO')) // 配置读失败不许落回内置预设、读错记忆桶
    await expect(cloudReadMemory('u', 'scout')).rejects.toThrow('EIO');
  });
});
