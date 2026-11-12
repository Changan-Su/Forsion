import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ state: null as any, query: vi.fn(() => { throw new Error('thin worker has no SQL'); }) }));
vi.mock('../../core/db.js', () => ({ query: fake.query }));
vi.mock('../../seams/runtime.js', () => ({ deps: () => ({ state: fake.state,
  brain: { llm: { resolveModelAndKey: async () => ({ model: {}, apiKey: 'test', baseUrl: 'test', apiModelId: 'test' }),
    buildProviderPayload: async (x: any) => x, streamProviderCompletion: async () => ({ content: '## Goal\nKeep the exact project marker CLOUD-STATE-42 and continue the conversation.' }) } },
  billing: { calculateCost: async () => 0 },
}) }));
vi.mock('../eventBus.js', () => ({ publish: async () => 0 }));
import { compactSession, getLatestSummary, messageTimestamp, persistCheckpoint } from '../compaction.js';
import { createHttpStateStore, runWithRequestToken } from './httpStateStore.js';

afterEach(() => { vi.unstubAllGlobals(); fake.query.mockClear(); });
it('thin worker compacts over HTTP, then a fresh store hydrates the persisted checkpoint without SQL', async () => {
  let checkpoint: any = null;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    requests.push(url);
    let body: any;
    if (url.endsWith('/compaction/messages')) body = [{ id: 'u', role: 'user', content: 'Remember CLOUD-STATE-42', timestamp: 100 }, { id: 'a', role: 'model', content: 'Remembered.', timestamp: 200 }];
    else if (url.endsWith('/compaction') && init.method === 'GET') body = { checkpoint, history: { through: 200, digest: 'a'.repeat(32) } };
    else if (url.endsWith('/compaction')) {
      const b = JSON.parse(init.body);
      expect(b.history.digest).toBe('a'.repeat(32));
      checkpoint = { id: 'cp', summary: b.summary, throughTimestamp: b.through.ts, throughMessageId: b.through.messageId };
      body = { saved: true };
    } else if (url.endsWith('/timestamp')) body = { timestamp: 200 };
    else if (url.endsWith('/steps-for-messages')) body = [];
    else throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  fake.state = createHttpStateStore({ cloudUrl: 'http://gateway', fleetSecret: 'fleet' });
  await runWithRequestToken('dispatch', async () => {
    expect(await compactSession('s', 'm', 'tangu')).toMatchObject({ ok: true, throughTimestamp: 200 });
    fake.state = createHttpStateStore({ cloudUrl: 'http://gateway', fleetSecret: 'fleet' });
    expect(await getLatestSummary('s')).toMatchObject({ summary: expect.stringContaining('CLOUD-STATE-42'), throughMessageId: 'a' });
    expect(await messageTimestamp('a')).toBe(200);
    expect(await persistCheckpoint('s', 'updated summary', { ts: 200, messageId: 'a' })).toBe(true);
  });
  expect(fake.query).not.toHaveBeenCalled();
  expect(requests.some(p => p.endsWith('/compaction/messages'))).toBe(true);
});

it('missing gateway support cannot be reported as a successful checkpoint write', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
  fake.state = createHttpStateStore({ cloudUrl: 'http://old-gateway' });
  expect(await getLatestSummary('s')).toBeNull();
  expect(await persistCheckpoint('s', 'summary', { ts: 200, messageId: 'a' })).toBe(false);
  expect(fake.query).not.toHaveBeenCalled();
});
