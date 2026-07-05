import { describe, it, expect } from 'vitest';
import { foldWorkingWithSummary } from './compaction.js';
import type { ChatMessage } from '../core/types.js';

function mk(role: string, content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

describe('foldWorkingWithSummary', () => {
  it('keeps leading system block + tail, replaces middle with one summary system msg', () => {
    const msgs: ChatMessage[] = [
      mk('system', 'sys1'),
      mk('system', 'sys2'),
      ...Array.from({ length: 20 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`)),
    ];
    const before = msgs.length;
    foldWorkingWithSummary(msgs, 'SUMMARY', 5);
    // head(2 system) + 1 summary + tail(5) = 8
    expect(msgs.length).toBe(8);
    expect(msgs[0].content).toBe('sys1');
    expect(msgs[1].content).toBe('sys2');
    expect((msgs[2] as any).role).toBe('system');
    expect(msgs[2].content).toContain('SUMMARY');
    // tail preserved (last 5 of original)
    expect(msgs[msgs.length - 1].content).toBe(`m19`);
    expect(before).toBe(22);
  });

  it('no-op when too short to fold', () => {
    const msgs: ChatMessage[] = [mk('system', 's'), mk('user', 'a'), mk('assistant', 'b')];
    const copy = msgs.map((m) => ({ ...m }));
    foldWorkingWithSummary(msgs, 'SUMMARY', 12);
    expect(msgs).toEqual(copy);
  });

  it('handles no leading system block', () => {
    const msgs: ChatMessage[] = Array.from({ length: 30 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `m${i}`));
    foldWorkingWithSummary(msgs, 'S', 4);
    expect((msgs[0] as any).role).toBe('system'); // summary at front
    expect(msgs.length).toBe(5); // summary + tail(4)
  });
});
