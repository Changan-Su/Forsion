import { describe, expect, it } from 'vitest';
import { defaultRealtimeVoice, retryableUpstream } from './realtimeVoice.js';

describe('realtime voice: model families', () => {
  it('picks a default voice the model family actually has', () => {
    expect(defaultRealtimeVoice('bailian/qwen3.8-omni-flash-realtime')).toBe('Tina');
    expect(defaultRealtimeVoice('qwen3.5-omni-plus-realtime')).toBe('Tina');
    expect(defaultRealtimeVoice('bailian/qwen-audio-3.1-realtime-plus')).toBe('longanqian');
    expect(defaultRealtimeVoice('qwen-audio-3.0-realtime-flash')).toBe('longanqian');
  });

  it('reconnects on upstream server faults but not on a request that is wrong', () => {
    expect(retryableUpstream(1011, '')).toBe(true);
    expect(retryableUpstream(1007, '<50002> InternalError.Algo.ModelServingError: boom')).toBe(true);
    expect(retryableUpstream(1007, "<400> InternalError.Algo.InvalidParameter: Voice 'Tina' is not supported.")).toBe(false);
    expect(retryableUpstream(1000, 'upstream closed (1000)')).toBe(false);
  });
});
