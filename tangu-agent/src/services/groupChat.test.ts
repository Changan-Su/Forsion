import { describe, it, expect, vi, beforeEach } from 'vitest';

const { compactMock, latestMock, stateMock } = vi.hoisted(() => ({
  compactMock: vi.fn(),
  latestMock: vi.fn(),
  stateMock: { countSessionMessages: vi.fn(), listSessionMessagesWindow: vi.fn() },
}));
vi.mock('./compaction.js', () => ({
  compactSession: (...a: any[]) => compactMock(...a),
  getLatestSummary: (...a: any[]) => latestMock(...a),
}));
vi.mock('../seams/runtime.js', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, deps: () => ({ state: stateMock }) };
});

import { formatDelta, buildHistorySeed, CONTEXT_SLUG, type TranscriptEntry } from './groupChat.js';

describe('formatDelta (群聊 delta 注入格式)', () => {
  it('空 delta → 直接请它干活并汇报', () => {
    expect(formatDelta([], 'A')).toContain('activated now (A)');
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
    expect(out).toContain('activated now (Bob)');
  });
});

describe('buildHistorySeed (群聊播种:先 Compact 再注入,压缩不可用退回尾窗)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestMock.mockResolvedValue(null);
  });

  it('无历史 → null,不触发压缩', async () => {
    stateMock.countSessionMessages.mockResolvedValue(0);
    expect(await buildHistorySeed('s', 'm', 'tangu')).toBeNull();
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('压缩成功 → 种摘要,不再读原始尾窗', async () => {
    stateMock.countSessionMessages.mockResolvedValue(10);
    compactMock.mockResolvedValue({ ok: true, summary: 'SUMMARY-XYZ' });
    const e = await buildHistorySeed('s', 'm', 'tangu');
    expect(e!.slug).toBe(CONTEXT_SLUG);
    expect(e!.text).toContain('SUMMARY-XYZ');
    expect(e!.text).toContain('[End of context]');
    expect(stateMock.listSessionMessagesWindow).not.toHaveBeenCalled();
  });

  it('压缩不可用(历史太短/模型失败/云端无本地库)→ 退回原始尾窗,role=model 归一为 assistant', async () => {
    stateMock.countSessionMessages.mockResolvedValue(2);
    compactMock.mockResolvedValue({ ok: false, reason: 'nothing to compact' });
    stateMock.listSessionMessagesWindow.mockResolvedValue([
      { role: 'user', content: 'hi' },
      { role: 'model', content: 'hello' },
    ]);
    const e = await buildHistorySeed('s', 'm', 'tangu');
    expect(e!.text).toContain('[User] hi');
    expect(e!.text).toContain('[Assistant] hello');
  });

  it('压缩抛异常 → 同样退回尾窗(绝不因压缩把群聊打挂)', async () => {
    stateMock.countSessionMessages.mockResolvedValue(1);
    compactMock.mockRejectedValue(new Error('boom'));
    stateMock.listSessionMessagesWindow.mockResolvedValue([{ role: 'user', content: 'only' }]);
    const e = await buildHistorySeed('s', 'm', 'tangu');
    expect(e!.text).toContain('[User] only');
  });

  it('压缩不可用但存在旧检查点 → 摘要拼在尾窗之前(不丢已压缩掉的早期上下文)', async () => {
    stateMock.countSessionMessages.mockResolvedValue(1);
    compactMock.mockResolvedValue({ ok: false });
    latestMock.mockResolvedValue({ summary: 'OLD-SUM', throughTimestamp: 5 });
    stateMock.listSessionMessagesWindow.mockResolvedValue([{ role: 'user', content: 'new msg' }]);
    const e = await buildHistorySeed('s', 'm', 'tangu');
    const text = e!.text;
    expect(text.indexOf('OLD-SUM')).toBeGreaterThan(-1);
    expect(text.indexOf('OLD-SUM')).toBeLessThan(text.indexOf('[User] new msg'));
  });
});
