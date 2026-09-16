/**
 * 团队运行模式编排单测(无网络:fake state/billing 经 configureTangu 注入;成员载体 = 注入的假 activateMember,只验编排)。
 * 覆盖:并行周期与显式上限、全员 DONE 即停、最后一步全员 DONE 记 done、重复 slug 去重、无缺省上限、<2 参与者报错、主持人总结(是/否)、
 * 临时 Agent 参与 / 校验丢弃。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { runGroupChat } from '../src/services/groupChat.js';
import { resolveInquiry } from '../src/services/inquiries.js';
import type { ActivateMember } from '../src/services/teamRuns.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

let home: string;
let events: Array<{ type: string; payload: any }>;
let finals: Array<{ content: string; modelId: string }>;
let statuses: Array<{ status: string; extra: any }>;
let acts: Array<{ slug: string; nth: number; delta: string }>;
/** 每位成员「说完这句要不要继续」:true = 这条发言以 DONE 收尾。 */
let doneDecider: (slug: string, nth: number) => boolean;
let inquiryAnswer: string;

const fakeActivate: ActivateMember = async (a) => {
  const slug = a.member.slug;
  const nth = acts.filter((x) => x.slug === slug).length + 1;
  acts.push({ slug, nth, delta: a.delta });
  a.onStarted?.({ sessionId: `ws-${slug}`, runId: `child-${slug}-${nth}` });
  await new Promise((r) => setTimeout(r, 3));
  return { status: 'done', text: `${slug}-speech-${nth}${doneDecider(slug, nth) ? '\nDONE' : ''}`, sessionId: `ws-${slug}`, runId: `child-${slug}-${nth}` };
};

function writeAgent(slug: string, name: string, body: string): void {
  writeFileSync(join(home, 'agents', `${slug}.md`), `---\nname: ${name}\ncreated_by: user\n---\n${body}\n`, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-group-'));
  process.env.TANGU_HOME = home;
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeAgent('alpha', 'Alpha', '你是 Alpha。');
  writeAgent('beta', 'Beta', '你是 Beta。');
  events = []; finals = []; statuses = []; acts = [];
  doneDecider = () => false;
  inquiryAnswer = '否,不用';
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ cacheKey: o.cacheKey, messages: o.messages }),
    streamProviderCompletion: async (o: any) => {
      const text = 'HOST-SUMMARY';
      if (o.onToken) o.onToken(text);
      return { content: text, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
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
    countSessionMessages: async () => 0,
    getSessionOwner: async () => 'u1',
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
    runId: 'r1', sessionId: 's1', userId: 'u1', appId: 'tangu', modelId: 'gpt',
    execMode: 'host', cwd: '/tmp', profile,
    agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 2, groupSeedHistory: false },
    message: 'discuss X', userMessageId: 'um1', attachments: [],
    signal: new AbortController().signal, activateMember: fakeActivate,
    ...over,
  };
}
const endedPayload = () => events.find((e) => e.type === 'group_ended')?.payload;

describe('runGroupChat', () => {
  it('members are activated cycle by cycle in parallel up to the explicit cap; each speech lands as a prefixed model message; each activation only sees the delta since its last one', async () => {
    await runGroupChat(params());
    // 无人 DONE → 跑到显式上限:4 次激活(2 成员 × 2 周期);同一周期两人并行,收场按完成先后
    expect(finals.map((f) => f.content)).toEqual([
      '**🗣 Alpha**\n\nalpha-speech-1',
      '**🗣 Beta**\n\nbeta-speech-1',
      '**🗣 Alpha**\n\nalpha-speech-2',
      '**🗣 Beta**\n\nbeta-speech-2',
    ]);
    const alpha2 = acts.filter((a) => a.slug === 'alpha')[1];
    expect(alpha2.delta).toContain('@Beta:\nbeta-speech-1'); // 周期 2 看到 beta 周期 1 的公开发言
    expect(alpha2.delta).not.toContain('alpha-speech-1'); // 自己的发言不回灌(住在自己的工作会话里)
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(statuses.at(-1)?.status).toBe('done');
  });

  it('every member ending with DONE stops the discussion (no vote step, no vote events)', async () => {
    doneDecider = () => true; // 每位成员第一句就 DONE
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 5 } }));
    expect(finals.filter((f) => f.content.includes('speech')).length).toBe(2);
    expect(events.some((e) => e.type === 'group_vote' || e.type === 'group_voting')).toBe(false);
    expect(endedPayload()).toMatchObject({ reason: 'done', steps: 2, rounds: 1 });
  });

  it('all members DONE on the very last allowed activation still ends as done, not max_rounds', async () => {
    doneDecider = () => true;
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 1 } }));
    expect(endedPayload()).toMatchObject({ reason: 'done', steps: 2, rounds: 1 });
  });

  it('duplicate slugs are deduped in order (TUI `/groupchat a a b`): 2 participants, no crash', async () => {
    doneDecider = () => true;
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'alpha', 'beta'], groupMaxRounds: 3 } }));
    const ended = endedPayload();
    expect(ended).toMatchObject({ reason: 'done', steps: 2 });
    expect(ended.participants.map((a: any) => a.slug)).toEqual(['alpha', 'beta']);
    expect(statuses.some((s) => s.status === 'failed')).toBe(false);
  });

  it('explicit groupMaxRounds stays a hard cap when nobody says DONE (internal callers: discussion / historian assist)', async () => {
    doneDecider = () => false;
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 3 } }));
    expect(finals.filter((f) => f.content.includes('speech')).length).toBe(6); // 3 周期 × 2
    expect(endedPayload().reason).toBe('max_rounds');
  });

  it('no groupMaxRounds = no default cap: members keep going until they all say DONE (well past the old default of 7 rounds)', async () => {
    // alpha 第 9 句才 DONE,beta 第 10 句才 DONE → 19 次激活收场;旧缺省 7 轮(14 步)会把它掐断
    doneDecider = (slug, nth) => (slug === 'alpha' ? nth >= 9 : nth >= 10);
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'] } }));
    expect(endedPayload()).toMatchObject({ reason: 'done', steps: 19 });
  });

  it('errors (no done) with fewer than 2 valid participants', async () => {
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha'], groupMaxRounds: 2 } }));
    expect(events.find((e) => e.type === 'error')?.payload.error).toBe('group_needs_2_agents');
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(statuses.at(-1)?.status).toBe('failed');
    expect(finals.length).toBe(0);
  });

  it('host summarizes when user says yes, not when no', async () => {
    doneDecider = () => true;
    inquiryAnswer = '是,总结';
    await runGroupChat(params({ agentConfig: { groupAgents: ['alpha', 'beta'], groupMaxRounds: 3 } }));
    expect(finals.some((f) => f.content.includes('主持人') && f.content.includes('HOST-SUMMARY'))).toBe(true);

    events = []; finals = []; statuses = []; acts = [];
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
