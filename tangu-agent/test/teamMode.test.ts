/**
 * 团队调度(新工作区 × 轨道体系 P5a/P5b;09-16 用户拍板后只剩一套:没有会议 / 协作之分,没有投票,没有缺省轮数上限)。
 * 钉的是:teamNext / parseMentions / isDoneSpeech 纯函数;「被 @ 者优先 → 轮转未发言且未 DONE 者 → 全员 DONE 才停」;
 * DONE 跨周期持续(不会在新周期被清掉)、被 @ 的 DONE 成员重新入场、DONE 发言里的 @ 不排队;
 * 「无人点名也无人 DONE → 继续,不 idle」(与旧协作模式相反,负对照);用户插话作废全员 DONE、在发言人边界落库 + 进下一位的 delta + turn_boundary;
 * 每条发言 finalize 带 agentSlug;teamDoc 注入每位成员 system,首条用户消息不再烤进 system;事件不再带 mode。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { runGroupChat, teamNext, parseMentions, isDoneSpeech, type TeamState } from '../src/services/groupChat.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

describe('teamNext / parseMentions(纯函数)', () => {
  it('被 @ 者 FIFO 优先(含已 DONE 的);不在场的点名跳过;然后按成员序轮转本周期未发言且未 DONE 者;都轮过 → null', () => {
    const st: TeamState = { participants: ['a', 'b', 'c'], pending: ['zzz', 'c'], cycleSpoken: new Set(['a']), done: new Set(['c']) };
    expect(teamNext(st)).toBe('c'); // 被点名的 DONE 成员照样轮到
    expect(teamNext(st)).toBe('b');
    st.cycleSpoken.add('b');
    expect(teamNext(st)).toBeNull(); // c 已 DONE 且没再被点名 → 跳过
  });
  it('按出现顺序解析 @<name> / @<slug>,排除自己,模型不守约定 = 空;词法边界:@Ann 不命中 @Anna,同位取最长', () => {
    const ps = [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta Bo' }, { slug: 'gamma', name: 'Gamma' }];
    expect(parseMentions('先 @Gamma 看看,再 @Beta Bo 补测试;@Alpha 我自己不算', ps, 'alpha')).toEqual(['gamma', 'beta']);
    expect(parseMentions('@beta 用 slug 也行', ps, 'alpha')).toEqual(['beta']);
    expect(parseMentions('没有点名', ps, 'alpha')).toEqual([]);
    const pre = [{ slug: 'ann', name: 'Ann' }, { slug: 'anna', name: 'Anna' }];
    expect(parseMentions('@Anna 你来', pre, 'zed')).toEqual(['anna']);
    expect(parseMentions('@Ann 你来', pre, 'zed')).toEqual(['ann']);
    expect(parseMentions('@Ann,@Anna 都来', pre, 'zed')).toEqual(['ann', 'anna']);
  });
  it('DONE 只认独占一行:NOT DONE / 行尾 DONE 不算', () => {
    expect(isDoneSpeech('接口好了\nDONE')).toBe(true);
    expect(isDoneSpeech('  DONE  ')).toBe(true);
    expect(isDoneSpeech('接口 NOT DONE')).toBe(false);
    expect(isDoneSpeech('接口好了 DONE')).toBe(false);
    expect(isDoneSpeech('done')).toBe(false);
  });
});

let home: string;
let events: Array<{ type: string; payload: any }>;
let finals: Array<{ content: string; agentSlug?: string }>;
let inserted: Array<{ id: string; content: string }>;
let calls: Array<{ cacheKey: string; messages: any[]; toolChoice: any }>;
let script: Record<string, string[]>; // slug → 依次发言(用完 → `${slug}-${n}`,不 DONE)
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
    agentConfig: { groupAgents: ['alpha', 'beta'], groupNoSummary: true, groupSeedHistory: false },
    message: 'start', userMessageId: 'um1', attachments: [], signal: new AbortController().signal, ...over,
  };
}
const cfg = (over: Record<string, unknown> = {}): any => ({ groupAgents: ['alpha', 'beta'], groupNoSummary: true, groupSeedHistory: false, ...over });
const speakers = () => events.filter((e) => e.type === 'group_speaker' && e.payload.phase === 'start').map((e) => e.payload.slug);
const ended = () => events.find((e) => e.type === 'group_ended')?.payload;

describe('统一调度:被 @ 者优先,成员各自以 DONE 表态', () => {
  it('被 @ 者优先 → 各自 DONE → 全员 DONE 即停(done);DONE 跨周期持续:beta 周期 1 就 DONE,周期 2 不再轮到它', async () => {
    script = { alpha: ['@Beta 你先做接口', '收到,总结完毕\nDONE'], beta: ['接口好了\nDONE'] };
    await runGroupChat(params());
    // 周期 1:alpha(轮转首位)→ beta(被点名,DONE);周期 2:alpha(DONE)→ 全员 DONE → 停。旧逻辑会在新周期清掉 beta 的 DONE 再让它说一次。
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha']);
    expect(ended()).toMatchObject({ reason: 'done', steps: 3, rounds: 2 });
    expect(ended().mode).toBeUndefined();
    expect(events.some((e) => e.type === 'group_cycle' && e.payload.cycle === 2)).toBe(true);
    expect(events.some((e) => e.type === 'group_voting' || e.type === 'group_vote')).toBe(false);
    expect(finals.map((f) => f.agentSlug)).toEqual(['alpha', 'beta', 'alpha']);
  });

  it('被 @ 的 DONE 成员重新入场并重新表态;DONE 发言里的 @ 不排队(致谢不把对方拉回来)', async () => {
    script = { alpha: ['@Beta 你先做接口', '@Beta 再补个测试', '好了\nDONE'], beta: ['接口好了\nDONE', '测试也好了\n@Alpha 谢了\nDONE'] };
    await runGroupChat(params());
    // 1 alpha 点名 → 2 beta DONE → 周期 2:3 alpha 再点名 beta(DONE 成员被 @ 重新入场)→ 4 beta DONE(其中的 @Alpha 不排队)→ 周期 3:5 alpha DONE → 全员 DONE
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta', 'alpha']);
    expect(ended()).toMatchObject({ reason: 'done', steps: 5 });
  });

  it('负对照:无人点名也无人 DONE → 不 idle,继续轮转直到显式上限(不写 DONE = 还想聊)', async () => {
    script = { alpha: ['a1', 'a2', 'a3'], beta: ['b1', 'b2', 'b3'] };
    await runGroupChat(params({ agentConfig: cfg({ groupMaxRounds: 3 }) }));
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta']);
    expect(ended().reason).toBe('max_rounds');
  });

  it('负对照:用户在边界插话让所有 DONE 作废、本周期重来;插话落库 + 进下一位 delta + turn_boundary', async () => {
    script = { alpha: ['a1\nDONE', 'a2\nDONE'], beta: ['b1', 'b2\nDONE'] };
    let once = true;
    const drainSteer = (): any[] => {
      // 第 3 步(周期 2)之前注入一条插话:此时 alpha 已 DONE,若无插话它不会再轮到
      if (once && speakers().length === 2) { once = false; return [{ id: 'st1', content: '别忘了 v1 兼容' }]; }
      return [];
    };
    await runGroupChat(params({ drainSteer }));
    expect(inserted.filter((m) => m.id !== 'um1')).toEqual([{ id: 'st1', content: '别忘了 v1 兼容' }]); // um1 = 开场白落库(既有行为)
    const tb = events.find((e) => e.type === 'turn_boundary');
    expect(tb?.payload.userMessages).toEqual([{ id: 'st1', content: '别忘了 v1 兼容' }]);
    expect(tb?.payload.finalizedAssistantId).toBeTruthy();
    // 插话后 alpha(已 DONE)重新回应:紧跟 turn_boundary 的那次发言的 delta 含 [User] 行;再之后的 delta 不再重复它
    const afterIdx = events.indexOf(tb!);
    const nextStart = events.slice(afterIdx).find((e) => e.type === 'group_speaker' && e.payload.phase === 'start');
    expect(nextStart?.payload.slug).toBe('alpha');
    const alphaSpeech = calls.filter((c) => slugFromKey(c.cacheKey) === 'alpha');
    const delta2 = String(alphaSpeech[1].messages.filter((m: any) => m.role === 'user').at(-1)!.content);
    expect(delta2).toContain('[User] 别忘了 v1 兼容');
    // 插话后:alpha DONE、beta DONE → 全员 DONE → done;共 4 步
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(ended().reason).toBe('done');
  });

  it('最后一位发言期间的插话不丢:收尾前再消费一次并让全员再回应一趟', async () => {
    script = { alpha: ['a1', 'a-late'], beta: ['b1', 'b-late'] };
    let fired = false;
    const drainSteer = (): any[] => {
      // 显式上限 1 周期:alpha、beta 说完循环就到顶结束;此时才有插话进来(边界 drain 都已过去)
      if (!fired && speakers().length === 2 && events.some((e) => e.type === 'group_speaker' && e.payload.phase === 'end' && e.payload.slug === 'beta')) { fired = true; return [{ id: 'late', content: '等等,还有一点' }]; }
      return [];
    };
    await runGroupChat(params({ drainSteer, agentConfig: cfg({ groupMaxRounds: 1 }) }));
    expect(inserted.some((m) => m.id === 'late')).toBe(true); // 落库了,没被 finally 清掉
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']); // 多回应一趟
    expect(finals.map((f) => f.content)).toContain('**🗣 Alpha**\n\na-late');
  });
});

describe('播种源(拍板 ⑬)', () => {
  it('groupSeedSessionId 指向别的会话 → 用那条会话的历史播种;缺省用本会话', async () => {
    const seen: string[] = [];
    // 换一个 state:countSessionMessages 记录被问到的会话 id(buildHistorySeed 第一步就是它)
    const prev = (await import('../src/seams/runtime.js')).deps();
    configureTangu({ ...(prev as any), state: { ...(prev as any).state, countSessionMessages: async (id: string) => { seen.push(id); return 0; }, getSessionOwner: async (id: string) => (id === 'solo-42' ? 'u1' : id === 'theirs' ? 'u2' : null) } });
    script = { alpha: ['DONE'], beta: ['DONE'] };
    await runGroupChat(params({ agentConfig: cfg({ groupSeedHistory: true, groupSeedSessionId: 'solo-42' }) }));
    expect(seen[0]).toBe('solo-42');
    // 越权:别人的会话 id 作播种源 → 整条 run failed,不读、不静默回退
    seen.length = 0; events.length = 0;
    await runGroupChat(params({ runId: 'r2', agentConfig: cfg({ groupSeedHistory: true, groupSeedSessionId: 'theirs' }) }));
    expect(events.some((e) => e.type === 'error' && e.payload.error === 'seed_session_forbidden')).toBe(true);
    expect(seen).toEqual([]);
    seen.length = 0;
    await runGroupChat(params({ agentConfig: cfg({ groupSeedHistory: true }) }));
    expect(seen[0]).toBe('s1');
  });
});

describe('共用行为', () => {
  it('teamMode 之类的旧键被忽略;首条用户消息不再烤进 system,teamDoc 注入每位成员 system;规则里写明 DONE 自决、无轮数无投票', async () => {
    script = { alpha: ['a1\nDONE'], beta: ['b1\nDONE'] };
    await runGroupChat(params({ agentConfig: cfg({ teamMode: 'meeting', teamDoc: '# Team\nAlpha owns API; Beta owns tests.' }) }));
    expect(speakers()).toEqual(['alpha', 'beta']);
    expect(ended().reason).toBe('done');
    const sys = String(calls[0].messages[0].content);
    expect(sys).toContain('Alpha owns API; Beta owns tests.');
    expect(sys).toContain('end the remark with DONE on its own line');
    expect(sys).toContain('no round limit and no vote');
    expect(sys).not.toContain('The topic of this discussion');
    expect(sys).not.toContain('\nstart'); // 首条用户消息只在 transcript(delta)里,不在 system
  });
});
