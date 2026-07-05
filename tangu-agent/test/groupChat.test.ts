/**
 * 群聊编排单测(无网络:fake llm/state/billing 经 configureTangu 注入)。
 * 覆盖:发言顺序、各 agent 私有持久上下文(只见他人公开发言、不见他人私有人格)、
 * 投票过半提前停 / 不足跑满轮数、<2 参与者报错、主持人总结(是/否)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { runGroupChat } from '../src/services/groupChat.js';
import { resolveInquiry } from '../src/services/inquiries.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

let home: string;
let events: Array<{ type: string; payload: any }>;
let finals: Array<{ content: string; modelId: string }>;
let statuses: Array<{ status: string; extra: any }>;
let calls: Array<{ cacheKey: string; messages: any[]; toolChoice: any }>;
let voteDecider: (slug: string) => boolean;
let inquiryAnswer: string;

const slugFromKey = (k: string): string => (k.split(':grp:')[1] || '');

function writeAgent(slug: string, name: string, body: string): void {
  writeFileSync(join(home, 'agents', `${slug}.md`), `---\nname: ${name}\ncreated_by: user\n---\n${body}\n`, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-group-'));
  process.env.TANGU_HOME = home;
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeAgent('alpha', 'Alpha', '你是 Alpha,只有 Alpha 知道的秘密人格 AAA。');
  writeAgent('beta', 'Beta', '你是 Beta,只有 Beta 知道的秘密人格 BBB。');

  events = []; finals = []; statuses = []; calls = [];
  voteDecider = () => false;
  inquiryAnswer = '否,不用';
  const perSlug: Record<string, number> = {};

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ cacheKey: o.cacheKey, messages: o.messages, toolChoice: o.toolChoice }),
    streamProviderCompletion: async (o: any) => {
      const p = o.payload;
      calls.push({ cacheKey: p.cacheKey, messages: p.messages, toolChoice: p.toolChoice });
      const usage = { prompt_tokens: 10, completion_tokens: 5 };
      if (p.toolChoice && p.toolChoice.function?.name === 'cast_vote') {
        const end = voteDecider(slugFromKey(p.cacheKey));
        return { content: '', reasoning: '', toolCalls: [{ id: 'v', type: 'function', function: { name: 'cast_vote', arguments: JSON.stringify({ end, reason: 'r' }) } }], usage };
      }
      const slug = slugFromKey(p.cacheKey);
      perSlug[slug] = (perSlug[slug] || 0) + 1;
      const text = slug === 'host' ? 'HOST-SUMMARY' : `${slug}-speech-${perSlug[slug]}`;
      if (o.onToken) o.onToken(text);
      return { content: text, reasoning: '', toolCalls: [], usage };
    },
  };
  const fakeState: any = {
    insertUserMessage: async () => {},
    finalizeAssistantMessage: async (m: any) => { finals.push({ content: m.content, modelId: m.modelId }); },
    appendEvent: async (_r: string, type: string, payload: any) => {
      events.push({ type, payload });
      if (type === 'inquiry_request') queueMicrotask(() => resolveInquiry(payload.inquiryId, inquiryAnswer));
      return events.length;
    },
    drain: async () => {},
    updateRunStatus: async (_id: string, status: string, extra: any) => { statuses.push({ status, extra }); },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host: hostStub, brain: { llm: fakeLlm } as any, billing: fakeBilling, profile, state: fakeState });
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function params(over: Partial<any> = {}): any {
  return {
    runId: 'r1', sessionId: 's1', userId: 'u1', appId: 'tangu', modelId: 'gpt',
    execMode: 'host', cwd: '/tmp', profile,
    agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 2 },
    message: 'discuss X', userMessageId: 'um1', attachments: [],
    signal: new AbortController().signal,
    ...over,
  };
}

const speechCalls = (slug: string) =>
  calls.filter((c) => slugFromKey(c.cacheKey) === slug && (c.toolChoice === 'auto' || c.toolChoice === 'none'));

describe('runGroupChat', () => {
  it('agents speak in order; each keeps a private persistent context (sees others\' public speech, not their persona)', async () => {
    await runGroupChat(params());
    // 4 条发言(2 agent × 2 轮),顺序 alpha,beta,alpha,beta
    expect(finals.map((f) => f.content)).toEqual([
      '**🗣 Alpha**\n\nalpha-speech-1',
      '**🗣 Beta**\n\nbeta-speech-1',
      '**🗣 Alpha**\n\nalpha-speech-2',
      '**🗣 Beta**\n\nbeta-speech-2',
    ]);
    // alpha 第 2 轮发言的上下文:含自己上轮发言(持久)+ beta 上轮公开发言(delta),且不含 beta 私有人格
    const alpha2 = speechCalls('alpha')[1];
    const flat = alpha2.messages.map((m: any) => String(m.content || '')).join('\n');
    expect(alpha2.messages.some((m: any) => m.role === 'assistant' && m.content === 'alpha-speech-1')).toBe(true);
    expect(flat).toContain('beta-speech-1');
    expect(flat).toContain('You are "Alpha"');    // 自己的人格在
    expect(flat).not.toContain('只有 Beta 知道');  // 他人私有人格不泄露
    // 终态 done
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(statuses.at(-1)?.status).toBe('done');
  });

  it('majority vote ends the discussion early', async () => {
    voteDecider = () => true; // 全员投票结束
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 5 } }));
    // 只跑 1 轮(2 条发言)即停
    expect(finals.filter((f) => f.content.includes('speech')).length).toBe(2);
    const vote = events.find((e) => e.type === 'group_vote');
    expect(vote?.payload).toMatchObject({ endCount: 2, total: 2 });
    expect(events.find((e) => e.type === 'group_ended')?.payload.reason).toBe('vote');
  });

  it('runs to maxRounds when no majority', async () => {
    voteDecider = () => false;
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 3 } }));
    expect(finals.filter((f) => f.content.includes('speech')).length).toBe(6); // 3 轮 × 2
    expect(events.find((e) => e.type === 'group_ended')?.payload.reason).toBe('max_rounds');
  });

  it('errors (no done) with fewer than 2 valid participants', async () => {
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha'], groupMaxRounds: 2 } }));
    expect(events.find((e) => e.type === 'error')?.payload.error).toBe('group_needs_2_agents');
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(statuses.at(-1)?.status).toBe('failed');
    expect(finals.length).toBe(0);
  });

  it('host summarizes when user says yes, not when no', async () => {
    voteDecider = () => true;
    inquiryAnswer = '是,总结';
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 3 } }));
    expect(finals.some((f) => f.content.includes('主持人') && f.content.includes('HOST-SUMMARY'))).toBe(true);

    // 重置并选「否」
    events = []; finals = []; statuses = []; calls = [];
    inquiryAnswer = '否,不用';
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 3 } }));
    expect(finals.some((f) => f.content.includes('HOST-SUMMARY'))).toBe(false);
  });

  it('temporary agents participate alongside saved agents (not on disk)', async () => {
    const temp = { slug: 'temp-x', name: 'Gamma', systemPrompt: '你是临时 Gamma。' };
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'temp-x'], groupTempAgents: [temp], groupMaxRounds: 1 } }));
    expect(finals.map((f) => f.content)).toEqual([
      '**🗣 Alpha**\n\nalpha-speech-1',
      '**🗣 Gamma**\n\ntemp-x-speech-1',
    ]);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('drops invalid temp agents (missing required fields) → <2 errors', async () => {
    const bad = { slug: 'temp-bad', name: 'NoPrompt' }; // 缺 systemPrompt → sanitize 丢弃
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'temp-bad'], groupTempAgents: [bad], groupMaxRounds: 2 } }));
    expect(events.find((e) => e.type === 'error')?.payload.error).toBe('group_needs_2_agents');
  });
});
