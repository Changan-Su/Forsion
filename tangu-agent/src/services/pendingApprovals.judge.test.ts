/** 代批判官(judgeApproval)的两条钉(2026-09-14):
 *  ① C-5 台账:判官这次 LLM 调用发一条 phase='muse-judge' 的 usage 事件,且挂在**父 Muse run** 上
 *     —— tokensInWindow 按 agent_run_events → agent_runs → chat_sessions(kind='muse')连接取数,
 *     挂到别的 runId 上这笔钱对预算就是隐形的;
 *  ② D3:判官下发 thinkingLevel='low'(缺省档在部分端点 = high,判一个 JSON 二选一不值这个钱)。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  events: [] as Array<{ runId: string; type: string; payload: any }>,
  payloadOpts: [] as any[],
}));

vi.mock('../core/db.js', () => ({ query: vi.fn(async () => []) }));
vi.mock('../tools/builtin/inboxSend.js', () => ({ MUSE_SENDER_ID: 'muse', sendInboxMessage: vi.fn(async () => ({ ok: true })) }));
vi.mock('../tools/toolRegistry.js', () => ({
  listToolProviders: () => [{ origin: 'builtin', tools: () => [{ name: 'write_file' }] }],
  AGENT_SCOPED_TOOLS: new Set(['manage_harness', 'manage_skill', 'manage_agent']), // deferApproval 的 ALS 闸要读
}));
vi.mock('../agents/agentRegistry.js', () => ({
  MUSE_AGENT_SLUG: 'muse',
  getAgent: vi.fn(async () => ({ model: 'm1', name: 'Default' })),
}));
vi.mock('./eventBus.js', () => ({
  publish: vi.fn(async (runId: string, type: string, payload: any) => { state.events.push({ runId, type, payload }); }),
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({
    brain: {
      memory: { getMemory: async () => ({ content: '' }), appendLogEntry: async () => {} },
      users: { getUserById: async () => ({ username: 'u1' }) },
      llm: {
        resolveModelAndKey: async () => ({ model: { id: 'm1', provider: 'p' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'am' }),
        buildProviderPayload: async (opts: any) => { state.payloadOpts.push(opts); return { ok: true }; },
        streamProviderCompletion: async () => ({
          content: '{"approve":false,"reason":"not sure"}',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      },
    },
    billing: { calculateCost: async () => 0.01, logApiUsage: async () => {} },
  }),
}));

import { judgeApproval } from './pendingApprovals.js';

const call = { id: 'c1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: '/tmp/x.md', content: 'hi' }) } };

beforeEach(() => { state.events.length = 0; state.payloadOpts.length = 0; });

describe('代批判官的用量台账与思考档', () => {
  it('发一条 phase=muse-judge 的 usage 事件,挂在父 Muse run 上;provider 没报缓存 → cacheReported=false', async () => {
    const v = await judgeApproval({ userId: 'u1', agentSlug: 'muse', call, preview: 'write /tmp/x.md', runId: 'r-parent' });
    expect(v.approve).toBe(false);
    const usage = state.events.filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].runId).toBe('r-parent');
    expect(usage[0].payload.phase).toBe('muse-judge');
    expect(usage[0].payload.prompt).toBe(100);
    expect(usage[0].payload.completion).toBe(20);
    expect(usage[0].payload.cached).toBe(0);
    expect(usage[0].payload.cacheReported).toBe(false);
  });

  it('D3:判官的 buildProviderPayload 显式带 thinkingLevel=low', async () => {
    await judgeApproval({ userId: 'u1', agentSlug: 'muse', call, preview: 'write /tmp/x.md', runId: 'r-parent' });
    expect(state.payloadOpts).toHaveLength(1);
    expect(state.payloadOpts[0].thinkingLevel).toBe('low');
  });
});
