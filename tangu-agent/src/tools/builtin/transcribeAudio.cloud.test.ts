/** transcribe_audio 的云端直连(没有桌面桥时经 brain.asr):什么时候出现、走哪条路、输出契约与桥同形。
 *  多账号模式那半(只读自己的文件夹、从不碰桥)在 test/multiAccountLeak.script.test.ts。 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { wavHeader } from '../../services/cloudTranscribe.js';

describe('transcribe_audio 云端直连', () => {
  let home: string;
  let wav: string;
  const calls: Array<{ mime: string; bytes: number; language?: string }> = [];
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-cloud-home-'));
    process.env.TANGU_HOME = home; // basename ≠ 'tangu' → 共享域 = home 自身(桥文件放这里)
    const pcm = Buffer.alloc(16000 * 2 * 45); // 45 秒静音 → 两段
    wav = path.join(home, 'audio.wav');
    writeFileSync(wav, Buffer.concat([wavHeader(pcm.length, 16000), pcm]));
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    configureTangu({
      host: {} as any,
      brain: { asr: { transcribe: async (req: any) => { calls.push({ mime: req.mime, bytes: req.audio.length, language: req.language }); return { text: `piece ${calls.length}` }; } } } as any,
      billing: {} as any,
      profile: createTanguProfile({ sandboxMode: 'none' }),
    });
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });
  afterEach(() => {
    calls.length = 0;
    delete process.env.TANGU_HOST_CLIENT;
    rmSync(path.join(home, 'desktop-bridge.json'), { force: true });
  });

  const names = async (): Promise<string[]> => {
    const { getToolDefinitions } = await import('../registry.js');
    const { deps } = await import('../../seams/runtime.js');
    const profile = deps().profile;
    return getToolDefinitions({ userId: 'u', sessionId: 's', appId: profile.appId, profile, execMode: 'host' } as any).map((d: any) => d.function.name);
  };
  const tool = async () => (await import('./transcribeAudio.js')).transcribeAudioProvider.tools()[0];

  it('没有桌面桥、装配了云端转写:工具出现,按段送,回与桥同形的 JSON', async () => {
    expect(await names()).toContain('transcribe_audio');
    const out = await (await tool()).execute({ path: wav, timestamps: true, language: 'zh' }, { userId: 'u' } as any);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.mime === 'audio/wav' && c.language === 'zh')).toBe(true);
    const j = JSON.parse(String(out));
    expect(j.text).toBe('piece 1\npiece 2');
    expect(j.segments).toHaveLength(2);
    expect(j.segments[0].start).toBe(0);
    expect(j.segments[0].end).toBeLessThanOrEqual(30);
    expect(j.segments[1].start).toBe(j.segments[0].end);
    expect(j.segments[1].end).toBe(45);
    expect(j.cite).toContain('#t=');
  });

  it('桌面托管的引擎(宿主注入 desktop 客户端):不走云端,工具只跟着桥出现', async () => {
    process.env.TANGU_HOST_CLIENT = 'desktop/2.15.0';
    expect(await names()).not.toContain('transcribe_audio');
    const out = await (await tool()).execute({ path: wav }, { userId: 'u' } as any);
    expect(String(out)).toMatch(/^Error: Forsion Desktop bridge not found/);
    expect(calls).toHaveLength(0);
  });

  it('没登录 Forsion(令牌是空的):工具不出现,也不发', async () => {
    const { setCloudTokenSource } = await import('../../services/cloudAccount.js');
    setCloudTokenSource(() => '');
    try {
      expect(await names()).not.toContain('transcribe_audio');
      const out = await (await tool()).execute({ path: wav }, { userId: 'u' } as any);
      expect(String(out)).toMatch(/^Error: /);
      expect(calls).toHaveLength(0);
    } finally { setCloudTokenSource(null); }
  });

  it('有桌面桥就只走桥:桥连不上也不悄悄改走计费的云端', async () => {
    writeFileSync(path.join(home, 'desktop-bridge.json'), JSON.stringify({ url: 'http://127.0.0.1:9/mcp', token: 't' }));
    const out = await (await tool()).execute({ path: wav }, { userId: 'u' } as any);
    expect(String(out)).toMatch(/desktop ASR bridge call failed/);
    expect(calls).toHaveLength(0);
  });

  it('文件不存在 / 云端报错:如实回 Error,不编文字', async () => {
    expect(String(await (await tool()).execute({ path: path.join(home, 'nope.wav') }, { userId: 'u' } as any))).toMatch(/^Error: .*does not exist/);
  });
});
