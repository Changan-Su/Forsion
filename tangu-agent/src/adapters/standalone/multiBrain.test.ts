import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pcmToWav, createMultiBrain } from './multiBrain.js';
import { createProviderRegistry } from '../../llm/providerRegistry.js';
import { freshOAuthCred } from '../../llm/providerOAuth.js';

vi.mock('../../llm/providerOAuth.js', () => ({ freshOAuthCred: vi.fn() }));

// CosyVoice 走 WS 取 pcm 后自封 WAV;微信只认头部合法的 WAV,这里守住头部字节正确。
describe('pcmToWav', () => {
  it('writes a correct 44-byte mono 16-bit header', () => {
    const pcm = new Uint8Array(1000).fill(7);
    const wav = Buffer.from(pcmToWav(pcm, 24000));
    expect(wav.length).toBe(44 + 1000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(4)).toBe(36 + 1000); // RIFF chunk size = 36 + data
    expect(wav.readUInt16LE(20)).toBe(1);         // PCM
    expect(wav.readUInt16LE(22)).toBe(1);         // mono
    expect(wav.readUInt32LE(24)).toBe(24000);     // sample rate
    expect(wav.readUInt32LE(28)).toBe(24000 * 2); // byte rate = rate * blockAlign
    expect(wav.readUInt16LE(32)).toBe(2);         // block align
    expect(wav.readUInt16LE(34)).toBe(16);        // bits/sample
    expect(wav.readUInt32LE(40)).toBe(1000);      // data size
    expect(wav[44]).toBe(7);                      // payload starts right after header
  });
});

describe('订阅登录的凭证在取用时与盘上同步', () => {
  const httpBrain: any = { llm: { resolveModelAndKey: vi.fn(async () => ({ model: { id: 'cloud' }, apiKey: 'cloud-key', baseUrl: 'c', apiModelId: 'cloud' })) }, assets: {} };
  const brain = () => {
    const registry = createProviderRegistry([
      { providerId: 'xai', baseUrl: 'https://cli-chat-proxy.grok.com/v1', apiKey: 'boot', oauth: true },
      { providerId: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 'tok-a', accountId: 'acct-a', protocol: 'openai-responses', oauth: true },
      { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-user' },
    ]);
    return { registry, brain: createMultiBrain(httpBrain, registry) };
  };
  const cred = (access_token: string, account_id?: string): any => ({ access_token, account_id });
  beforeEach(() => vi.clearAllMocks());

  it('resolve 拿续期后的 token,并换进注册表(图像 / 语音直接读 p.apiKey 的路径也跟上)', async () => {
    vi.mocked(freshOAuthCred).mockResolvedValue(cred('fresh'));
    const { registry, brain: b } = brain();
    expect((await b.llm.resolveModelAndKey('xai/grok-4.7')).apiKey).toBe('fresh');
    expect(freshOAuthCred).toHaveBeenCalledWith('xai', false);
    expect(registry.list().find((p) => p.providerId === 'xai')!.apiKey).toBe('fresh');
  });

  it('别的进程换号登录:token 与 account id 成对换,解析出的模型带新账号', async () => {
    vi.mocked(freshOAuthCred).mockResolvedValue(cred('tok-b', 'acct-b'));
    const { registry, brain: b } = brain();
    const r = await b.llm.resolveModelAndKey('codex/gpt-5.6-luna');
    expect(r.apiKey).toBe('tok-b');
    expect(JSON.stringify(r.model)).toContain('acct-b');
    expect(JSON.stringify(r.model)).not.toContain('acct-a');
    expect(registry.list().find((p) => p.providerId === 'codex')).toMatchObject({ apiKey: 'tok-b', accountId: 'acct-b' });
  });

  it('用户自己配了 key 的 provider 不碰(靠 oauth 标记区分,不看 id)', async () => {
    const { brain: b } = brain();
    expect((await b.llm.resolveModelAndKey('deepseek/deepseek-chat')).apiKey).toBe('sk-user');
    expect(freshOAuthCred).not.toHaveBeenCalled();
    expect(await b.llm.refreshModelKey!('deepseek/deepseek-chat')).toBeNull();
  });

  it('同步抛错 / 盘上已没有这条 → 退回注册表里现有的 token,不让 resolve 失败', async () => {
    vi.mocked(freshOAuthCred).mockRejectedValue(new Error('lock'));
    expect((await brain().brain.llm.resolveModelAndKey('xai/grok-4.7')).apiKey).toBe('boot');
    vi.mocked(freshOAuthCred).mockResolvedValue(undefined);
    expect((await brain().brain.llm.resolveModelAndKey('xai/grok-4.7')).apiKey).toBe('boot');
  });

  it('refreshModelKey 强制续期;云端托管模型没有这回事', async () => {
    vi.mocked(freshOAuthCred).mockResolvedValue(cred('forced'));
    const { brain: b } = brain();
    expect(await b.llm.refreshModelKey!('xai/grok-4.7')).toBe('forced');
    expect(freshOAuthCred).toHaveBeenCalledWith('xai', true);
    expect(await b.llm.refreshModelKey!('gpt-cloud')).toBeNull();
    expect((await b.llm.resolveModelAndKey('gpt-cloud')).apiKey).toBe('cloud-key');
  });
});

// 10-05:续期此前只接在对话那条路上(resolveModelAndKey)。生图 / 改图 / 朗读直接读注册表里的 key 发请求 ——
// 订阅登录的 token 过期后,要等一次对话调用续过,这三条才拿得到新的;期间一直 401。
describe('订阅登录的凭证:生图 / 改图 / 朗读也在调用前续期,凭证失效时强制续一次再试', () => {
  const httpBrain: any = { llm: {}, assets: {} };
  const make = () => {
    const registry = createProviderRegistry([
      { providerId: 'xai', baseUrl: 'https://sub.example/v1', apiKey: 'boot', oauth: true },
      { providerId: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'sk-user', imageModelIds: ['gpt-image-1'], ttsModelIds: ['tts-1'] },
    ]);
    return { registry, brain: createMultiBrain(httpBrain, registry) };
  };
  const cred = (access_token: string): any => ({ access_token });
  const png = { ok: true, json: async () => ({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) };
  const audio = { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const fail = (status: number, body: string) => ({ ok: false, status, text: async () => body });
  const bearer = (fetchMock: any, i: number): string => fetchMock.mock.calls[i][1].headers.Authorization;
  const stubFetch = (...responses: any[]) => { const f = vi.fn(); for (const r of responses) f.mockResolvedValueOnce(r); vi.stubGlobal('fetch', f); return f; };
  /** 调用前那次(不强制)给 first,强制那次给 forced。 */
  const renewals = (first: any, forced: any) => vi.mocked(freshOAuthCred).mockImplementation(async (_id: string, force?: boolean) => (force ? forced : first));
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('调用前续期:三条路都带着续过的 token 出门,并换进注册表', async () => {
    renewals(cred('fresh'), cred('fresh'));
    const { registry, brain: b } = make();
    const f = stubFetch(png, png, audio);
    await b.images!.generate({ model: 'xai/grok-image', prompt: 'a cat' });
    await b.images!.edit!({ model: 'xai/grok-image', prompt: 'a hat', images: [{ b64: 'iVBORw0KGgo=', mime: 'image/png' }] } as any);
    await b.tts!.synthesize({ model: 'xai/grok-tts', text: 'hi' });
    expect([0, 1, 2].map((i) => bearer(f, i))).toEqual(['Bearer fresh', 'Bearer fresh', 'Bearer fresh']);
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual(['https://sub.example/v1/images/generations', 'https://sub.example/v1/images/edits', 'https://sub.example/v1/audio/speech']);
    expect(freshOAuthCred).toHaveBeenCalledWith('xai', false);
    expect(freshOAuthCred).not.toHaveBeenCalledWith('xai', true);
    expect(registry.list().find((p) => p.providerId === 'xai')!.apiKey).toBe('fresh');
  });

  it.each([
    ['401', fail(401, 'unauthorized')],
    ['网关用 502 包着的「凭证失效」', fail(502, 'Invalid or expired credentials')],
  ])('上游说凭证失效(%s)→ 强制续一次,换到新 token 再试一次', async (_name, denied) => {
    renewals(cred('boot'), cred('renewed'));
    const { brain: b } = make();
    const f = stubFetch(denied, png);
    const out = await b.images!.generate({ model: 'xai/grok-image', prompt: 'a cat' });
    expect(out.images).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect([bearer(f, 0), bearer(f, 1)]).toEqual(['Bearer boot', 'Bearer renewed']);
    expect(freshOAuthCred).toHaveBeenCalledWith('xai', true);
  });

  it('改图、朗读同样:凭证失效 → 续 → 再试', async () => {
    renewals(cred('boot'), cred('renewed'));
    const { brain: b } = make();
    const f = stubFetch(fail(401, 'expired'), png, fail(401, 'expired'), audio);
    expect((await b.images!.edit!({ model: 'xai/grok-image', prompt: 'a hat', images: [{ b64: 'iVBORw0KGgo=', mime: 'image/png' }] } as any)).images).toHaveLength(1);
    vi.mocked(freshOAuthCred).mockImplementation(async (_id: string, force?: boolean) => cred(force ? 'renewed-2' : 'renewed'));
    expect((await b.tts!.synthesize({ model: 'xai/grok-tts', text: 'hi' })).audio).toHaveLength(3);
    expect([0, 1, 2, 3].map((i) => bearer(f, i))).toEqual(['Bearer boot', 'Bearer renewed', 'Bearer renewed', 'Bearer renewed-2']);
  });

  it('续不了 / 续完还是同一个 token → 不白试第二次,原样报上游的错', async () => {
    const { brain: b } = make();
    renewals(cred('boot'), undefined); // 强制续期拿不到(已登出 / 不是订阅登录了)
    let f = stubFetch(fail(401, 'expired'));
    await expect(b.images!.generate({ model: 'xai/grok-image', prompt: 'x' })).rejects.toThrow('image gen 401: expired');
    expect(f).toHaveBeenCalledTimes(1);
    renewals(cred('boot'), cred('boot')); // 续期没换出新 token
    f = stubFetch(fail(401, 'expired'));
    await expect(b.tts!.synthesize({ model: 'xai/grok-tts', text: 'hi' })).rejects.toThrow('tts 401: expired');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('不是凭证的问题(500 / 400)→ 不续期、不重试', async () => {
    renewals(cred('boot'), cred('renewed'));
    const { brain: b } = make();
    const f = stubFetch(fail(500, 'upstream down'));
    await expect(b.images!.generate({ model: 'xai/grok-image', prompt: 'x' })).rejects.toThrow('image gen 500: upstream down');
    expect(f).toHaveBeenCalledTimes(1);
    expect(freshOAuthCred).not.toHaveBeenCalledWith('xai', true);
  });

  it('用户自己配了 key 的 provider:不续期,401 也不重试,报错原样', async () => {
    const { brain: b } = make();
    const f = stubFetch(fail(401, 'bad key'), fail(401, 'bad key'));
    await expect(b.images!.generate({ model: 'gpt-image-1', prompt: 'x' })).rejects.toThrow('image gen 401: bad key');
    await expect(b.tts!.synthesize({ model: 'tts-1', text: 'hi' })).rejects.toThrow('tts 401: bad key');
    expect(f).toHaveBeenCalledTimes(2);
    expect([bearer(f, 0), bearer(f, 1)]).toEqual(['Bearer sk-user', 'Bearer sk-user']);
    expect(freshOAuthCred).not.toHaveBeenCalled();
  });

  it('续期本身抛错 → 不拦调用,带着现有的 token 照发', async () => {
    vi.mocked(freshOAuthCred).mockRejectedValue(new Error('lock'));
    const { brain: b } = make();
    const f = stubFetch(png);
    expect((await b.images!.generate({ model: 'xai/grok-image', prompt: 'x' })).images).toHaveLength(1);
    expect(bearer(f, 0)).toBe('Bearer boot');
  });
});
