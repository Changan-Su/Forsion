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
