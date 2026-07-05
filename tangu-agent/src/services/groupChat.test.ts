import { describe, it, expect } from 'vitest';
import { formatDelta, CONTEXT_SLUG, type TranscriptEntry } from './groupChat.js';

describe('formatDelta (群聊 delta 注入格式)', () => {
  it('空 delta → 直接请发言', () => {
    expect(formatDelta([], 'A')).toContain('your turn (A)');
  });
  it('用户/成员条目按各自格式;CONTEXT 条目(播种历史)原样呈现,不加 @前缀', () => {
    const delta: TranscriptEntry[] = [
      { round: 0, slug: CONTEXT_SLUG, name: 'Context', text: '[Context — the conversation so far]\n[User] hi\n[Assistant] hello' },
      { round: 0, slug: '__user__', name: 'User', text: 'kickoff topic' },
      { round: 1, slug: 'alice', name: 'Alice', text: 'my view' },
    ];
    const out = formatDelta(delta, 'Bob');
    expect(out).toContain('[Context — the conversation so far]');
    expect(out).not.toContain('@Context'); // CONTEXT 不按发言人格式渲染
    expect(out).toContain('[User] kickoff topic');
    expect(out).toContain('@Alice:\nmy view');
    expect(out).toContain('your turn (Bob)');
  });
});
