import { describe, it, expect } from 'vitest';
import { shouldForward, MUSE_SENDER_ID } from './inboxSend.js';

describe('shouldForward(收件箱 → 通道转发裁决)', () => {
  it('Muse 缺省不转发;普通 agent 缺省转发', () => {
    expect(shouldForward({}, MUSE_SENDER_ID)).toBe(false);
    expect(shouldForward({}, 'xyra')).toBe(true);
  });
  it('urgent 强制转发,高于显式 forward:false(与注释一致)', () => {
    expect(shouldForward({ urgent: true, forward: false }, MUSE_SENDER_ID)).toBe(true);
    expect(shouldForward({ forward: false }, 'xyra')).toBe(false);
    expect(shouldForward({ forward: true }, MUSE_SENDER_ID)).toBe(true);
  });
});
