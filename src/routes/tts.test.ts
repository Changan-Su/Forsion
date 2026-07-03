import { describe, it, expect } from 'vitest';
import { parseVoiceList } from './tts.js';

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
