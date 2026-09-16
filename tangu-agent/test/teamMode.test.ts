/**
 * 团队运行模式(新工作区 × 轨道体系 P5a/P5b):同一条 runGroupChat,teamMode 决定发言调度。
 * 钉的是:collabNext / parseMentions 纯函数;协作模式「被 @ 者优先 → 轮转未发言者 → 整周期无人点名且无人写 DONE → idle」;
 * 「无人点名但用户有新插话 → 不停」负对照;用户插话在发言人边界落库 + 进下一位的 delta + turn_boundary 通知;
 * 每条发言 finalize 带 agentSlug;teamDoc 注入每位成员 system,首条用户消息不再烤进 system;未知 teamMode 回落会议。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { runGroupChat, collabNext, parseMentions, type CollabState } from '../src/services/groupChat.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

describe('collabNext / parseMentions(纯函数)', () => {
  it('被 @ 者 FIFO 优先;不在场的点名跳过;然后按成员序轮转本周期未发言者;全员发过 → null', () => {
    const st: CollabState = { participants: ['a', 'b', 'c'], pending: ['zzz', 'c'], cycleSpoken: new Set(['a']) };
    expect(collabNext(st)).toBe('c');
    expect(collabNext(st)).toBe('b');
    st.cycleSpoken.add('b'); st.cycleSpoken.add('c');
    expect(collabNext(st)).toBeNull();
  });
  it('按出现顺序解析 @<name> / @<slug>,排除自己,模型不守约定 = 空', () => {
    const ps = [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta Bo' }, { slug: 'gamma', name: 'Gamma' }];
    expect(parseMentions('先 @Gamma 看看,再 @Beta Bo 补测试;@Alpha 我自己不算', ps, 'alpha')).toEqual(['gamma', 'beta']);
    expect(parseMentions('@beta 用 slug 也行', ps, 'alpha')).toEqual(['beta']);
    expect(parseMentions('没有点名', ps, 'alpha')).toEqual([]);
  });
});

let home: string;
let events: Array<{ type: string; payload: any }>;
let finals: Array<{ content: string; agentSlug?: string }>;
let inserted: Array<{ id: string; content: string }>;
let calls: Array<{ cacheKey: string; messages: any[]; toolChoice: any }>;
let script: Record<string, string[]>; // slug → 依次发言
const slugFromKey = (k: string): string => (k.split(':grp:')[1] || '');

function writeAgent(slug: string, name: string): void {
  writeFileSync(join(home, 'agents', `${slug}.md`), `---\nname: ${name}\ncreated_by: user\n---\n你是 ${name}。\n`, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-team-'));
  process.env.TANGU_HOME = home;
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeAgent('alpha', 'Alpha'); writeAgent('beta', 'Beta');
  events = []; finals = []; inserted = []; calls = []; script = {};
  const n: Record<string, number> = {};
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    // 快照:ctx 是每位成员的持久数组(后续 push 会改到同一引用),按调用时刻拷一份才能看「那一次」的 delta。
    buildProviderPayload: async (o: any) => ({ cacheKey: o.cacheKey, messages: o.messages.map((m: any) => ({ ...m })), toolChoice: o.toolChoice }),
    streamProviderCompletion: async (o: any) => {
      const p = o.payload;
      calls.push({ cacheKey: p.cacheKey, messages: p.messages, toolChoice: p.toolChoice });
      const usage = { prompt_tokens: 10, completion_tokens: 5 };
      if (p.toolChoice && p.toolChoice.function?.name === 'cast_vote') {
        return { content: '', reasoning: '', toolCalls: [{ id: 'v', type: 'function', function: { name: 'cast_vote', arguments: JSON.stringify({ end: false, reason: 'r' }) } }], usage };
      }
      const slug = slugFromKey(p.cacheKey);
      n[slug] = (n[slug] || 0) + 1;
      const text = (script[slug] || [])[n[slug] - 1] ?? `${slug}-${n[slug]}`;
      return { content: text, reasoning: '', toolCalls: [], usage };
    },
  };
  const fakeState: any = {
    insertUserMessage: async (m: any) => { inserted.push({ id: m.id, content: m.content }); },
    finalizeAssistantMessage: async (m: any) => { finals.push({ content: m.content, agentSlug: m.agentSlug }); },
    appendEvent: async (_r: string, type: string, payload: any) => { events.push({ type, payload }); return events.length; },
    drain: async () => {},
    updateRunStatus: async () => {},
    countSessionMessages: async () => 0,
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host: hostStub, brain: { llm: fakeLlm } as any, billing: fakeBilling, profile, state: fakeState });
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function params(over: Partial<any> = {}): any {
  return {
    runId: 'r1', sessionId: 's1', userId: 'u1', appId: 'tangu', modelId: 'gpt', execMode: 'host', cwd: '/tmp', profile,
    agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 4, groupNoSummary: true, groupSeedHistory: false, teamMode: 'collab' },
    message: 'start', userMessageId: 'um1', attachments: [], signal: new AbortController().signal, ...over,
  };
}
const speakers = () => events.filter((e) => e.type === 'group_speaker' && e.payload.phase === 'start').map((e) => e.payload.slug);
const ended = () => events.find((e) => e.type === 'group_ended')?.payload;

describe('协作模式', () => {
  it('被 @ 者优先 → 轮转 → 周期分隔 → 整周期无人点名且无人写 DONE → idle 停;事件带 mode/step', async () => {
    script = { alpha: ['@Beta 你先做接口', '我这边没事了'], beta: ['接口好了 DONE', '好'] };
    await runGroupChat(params());
    // 周期 1:alpha(轮转首位)→ beta(被点名);周期 2:alpha → beta(都无点名、无 DONE)→ idle
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(ended()).toMatchObject({ reason: 'idle', mode: 'collab', steps: 4, rounds: 2 });
    expect(events.some((e) => e.type === 'group_cycle' && e.payload.cycle === 2)).toBe(true);
    expect(events.filter((e) => e.type === 'group_voting').length).toBe(0); // 协作没有投票
    expect(finals.map((f) => f.agentSlug)).toEqual(['alpha', 'beta', 'alpha', 'beta']);
  });

  it('全员 DONE 且无人再点名 → done 停', async () => {
    script = { alpha: ['分工完毕 DONE'], beta: ['DONE'] };
    await runGroupChat(params());
    expect(speakers()).toEqual(['alpha', 'beta']);
    expect(ended().reason).toBe('done');
  });

  it('负对照:无人点名但用户在边界插话 → 本周期重来、不 idle;插话落库 + 进下一位 delta + turn_boundary', async () => {
    script = { alpha: ['a1', 'a2', 'a3'], beta: ['b1', 'b2', 'b3'] };
    let once = true;
    const drainSteer = (): any[] => {
      // 第 3 步(周期 2 的 alpha)之前注入一条插话:此时周期 1 已整周期无点名,若无插话本应 idle
      if (once && speakers().length === 2) { once = false; return [{ id: 'st1', content: '别忘了 v1 兼容' }]; }
      return [];
    };
    await runGroupChat(params({ drainSteer }));
    expect(inserted.filter((m) => m.id !== 'um1')).toEqual([{ id: 'st1', content: '别忘了 v1 兼容' }]); // um1 = 开场白落库(既有行为)
    const tb = events.find((e) => e.type === 'turn_boundary');
    expect(tb?.payload.userMessages).toEqual([{ id: 'st1', content: '别忘了 v1 兼容' }]);
    expect(tb?.payload.finalizedAssistantId).toBeTruthy();
    // 插话后下一位(alpha)的 delta 含 [User] 行
    const afterIdx = events.indexOf(tb!);
    const nextStart = events.slice(afterIdx).find((e) => e.type === 'group_speaker' && e.payload.phase === 'start');
    expect(nextStart?.payload.slug).toBe('alpha');
    // 插话之后 alpha 的第 2 次发言(紧跟 turn_boundary 的那次)的 delta 含 [User] 行;再之后的 delta 不再重复它
    const alphaSpeech = calls.filter((c) => slugFromKey(c.cacheKey) === 'alpha' && !(c.toolChoice?.function));
    const delta2 = String(alphaSpeech[1].messages.filter((m: any) => m.role === 'user').at(-1)!.content);
    expect(delta2).toContain('[User] 别忘了 v1 兼容');
    const delta3 = String(alphaSpeech[2].messages.filter((m: any) => m.role === 'user').at(-1)!.content);
    expect(delta3).not.toContain('别忘了 v1 兼容');
    // 插话让本周期重来(alpha、beta 再各说一次)→ 周期 2 全员无点名 → 才 idle:共 6 步
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta']);
    expect(ended().reason).toBe('idle');
  });
});

describe('会议模式与共用行为', () => {
  it('未知 teamMode 回落会议:固定发言序 + 投票;首条用户消息不再烤进 system,teamDoc 注入每位成员 system', async () => {
    script = { alpha: ['a1', 'a2'], beta: ['b1', 'b2'] };
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 2, groupNoSummary: true, groupSeedHistory: false, teamMode: 'bogus', teamDoc: '# Team\nAlpha owns API; Beta owns tests.' } }));
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(ended()).toMatchObject({ mode: 'meeting' });
    expect(events.filter((e) => e.type === 'group_voting').length).toBe(1);
    const sys = String(calls[0].messages[0].content);
    expect(sys).toContain('Alpha owns API; Beta owns tests.');
    expect(sys).not.toContain('The topic of this discussion');
    expect(sys).not.toContain('\nstart'); // 首条用户消息只在 transcript(delta)里,不在 system
  });
});
