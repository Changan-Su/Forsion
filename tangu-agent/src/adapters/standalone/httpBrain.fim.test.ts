/**
 * FIM(行内补全)上云的契约:httpBrain.llm.fimCompletion → POST /api/brain/llm/fim-stream。
 *   - 请求体:modelId / prefix / suffix / maxTokens / stop / client,用量归属 usageSource 作 projectSource。
 *   - 帧与 /llm/stream 同一套读法(token 逐段回调,done 定稿,error 帧抛)。
 *   - 老服务端没有这条路由(404)、模型做不了补全(400 detail=fim_unsupported)→ 抛 code 'fim_unsupported';
 *     别的 400(缺字段)照常 LlmError,不许被误认成「不支持」。
 *   - multiBrain:直连 / 订阅模型没有 FIM → fim_unsupported;云端模型透传给 httpBrain。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/adapters/standalone/httpBrain.fim.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpBrain } from './httpBrain.js';
import { createMultiBrain } from './multiBrain.js';
import { createProviderRegistry } from '../../llm/providerRegistry.js';

const frame = (o: object): string => `data: ${JSON.stringify(o)}\n\n`;

function stubFetch(reply: () => Response): Array<{ url: string; body: any }> {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return Promise.resolve(reply());
  });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('httpBrain.fimCompletion', () => {
  it('打 /api/brain/llm/fim-stream,token 帧逐段回调,done 帧定稿', async () => {
    const body = frame({ t: 'alive' }) + ': ping\n\n' + frame({ t: 'token', d: '  return' }) + frame({ t: 'token', d: ' a + b;' })
      + frame({ t: 'done', content: '  return a + b;', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' });
    const calls = stubFetch(() => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const brain = createHttpBrain({ cloudUrl: 'http://fim-a.test/', token: 'tok' });
    const deltas: string[] = [];
    const r = await brain.llm.fimCompletion!({ modelId: 'ds', prefix: 'function add(a, b) {\n', suffix: '\n}', maxTokens: 32, stop: ['\n\n'], client: 'desktop/9.9.9', usageSource: 'tangu', onToken: (d) => deltas.push(d) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://fim-a.test/api/brain/llm/fim-stream');
    expect(calls[0].body).toEqual({ modelId: 'ds', prefix: 'function add(a, b) {\n', suffix: '\n}', maxTokens: 32, stop: ['\n\n'], client: 'desktop/9.9.9', projectSource: 'tangu' });
    expect(deltas).toEqual(['  return', ' a + b;']);
    expect(r.content).toBe('  return a + b;');
    expect(r.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 4 });
    expect(r.finishReason).toBe('stop');
  });

  it('老服务端 404 / 400 fim_unsupported → code fim_unsupported;别的 400 照常报错', async () => {
    const brain = createHttpBrain({ cloudUrl: 'http://fim-b.test', token: 'tok' });
    stubFetch(() => new Response('Cannot POST', { status: 404, headers: { 'Content-Type': 'text/html' } }));
    await expect(brain.llm.fimCompletion!({ modelId: 'x', prefix: 'a' })).rejects.toMatchObject({ code: 'fim_unsupported', message: 'fim_unsupported' });
    stubFetch(() => new Response(JSON.stringify({ detail: 'fim_unsupported' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    await expect(brain.llm.fimCompletion!({ modelId: 'chat', prefix: 'a' })).rejects.toMatchObject({ code: 'fim_unsupported' });
    stubFetch(() => new Response(JSON.stringify({ detail: 'modelId and prefix (or suffix) required' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const err: any = await brain.llm.fimCompletion!({ modelId: 'x', prefix: '' }).catch((e) => e);
    expect(err?.code).not.toBe('fim_unsupported');
    expect(err?.status).toBe(400);
  });

  it('流里的 error 帧(额度用尽)原样抛出', async () => {
    stubFetch(() => new Response(frame({ t: 'error', status: 402, message: 'token_quota_exceeded' }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const brain = createHttpBrain({ cloudUrl: 'http://fim-c.test', token: 'tok' });
    await expect(brain.llm.fimCompletion!({ modelId: 'x', prefix: 'a' })).rejects.toMatchObject({ status: 402, message: 'token_quota_exceeded' });
  });

  it('目录透传 fimModels', async () => {
    stubFetch(() => new Response(JSON.stringify({ models: [], fimModels: [{ id: 'ds', name: 'DeepSeek FIM', provider: 'deepseek', apiModelId: 'deepseek-chat' }, { name: 'no id' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const brain = createHttpBrain({ cloudUrl: 'http://fim-d.test', token: 'tok' });
    const r = await brain.models.listModelsForProject!('tangu');
    expect(r.fimModels).toEqual([{ id: 'ds', name: 'DeepSeek FIM', provider: 'deepseek', apiModelId: 'deepseek-chat' }]);
  });
});

describe('multiBrain.fimCompletion', () => {
  it('直连模型 → fim_unsupported(不碰云端);云端模型透传', async () => {
    const fim = vi.fn(async () => ({ content: 'x', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const http: any = { llm: { fimCompletion: fim }, assets: {}, models: {} };
    const registry = createProviderRegistry([{ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-user' }]);
    const brain = createMultiBrain(http, registry);
    await expect(brain.llm.fimCompletion!({ modelId: 'deepseek/deepseek-chat', prefix: 'a' })).rejects.toMatchObject({ code: 'fim_unsupported' });
    expect(fim).not.toHaveBeenCalled();
    expect((await brain.llm.fimCompletion!({ modelId: 'cloud-ds', prefix: 'a' })).content).toBe('x');
    expect(fim).toHaveBeenCalledTimes(1);
    // 云端 brain 太老、没有这个方法:同样是不支持
    const old = createMultiBrain({ llm: {}, assets: {}, models: {} } as any, registry);
    await expect(old.llm.fimCompletion!({ modelId: 'cloud-ds', prefix: 'a' })).rejects.toMatchObject({ code: 'fim_unsupported' });
  });
});
