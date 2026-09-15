/**
 * HttpStateStore 的会话召回两法(thin worker → 网关 /api/agent-state/sessions/*):
 * 路径 / 方法 / 请求体(不带 signal、transcript 不重复带 sessionId)/ 当前 run 的 token / fleet 头;
 * 裸 404 = 网关没这条路由 → 抛明确错误,绝不当「无结果」(否则模型会把「搜不到」当成「没聊过」)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpStateStore, enterRequestToken } from './httpStateStore.js';

const calls: Array<{ url: string; init: any }> = [];
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(status === 404 ? 'Cannot POST' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

describe('HttpStateStore session recall', () => {
  it('posts the search to the gateway with the run token, without the abort signal in the body', async () => {
    stubFetch(200, [{ id: 's1', title: 't', summary: '', archived: 0, updated_at: '2026-09-13' }]);
    const store = createHttpStateStore({ cloudUrl: 'http://gw/', fleetSecret: 'fleet-key' });
    enterRequestToken('tok-1');
    const ac = new AbortController();
    const hits = await store.searchSessions({ userId: 'u1', appId: 'tangu', terms: ['插件'], limit: 3,
      toolScope: { agentSlug: 'alpha' }, matchAny: true, signal: ac.signal });
    expect(hits.map((h) => h.id)).toEqual(['s1']);
    expect(calls[0].url).toBe('http://gw/api/agent-state/sessions/search');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok-1');
    expect(calls[0].init.headers['X-Fleet-Auth']).toBe('fleet-key');
    expect(JSON.parse(calls[0].init.body)).toEqual({ userId: 'u1', appId: 'tangu', terms: ['插件'], limit: 3, toolScope: { agentSlug: 'alpha' }, matchAny: true });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads a transcript by session id; a missing gateway route is an error, not "no session"', async () => {
    stubFetch(200, { session: { id: 'a/b', title: 'x', summary: '' }, rows: [] });
    const store = createHttpStateStore({ cloudUrl: 'http://gw' });
    const input = { sessionId: 'a/b', userId: 'u1', appId: 'tangu', toolScope: { agentSlug: 'alpha' }, limit: 60, perMessageChars: 600, charOffset: 0 };
    const transcript = await store.readSessionTranscript(input);
    expect(transcript.session?.id).toBe('a/b');
    expect(calls[0].url).toBe('http://gw/api/agent-state/sessions/a%2Fb/transcript');
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('sessionId');

    stubFetch(404, null);
    await expect(store.readSessionTranscript(input)).rejects.toThrow(/agent-state route missing/);
    await expect(store.searchSessions({ userId: 'u1', appId: 'tangu', terms: [], limit: 5 })).rejects.toThrow(/agent-state route missing/);
  });
  it('caller cancellation aborts the in-flight gateway request; 5xx surfaces with its status instead of "no results"', async () => {
    // fetch 挂住直到 signal 触发:证明 AbortSignal.any 组合真的把调用方的取消接到了请求上。
    vi.stubGlobal('fetch', vi.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const store = createHttpStateStore({ cloudUrl: 'http://gw' });
    const ac = new AbortController();
    const pending = store.searchSessions({ userId: 'u1', appId: 'tangu', terms: ['x'], limit: 5, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    stubFetch(500, null);
    await expect(store.searchSessions({ userId: 'u1', appId: 'tangu', terms: [], limit: 5 })).rejects.toMatchObject({ status: 500 });
    stubFetch(501, null);
    await expect(store.readSessionTranscript({ sessionId: 's', userId: 'u1', appId: 'tangu', toolScope: { agentSlug: 'alpha' },
      limit: 60, perMessageChars: 600, charOffset: 0 })).rejects.toMatchObject({ status: 501 });
  });
});
