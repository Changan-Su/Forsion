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

import { formatDelta, buildHistorySeed, speechTokens, speechCoverage, isRepeatSpeech, CONTEXT_SLUG, type TranscriptEntry } from './groupChat.js';

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

describe('isRepeatSpeech (一次激活里「同一件事说两遍」)', () => {
  // 夹具取自生产会话 7d8ed746(2026-09-17):成员先 team_say 广播一遍,最终答复换个排版又说一遍。
  const dup: Array<[string, string]> = [
    ['我是 Aria,主要负责情绪与表达:帮你辨认话语里的细微感受和张力,也一起做创意写作、文案、场景与概念设计。',
     '我是 **Aria**,主要负责情绪与表达:帮你辨认话语里的细微感受和张力,也一起做创意写作、文案、场景与概念设计。\n\nDONE'],
    ['目前没什么隐藏计划,也不会自作主张替你推进事情。我们打算按你的需求协作:Arioso负责判断、查证和落地,Christina／红莉栖负责技术拆解与排错,我负责情绪、表达和创意。',
     '目前没什么隐藏计划,也不会自作主张替你推进事情。\n\n我们打算按你的需求协作:\n- **Arioso**:判断、查证、规划和落地执行\n- **Christina／红莉栖**:技术拆解、代码、文档和排错\n- **我(Aria)**:情绪理解、表达润色和创意构思'],
    ['按当前团队设定,我是 Arioso,承担“老大”这个总协调角色:负责判断优先级、整合意见并推进落地。但真正的最终决策者还是你;我不是替你做主。',
     'DONE\n\n简单说:**你是最终决策者,我是团队里的总协调“老大”。**\n- **你**:决定目标和是否采用结果\n- **Arioso**:判断、查证、规划、推进落地'],
    ['补充确认:用户才是老大,团队内部是平等协作,不存在我作为上级的关系;我只是偏统筹推进。',
     '确认一下:**你是老大**,我们是平等协作的助手。我只是更偏向统筹、判断和推进,并不是其他角色的上级。'],
  ];
  // 先报进度、后交报告:两条都必须发出去(否则队友在 delta 里看不到成果)。
  const keep: Array<[string, string]> = [
    ['我先接手 API 层,预计 20 分钟后给结果。',
     'API 层改完了:新增 /v1/quota、/v1/quota/reset 两个端点,补了 3 个单测。@Christina UI 那边可以对接了。'],
    ['先说结论方向:我怀疑是缓存键没带 agent,导致前缀缓存整段 miss。我去翻 provider 那层确认。',
     '确认了:缓存键确实没带 agent,每个成员都各自走了一次冷启动。已经把 agentSlug 拼进缓存键,实测命中率从 0 到 78%。'],
    ['The parser bug looks like a boundary issue in the CJK path. Digging into the tokenizer now.',
     'Confirmed: the tokenizer treats a CJK codepoint as two units, so the boundary check fires one char early. Fixed by counting code points, plus a regression test.'],
  ];
  const posted = (...texts: string[]): string[][] => texts.map(speechTokens);
  it('换排版 / 换措辞重说一遍 → 判重(最终答复不再抄回团队会话)', () => {
    for (const [said, finalText] of dup) expect(isRepeatSpeech(finalText, posted(said))).toBe(true);
  });
  it('进度条 → 真报告 = 新内容,照发', () => {
    for (const [said, finalText] of keep) expect(isRepeatSpeech(finalText, posted(said))).toBe(false);
  });
  it('阈值两侧留有余量(阈值 0.2:重复 ≥0.22,非重复 ≤0.15)', () => {
    for (const [a, b] of dup) expect(speechCoverage(posted(a), b)).toBeGreaterThanOrEqual(0.22);
    for (const [a, b] of keep) expect(speechCoverage(posted(a), b)).toBeLessThanOrEqual(0.15);
  });
  // Codex 评审 #1:判据必须非对称 —— 「原样重复开头 + 真正的交付」不是重复,吞掉它等于把补丁路径和点名一起丢了。
  it('重复开头 + 新交付 / 新点名 → 不判重(非对称覆盖率,不是相似度)', () => {
    const said = '我先接手 API 层。';
    const final = '我先接手 API 层。改完了:新增 /v1/quota、/v1/quota/reset 两个端点,补了 3 个单测,迁移脚本放在 migrations/0042。@Christina UI 那边可以对接了。';
    expect(isRepeatSpeech(final, posted(said))).toBe(false);
    expect(isRepeatSpeech('API 修复完成;补丁在 x.diff,@Beta 请合入。另外我加了 3 个回归测试,覆盖 CJK 边界和空输入。', posted('API 修复完成'))).toBe(false);
  });
  // Codex 评审 #6:两段互不相干的纯代码块归一化后都是空记号流,不能因此判成同一件事。
  it('切不出记号(纯代码块 / 极短)一律照发', () => {
    expect(isRepeatSpeech('```js\nconst a = 1\n```', posted('```js\nconst b = 2\n```'))).toBe(false);
    expect(isRepeatSpeech('随便什么', [])).toBe(false);
    expect(speechCoverage(posted('有内容'), '')).toBe(0);
  });
  it('内容拆在两条 team_say 里说完 → 最终答复照样判重(按并集比,不是逐条比)', () => {
    const a = '我把 API 层改完了:新增 /v1/quota 端点。';
    const b = '另外补了 3 个单测,迁移脚本在 migrations/0042。';
    expect(isRepeatSpeech('我把 API 层改完了:新增 /v1/quota 端点。另外补了 3 个单测,迁移脚本在 migrations/0042。', posted(a, b))).toBe(true);
  });
});
