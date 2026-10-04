import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pcmToWav, createMultiBrain } from './multiBrain.js';
import { createProviderRegistry } from '../../llm/providerRegistry.js';
import { freshOAuthToken } from '../../llm/providerOAuth.js';

vi.mock('../../llm/providerOAuth.js', () => ({ freshOAuthToken: vi.fn() }));

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

describe('订阅登录的 token 在取用时续期', () => {
  const httpBrain: any = { llm: { resolveModelAndKey: vi.fn(async () => ({ model: { id: 'cloud' }, apiKey: 'cloud-key', baseUrl: 'c', apiModelId: 'cloud' })) }, assets: {} };
  const brain = () => {
    const registry = createProviderRegistry([
      { providerId: 'xai', baseUrl: 'https://cli-chat-proxy.grok.com/v1', apiKey: 'boot', oauth: true },
      { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-user' },
    ]);
    return { registry, brain: createMultiBrain(httpBrain, registry) };
  };
  beforeEach(() => vi.clearAllMocks());

  it('resolve 拿续期后的 token,并换进注册表(图像 / 语音直接读 p.apiKey 的路径也跟上)', async () => {
    vi.mocked(freshOAuthToken).mockResolvedValue('fresh');
    const { registry, brain: b } = brain();
    expect((await b.llm.resolveModelAndKey('xai/grok-4.7')).apiKey).toBe('fresh');
    expect(freshOAuthToken).toHaveBeenCalledWith('xai', false);
    expect(registry.list().find((p) => p.providerId === 'xai')!.apiKey).toBe('fresh');
  });

  it('用户自己配了 key 的 provider 不碰(哪怕 id 与订阅登录同名的那种也靠 oauth 标记区分)', async () => {
    const { brain: b } = brain();
    expect((await b.llm.resolveModelAndKey('deepseek/deepseek-chat')).apiKey).toBe('sk-user');
    expect(freshOAuthToken).not.toHaveBeenCalled();
    expect(await b.llm.refreshModelKey!('deepseek/deepseek-chat')).toBeNull();
  });

  it('续期抛错 → 退回启动时的 token,不让 resolve 失败', async () => {
    vi.mocked(freshOAuthToken).mockRejectedValue(new Error('disk'));
    expect((await brain().brain.llm.resolveModelAndKey('xai/grok-4.7')).apiKey).toBe('boot');
  });

  it('refreshModelKey 强制续期;云端托管模型没有这回事', async () => {
    vi.mocked(freshOAuthToken).mockResolvedValue('forced');
    const { brain: b } = brain();
    expect(await b.llm.refreshModelKey!('xai/grok-4.7')).toBe('forced');
    expect(freshOAuthToken).toHaveBeenCalledWith('xai', true);
    expect(await b.llm.refreshModelKey!('gpt-cloud')).toBeNull();
    expect((await b.llm.resolveModelAndKey('gpt-cloud')).apiKey).toBe('cloud-key');
  });
});
