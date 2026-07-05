import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMultiBrain, dashScopeApiBase, isDashScopeBase } from '../src/adapters/standalone/multiBrain.js';
import { createProviderRegistry } from '../src/llm/providerRegistry.js';

const registry = createProviderRegistry([
  { providerId: 'sf', baseUrl: 'https://api.sf.test/v1', apiKey: 'k1', ttsModelIds: ['CosyVoice2'] },
  { providerId: 'oa', baseUrl: 'https://api.oa.test/v1', apiKey: 'k2' },
  { providerId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'k3', ttsModelIds: ['qwen3-tts-flash'] },
]);

afterEach(() => vi.unstubAllGlobals());

function stubFetchOk(): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  vi.stubGlobal('fetch', f);
  return f;
}

describe('multiBrain tts dispatch', () => {
  it('hits provider by ttsModelIds whitelist and posts /audio/speech', async () => {
    const f = stubFetchOk();
    const brain = createMultiBrain({} as any, registry);
    const out = await brain.tts!.synthesize({ model: 'CosyVoice2', text: '你好', voice: 'alex', speed: 1.2 });
    expect(out.mime).toBe('audio/mpeg');
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.sf.test/v1/audio/speech');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'CosyVoice2', input: '你好', voice: 'alex', speed: 1.2, response_format: 'mp3' });
    expect(init.headers.Authorization).toBe('Bearer k1');
  });

  it('hits provider by <providerId>/<model> prefix', async () => {
    const f = stubFetchOk();
    const brain = createMultiBrain({} as any, registry);
    await brain.tts!.synthesize({ model: 'oa/tts-1', text: 'hi' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.oa.test/v1/audio/speech');
    expect(JSON.parse(init.body).model).toBe('tts-1'); // 前缀已剥
  });

  it('throws (no cloud delegation) when no provider matches', async () => {
    stubFetchOk();
    const brain = createMultiBrain({} as any, registry);
    await expect(brain.tts!.synthesize({ model: 'nope', text: 'hi' })).rejects.toThrow(/nope/);
  });

  it('routes aliyuncs baseUrl to dashscope native protocol (generation → url download)', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { audio: { url: 'https://oss.test/a.wav' } } }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    vi.stubGlobal('fetch', f);
    const brain = createMultiBrain({} as any, registry);
    const out = await brain.tts!.synthesize({ model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry' });
    expect(out.mime).toBe('audio/wav');
    const [url1, init1] = f.mock.calls[0];
    expect(url1).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    expect(JSON.parse(init1.body)).toMatchObject({ model: 'qwen3-tts-flash', input: { text: '你好', voice: 'Cherry' } });
    expect(f.mock.calls[1][0]).toBe('https://oss.test/a.wav');
  });
});

describe('dashscope base url helpers', () => {
  it('detects and normalizes bases', () => {
    expect(isDashScopeBase('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(true);
    expect(isDashScopeBase('https://api.openai.com/v1')).toBe(false);
    expect(dashScopeApiBase('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('https://dashscope.aliyuncs.com/api/v1');
    expect(dashScopeApiBase('https://dashscope.aliyuncs.com/api/v1')).toBe('https://dashscope.aliyuncs.com/api/v1');
    expect(dashScopeApiBase('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com/api/v1');
    expect(dashScopeApiBase('https://ws123.cn-beijing.maas.aliyuncs.com/')).toBe('https://ws123.cn-beijing.maas.aliyuncs.com/api/v1');
  });
});
