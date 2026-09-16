/**
 * 团队调度(方案 §6.4;09-16 第四轮拍板:成员并行、全员起头、被 @ 者优先、成员各自以 DONE 表态、内部调用方 groupMaxConcurrent:1 退化成顺序)。
 * 钉的是:teamDue / parseMentions / isDoneSpeech / teamMemberSection 纯函数;并发(两次激活同时在跑)、cap=1 逐字等于旧顺序(旧用例原样保留)、
 * DONE 跨周期持续、被 @ 的 DONE 成员重新入场、DONE 发言里的 @ 不排队、无人 DONE 不 idle、插话作废全员 DONE + 唤醒空闲成员 + 等子 run 时被叫醒、
 * 预算尾巴的插话推迟到收尾趟、abort 级联、失败成员按 DONE 记、团队成本天花板、额度、审批 / 工具活动 / 用量转发、临时成员 inlineDef、
 * teamDoc / role / roster 下发、发言抄回(group_speaker end 带 text、finalize 带 agentSlug、team_member start/end 带子 run id)。
 * 载体 = 注入的假 activateMember(只验调度,不碰库;真载体见 teamRuns.test.ts)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { runGroupChat, teamDue, parseMentions, isDoneSpeech, teamMemberSection, type TeamState } from '../src/services/groupChat.js';
import type { ActivateMember, MemberActivation, MemberOutcome } from '../src/services/teamRuns.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

describe('teamDue / parseMentions / isDoneSpeech / teamMemberSection(纯函数)', () => {
  it('被 @ 者 FIFO 优先(含已 DONE 的);不在场的点名丢弃;正在跑的留队;然后按成员序轮转本周期未激活且未 DONE 者;总数不超过 cap − 在跑', () => {
    const st: TeamState = { participants: ['a', 'b', 'c'], pending: ['zzz', 'c', 'b'], cycleSpoken: new Set(['a']), done: new Set(['c']), running: new Set(['b']) };
    expect(teamDue(st, 3)).toEqual(['c']); // c 被点名(DONE 也入场);b 在跑留队;a 本周期已激活
    expect(st.pending).toEqual(['b']); // zzz 丢弃、c 出队、b 留队
    st.running.delete('b'); st.cycleSpoken.add('b');
    expect(teamDue(st, 3)).toEqual(['b']); // 留队的 b 跑完即再起(被点名 → 重新激活)
    expect(teamDue(st, 3)).toEqual([]); // 都轮过 / DONE → 周期边界
  });
  it('cap=1 逐字等于旧的 teamNext 顺序;全员起头:空状态下 cap≥人数全员同起,cap 小于人数按成员序截断', () => {
    const st: TeamState = { participants: ['a', 'b', 'c'], pending: ['c'], cycleSpoken: new Set(['a']), done: new Set(['c']), running: new Set() };
    expect(teamDue(st, 1)).toEqual(['c']);
    st.cycleSpoken.add('c');
    expect(teamDue(st, 1)).toEqual(['b']);
    st.cycleSpoken.add('b');
    expect(teamDue(st, 1)).toEqual([]);
    const fresh = (): TeamState => ({ participants: ['a', 'b', 'c'], pending: [], cycleSpoken: new Set(), done: new Set(), running: new Set() });
    expect(teamDue(fresh(), 3)).toEqual(['a', 'b', 'c']);
    expect(teamDue(fresh(), 2)).toEqual(['a', 'b']);
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
  it('DONE 只看最后一个非空行:独占一行或缀在末句句尾都算;NOT DONE / 中间行 DONE / 代码块里的 DONE / 小写 done 不算', () => {
    expect(isDoneSpeech('接口好了\nDONE')).toBe(true);
    expect(isDoneSpeech('接口好了\nDONE\n\n  ')).toBe(true);
    expect(isDoneSpeech('  DONE  ')).toBe(true);
    expect(isDoneSpeech('接口好了 DONE')).toBe(true); // 行尾 DONE 也认(live 09-16 第四轮:模型把 DONE 缀在末句,判「没完」就整场空转)
    expect(isDoneSpeech('@Alpha:确认,口号为“同心协作”。 DONE')).toBe(true);
    expect(isDoneSpeech('接口 NOT DONE')).toBe(false);
    expect(isDoneSpeech('done')).toBe(false);
    expect(isDoneSpeech('DONE\n但还有后续:测试没写')).toBe(false); // 中间行不算(Codex r3 #1)
    expect(isDoneSpeech('脚本:\n```\necho ok\nDONE\n```')).toBe(false); // 代码块里的不算
  });
  it('teamMemberSection:自己的线程 / 随时主动发言 / 等人就 @ 且不写 DONE / 完事 DONE / 同目录并行编辑纪律 / 无轮数无投票;teamDoc 拼在末尾', () => {
    const sys = teamMemberSection('Alpha', '- Alpha(alpha):——\n- Beta(beta):——', '## Team\nAlpha owns API; Beta owns tests.');
    expect(sys).toContain('You are "Alpha"');
    expect(sys).toContain('works in their own thread, in parallel');
    expect(sys).toContain('Use team_say whenever');
    expect(sys).toContain('end WITHOUT DONE');
    expect(sys).toContain('end your final message with DONE on its own line');
    expect(sys).toContain('never rewrite files a teammate owns');
    expect(sys).toContain('no round limit and no vote');
    expect(sys.endsWith('Alpha owns API; Beta owns tests.')).toBe(true);
    expect(teamMemberSection('A', 'r').endsWith('do not blindly agree.')).toBe(true); // 没有 teamDoc 就不拼
  });
});

// ── 假载体:不建会话不起 run,记录每次激活的输入,按剧本回发言;并发用计数器观测;honor abort 信号。──
let home: string;
let events: Array<{ type: string; payload: any }>;
let finals: Array<{ content: string; agentSlug?: string; timestamp?: number }>;
let inserted: Array<{ id: string; content: string }>;
let statuses: Array<{ status: string; extra: any }>;
let acts: Array<{ slug: string; nth: number; delta: string; cycle: number; inlineDef: boolean; teamDoc?: string; roster: string; runId: string }>;
let script: Record<string, string[]>;
let delayOf: (slug: string) => number;
let inflightNow: number;
let inflightMax: number;
let quotaOk: boolean;
/** 每次激活的钩子:发子 run 事件(onEvent)/ 改结果(返回 outcome 即覆盖)。 */
let onActivate: ((a: MemberActivation, nth: number) => MemberOutcome | void) | null;
let savedCost: string | undefined;

const fakeActivate: ActivateMember = async (a) => {
  const slug = a.member.slug;
  const nth = acts.filter((x) => x.slug === slug).length + 1;
  const runId = `child-${slug}-${nth}`;
  acts.push({ slug, nth, delta: a.delta, cycle: a.cycle, inlineDef: a.inlineDef, teamDoc: a.teamDoc, roster: a.roster, runId });
  inflightNow++; inflightMax = Math.max(inflightMax, inflightNow);
  a.onStarted?.({ sessionId: `ws-${slug}`, runId });
  const override = onActivate?.(a, nth);
  const how = await new Promise<'done' | 'aborted'>((resolve) => {
    const t = setTimeout(() => resolve('done'), delayOf(slug));
    // 中止后稍等一拍再收场:让团队 run 的 catch(级联中止)先跑,与真载体「abortRun 后等子 run 收尾」的形状一致。
    const onAbort = (): void => { clearTimeout(t); setTimeout(() => resolve('aborted'), 5); };
    if (a.signal.aborted) onAbort(); else a.signal.addEventListener('abort', onAbort, { once: true });
  });
  inflightNow--;
  if (how === 'aborted') return { status: 'aborted', text: '', sessionId: `ws-${slug}`, runId };
  if (override) return { ...override, sessionId: `ws-${slug}`, runId };
  const text = (script[slug] || [])[nth - 1] ?? `${slug}-${nth}`;
  return { status: 'done', text, sessionId: `ws-${slug}`, runId };
};

function writeAgent(slug: string, name: string): void {
  writeFileSync(join(home, 'agents', `${slug}.md`), `---\nname: ${name}\ncreated_by: user\n---\n你是 ${name}。\n`, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-team-'));
  process.env.TANGU_HOME = home;
  savedCost = process.env.TANGU_MAX_RUN_COST;
  process.env.TANGU_MAX_RUN_COST = '20000';
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeAgent('alpha', 'Alpha'); writeAgent('beta', 'Beta');
  events = []; finals = []; inserted = []; statuses = []; acts = []; script = {};
  delayOf = () => 5; inflightNow = 0; inflightMax = 0; quotaOk = true; onActivate = null;
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages }),
    streamProviderCompletion: async () => ({ content: 'HOST-SUMMARY', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  };
  const fakeState: any = {
    insertUserMessage: async (m: any) => { inserted.push({ id: m.id, content: m.content }); },
    finalizeAssistantMessage: async (m: any) => { finals.push({ content: m.content, agentSlug: m.agentSlug, timestamp: m.timestamp }); },
    appendEvent: async (_r: string, type: string, payload: any) => { events.push({ type, payload }); return events.length; },
    drain: async () => {},
    updateRunStatus: async (_id: string, status: string, extra: any) => { statuses.push({ status, extra }); },
    countSessionMessages: async () => 0,
    getSessionOwner: async () => 'u1',
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: quotaOk }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host: hostStub, brain: { llm: fakeLlm } as any, billing: fakeBilling, profile, state: fakeState });
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  if (savedCost === undefined) delete process.env.TANGU_MAX_RUN_COST; else process.env.TANGU_MAX_RUN_COST = savedCost;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function params(over: Partial<any> = {}): any {
  return {
    runId: 'r1', sessionId: 's1', userId: 'u1', appId: 'tangu', modelId: 'gpt', execMode: 'host', cwd: '/tmp', profile,
    agentConfig: { groupAgents: ['alpha', 'beta'], groupNoSummary: true, groupSeedHistory: false },
    message: 'start', userMessageId: 'um1', attachments: [], signal: new AbortController().signal, activateMember: fakeActivate, ...over,
  };
}
const cfg = (over: Record<string, unknown> = {}): any => ({ groupAgents: ['alpha', 'beta'], groupNoSummary: true, groupSeedHistory: false, ...over });
const speakers = () => events.filter((e) => e.type === 'group_speaker' && e.payload.phase === 'start').map((e) => e.payload.slug);
const ended = () => events.find((e) => e.type === 'group_ended')?.payload;
const starts = () => events.filter((e) => e.type === 'team_member' && e.payload.phase === 'start').map((e) => e.payload);
const ends = () => events.filter((e) => e.type === 'team_member' && e.payload.phase === 'end').map((e) => e.payload);

describe('统一调度:并行 + 全员起头 + 被 @ 者优先 + 成员各自以 DONE 表态', () => {
  it('全员起头且并行:两名成员同时在跑;各自 DONE → done;group_speaker end 带 text、finalize 带 agentSlug、team_member start/end 带子 run id', async () => {
    script = { alpha: ['a1\nDONE'], beta: ['b1\nDONE'] };
    delayOf = () => 20;
    await runGroupChat(params());
    expect(inflightMax).toBe(2); // 同时在跑 —— 旧调度恒为 1
    expect(speakers()).toEqual(['alpha', 'beta']);
    expect(ended()).toMatchObject({ reason: 'done', steps: 2, rounds: 1 });
    expect(ended().mode).toBeUndefined();
    expect(events.some((e) => e.type === 'group_voting' || e.type === 'group_vote')).toBe(false);
    const endA = events.find((e) => e.type === 'group_speaker' && e.payload.phase === 'end' && e.payload.slug === 'alpha')!.payload;
    expect(endA.text).toBe('a1\nDONE');
    expect(events.find((e) => e.type === 'token')?.payload).toMatchObject({ delta: 'a1\nDONE', publicSpeech: true });
    expect(finals).toMatchObject([{ content: '**🗣 Alpha**\n\na1\nDONE', agentSlug: 'alpha' }, { content: '**🗣 Beta**\n\nb1\nDONE', agentSlug: 'beta' }]);
    expect(starts().map((s) => [s.slug, s.sessionId, s.runId])).toEqual([['alpha', 'ws-alpha', 'child-alpha-1'], ['beta', 'ws-beta', 'child-beta-1']]);
    expect(starts()[0].messageId).toBe(endA.messageId);
    expect(starts()[0].task).toContain('start');
    expect(ends().map((e) => [e.slug, e.reason, e.runId])).toEqual([['alpha', 'done', 'child-alpha-1'], ['beta', 'done', 'child-beta-1']]);
    expect(statuses.at(-1)?.status).toBe('done');
    expect(statuses.at(-1)?.extra?.result?.reason).toBe('done');
  });

  it('cap=1(内部调用方 groupMaxConcurrent:1)逐字等于旧顺序:被 @ 者优先 → 各自 DONE → 全员 DONE 即停;DONE 跨周期持续', async () => {
    script = { alpha: ['@Beta 你先做接口', '收到,总结完毕\nDONE'], beta: ['接口好了\nDONE'] };
    await runGroupChat(params({ agentConfig: cfg({ groupMaxConcurrent: 1 }) }));
    // 周期 1:alpha(轮转首位)→ beta(被点名,DONE);周期 2:alpha(DONE)→ 全员 DONE → 停。beta 周期 1 就 DONE,周期 2 不再轮到它。
    expect(inflightMax).toBe(1);
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha']);
    expect(ended()).toMatchObject({ reason: 'done', steps: 3, rounds: 2 });
    expect(events.some((e) => e.type === 'group_cycle' && e.payload.cycle === 2)).toBe(true);
    expect(acts[1].delta).toContain('@Alpha:\n@Beta 你先做接口');
  });

  it('cap=1:被 @ 的 DONE 成员重新入场并重新表态;DONE 发言里的 @ 不排队(致谢不把对方拉回来)', async () => {
    script = { alpha: ['@Beta 你先做接口', '@Beta 再补个测试', '好了\nDONE'], beta: ['接口好了\nDONE', '测试也好了\n@Alpha 谢了\nDONE'] };
    await runGroupChat(params({ agentConfig: cfg({ groupMaxConcurrent: 1 }) }));
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta', 'alpha']);
    expect(ended()).toMatchObject({ reason: 'done', steps: 5 });
  });

  it('并行下被 @ 者优先:用户消息里的 @ 先起;成员发言里的 @ 让正在跑的成员留队、跑完立刻再起并看到那条点名', async () => {
    script = { beta: ['b1', 'b2\nDONE'], alpha: ['@Beta 补测试', 'a2\nDONE'] };
    delayOf = () => 10;
    await runGroupChat(params({ message: '@Beta 你先' }));
    expect(acts.map((a) => a.slug)).toEqual(['beta', 'alpha', 'beta', 'alpha']);
    expect(acts[2].delta).toContain('@Alpha:\n@Beta 补测试');
    expect(ended()).toMatchObject({ reason: 'done', steps: 4 });
  });

  it('priorityAgent(内部调用方:讨论对象先回应话题)与用户 @ 一样作入场种子', async () => {
    script = { alpha: ['a\nDONE'], beta: ['b\nDONE'] };
    await runGroupChat(params({ agentConfig: cfg({ priorityAgent: 'beta', groupMaxConcurrent: 1 }) }));
    expect(acts.map((a) => a.slug)).toEqual(['beta', 'alpha']);
  });

  it('负对照:无人点名也无人 DONE → 不 idle,并行地一周期一周期轮到显式上限(不写 DONE = 还想聊)', async () => {
    script = { alpha: ['a1', 'a2', 'a3'], beta: ['b1', 'b2', 'b3'] };
    await runGroupChat(params({ agentConfig: cfg({ groupMaxRounds: 3 }) }));
    expect(acts.map((a) => a.cycle)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(ended()).toMatchObject({ reason: 'max_rounds', steps: 6, rounds: 3 });
  });

  it('插话:全员 DONE 作废、空闲成员立刻再起;落库 + turn_boundary + 进下次激活的 delta', async () => {
    script = { alpha: ['a1\nDONE', 'a2\nDONE'], beta: ['b1', 'b2\nDONE'] };
    let once = true;
    const drainSteer = (): any[] => {
      if (once && speakers().length === 2) { once = false; return [{ id: 'st1', content: '别忘了 v1 兼容' }]; } // 周期 1 两人都说完之后
      return [];
    };
    await runGroupChat(params({ drainSteer }));
    expect(inserted.filter((m) => m.id !== 'um1')).toEqual([{ id: 'st1', content: '别忘了 v1 兼容' }]); // um1 = 开场白落库(既有行为)
    const tb = events.find((e) => e.type === 'turn_boundary');
    expect(tb?.payload.userMessages).toEqual([{ id: 'st1', content: '别忘了 v1 兼容' }]);
    expect(tb?.payload.finalizedAssistantId).toBeTruthy();
    // 插话后 alpha(已 DONE)重新回应:它下一次激活的 delta 含 [User] 行;两人都再表态 DONE → done;共 4 步
    expect(acts.filter((a) => a.slug === 'alpha')[1].delta).toContain('[User] 别忘了 v1 兼容');
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(ended().reason).toBe('done');
  });

  it('等子 run 期间插话到达 → waitSteer 叫醒团队 run,不等激活结束就落库进 transcript', async () => {
    script = { alpha: ['a1\nDONE', 'a2\nDONE'], beta: ['b1\nDONE', 'b2\nDONE'] };
    delayOf = () => 80;
    let arrived = false;
    const waitSteer = (): Promise<void> => new Promise((resolve) => { if (arrived) return; setTimeout(() => { arrived = true; resolve(); }, 10); });
    let once = true;
    const drainSteer = (): any[] => { if (arrived && once) { once = false; return [{ id: 'mid', content: '中途一句' }]; } return []; };
    await runGroupChat(params({ drainSteer, waitSteer }));
    const tbIdx = events.findIndex((e) => e.type === 'turn_boundary');
    const firstSpeech = events.findIndex((e) => e.type === 'group_speaker');
    expect(tbIdx).toBeGreaterThan(-1);
    expect(tbIdx).toBeLessThan(firstSpeech); // 在两人的激活结束之前就消费了
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']); // 两人这次激活没看到插话 → 跑完各再起一次(delta 里才有它),再 DONE
    expect(acts.filter((a) => a.slug === 'beta')[1].delta).toContain('[User] 中途一句');
    expect(ended().reason).toBe('done');
  });

  it('预算尾巴上的插话推迟到收尾趟:上限不突破,但每位成员都回应一次', async () => {
    script = { alpha: ['a1', 'a-after'], beta: ['b1', 'b-after'] };
    let once = true;
    const drainSteer = (): any[] => {
      if (once && speakers().length >= 1) { once = false; return [{ id: 'st-tail', content: '补一句' }]; } // 第 1 次激活结束后就进来:剩余预算不够两人各一次
      return [];
    };
    await runGroupChat(params({ drainSteer, agentConfig: cfg({ groupMaxRounds: 1, groupMaxConcurrent: 1 }) }));
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(ended()).toMatchObject({ reason: 'max_rounds', steps: 4 });
    const beta = acts.filter((a) => a.slug === 'beta');
    expect(beta[0].delta).not.toContain('补一句');
    expect(beta[1].delta).toContain('[User] 补一句');
  });

  it('最后一位发言期间的插话不丢:收尾前再消费一次并让全员再回应一趟(并发上限内分批)', async () => {
    script = { alpha: ['a1', 'a-late'], beta: ['b1', 'b-late'] };
    let fired = false;
    const drainSteer = (): any[] => {
      if (!fired && speakers().length === 2) { fired = true; return [{ id: 'late', content: '等等,还有一点' }]; }
      return [];
    };
    await runGroupChat(params({ drainSteer, agentConfig: cfg({ groupMaxRounds: 1 }) }));
    expect(inserted.some((m) => m.id === 'late')).toBe(true);
    expect(speakers()).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(finals.map((f) => f.content)).toContain('**🗣 Alpha**\n\na-late');
  });

  it('中止:团队 run 被 abort → 在跑的子 run 被级联中止(abortChild),终态 aborted,不等它们自然结束', async () => {
    script = { alpha: ['a'], beta: ['b'] };
    delayOf = () => 5000;
    const ac = new AbortController();
    const aborted: string[] = [];
    const t0 = Date.now();
    onActivate = () => { if (acts.length === 2) setTimeout(() => ac.abort(), 10); }; // Wait for both child runs, independent of filesystem / test runner load.
    await runGroupChat(params({ signal: ac.signal, abortChild: (id: string) => aborted.push(id) }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(aborted.sort()).toEqual(['child-alpha-1', 'child-beta-1']);
    expect(statuses.at(-1)?.status).toBe('aborted');
    expect(events.find((e) => e.type === 'error')?.payload.aborted).toBe(true);
  });

  it('失败的激活按 DONE 记(不再自动重起),队友看得到失败说明,团队照常收场', async () => {
    script = { beta: ['b1', 'b2\nDONE'] };
    onActivate = (a, nth) => (a.member.slug === 'alpha' && nth === 1 ? { status: 'failed', text: '', error: 'boom' } : undefined);
    await runGroupChat(params());
    expect(ends().find((e) => e.slug === 'alpha')).toMatchObject({ reason: 'failed', error: 'boom' });
    expect(finals.map((f) => f.agentSlug)).toEqual(['beta', 'beta']); // alpha 没有发言落库
    expect(acts.filter((a) => a.slug === 'beta')[1].delta).toContain('(activation failed: boom)'); // 周期 2 的 beta 看到
    expect(acts.filter((a) => a.slug === 'alpha').length).toBe(1); // 不再自动重起
    expect(ended().reason).toBe('done');
  });

  it('团队成本天花板 = 单 run 上限 × 成员数:子 run 用量求和超线 → cost_limit,级联中止在跑的成员', async () => {
    script = { alpha: ['a'], beta: ['b'] };
    delayOf = (slug) => (slug === 'alpha' ? 5 : 500);
    onActivate = (a) => { if (a.member.slug === 'alpha') a.onEvent?.({ seq: 1, type: 'usage', payload: { prompt: 10, completion: 5, cost: 50_000 } }); };
    const aborted: string[] = [];
    await runGroupChat(params({ abortChild: (id: string) => aborted.push(id) }));
    expect(ended().reason).toBe('cost_limit');
    expect(events.some((e) => e.type === 'status' && e.payload.phase === 'group_cost_limit')).toBe(true);
    expect(aborted).toEqual(['child-alpha-1']);
    expect(acts.map((a) => a.slug)).toEqual(['alpha']);
    const usage = events.find((e) => e.type === 'usage')!.payload;
    expect(usage).toMatchObject({ agentId: 'alpha', costTotal: 50_000, costLimit: 40_000, total: 15 });
  });

  it('额度不足 → quota 停,error 事件', async () => {
    quotaOk = false;
    await runGroupChat(params());
    expect(events.some((e) => e.type === 'error' && e.payload.error === 'token_quota_exceeded')).toBe(true);
    expect(ended().reason).toBe('quota');
    expect(acts.length).toBe(0);
  });

  it('子 run 的审批 / 询问 / 工具活动转发到团队 run 的流上,带子 runId、本次发言的 messageId 与成员身份(主聊天就地批)', async () => {
    script = { alpha: ['a\nDONE'], beta: ['b\nDONE'] };
    onActivate = (a) => {
      if (a.member.slug !== 'alpha') return;
      a.onEvent?.({ seq: 1, type: 'approval_request', payload: { approvalId: 'ap1', name: 'run_bash', arguments: '{"command":"ls"}', preview: 'ls' } });
      a.onEvent?.({ seq: 2, type: 'tool_call', payload: { id: 'c1', name: 'edit_file', arguments: '{"path":"src/api.ts"}' } });
      a.onEvent?.({ seq: 3, type: 'inquiry_request', payload: { inquiryId: 'q1', question: '要不要 v1?', options: ['要', '不要'] } });
      a.onEvent?.({ seq: 4, type: 'token', payload: { delta: 'x' } }); // 过程 token 不转发
      a.onEvent?.({ seq: 5, type: 'desk_present', payload: { path: '/tmp/preview.html' } });
      a.onEvent?.({ seq: 6, type: 'desk_capture_request', payload: { shotId: 'shot-alpha' } });
    };
    await runGroupChat(params());
    const mid = starts().find((s) => s.slug === 'alpha')!.messageId;
    expect(events.find((e) => e.type === 'approval_request')?.payload).toMatchObject({ approvalId: 'ap1', name: 'run_bash', runId: 'child-alpha-1', agentSlug: 'alpha', agentName: 'Alpha', messageId: mid });
    expect(events.find((e) => e.type === 'inquiry_request')?.payload).toMatchObject({ inquiryId: 'q1', runId: 'child-alpha-1', agentSlug: 'alpha', messageId: mid });
    expect(events.find((e) => e.type === 'team_activity')?.payload).toMatchObject({ slug: 'alpha', tool: 'edit_file', messageId: mid });
    expect(events.find((e) => e.type === 'desk_present')?.payload).toEqual({ path: '/tmp/preview.html' });
    expect(events.find((e) => e.type === 'desk_capture_request')?.payload).toMatchObject({ shotId: 'shot-alpha', runId: 'child-alpha-1' });
    expect(events.some((e) => e.type === 'token' && e.payload.delta === 'x')).toBe(false);
  });

  it('bare DONE and empty final responses do not add empty public bubbles', async () => {
    script = { alpha: ['DONE'], beta: ['', 'DONE'] };
    await runGroupChat(params());
    expect(finals).toHaveLength(0);
    expect(events.some((e) => e.type === 'group_speaker')).toBe(false);
    expect(ended().reason).toBe('done');
  });

  it.each([false, true])('public @remarks reactivate teammates only when requestReply=%s', async (requestReply) => {
    script = { alpha: ['DONE'], beta: ['DONE', 'DONE'] };
    delayOf = (slug) => slug === 'alpha' ? 10 : 20;
    onActivate = (a) => {
      if (a.member.slug === 'alpha') a.onEvent?.({ seq: 1, type: 'team_speech', payload: { text: '@Beta result ready', requestReply } });
    };
    await runGroupChat(params());
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toContain('@Beta result ready');
    expect(acts.filter((a) => a.slug === 'beta')).toHaveLength(requestReply ? 2 : 1);
    expect(ended().reason).toBe('done');
  });

  it('members post multiple remarks before completing, with matching event and database order', async () => {
    script = { alpha: ['alpha final\nDONE'], beta: ['beta final\nDONE'] };
    delayOf = (slug) => slug === 'alpha' ? 30 : 60;
    onActivate = (a) => {
      if (a.member.slug !== 'beta') return;
      a.onEvent?.({ seq: 1, type: 'team_speech', payload: { text: 'first finding' } });
      a.onEvent?.({ seq: 2, type: 'team_speech', payload: { text: 'second finding' } });
    };
    await runGroupChat(params());
    const speeches = events.filter((e) => e.type === 'group_speaker' && e.payload.phase === 'end');
    expect(speeches.map((e) => e.payload.text)).toEqual(['first finding', 'second finding', 'alpha final\nDONE', 'beta final\nDONE']);
    expect(finals.map((f) => f.content.split('**\n\n')[1])).toEqual(speeches.map((e) => e.payload.text));
    expect(events.findIndex((e) => e.type === 'group_speaker')).toBeLessThan(events.findIndex((e) => e.type === 'team_member' && e.payload.phase === 'end'));
    expect(inflightMax).toBe(2);
    expect(finals.every((f, i) => i === 0 || f.timestamp! > finals[i - 1].timestamp!)).toBe(true);
  });

  it('临时成员 inlineDef;teamDoc / role / roster 下发到每次激活;首条用户消息只在 delta 里', async () => {
    const temp = { slug: 'temp-x', name: 'Gamma', systemPrompt: '你是临时 Gamma。' };
    script = { alpha: ['a\nDONE'], 'temp-x': ['g\nDONE'] };
    await runGroupChat(params({ agentConfig: cfg({ groupAgents: ['alpha', 'temp-x'], groupTempAgents: [temp], teamMode: 'meeting', teamDoc: '# Team\nAlpha owns API.', teamRoles: { alpha: 'API' } }) }));
    const a = acts.find((x) => x.slug === 'alpha')!;
    const g = acts.find((x) => x.slug === 'temp-x')!;
    expect(a.inlineDef).toBe(false);
    expect(g.inlineDef).toBe(true);
    expect(a.teamDoc).toBe('## Team\n# Team\nAlpha owns API.\n\n## Your role\nAPI');
    expect(g.teamDoc).toBe('## Team\n# Team\nAlpha owns API.');
    expect(a.roster).toContain('Gamma(temp-x)');
    expect(a.delta).toContain('[User] start');
    expect(a.delta).toContain('activated now (Alpha)');
    expect(ended().reason).toBe('done');
  });
});

describe('播种源(拍板 ⑬)', () => {
  it('groupSeedSessionId 指向别的会话 → 用那条会话的历史播种;缺省用本会话;越权 → 整条 run failed', async () => {
    const seen: string[] = [];
    const prev = (await import('../src/seams/runtime.js')).deps();
    configureTangu({ ...(prev as any), state: { ...(prev as any).state, countSessionMessages: async (id: string) => { seen.push(id); return 0; }, getSessionOwner: async (id: string) => (id === 'solo-42' ? 'u1' : id === 'theirs' ? 'u2' : null) } });
    script = { alpha: ['DONE'], beta: ['DONE'] };
    await runGroupChat(params({ agentConfig: cfg({ groupSeedHistory: true, groupSeedSessionId: 'solo-42' }) }));
    expect(seen[0]).toBe('solo-42');
    seen.length = 0; events.length = 0;
    await runGroupChat(params({ runId: 'r2', agentConfig: cfg({ groupSeedHistory: true, groupSeedSessionId: 'theirs' }) }));
    expect(events.some((e) => e.type === 'error' && e.payload.error === 'seed_session_forbidden')).toBe(true);
    expect(seen).toEqual([]);
    seen.length = 0;
    await runGroupChat(params({ agentConfig: cfg({ groupSeedHistory: true }) }));
    expect(seen[0]).toBe('s1');
  });
});
