import { describe, expect, it } from 'vitest';
import { defaultRealtimeVoice, handshakeRefusal, retryableUpstream } from './realtimeVoice.js';

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

  // Forsion 云端中转:握手前的拒绝在正文里给 detail;接通后的挂断原因以 <4xx> 开头 —— 都不该触发重连(重连 = 再过一次额度预检、再开一条上游)。
  it('reports why the Forsion cloud relay refused, and never reconnects on its <4xx> hang-ups', () => {
    expect(handshakeRefusal(402, '{"detail":"token_quota_exceeded","reason":"daily_exceeded"}')).toBe('<402> token_quota_exceeded');
    expect(handshakeRefusal(401, '{"detail":"unauthorized"}')).toBe('<401> unauthorized');
    expect(handshakeRefusal(401, '{"code":"InvalidApiKey","message":"bad key"}')).toBe('upstream HTTP 401'); // 直连百炼:正文没有 detail
    expect(handshakeRefusal(502, '<html>Bad Gateway</html>')).toBe('upstream HTTP 502');
    expect(retryableUpstream(1008, '<402> token_quota_exceeded')).toBe(false);
    expect(retryableUpstream(1008, '<401> unauthorized')).toBe(false);
    expect(retryableUpstream(1008, '<409> replaced by a newer call')).toBe(false);
    expect(retryableUpstream(1008, '<400> upstream HTTP 401')).toBe(false);
    expect(retryableUpstream(1001, 'server restarting')).toBe(false);
    expect(retryableUpstream(1011, '<50002> InternalError.Algo.ModelServingError')).toBe(true); // 云端原样转来的百炼服务端错误照旧重连
  });
});
