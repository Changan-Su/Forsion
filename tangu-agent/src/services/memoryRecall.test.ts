import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureTangu } from '../seams/runtime.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { createLocalMemoryBrain } from '../adapters/standalone/localMemoryBrain.js';
import { createMemoryRepository } from './memoryRepository.js';
import { buildAgentMemoryContext, memoryQueryTerms } from './memoryRecall.js';
import { searchSessions } from './sessionSearch.js';

vi.mock('./sessionSearch.js', async (original) => ({ ...await original<typeof import('./sessionSearch.js')>(), searchSessions: vi.fn(async () => []) }));
let temporaryHome: string;
beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'tangu-memory-recall-'));
  vi.stubEnv('TANGU_HOME', temporaryHome);
  vi.mocked(searchSessions).mockReset().mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(temporaryHome, { recursive: true, force: true }); });
const configure = (memory = createLocalMemoryBrain({ deviceId: 'test' })) => configureTangu({
  host: {}, brain: { memory }, billing: {}, profileStore: {}, profile: {},
} as any);
const recall = (agentSlug: string, query = '插件 AlphaProject') => runWithAgentSlug(agentSlug, () => buildAgentMemoryContext({
  userId: 'u1', appId: 'tangu', agentSlug, query, excludeSessionId: 'current',
}));

describe('Agent memory recall', () => {
  it('segments natural Chinese/English without an extra model request; irrelevant meta words are omitted', () => {
    expect(memoryQueryTerms('请帮我回忆之前 AlphaProject 的插件发布')).toEqual(expect.arrayContaining(['alphaproject', '插件']));
    expect(memoryQueryTerms('please tell me what we did')).not.toContain('please');
    expect(memoryQueryTerms('')).toEqual([]);
    expect(memoryQueryTerms('x'.repeat(100_000)).join('').length).toBeLessThanOrEqual(400);
  });
  it('keeps same-named facts isolated under concurrent Agent scopes, and exposes exact source ids', async () => {
    configure();
    for (const [slug, secret] of [['alpha', 'ALPHA_ONLY'], ['beta', 'BETA_ONLY']]) {
      createMemoryRepository(join(temporaryHome, 'agents', slug)).mutate({ action: 'add', fact: `插件 AlphaProject ${secret}`,
        source: { kind: 'explicit', sessionId: `${slug}-session`, messageId: `${slug}-message` } });
    }
    const [alpha, beta] = await Promise.all([recall('alpha'), recall('beta')]);
    expect(alpha.content).toContain('ALPHA_ONLY'); expect(alpha.content).not.toContain('BETA_ONLY');
    expect(beta.content).toContain('BETA_ONLY'); expect(beta.content).not.toContain('ALPHA_ONLY');
    expect(alpha.content).toContain('messageId=alpha-message');
    expect(alpha.entryIds.length).toBe(1); expect(alpha.entryIds).not.toEqual(beta.entryIds);
    expect(vi.mocked(searchSessions)).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', appId: 'tangu', toolScope: { agentSlug: 'alpha' }, excludeSessionId: 'current',
      candidateLimit: 16, messagesPerSession: 16, messageChars: 2000,
    }));
  });
  it('reads only active entries; forget/purge cannot be resurrected by a cached snapshot or revision', async () => {
    configure();
    const repository = createMemoryRepository(join(temporaryHome, 'agents', 'alpha'));
    const first = repository.mutate({ action: 'add', fact: '插件待删除 SECRET_FACT' });
    expect((await recall('alpha')).content).toContain('SECRET_FACT');
    repository.mutate({ action: 'forget', id: first.entries[0].id, expectedVersion: first.version });
    vi.mocked(searchSessions).mockResolvedValue([{ id: 'old', title: '', summary: '', updated_at: '', archived: false,
      hit: { messageId: 'original', role: 'user', timestamp: 1000, snippet: '以前说过 插件待删除 SECRET_FACT' } }]);
    const second = await recall('alpha');
    expect(second.content).not.toContain('SECRET_FACT'); expect(second.entryIds).toEqual([]);
    expect(second.historyMessageIds).toEqual([]);
    expect(repository.snapshot().tombstones.length).toBe(1);
    repository.mutate({ action: 'add', fact: '插件待删除 SECRET_FACT', source: { kind: 'explicit' } });
    expect((await recall('alpha')).content).toContain('SECRET_FACT');
  });
  it('keeps resident and relevant entry evidence under a hard character cap and adds original history ids', async () => {
    configure();
    const repository = createMemoryRepository(join(temporaryHome, 'agents', 'alpha'));
    repository.mutate({ action: 'add', fact: '普通偏好 '.repeat(300) });
    const added = repository.mutate({ action: 'add', fact: 'AlphaProject 插件用 ESM 发布', source: { kind: 'historian', runId: 'r1' } });
    const wanted = added.entries.at(-1)!.id;
    vi.mocked(searchSessions).mockResolvedValue([{ id: 's1', title: 'topic', summary: '', updated_at: '', archived: false,
      hit: { messageId: 'm1', role: 'user', timestamp: 1000, snippet: 'AlphaProject 原文证据' } }]);
    const context = await recall('alpha');
    expect(context.content.length).toBeLessThanOrEqual(4000);
    expect(context.content).toContain('AlphaProject 插件用 ESM 发布'); expect(context.entryIds).toContain(wanted);
    expect(context.historyMessageIds).toEqual(['m1']); expect(context.content).toContain('session_id=s1; message_id=m1;');
    expect(context.truncated).toBe(true);
  });
  it('empty query injects only the small resident memory budget and performs no history lookup', async () => {
    configure();
    createMemoryRepository(join(temporaryHome, 'agents', 'alpha')).mutate({ action: 'add', fact: '事实 '.repeat(2000) });
    const context = await recall('alpha', '');
    expect(context.content.length).toBeLessThanOrEqual(1000);
    expect(searchSessions).not.toHaveBeenCalled();
  });
  it('bounded legacy fallback is explicit, while a mismatched active Agent fails closed', async () => {
    const getMemory = vi.fn(async (userId: string) => ({ content: `Facts for ${userId}\n` + 'x'.repeat(100_000), updatedAt: 0 }));
    configure({ getMemory } as any);
    const context = await recall('alpha', '');
    expect(context.content).toContain('legacy-line-1'); expect(context.content.length).toBeLessThanOrEqual(1000);
    expect(getMemory).toHaveBeenCalledWith('u1', { signal: undefined });
    await expect(runWithAgentSlug('beta', () => buildAgentMemoryContext({ userId: 'u1', appId: 'tangu', agentSlug: 'alpha', query: '' })))
      .rejects.toThrow('scope');
    getMemory.mockClear();
    await buildAgentMemoryContext({ userId: 'u1', appId: 'tangu', agentSlug: 'alpha', query: '' });
    expect(getMemory).not.toHaveBeenCalled();
  });
  it('forwards cancellation into an in-flight legacy HTTP memory read and never starts history afterwards', async () => {
    const controller = new AbortController();
    const getMemory = vi.fn((_userId: string, opts: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason), { once: true });
    }));
    configure({ getMemory } as any);
    const pending = runWithAgentSlug('alpha', () => buildAgentMemoryContext({ userId: 'u1', appId: 'tangu', agentSlug: 'alpha', query: '插件', signal: controller.signal }));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(getMemory).toHaveBeenCalledWith('u1', { signal: controller.signal });
    expect(searchSessions).not.toHaveBeenCalled();
    // A legacy adapter may ignore AbortSignal: its late reply must still be discarded.
    const lateAbort = new AbortController();
    let resolveLate!: (value: any) => void;
    getMemory.mockImplementation(() => new Promise((resolve) => { resolveLate = resolve; }));
    const late = runWithAgentSlug('alpha', () => buildAgentMemoryContext({ userId: 'u1', appId: 'tangu', agentSlug: 'alpha', query: '插件', signal: lateAbort.signal }));
    const lateRejected = expect(late).rejects.toMatchObject({ name: 'AbortError' });
    lateAbort.abort(); resolveLate({ content: 'LATE_FACT', updatedAt: 0 });
    await lateRejected;
    expect(searchSessions).not.toHaveBeenCalled();
  });
  it('cancelled recall starts no memory or history read', async () => {
    const getMemory = vi.fn(); configure({ getMemory } as any);
    await expect(buildAgentMemoryContext({ userId: 'u1', appId: 'tangu', agentSlug: 'xyra', query: '插件', signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(getMemory).not.toHaveBeenCalled(); expect(searchSessions).not.toHaveBeenCalled();
  });
});
