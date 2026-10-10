/**
 * 输入建议(promptSuggestion.ts)。这功能的成本靠「请求前缀与主循环相同 → 命中前缀缓存」,
 * 能机械守住的就是这里:发出去的请求 = 快照 + 一条尾部指令,同一份工具头、同思考档、同一个缓存路由键(cacheKey + agentId)。
 * 另外钉:快照取走即删 / 过期 / run 对不上 / 云端不存;模型原话不合规就是空串。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../profiles/index.js';
import {
  stashSuggestionSeed, suggestNextPrompt, cleanSuggestion,
  SUGGEST_INSTRUCTION, SUGGEST_MAX_CHARS, __resetSuggestionSeedsForTests,
} from './promptSuggestion.js';

const TOOLS = [{ type: 'function', function: { name: 'read_file' } }];
let payloads: any[];
let reply: any;

function configure(hostExec = true, canConsume = true): void {
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => { payloads.push(o); return {}; },
      streamProviderCompletion: async () => reply,
    },
    users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
  };
  const billing: any = { canConsumeTokenPoints: async () => ({ ok: canConsume }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host: {}, brain, billing, profile: hostExec ? createTanguProfile({ sandboxMode: 'none' }) : createAiStudioProfile() } as any);
}

const seedOf = (messages: any[], over: Record<string, unknown> = {}): any => ({
  getMessages: () => messages.map((m) => ({ ...m })), tools: TOOLS, thinkingLevel: 'high', modelId: 'm1', contextWindow: 100_000, agentId: 'tangu', verbosity: 'low', ...over,
});
const CHAT = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '先跑测试还是先提交?' },
  { role: 'assistant', content: '建议先跑测试。要我现在跑吗?' },
];
const ask = (over: Record<string, unknown> = {}) => suggestNextPrompt({ sessionId: 'S', userId: 'u1', appId: 'tangu', runId: 'R1', ...over });

beforeEach(() => {
  payloads = [];
  reply = { content: '跑吧', usage: { prompt_tokens: 900, cached_tokens: 850, completion_tokens: 4 }, finishReason: 'stop' };
  __resetSuggestionSeedsForTests();
  configure();
});
afterEach(() => { vi.useRealTimers(); });

describe('suggestNextPrompt', () => {
  it('没有快照 → 空,一次模型都不调', async () => {
    expect(await ask()).toEqual({ suggestion: '' });
    expect(payloads).toHaveLength(0);
  });

  it('请求 = 快照 + 尾部指令,工具头 / 思考档 / 缓存路由键与主循环对齐', async () => {
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    const out = await ask();
    expect(out).toEqual({ suggestion: '跑吧', usage: { prompt: 900, cached: 850, completion: 4 } });
    const p = payloads[0];
    expect(p.messages.slice(0, -1)).toEqual(CHAT); // 前缀原样,一个字不多不少
    expect(p.messages.at(-1)).toEqual({ role: 'user', content: SUGGEST_INSTRUCTION });
    expect(p.tools).toBe(TOOLS); // 同一份引用
    expect(p.thinkingLevel).toBe('high');
    expect(p.cacheKey).toBe('S');
    expect(p.agentId).toBe('tangu'); // 路由键缺省按 agent + 模型取:少了它就落到另一个缓存桶
    expect(p.verbosity).toBe('low');
  });

  it('取走即删:同一轮再问拿空,不再调模型', async () => {
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    await ask();
    expect(await ask()).toEqual({ suggestion: '' });
    expect(payloads).toHaveLength(1);
  });

  it('run 对不上 → 空,快照留给对的那一轮', async () => {
    stashSuggestionSeed('S', 'R2', seedOf(CHAT));
    expect((await ask({ runId: 'R1' })).suggestion).toBe('');
    expect(payloads).toHaveLength(0);
    expect((await ask({ runId: 'R2' })).suggestion).toBe('跑吧');
  });

  it('过期 → 空;到点自己放手(没人来拉也不一直攥着快照)', async () => {
    vi.useFakeTimers();
    let alive = 0;
    const seed = seedOf(CHAT);
    stashSuggestionSeed('S', 'R1', { ...seed, getMessages: () => { alive++; return seed.getMessages(); } });
    vi.advanceTimersByTime(91_000);
    expect((await ask()).suggestion).toBe('');
    expect(payloads).toHaveLength(0);
    expect(alive).toBe(0); // 快照已经放掉,连读都没读
  });

  it('只留最近 4 个会话的快照', async () => {
    for (const sid of ['A', 'B', 'C', 'D', 'E']) stashSuggestionSeed(sid, 'R1', seedOf(CHAT));
    expect((await ask({ sessionId: 'A' })).suggestion).toBe('');
    expect((await ask({ sessionId: 'E' })).suggestion).toBe('跑吧');
  });

  it('云端(非 hostExec)不存快照', async () => {
    configure(false);
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    configure(true);
    expect((await ask()).suggestion).toBe('');
  });

  it('收尾不是模型正文(异常出口)/ 上下文快满 / 额度不够 → 不问', async () => {
    stashSuggestionSeed('S', 'R1', seedOf(CHAT.slice(0, 2)));
    expect((await ask()).suggestion).toBe('');
    stashSuggestionSeed('S', 'R1', seedOf(CHAT, { contextWindow: 10 }));
    expect((await ask()).suggestion).toBe('');
    configure(true, false);
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    expect((await ask()).suggestion).toBe('');
    expect(payloads).toHaveLength(0);
  });

  it('尾部悬空的工具批次先剥掉(协议要求调用 / 结果配对)', async () => {
    const withTools = [...CHAT.slice(0, 2), { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'x' }, CHAT[2]];
    stashSuggestionSeed('S', 'R1', seedOf(withTools));
    await ask();
    expect(payloads[0].messages.slice(0, -1)).toEqual(withTools); // 以正文收尾的整段都在
  });

  it('模型调用失败 / 被截断 / 带着工具调用回来 → 空,不抛', async () => {
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    reply = { content: '跑', usage: {}, finishReason: 'length' };
    expect((await ask()).suggestion).toBe('');
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    reply = { content: '我来跑测试', toolCalls: [{ id: 't', function: { name: 'run_bash', arguments: '{}' } }], usage: { prompt_tokens: 9 }, finishReason: 'tool_calls' };
    expect(await ask()).toEqual({ suggestion: '', usage: { prompt: 9, cached: 0, completion: 0 } }); // 用量照记
    stashSuggestionSeed('S', 'R1', seedOf(CHAT));
    reply = Promise.reject(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await ask()).toEqual({ suggestion: '' });
    warn.mockRestore();
  });
});

describe('cleanSuggestion', () => {
  it('一句话原样;外层引号去掉', () => {
    expect(cleanSuggestion('  跑一下测试  ')).toBe('跑一下测试');
    expect(cleanSuggestion('"run the tests"')).toBe('run the tests');
    expect(cleanSuggestion('「先提交」')).toBe('先提交');
  });
  it('NONE / 空 / 多行 / 太长 / 写成工具调用 → 空', () => {
    expect(cleanSuggestion('NONE')).toBe('');
    expect(cleanSuggestion('none.')).toBe('');
    expect(cleanSuggestion('')).toBe('');
    expect(cleanSuggestion(undefined)).toBe('');
    expect(cleanSuggestion('跑测试\n因为你刚才问了')).toBe('');
    expect(cleanSuggestion('字'.repeat(SUGGEST_MAX_CHARS + 1))).toBe('');
    expect(cleanSuggestion('字'.repeat(SUGGEST_MAX_CHARS))).toHaveLength(SUGGEST_MAX_CHARS);
    expect(cleanSuggestion('to=read_file json{"path":"a.ts"}')).toBe('');
  });
});
