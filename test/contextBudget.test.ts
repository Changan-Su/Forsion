import { describe, it, expect } from 'vitest';
import { compactContext, pinMessage } from '../src/services/contextBudget.js';

describe('compactContext pin', () => {
  it('never folds a pinned mid-band message, but folds unpinned mid-band peers', () => {
    const big = 'x'.repeat(9000); // > MSG_TRUNC_THRESHOLD(8000) → 中段会被折叠
    const msgs: any[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: `${big} #${i}` });

    // msgs[5] 落在中段(保护头=前3,保护尾=后20 之外);锚定它。
    const pinned = msgs[5];
    pinMessage(pinned);
    const pinnedBefore = pinned.content;
    const peerBefore = msgs[6].content;

    compactContext(msgs);

    expect(pinned.content).toBe(pinnedBefore); // 锚定 → 未折叠
    expect(msgs[6].content).not.toBe(peerBefore); // 同 band 未锚定 → 被折叠
  });
});
