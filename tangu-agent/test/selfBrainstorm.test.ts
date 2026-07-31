/**
 * self_brainstorm 仪器(2026-07-30 设计评审 + Codex 评审闭环后的命门):
 *   1. **前缀逐字节一致** = 缓存命中承诺的守门员:分身请求 messages 的前 |prefix| 条必须与
 *      workingMessages 快照(剥尾部悬空工具批次后)JSON 逐字节相等;阶段二必须是各席自己
 *      阶段一序列的纯延长;cacheKey=主会话 sessionId;**工具面与思考档必须随父**(schema/档位
 *      参与 provider 前缀缓存,不一致=全 miss——Codex 评审 #1)。
 *   2. **逐请求深拷贝**:payload 构建器原地改消息(prefix-thinking 注 system)不得污染其它分身(#2)。
 *   3. 结构层不可让渡:对抗席无条件追加(#7);首轮独立;共发同批其它工具直接拒(#5)。
 *   4. 收敛如实汇报:单轮/批判轮失败不得谎称 cross-critique 发生过(#6);失败席位标注。
 * 无网络:fake brain.llm 经 configureTangu 注入,捕获全部 buildProviderPayload 入参。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import {
  resolveSeats,
  buildSharedPrefix,
  runSelfBrainstorm,
  DEFAULT_SEATS,
  CHALLENGER_SEAT,
} from '../src/services/selfBrainstorm.js';
import type { ChatMessage } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

interface Captured { messages: any[]; cacheKey?: string; temperature?: number; tools?: any; thinkingLevel?: string; maxTokens?: number; toolChoice?: string }
let captured: Captured[] = [];
let failSeatRe: RegExp | null = null; // 匹配席位名 → 第 1 轮补全抛错
let fail2SeatRe: RegExp | null = null; // 匹配席位名 → 第 2 轮补全抛错
let emptySeatRe: RegExp | null = null; // 匹配席位名 → 只回工具调用不回正文

function seatOf(messages: any[]): string {
  const last = String(messages[messages.length - 1]?.content || '');
  const m = last.match(/Your seat: ([^\n]+)/) || last.match(/your seat: ([^;]+);/i);
  return (m?.[1] || '?').trim();
}
function roundOf(messages: any[]): 1 | 2 {
  return String(messages[messages.length - 1]?.content || '').includes('Round 2') ? 2 : 1;
}

const fakeLlm: any = {
  resolveModelAndKey: async () => ({ model: { provider: 'openai' }, apiKey: 'k', baseUrl: 'http://x', apiModelId: 'm' }),
  buildProviderPayload: async (opts: any) => {
    // 先深拷贝捕获,再模拟真实构建器的**原地变异**(openaiCompat prefix-thinking 注 system):
    // 若服务侧没做逐请求深拷贝,这个变异会串进其它分身/后续轮次的捕获里。
    captured.push(JSON.parse(JSON.stringify({
      messages: opts.messages, cacheKey: opts.cacheKey, temperature: opts.temperature,
      tools: opts.tools, thinkingLevel: opts.thinkingLevel, maxTokens: opts.maxTokens, toolChoice: opts.toolChoice,
    })));
    if (opts.messages[0]) opts.messages[0].content = String(opts.messages[0].content) + '!MUTATED';
    return { messages: opts.messages };
  },
  streamProviderCompletion: async ({ payload }: any) => {
    const seat = seatOf(payload.messages);
    const round = roundOf(payload.messages);
    if (round === 1 && failSeatRe?.test(seat)) throw new Error('boom-' + seat);
    if (round === 2 && fail2SeatRe?.test(seat)) throw new Error('r2boom-' + seat);
    if (emptySeatRe?.test(seat)) return { content: '', toolCalls: [{ id: 't' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return { content: `R${round}-${seat}`, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  },
};

const snapshot: ChatMessage[] = [
  { role: 'system', content: 'SYS' } as ChatMessage,
  { role: 'user', content: 'q1' } as ChatMessage,
  { role: 'assistant', content: 'a1' } as ChatMessage,
  { role: 'user', content: 'decide X or Y?' } as ChatMessage,
  { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'self_brainstorm', arguments: '{}' } }] } as any,
];

function mkCtx(snap: ChatMessage[] = snapshot): any {
  return {
    userId: 'u', sessionId: 'sess-1', appId: 'tangu', modelId: 'm1', profile, execMode: 'host', thinkingLevel: 'high',
    getWorkingMessages: () => snap.map((m) => ({ ...m })),
  };
}

beforeEach(() => {
  captured = [];
  failSeatRe = fail2SeatRe = emptySeatRe = null;
  configureTangu({ host: hostStub, brain: { llm: fakeLlm } as any, billing: {} as any, profile, state: {} as any });
});

describe('resolveSeats — 内容层归主人格,结构层无条件补对抗席', () => {
  it('不传 → 默认三席;自定义 → 正典 Challenger 一律追加(名字像 Critic 也不豁免)', () => {
    expect(resolveSeats(undefined)).toEqual(DEFAULT_SEATS);
    expect(resolveSeats([{ name: 'Migration Cost', brief: 'estimate it' }]).map((s) => s.name)).toEqual(['Migration Cost', 'Challenger']);
    // 名字对抗但简报可以是捧场的——正则拦不住,所以正典席无条件在场
    const withAdvName = resolveSeats([{ name: 'Critic', brief: 'support the plan' }]);
    expect(withAdvName.some((s) => s === CHALLENGER_SEAT)).toBe(true);
    expect(withAdvName.length).toBe(2); // 顺带保证 ≥2 席
  });

  it('自定义至多 3 席 + 对抗席,总席位 ≤4;无效条目剔除', () => {
    const many = resolveSeats([
      { name: 'A', brief: 'a' }, { name: 'B', brief: 'b' }, { name: 'C', brief: 'c' },
      { name: 'D', brief: 'd' }, { name: '', brief: 'x' }, { brief: 'no name' },
    ]);
    expect(many.length).toBe(4);
    expect(many[3]).toEqual(CHALLENGER_SEAT);
  });
});

describe('buildSharedPrefix — 分叉点=尾部悬空工具批次之前', () => {
  it('剥掉带未配对 tool_calls 的尾部 assistant;完整配对的历史保留', () => {
    const prefix = buildSharedPrefix(snapshot);
    expect(prefix.length).toBe(4);
    expect((prefix[3] as any).content).toBe('decide X or Y?');
    const withPair: ChatMessage[] = [
      { role: 'user', content: 'u' } as ChatMessage,
      { role: 'assistant', content: '', tool_calls: [{ id: 't' }] } as any,
      { role: 'tool', content: 'r', tool_call_id: 't' } as any,
      { role: 'assistant', content: 'done' } as ChatMessage,
    ];
    expect(buildSharedPrefix(withPair).length).toBe(4);
  });
});

describe('runSelfBrainstorm — 缓存守门 + 两阶段 + 机械汇编', () => {
  it('命门:每席每轮前缀逐字节=快照;工具面/思考档随父;深拷贝隔离构建器变异;阶段二=席内纯延长', async () => {
    const digest = await runSelfBrainstorm({ topic: 'X or Y', ctx: mkCtx() });
    const prefix = buildSharedPrefix(snapshot);
    expect(captured.length).toBe(6); // 3 席 × 2 轮
    for (const c of captured) {
      // 深拷贝隔离:fake 构建器每次都把 messages[0].content 改成 SYS!MUTATED——
      // 捕获若见到 MUTATED 说明分身间共享了对象(浅拷贝),缓存前缀已被交叉污染。
      expect(c.messages[0].content).toBe('SYS');
      expect(JSON.stringify(c.messages.slice(0, prefix.length))).toBe(JSON.stringify(prefix));
      expect(c.cacheKey).toBe('sess-1');
      expect(c.temperature).toBe(0.9);
      expect(c.thinkingLevel).toBe('high'); // 随父档,不许写死 medium
      expect(c.maxTokens).toBe(2000);
      expect(c.toolChoice).toBe('auto');
      // 工具 schema 参与前缀缓存:必须带上与父一致的定义面(host 全集,含本工具自身)
      expect(Array.isArray(c.tools)).toBe(true);
      expect(c.tools.some((t: any) => t?.function?.name === 'self_brainstorm')).toBe(true);
      expect(c.tools.some((t: any) => t?.function?.name === 'run_bash')).toBe(true);
    }
    const r2s = captured.filter((c) => roundOf(c.messages) === 2);
    expect(r2s.length).toBe(3);
    for (const c of r2s) {
      const seat = seatOf(c.messages);
      const r1 = captured.find((x) => roundOf(x.messages) === 1 && seatOf(x.messages) === seat)!;
      expect(c.messages.length).toBe(prefix.length + 3);
      expect(JSON.stringify(c.messages.slice(0, r1.messages.length))).toBe(JSON.stringify(r1.messages));
      expect(c.messages[prefix.length + 1]).toEqual({ role: 'assistant', content: `R1-${seat}` });
      const last = String(c.messages[c.messages.length - 1].content);
      for (const s of DEFAULT_SEATS) {
        if (s.name === seat) expect(last).not.toContain(`### ${s.name}\nR1-${s.name}`);
        else expect(last).toContain(`### ${s.name}\nR1-${s.name}`);
      }
    }
    for (const s of DEFAULT_SEATS) expect(digest).toContain(`### ${s.name}\nR2-${s.name}`);
    expect(digest).toContain('independent takes, then cross-critique');
  });

  it('rounds=1:只发 3 次补全,摘要如实写单轮,不谎称批判轮', async () => {
    const digest = await runSelfBrainstorm({ topic: 'T', rounds: 1, ctx: mkCtx() });
    expect(captured.length).toBe(3);
    expect(digest).toContain('independent takes (single round)');
    expect(digest).not.toContain('then cross-critique');
    expect(digest).toContain('### Challenger\nR1-Challenger');
  });

  it('单席一轮失败:其余照常;二轮失败:回退一轮陈述且如实标注;全失败才报错', async () => {
    failSeatRe = /Steelman/;
    const digest = await runSelfBrainstorm({ topic: 'T', ctx: mkCtx() });
    expect(digest).toContain('(seat failed: boom-Steelman Builder)');
    expect(digest).toContain('### Challenger\nR2-Challenger');

    failSeatRe = null;
    fail2SeatRe = /Alternative/;
    const d2 = await runSelfBrainstorm({ topic: 'T', ctx: mkCtx() });
    expect(d2).toContain('### Alternative Seeker\nR1-Alternative Seeker\n(cross-critique round failed for this seat');
    expect(d2).toContain('### Challenger\nR2-Challenger');

    fail2SeatRe = null;
    failSeatRe = /.*/;
    const all = await runSelfBrainstorm({ topic: 'T', ctx: mkCtx() });
    expect(all.startsWith('Error: all brainstorm seats failed')).toBe(true);
  });

  it('只回工具调用不回正文的席位=失败(分身无工具,调用被丢弃)', async () => {
    emptySeatRe = /Challenger/;
    const digest = await runSelfBrainstorm({ topic: 'T', rounds: 1, ctx: mkCtx() });
    expect(digest).toContain('(seat failed: seat emitted only tool calls (discarded)');
    expect(digest).toContain('### Steelman Builder\nR1-Steelman Builder');
  });

  it('同批共发其它工具 → 拒绝并教单独调用;独发+同轮旁白 → 旁白进分身前缀', async () => {
    const coIssued = snapshot.slice(0, 4).concat([
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'self_brainstorm', arguments: '{}' } },
      ] } as any,
    ]);
    const r = await runSelfBrainstorm({ topic: 'T', ctx: mkCtx(coIssued) });
    expect(r).toContain('ONLY tool call');

    const withPreamble = snapshot.slice(0, 4).concat([
      { role: 'assistant', content: 'let me stress-test this first', tool_calls: [
        { id: 'b', type: 'function', function: { name: 'self_brainstorm', arguments: '{}' } },
      ] } as any,
    ]);
    await runSelfBrainstorm({ topic: 'T', rounds: 1, ctx: mkCtx(withPreamble) });
    const msgs = captured[0].messages;
    expect(msgs[msgs.length - 2]).toEqual({ role: 'assistant', content: 'let me stress-test this first' });
  });

  it('无 getWorkingMessages 接缝(子代理/群聊旁路 loop)→ 优雅报错不抛', async () => {
    const ctx = mkCtx();
    delete ctx.getWorkingMessages;
    const r = await runSelfBrainstorm({ topic: 'T', ctx });
    expect(r).toContain('unavailable in this run mode');
  });
});
