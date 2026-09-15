/**
 * HttpStateStore.listStepsForMessages(thin worker → 网关 /api/agent-state/sessions/:id/steps-for-messages):
 * 路径 / 方法 / 请求体 / 会话 token / fleet 头,以及**失败一律退回空数组**的语义 ——
 * 404(老网关没这条路由)、网络错、5xx、畸形响应都只该让回放退回扁平形态,绝不能抛进 hydrate。
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

const ROWS = [
  { messageId: 'a1', stepNo: 1, llmResponse: { content: 'x' }, toolCalls: [{ id: 'c1' }] },
  { messageId: 'a1', stepNo: 2, llmResponse: { content: 'y' }, toolCalls: null },
];

describe('HttpStateStore.listStepsForMessages', () => {
  it('posts the message ids to the gateway with the session token and maps the rows back', async () => {
    stubFetch(200, ROWS);
    const store = createHttpStateStore({ cloudUrl: 'http://gw/', fleetSecret: 'fleet-key' });
    enterRequestToken('tok-1');
    const steps = await store.listStepsForMessages!('a/b', ['a1', 'a2']);
    expect(steps).toEqual(ROWS);
    expect(calls[0].url).toBe('http://gw/api/agent-state/sessions/a%2Fb/steps-for-messages');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok-1');
    expect(calls[0].init.headers['X-Fleet-Auth']).toBe('fleet-key');
    // 契约夹具:server 侧 stateApiSteps.test.ts 断言的就是这份 body
    expect(JSON.parse(calls[0].init.body)).toEqual({ messageIds: ['a1', 'a2'] });
  });

  it('an old gateway without the route (404) degrades to flat replay instead of throwing', async () => {
    stubFetch(404, null);
    const store = createHttpStateStore({ cloudUrl: 'http://gw' });
    await expect(store.listStepsForMessages!('s1', ['a1'])).resolves.toEqual([]);
    expect(calls.length).toBe(1);
  });

  it('a network error, a 5xx, or a malformed payload all degrade to flat replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const store = createHttpStateStore({ cloudUrl: 'http://gw' });
    await expect(store.listStepsForMessages!('s1', ['a1'])).resolves.toEqual([]);

    stubFetch(500, null);
    await expect(store.listStepsForMessages!('s1', ['a1'])).resolves.toEqual([]);

    stubFetch(200, { oops: true }); // 不是数组
    await expect(store.listStepsForMessages!('s1', ['a1'])).resolves.toEqual([]);
  });

  // 负对照:上面三条「空数组」不是因为方法永远返回空 —— 同一 store 在 200 + 正常数组下必须真的吐行。
  it('negative control: the empty results above are not a method that always returns nothing', async () => {
    stubFetch(200, ROWS);
    const store = createHttpStateStore({ cloudUrl: 'http://gw' });
    await expect(store.listStepsForMessages!('s1', ['a1'])).resolves.toHaveLength(2);
  });

  it('an empty id list never touches the network', async () => {
    stubFetch(200, ROWS);
    const store = createHttpStateStore({ cloudUrl: 'http://gw' });
    await expect(store.listStepsForMessages!('s1', [])).resolves.toEqual([]);
    expect(calls.length).toBe(0);
  });
});
