/** 三个直连客户端都把 Retry-After 响应头挂到 LlmError.retryAfterMs 上(重试链据此等待,llm/retry.ts)。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { streamOpenAiCompat } from './openaiCompat.js';
import { streamOpenAiResponses } from './openaiResponses.js';
import { streamAnthropicMessages } from './anthropicMessages.js';

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, headers: Record<string, string>, body = { error: { message: 'Rate limit reached for requests' } }) =>
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })));

describe('Retry-After 进报错', () => {
  it('openaiCompat:retry-after 秒数', async () => {
    reply(429, { 'retry-after': '7' });
    const err: any = await streamOpenAiCompat({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', payload: { model: 'gpt-x', messages: [] } } as any).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
  });
  it('openaiResponses:retry-after-ms 优先', async () => {
    reply(429, { 'retry-after-ms': '1500', 'retry-after': '9' });
    const err: any = await streamOpenAiResponses({ apiKey: 'k', baseUrl: 'https://example/codex', payload: { model: 'gpt-5-codex', messages: [] } } as any).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(1500);
  });
  it('anthropicMessages:529 过载 + HTTP-date', async () => {
    const at = new Date(Date.now() + 20_000).toUTCString();
    reply(529, { 'retry-after': at }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } as any);
    const err: any = await streamAnthropicMessages({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', payload: { model: 'claude-x', messages: [] } } as any).catch((e) => e);
    expect(err.status).toBe(529);
    expect(err.retryAfterMs).toBeGreaterThan(17_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(20_000);
  });
  it('没有这个头 → 不挂', async () => {
    reply(503, {});
    const err: any = await streamOpenAiCompat({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', payload: { model: 'gpt-x', messages: [] } } as any).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBeUndefined();
  });
});
