import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompletionOutbox, type Completion } from './completionOutbox.js';

describe('durable terminal delivery', () => {
  it('retains a failed write, restores after restart, and removes only on acknowledgement', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tangu-completion-'));
    let outbox = new CompletionOutbox(dir, async () => { throw new Error('502 Bad Gateway'); }, () => {});
    try {
      const key = outbox.create('abc-123');
      outbox.stageMessage('abc-123', { messageId: 'm', sessionId: 's', content: 'actual answer', toolCalls: [], toolResults: [] } as any);
      outbox.finish('abc-123', 'failed', { error: 'original upstream failure' });
      await outbox.flush('abc-123');
      expect(readdirSync(dir)).toEqual(['abc-123.json']);
      expect(statSync(path.join(dir, 'abc-123.json')).mode & 0o777).toBe(0o600);
      outbox.close();
      const delivered: Completion[] = [];
      outbox = new CompletionOutbox(dir, async job => { delivered.push(job); }, () => {});
      await outbox.flush('abc-123');
      expect(delivered).toMatchObject([{ key, status: 'failed', message: { content: 'actual answer' }, extra: { error: 'original upstream failure' } }]);
      expect(readdirSync(dir)).toEqual([]);
    } finally { outbox.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('a crashed active run becomes failed without re-executing it; first terminal state wins', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tangu-completion-'));
    const delivered: Completion[] = [];
    let outbox = new CompletionOutbox(dir, async job => { delivered.push(job); }, () => {});
    try {
      outbox.create('abc');
      outbox.close();
      outbox = new CompletionOutbox(dir, async job => { delivered.push(job); }, () => {});
      expect(JSON.parse(readFileSync(path.join(dir, 'abc.json'), 'utf8')).status).toBe('failed');
      outbox.finish('abc', 'done');
      await outbox.flush('abc');
      expect(delivered[0].status).toBe('failed');
      expect(delivered[0].extra?.error).toContain('execution was not resumed');
    } finally { outbox.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps multiple steered messages and uncertain writes for safe replay', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tangu-completion-'));
    let sent: Completion | undefined;
    const outbox = new CompletionOutbox(dir, async job => { sent = job; }, () => {});
    try {
      outbox.create('abc');
      const m = (messageId: string, content: string) => ({ messageId, sessionId: 's', content, toolCalls: [], toolResults: [] } as any);
      outbox.stageMessage('abc', m('a', 'first'));
      outbox.stageMessage('abc', m('b', 'V0'));
      outbox.acknowledgeMessage('abc', 'b');
      outbox.stageMessage('abc', m('b', 'V1')); // response lost
      outbox.stageMessage('abc', m('b', 'V2'));
      outbox.finish('abc', 'done');
      await outbox.flush('abc');
      expect(sent?.messages).toMatchObject([{ value: { messageId: 'a', content: 'first' } },
        { value: { messageId: 'b', content: 'V2' }, previous: { content: 'V0' }, attempted: [{ content: 'V1' }] }]);
    } finally { outbox.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
