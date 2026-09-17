import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../core/types.js';

const fake = vi.hoisted(() => ({
  query: vi.fn(), resolve: vi.fn(), build: vi.fn(), stream: vi.fn(),
  publish: vi.fn(), cost: vi.fn(),
}));
vi.mock('../core/db.js', () => ({ query: fake.query }));
vi.mock('./eventBus.js', () => ({ publish: fake.publish }));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({
  brain: { llm: {
    resolveModelAndKey: fake.resolve, buildProviderPayload: fake.build, streamProviderCompletion: fake.stream,
  } },
  billing: { calculateCost: fake.cost },
}) }));
import { compactWorkingMessages, compactSession, tagMessageSource, summaryMessage } from './compaction.js';
import { DEFAULT_COMPACTION_SETTINGS } from './compactionSettings.js';
import { estimateMessagesTokens } from './contextBudget.js';
import { enterRunContext } from '../seams/runContext.js';

const message = (role: string, content: string): ChatMessage => ({ role, content }) as ChatMessage;
/** 保留最近 n 条的 token 预算(按当前 msgs 估算;旧 API 的 tail=n 语义,测试用)。 */
const keepLast = (msgs: ChatMessage[], n: number) => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: estimateMessagesTokens(msgs.slice(-n)) });
/** history() 固定形状:保留最近 12 条(旧 tail=12 语义)。 */
const HIST_OPTS = { settings: keepLast(history(), 12) };
function history(): ChatMessage[] {
  return [message('system', 'stable developer instructions'), message('user', 'ORIGINAL_GOAL'),
    { role: 'assistant', content: 'Changed the parser', tool_calls: [
      { id: 'edit1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/parser.ts"}' } },
    ] } as any,
    { role: 'tool', tool_call_id: 'edit1', content: 'CURRENT_RUN_EVIDENCE: failing test expects a colon' } as any,
    ...Array.from({ length: 20 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `recent ${i}`))];
}

beforeEach(() => {
  vi.resetAllMocks();
  fake.resolve.mockResolvedValue({ model: {}, apiKey: 'test', baseUrl: 'test', apiModelId: 'test' });
  fake.build.mockImplementation(async (opts) => opts);
  fake.stream.mockResolvedValue({ content: '## Goal\nContinue fixing the parser; keep the failing test evidence.' });
  fake.cost.mockResolvedValue(0.5);
  fake.publish.mockResolvedValue(1);
});

// A5 / 契约 C-5:后台 LLM 调用必须上台账,否则 Muse 预算与「本 run 花了多少」都有洞。
describe('compaction 摘要调用的用量台账', () => {
  it('在 run 上下文里发一条 phase=compaction 的 usage 事件(不发 total/costTotal)', async () => {
    fake.stream.mockResolvedValue({
      content: '## Goal\nkeep going',
      usage: { prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 900 },
    });
    enterRunContext('u1', 'run-compact-1');
    const r = await compactWorkingMessages(history(), 'm', 'tangu', undefined, HIST_OPTS);
    expect(r.ok).toBe(true);
    const call = fake.publish.mock.calls.find((c) => c[1] === 'usage');
    expect(call).toBeTruthy();
    expect(call![0]).toBe('run-compact-1');
    expect(call![2]).toMatchObject({ phase: 'compaction', prompt: 1200, completion: 300, cached: 900, cacheReported: true, cost: 0.5 });
    expect(call![2]).not.toHaveProperty('total');
    expect(call![2]).not.toHaveProperty('costTotal');
  });

  it('provider 没报缓存命中量时 cacheReported=false(「没报」≠「0 命中」)', async () => {
    fake.stream.mockResolvedValue({ content: '## Goal\nkeep going', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    enterRunContext('u1', 'run-compact-2');
    await compactWorkingMessages(history(), 'm', 'tangu', undefined, HIST_OPTS);
    const call = fake.publish.mock.calls.find((c) => c[1] === 'usage');
    expect(call![2]).toMatchObject({ cached: 0, cacheReported: false });
  });
});

describe('current working context compaction', () => {
  it('summarizes current tools and the full replaced prefix without advancing persisted history', async () => {
    const msgs = history();
    // 超過旧 60k 尾截断：目标和本轮早期工具证据仍必须完整进入摘要输入。
    msgs.splice(4, 0, message('assistant', 'x'.repeat(65_000)));
    const stable = msgs[0];
    const tail = msgs.slice(-12);
    const ac = new AbortController();
    const result = await compactWorkingMessages(msgs, 'm', 'tangu', ac.signal, { settings: keepLast(msgs, 12) });
    expect(result.ok).toBe(true);
    const transcript = fake.build.mock.calls[0][0].messages[1].content;
    expect(transcript).toContain('ORIGINAL_GOAL');
    expect(transcript).toContain('CURRENT_RUN_EVIDENCE');
    expect(transcript).toContain('edit_file');
    expect(transcript).not.toContain('recent 19'); // 尾部不删除,也不重复总结。
    expect(transcript.length).toBeGreaterThan(65_000); // 正文不截(只截工具结果),被替换的内容都进摘要输入
    expect(msgs[0]).toBe(stable);
    expect(msgs.slice(-12)).toEqual(tail);
    expect(msgs[1].content).toContain('<modified-files>\nsrc/parser.ts');
    expect(fake.build.mock.calls[0][0].signal).toBe(ac.signal);
    expect(fake.stream.mock.calls[0][0].signal).toBe(ac.signal);
    expect(result).not.toHaveProperty('throughTimestamp');
    expect(fake.query).not.toHaveBeenCalled(); // DB 无关:落检查点是 agentLoop 按 boundary 做的事
  });

  it('keeps a tool call and all its results together at the retained-tail boundary', async () => {
    const msgs = history();
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] } as any,
      { role: 'tool', tool_call_id: 'a', content: 'a result' } as any,
      { role: 'tool', tool_call_id: 'b', content: 'b result' } as any, message('assistant', 'next'));
    const whole = msgs.map((m) => m);
    // 预算恰好落在发起这批调用的 assistant 上 → 整批保留
    await compactWorkingMessages(msgs, 'm', 'tangu', undefined, { settings: keepLast(msgs, 4) });
    const firstTool = msgs.findIndex((m) => m.role === 'tool');
    expect((msgs[firstTool - 1] as any).tool_calls).toHaveLength(2);
    expect(msgs.slice(firstTool).map((m: any) => m.tool_call_id)).toEqual(['a', 'b', undefined]);
    // 预算落在批次中间 → 整批进摘要(切点前移到批次之后),绝不产出孤立 role:tool
    vi.clearAllMocks();
    fake.resolve.mockResolvedValue({ model: {}, apiKey: 'test', baseUrl: 'test', apiModelId: 'test' });
    fake.build.mockImplementation(async (opts) => opts);
    fake.stream.mockResolvedValue({ content: '## Goal\nbatch summarized' });
    await compactWorkingMessages(whole, 'm', 'tangu', undefined, { settings: keepLast(whole, 2) });
    expect(whole.some((m) => m.role === 'tool')).toBe(false);
    expect(whole[whole.length - 1].content).toBe('next');
    expect(fake.build.mock.calls[0][0].messages[1].content).toContain('[Tool result: tool]\nb result');
  });

  it('measuredTokens:实测远大于粗估(截图按定额估)→ 保留预算按比例换算;按估算全装得下也强制压一次(最小切法)', async () => {
    const msgs = history(); // 粗估很小
    const r = await compactWorkingMessages(msgs, 'm', 'tangu', undefined, { measuredTokens: 125_000 });
    expect(r.ok).toBe(true);
    expect(msgs.filter((m) => String(m.content).startsWith('## Compacted Summary'))).toHaveLength(1);
    // 换算后预算极小(20k/400 ≈ 50 估算 token)→ 只留最后几条,目标与早期证据进摘要输入
    expect(msgs.length).toBeLessThanOrEqual(8);
    expect(msgs[msgs.length - 1].content).toBe('recent 19');
    expect(msgs.some((m) => m.content === 'ORIGINAL_GOAL')).toBe(false);
    expect(fake.build.mock.calls[0][0].messages[1].content).toContain('ORIGINAL_GOAL');
    // 不给实测:全部在缺省 20k 预算内 → 不压
    const same = history();
    expect(await compactWorkingMessages(same, 'm')).toMatchObject({ ok: false, reason: 'nothing to compact' });
  });

  it('updates a previous in-memory summary instead of accumulating old checkpoints', async () => {
    const msgs = history();
    msgs.splice(1, 0, summaryMessage('Earlier decision\n\n<file-operations>\n<modified-files>\nsrc/old.ts\n</modified-files>\n</file-operations>'));
    await compactWorkingMessages(msgs, 'm', 'tangu', undefined, { settings: keepLast(msgs, 12) });
    expect(fake.build.mock.calls[0][0].messages[1].content).toContain('[Existing Summary]\nEarlier decision');
    expect(fake.build.mock.calls[0][0].messages[0].content).toContain('UPDATE it instead of restarting');
    expect(msgs.filter((m) => String(m.content).startsWith('## Compacted Summary'))).toHaveLength(1);
    expect(msgs[1].content).toContain('src/old.ts');
    expect(msgs[1].content).toContain('src/parser.ts');
  });

  it('request params: settings.model / thinking / summaryMaxTokens / focus 都上 payload;thinking off 不发字段', async () => {
    const msgs = history();
    await compactWorkingMessages(msgs, 'm', 'tangu', undefined, {
      settings: { ...keepLast(msgs, 12), model: 'cheap', thinking: 'inherit', summaryMaxTokens: 4096, reserveTokens: 16_384, instructions: 'keep ids' },
      runThinking: 'high', focus: 'the migration',
    });
    expect(fake.resolve).toHaveBeenCalledWith('cheap');
    const req = fake.build.mock.calls[0][0];
    expect(req.thinkingLevel).toBe('high');
    expect(req.maxTokens).toBe(4096);
    expect(req.messages[0].content).toContain('Additional focus: keep ids\nthe migration');
    vi.clearAllMocks();
    fake.resolve.mockResolvedValue({ model: {}, apiKey: 'test', baseUrl: 'test', apiModelId: 'test' });
    fake.build.mockImplementation(async (opts) => opts);
    fake.stream.mockResolvedValue({ content: '## Goal\nagain' });
    const again = history();
    await compactWorkingMessages(again, 'm', 'tangu', undefined, { settings: keepLast(again, 12), runThinking: 'high' });
    expect(fake.build.mock.calls[0][0]).not.toHaveProperty('thinkingLevel'); // 缺省 off = 与改前 wire 一致
    expect(fake.build.mock.calls[0][0].maxTokens).toBe(6144);
  });

  it('boundary:已落库行整体覆盖 → throughTs;行内切点 → partialRow;本 run 未落库段 → pendingToolCallId', async () => {
    // 已落库:U0(row u0) / A0 的两轮(row a0);本 run:U1(row u1)+ 两轮未落库
    const call = (id: string) => ({ id, type: 'function', function: { name: 'todo_read', arguments: '{}' } });
    const rowA0 = { id: 'a0', ts: 20 };
    const msgs: ChatMessage[] = [
      message('system', 'stable'),
      tagMessageSource(message('user', 'first ask'), { id: 'u0', ts: 10 }),
      tagMessageSource({ role: 'assistant', content: 'r1', tool_calls: [call('x1')] } as any, rowA0),
      tagMessageSource({ role: 'tool', tool_call_id: 'x1', content: 'x1 result' } as any, rowA0),
      tagMessageSource({ role: 'assistant', content: 'r2', tool_calls: [call('x2')] } as any, rowA0),
      tagMessageSource({ role: 'tool', tool_call_id: 'x2', content: 'x2 result' } as any, rowA0),
      tagMessageSource(message('user', 'current ask'), { id: 'u1', ts: 30 }),
      { role: 'assistant', content: 'now1', tool_calls: [call('n1')] } as any,
      { role: 'tool', tool_call_id: 'n1', content: 'n1 result' } as any,
      { role: 'assistant', content: 'now2', tool_calls: [call('n2')] } as any,
      { role: 'tool', tool_call_id: 'n2', content: 'n2 result' } as any,
    ];
    // 切点落在 a0 行内(x2 轮保留)
    let r = await compactWorkingMessages(msgs.map((m) => m), 'm', 'tangu', undefined, { settings: keepLast(msgs, 7) });
    expect(r.boundary).toEqual({ partialRow: { id: 'a0', ts: 20, toolCallId: 'x1' } });
    // 切点在 now2 之前:a0 与 u1 整体覆盖(边界行 = u1,带 id),本 run 的 n1 轮也被覆盖 → pending
    r = await compactWorkingMessages(msgs.map((m) => m), 'm', 'tangu', undefined, { settings: keepLast(msgs, 2) });
    expect(r.boundary).toEqual({ through: { id: 'u1', ts: 30 }, pendingToolCallId: 'n1' });
    // 切点在 u1 之前:a0 整体覆盖,无行内切点、无未落库段
    r = await compactWorkingMessages(msgs.map((m) => m), 'm', 'tangu', undefined, { settings: keepLast(msgs, 5) });
    expect(r.boundary).toEqual({ through: { id: 'a0', ts: 20 } });
  });

  it('boundary:范围里有有损消息(机械折叠 / 硬帽截断)→ lossy,摘要只留内存不推进检查点', async () => {
    const { markLossy } = await import('./contextBudget.js');
    const msgs = history();
    tagMessageSource(msgs[1], { id: 'u0', ts: 10 });
    markLossy(tagMessageSource(msgs[3], { id: 'a0', ts: 20 })); // 折叠过的工具结果
    const r = await compactWorkingMessages(msgs, 'm', 'tangu', undefined, { settings: keepLast(msgs, 12) });
    expect(r.ok).toBe(true);
    expect(r.boundary?.lossy).toBe(true);
  });

  it('propagates cancellation to the stream and leaves the original context intact', async () => {
    fake.stream.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const msgs = history();
    const original = structuredClone(msgs);
    const ac = new AbortController();
    const running = compactWorkingMessages(msgs, 'm', 'tangu', ac.signal, HIST_OPTS);
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fake.stream).toHaveBeenCalledOnce());
    ac.abort();
    await rejected;
    expect(msgs).toEqual(original);
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('does not start compaction for an already stopped run', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(compactWorkingMessages(history(), 'm', 'tangu', ac.signal, HIST_OPTS)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.resolve).not.toHaveBeenCalled();
  });

  it('does not continue after a cancelled resolve or overwrite a changed working snapshot', async () => {
    const ac = new AbortController();
    fake.resolve.mockImplementationOnce(async () => { ac.abort(); return { model: {}, apiKey: '', baseUrl: '', apiModelId: '' }; });
    await expect(compactWorkingMessages(history(), 'm', 'tangu', ac.signal, HIST_OPTS)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.build).not.toHaveBeenCalled();

    const msgs = history();
    fake.stream.mockImplementationOnce(async () => { msgs[1].content = 'NEW USER REQUIREMENT'; return { content: 'summary is now stale' }; });
    const result = await compactWorkingMessages(msgs, 'm', 'tangu', undefined, HIST_OPTS);
    expect(result).toMatchObject({ ok: false, reason: 'working context changed during compaction' });
    expect(msgs[1].content).toBe('NEW USER REQUIREMENT');
    expect(msgs).toHaveLength(24);
  });

  it('does not write a persisted checkpoint after cancellation during summary generation', async () => {
    fake.query.mockResolvedValueOnce([
      { role: 'user', content: 'question', timestamp: 1 }, { role: 'assistant', content: 'answer', timestamp: 2 },
    ]).mockResolvedValueOnce([]);
    const ac = new AbortController();
    fake.stream.mockImplementationOnce(async () => { ac.abort(); return { content: 'stale persisted summary' }; });
    await expect(compactSession('s', 'm', 'tangu', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.query.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true);
  });
});
