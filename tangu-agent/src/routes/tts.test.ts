import { afterEach, describe, it, expect, vi } from 'vitest';
import { cloneService, dsAwaitVoice, parseVoiceList, qwenCloneBody } from './tts.js';

// 三家百炼 list 响应形态无逐字文档,字段名靠猜(qwen=voice/voices，cosy=voice_id/voice_list)——守住防御解析。
describe('parseVoiceList', () => {
  it('reads qwen shape (output.voices, {voice})', () => {
    const out = parseVoiceList({ output: { voices: [{ voice: 'v1', target_model: 'm1' }, 'v2'] } }, 'clone');
    expect(out).toEqual([{ voice: 'v1', kind: 'clone', targetModel: 'm1' }, { voice: 'v2', kind: 'clone' }]);
  });
  it('reads cosy shape (output.voice_list, {voice_id})', () => {
    const out = parseVoiceList({ output: { voice_list: [{ voice_id: 'cosyvoice-v2-abc-xxxx' }] } }, 'cosy');
    expect(out).toEqual([{ voice: 'cosyvoice-v2-abc-xxxx', kind: 'cosy', targetModel: undefined }]);
  });
  it('drops empties and tolerates non-array / missing output', () => {
    expect(parseVoiceList({ output: { voices: [{}, { voice: '' }] } }, 'clone')).toEqual([]);
    expect(parseVoiceList({}, 'design')).toEqual([]);
    expect(parseVoiceList({ output: 'nope' }, 'design')).toEqual([]);
  });
});

describe('cloneService', () => {
  it('routes Qwen-Audio-TTS and CosyVoice to voice-enrollment, the rest to qwen-voice-enrollment', () => {
    for (const m of ['qwen-audio-3.0-tts-plus', 'qwen-audio-3.1-tts-flash', 'cosyvoice-v3.5-plus', 'cosyvoice-v2']) expect(cloneService(m)).toBe('voice-enrollment');
    for (const m of ['qwen3-tts-vc-2026-01-22', 'qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime']) expect(cloneService(m)).toBe('qwen-voice-enrollment');
  });
});

// 百炼对 qwen3.8-omni 不带 voice_clone_mode 不报错,只是静默退回旧复刻模式 —— 线上看不出来,只能在这里钉住请求体。
describe('qwenCloneBody', () => {
  it('sends voice_clone_mode for qwen3.8-omni targets', () => {
    expect(qwenCloneBody('qwen3.8-omni-flash-realtime', 'me', 'data:audio/wav;base64,AA')).toEqual({
      model: 'qwen-voice-enrollment',
      input: { action: 'create', target_model: 'qwen3.8-omni-flash-realtime', preferred_name: 'me', audio: { data: 'data:audio/wav;base64,AA' } },
      parameters: { voice_clone_mode: 'normal' },
    });
  });
  it('leaves it out for qwen3.5-omni (that is the legacy mode) and for Qwen3-TTS', () => {
    expect(qwenCloneBody('qwen3.5-omni-plus-realtime', 'me', 'x')).not.toHaveProperty('parameters');
    expect(qwenCloneBody('qwen3-tts-vc-2026-01-22', 'me', 'x')).not.toHaveProperty('parameters');
  });
});

// 只有 OK 才算部署好:到点还在 DEPLOYING、或一直查不到,都不能当成功交还(界面会立刻采用一个还用不了的音色)。
describe('dsAwaitVoice', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answers = (...seq: Array<string | null>) => {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const s = seq[Math.min(i++, seq.length - 1)];
      if (s === null) throw new Error('network down');
      return new Response(JSON.stringify({ output: { status: s } }), { status: 200 });
    }));
  };
  const wait = () => dsAwaitVoice('https://dashscope.aliyuncs.com/compatible-mode/v1', 'k', 'v1', 4, 1);
  it('resolves once the voice is OK, riding out a failed query', async () => {
    answers('DEPLOYING', null, 'OK');
    await expect(wait()).resolves.toBeUndefined();
  });
  it('rejects when the voice is still deploying at the deadline', async () => {
    answers('DEPLOYING');
    await expect(wait()).rejects.toThrow(/still deploying/);
  });
  it('rejects when every query fails', async () => {
    answers(null);
    await expect(wait()).rejects.toThrow(/still deploying/);
  });
  it('rejects a voice that failed review', async () => {
    answers('DEPLOYING', 'UNDEPLOYED');
    await expect(wait()).rejects.toThrow(/UNDEPLOYED/);
  });
});
