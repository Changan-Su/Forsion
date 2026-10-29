// 「添加连接」的拉模型 / 测试连接按协议换请求形态:Anthropic 原生用 x-api-key + 分页 + /v1/messages,其余 Bearer + /models + /chat/completions。
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

vi.mock('../core/http.js', () => ({ authMiddleware: (_req: any, _res: any, next: any) => next() }));
const { default: router } = await import('./providers.js');

let server: Server;
let base = '';
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Record<string, string>; body?: any; redirect?: string }> = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
afterEach(() => { calls.length = 0; globalThis.fetch = realFetch; });

/** 上游假响应:按 URL 回 JSON;本机路由的请求放行到真 fetch。 */
function stubUpstream(reply: (url: string) => { status?: number; json: any }) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith(base)) return realFetch(input, init);
    calls.push({ url, headers: { ...(init?.headers || {}) }, body: init?.body ? JSON.parse(init.body) : undefined, redirect: init?.redirect });
    const r = reply(url);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
}
const post = (path: string, body: any) => realFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

describe('provider probe routes', () => {
  it('Anthropic: x-api-key, no Bearer on the official host, follows pagination', async () => {
    stubUpstream((url) => url.includes('after_id=m2')
      ? { json: { data: [{ id: 'm3', display_name: 'M3' }], has_more: false, last_id: 'm3' } }
      : { json: { data: [{ id: 'm1' }, { id: 'm2' }], has_more: true, last_id: 'm2' } });
    const r = await post('/agent/providers/fetch-models', { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', protocol: 'anthropic-messages' });
    expect(r.models.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(calls[0].headers['x-api-key']).toBe('k');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].redirect).toBe('error'); // x-api-key 跨域重定向不会被剥,不能跟
  });

  it('Anthropic without a key still sends anthropic-version (local proxies inject credentials)', async () => {
    stubUpstream(() => ({ json: { data: [] } }));
    await post('/agent/providers/fetch-models', { baseUrl: 'http://127.0.0.1:9/v1', protocol: 'anthropic-messages' });
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('Anthropic test falls back to a 1-token /v1/messages call', async () => {
    stubUpstream((url) => (url.endsWith('/models') ? { status: 404, json: {} } : { json: { id: 'msg' } }));
    const r = await post('/agent/providers/test', { baseUrl: 'https://relay.example/v1', apiKey: 'k', protocol: 'anthropic-messages', modelId: 'claude-x' });
    expect(r.success).toBe(true);
    const msg = calls.find((c) => c.url === 'https://relay.example/v1/messages')!;
    expect(msg.body).toEqual({ model: 'claude-x', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 });
    expect(msg.headers.Authorization).toBe('Bearer k'); // 中转:x-api-key 与 Bearer 都带
  });

  it('OpenAI-compatible stays Bearer + /models', async () => {
    stubUpstream(() => ({ json: { data: [{ id: 'b' }, { id: 'a' }] } }));
    const r = await post('/agent/providers/fetch-models', { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' });
    expect(r.models.map((m: any) => m.id)).toEqual(['a', 'b']);
    expect(calls[0]).toMatchObject({ url: 'https://api.siliconflow.cn/v1/models', headers: { Authorization: 'Bearer k' } });
    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });
});
