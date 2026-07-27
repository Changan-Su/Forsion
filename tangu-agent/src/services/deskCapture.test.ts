// deskCapture 登记表:兑现 / 超时 / 中止 —— 这三条任何一条漏了都会把 agent 的 run 挂死。
import { describe, it, expect, vi } from 'vitest';

vi.mock('./eventBus.js', () => ({ publish: vi.fn(async () => {}) }));

import { requestDeskShot, resolveDeskShot } from './deskCapture.js';
import { publish } from './eventBus.js';

const shotIdOf = (): string => {
  const calls = (publish as any).mock.calls;
  return calls[calls.length - 1][2].shotId as string;
};

describe('deskCapture', () => {
  it('resolves with the posted image', async () => {
    const p = requestDeskShot('run1');
    expect(resolveDeskShot(shotIdOf(), { dataUrl: 'data:image/png;base64,AAA', mode: 'open' })).toBe(true);
    expect(await p).toEqual({ dataUrl: 'data:image/png;base64,AAA', mode: 'open' });
  });

  it('times out instead of hanging when nobody answers', async () => {
    expect(await requestDeskShot('run1', undefined, 5)).toEqual({ error: 'no response from the desktop app' });
  });

  it('a timed-out shot is no longer pending (late POST gets 410)', async () => {
    await requestDeskShot('run1', undefined, 5);
    expect(resolveDeskShot(shotIdOf(), { dataUrl: 'data:image/png;base64,AAA' })).toBe(false);
  });

  it('aborting the run resolves the wait', async () => {
    const ac = new AbortController();
    const p = requestDeskShot('run1', ac.signal, 60_000);
    ac.abort();
    expect(await p).toEqual({ error: 'aborted' });
  });

  it('already-aborted signal never publishes a request', async () => {
    const before = (publish as any).mock.calls.length;
    expect(await requestDeskShot('run1', AbortSignal.abort())).toEqual({ error: 'aborted' });
    expect((publish as any).mock.calls.length).toBe(before);
  });
});
