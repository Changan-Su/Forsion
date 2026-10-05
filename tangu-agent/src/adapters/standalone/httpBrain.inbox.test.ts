import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpBrain } from './httpBrain.js';

afterEach(() => vi.unstubAllGlobals());

describe('cloud Inbox capability advertisement', () => {
  it('omits broadcast polling without a cloud URL or credential', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(createHttpBrain({ cloudUrl: '', token: '' }).inbox).toBeUndefined();
    expect(createHttpBrain({ cloudUrl: '  ', token: 'local-owner' }).inbox).toBeUndefined();
    expect(createHttpBrain({ cloudUrl: 'https://server.example', token: '' }).inbox).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves authenticated cloud broadcasts for configured static or per-user credentials', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ broadcasts: [{ id: 'fixture-broadcast' }] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    for (const token of ['static-cloud-token', () => 'scoped-cloud-token']) {
      const brain = createHttpBrain({ cloudUrl: 'https://server.example/', token });
      expect(await brain.inbox!.listBroadcasts('2026-09-09 12:00:00')).toEqual([{ id: 'fixture-broadcast' }]);
    }
    expect(fetch.mock.calls).toHaveLength(2);
    expect((fetch.mock.calls[0] as any)[0]).toBe('https://server.example/api/brain/inbox/broadcasts?since=2026-09-09%2012%3A00%3A00');
    expect((fetch.mock.calls[1] as any)[1].headers.Authorization).toBe('Bearer scoped-cloud-token');
  });
});

describe('agent file manifest path negotiation', () => {
  it('declares the optional paths it understands and passes the server answer through', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    const fetch = vi.fn(async () => json({ agents: [{ slug: 'fixture', files: [] }], paths: ['human'] }));
    vi.stubGlobal('fetch', fetch);
    const files = createHttpBrain({ cloudUrl: 'https://server.example', token: 'static-cloud-token' }).agentFiles!;
    const manifest = await files.getManifest('fixture-user');
    // 不声明 → 服务端不列 HUMAN.md(老客户端见到不认识的路径会判整次同步失败);声明了才列
    expect((fetch.mock.calls[0] as any)[0]).toBe('https://server.example/api/brain/agents/manifest?paths=human');
    expect([...manifest]).toEqual([{ slug: 'fixture', files: [] }]);
    expect(manifest.paths).toEqual(['human']);
    fetch.mockResolvedValueOnce(json({ agents: [] })); // 老服务端:不回带 → 引擎本次不同步 HUMAN.md
    expect((await files.getManifest('fixture-user')).paths).toBeUndefined();
  });
});
