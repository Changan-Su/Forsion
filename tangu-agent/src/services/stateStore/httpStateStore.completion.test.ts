import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createHttpStateStore, runWithRequestToken } from './httpStateStore.js';
import { enterRunContext } from '../../seams/runContext.js';

it('an unsaved assistant ACK stays in the durable HTTP completion retry, including after janitor failure', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(path.join(tmpdir(), 'tangu-http-completion-'));
  const runId = randomUUID();
  let attempts = 0;
  let delivered: any;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    if (url.endsWith('/runs')) return new Response(JSON.stringify({ ok: true, completionReceipt: true }));
    if (url.endsWith('/assistant-message')) return new Response(JSON.stringify({ ok: true, saved: false }));
    if (url.endsWith('/completion')) {
      delivered = JSON.parse(init.body);
      if (++attempts === 1) return new Response('502 Bad Gateway', { status: 502 });
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  try {
    const state = createHttpStateStore({ cloudUrl: 'http://gateway', fleetSecret: 'fleet', completionOutboxDir: dir });
    await runWithRequestToken('dispatch', () => state.createRun({ id: runId, sessionId: 's', userId: 'u', appId: 'tangu', modelId: 'm', assistantMessageId: 'a' } as any));
    enterRunContext('u', runId);
    await expect(state.finalizeAssistantMessage({ messageId: 'a', sessionId: 's', modelId: 'm', content: 'recover this answer', reasoning: '', toolCalls: [], toolResults: [] })).rejects.toThrow('not committed');
    await state.updateRunStatus(runId, 'failed', { error: 'gateway failure' });
    expect(readdirSync(dir)).toEqual([`${runId}.json`]);
    expect(delivered.messages).toMatchObject([{ value: { content: 'recover this answer' } }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    enterRunContext(''); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});
