/**
 * 装备用量巡检(10-04):Muse 每周看各 agent 的工具 / 技能用量,把一直没用到的当场代收(不出卡片)。
 * 真 SQLite(内存)+ 临时 TANGU_HOME;用量行直接插进 agent_runs / agent_run_events,不起模型。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { saveAgent, agentNotesOff } from '../src/agents/agentRegistry.js';
import { applyHarnessEdit, loadHarness, readJournal, peekHarnessCandidates, MUSE_EQUIP_TITLE } from '../src/agents/harnessStore.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { manageHarnessProvider } from '../src/tools/builtin/manageHarness.js';
import { scheduleAgentFilesSync } from '../src/services/agentFileSync.js';
import { collectLoadoutUsage, buildLoadoutReview, suggestedLoadout, MIN_RUNS, LOADOUT_APPLY_STEPS, SUGGEST_MAX } from '../src/services/loadoutUsage.js';
import { isShelvable } from '../src/tools/toolRegistry.js';
import { reviewLoadoutProvider } from '../src/tools/builtin/reviewLoadout.js';
import { getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { seedLoadoutReviewOnce, museDueSchedules, LOADOUT_REVIEW_PROMPT } from '../src/services/muse.js';
import { loadSchedule, entriesOf, removeEntry } from '../src/services/agentSchedule.js';
import { setUiLocale } from '../src/tui/i18n.js';

const USER = 'u1';
let home: string, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const SKILLS = [
  { id: 'local:foo', name: 'Foo', description: 'foo skill' },
  { id: 'local:bar', name: 'Bar', description: 'bar skill' },
];
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
let seq = 0;
async function session(id: string, kind: string, agentConfig: unknown, user = USER): Promise<void> {
  await query('INSERT INTO chat_sessions (id, user_id, app_id, title, kind, agent_config) VALUES (?, ?, ?, ?, ?, ?)', [id, user, 'tangu', id, kind, agentConfig == null ? null : JSON.stringify(agentConfig)]);
}
/** 一次 run + 它的 tool_call 行。calls 的元素是工具名,或 [工具名, arguments 原文]。 */
async function run(sessionId: string, input: unknown, calls: Array<string | [string, string]>, at = ago(1), user = USER): Promise<void> {
  const id = `run-${++seq}`;
  await query('INSERT INTO agent_runs (id, session_id, user_id, app_id, status, input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, sessionId, user, 'tangu', 'completed', typeof input === 'string' ? input : JSON.stringify(input), at]);
  let n = 0;
  for (const c of calls) {
    const [name, args] = Array.isArray(c) ? c : [c, '{}'];
    await query('INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)', [id, ++n, 'tool_call', JSON.stringify({ id: `c${n}`, name, arguments: args, startedAt: 0 }), at]);
  }
  await query('INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)', [id, ++n, 'tool_result', JSON.stringify({ id: 'c1', name: 'run_bash', result: 'ok' }), at]);
}
const ctx = (): any => ({ userId: USER, sessionId: 's-muse', appId: 'tangu', execMode: 'host', profile: deps().profile, muse: true });

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-loadout-'))); process.env.TANGU_HOME = home;
  setUiLocale('en');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const assets: any = { listSkills: async () => SKILLS, getSkill: async (id: string) => SKILLS.find((s) => s.id === id) || null };
  configureTangu({ host, brain: { assets } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }), state: {} as any });
  await runMigration();
  await saveAgent({ slug: 'worker', name: 'Worker', systemPrompt: 'Work.' } as any);
  await saveAgent({ slug: 'rookie', name: 'Rookie', systemPrompt: 'Learn.' } as any);

  // worker:25 次 run,只用 run_bash / read_file / use_skill(local:foo);一次坏参数的 use_skill 不算装载;
  // 三次装载里有一次没带 local: 前缀(模型常这么写,use_skill 认)—— 照样记在 local:foo 名下
  // 统计口径 = 本机工作面:execMode 取 run 入参(真实 run 都带),没写再看会话存档
  const W = { agentSlug: 'worker', execMode: 'host' };
  await session('s-worker', 'user', W);
  for (let i = 0; i < MIN_RUNS + 5; i++) await run('s-worker', { agentConfig: W }, ['run_bash', 'read_file', ...(i < 3 ? [['use_skill', i === 0 ? '{"skill_id":"foo"}' : '{"skill_id":"local:foo"}'] as [string, string]] : [])]);
  await run('s-worker', { agentConfig: W }, [['use_skill', '{not json']]);
  await run('s-worker', { agentConfig: W }, ['web_fetch']); // 只调过 1 次 → 「偶尔」
  // 入参没写 agentSlug / execMode:按会话存档归到 worker、认作本机
  await run('s-worker', {}, ['list_dir']);
  // rookie:3 次 run → 数据不够
  await session('s-rookie', 'user', { agentSlug: 'rookie', execMode: 'host' });
  for (let i = 0; i < 3; i++) await run('s-rookie', { agentConfig: { agentSlug: 'rookie', execMode: 'host' } }, ['run_bash']);
  // 默认 agent:会话与 run 都没写 slug;入参是坏 JSON 也不能把查询弄挂
  await session('s-default', 'user', { execMode: 'host' });
  await run('s-default', '{broken', ['get_datetime']);
  // 不该算进来的:Muse 会话、窗口之外、别的用户
  await session('s-musebg', 'muse', { agentSlug: 'muse' });
  await run('s-musebg', { agentConfig: W }, ['sketch', 'sketch']);
  await run('s-worker', { agentConfig: W }, ['browser_task'], ago(60));
  await session('s-other', 'user', W, 'u2');
  await run('s-other', { agentConfig: W }, ['delegate'], ago(1), 'u2');
  // 不该算进来的(Codex 10-04):工具面不是「本机工作面」的 run —— 那里这些常驻工具根本没露出来,算进分母只会把「没调过」说大
  await run('s-worker', { agentConfig: { ...W, execMode: 'sandbox' } }, ['x_sandbox']);          // 沙箱 run(入参压过会话存档)
  await run('s-worker', { agentConfig: { ...W, groupChat: true } }, ['x_group_run']);             // 团队编排 run
  await session('s-nomode', 'user', { agentSlug: 'worker' });
  await run('s-nomode', { agentConfig: { agentSlug: 'worker' } }, ['x_nomode']);                  // 哪儿都没写 execMode → 引擎按沙箱跑
  await session('s-chat', 'user', { ...W, preset: 'chat' });
  await run('s-chat', { agentConfig: W }, ['x_chat']);                                            // chat 预设会话
  await session('s-chatreq', 'user', W);
  await run('s-chatreq', { agentConfig: { ...W, preset: 'chat' } }, ['x_chat_request']);          // 预设只在入参里(存档还没落)
  await session('s-coding', 'user', { ...W, preset: 'coding' });
  await run('s-coding', { agentConfig: W }, ['x_coding']);                                        // coding 预设会话
  await session('s-team', 'user', { ...W, groupChat: true });
  await run('s-team', { agentConfig: W }, ['x_group_session']);                                   // 团队会话
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); setUiLocale(null);
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('collectLoadoutUsage', () => {
  it('按 run 入参 → 会话存档 → 默认 agent 归属;只数本用户、窗口内、用户会话里的本机工作面 run', async () => {
    const usage = await collectLoadoutUsage(USER, 30);
    const worker = usage.get('worker')!;
    expect(worker.runs).toBe(MIN_RUNS + 5 + 3);
    expect(worker.tools.get('run_bash')?.calls).toBe(MIN_RUNS + 5);
    expect(worker.tools.get('list_dir')?.calls).toBe(1); // 靠会话存档归属的那次
    expect(worker.tools.get('web_fetch')?.calls).toBe(1);
    for (const outside of ['sketch', 'browser_task', 'delegate']) expect(worker.tools.has(outside), outside).toBe(false);
    // 沙箱 / 团队 / chat / coding 的 run 不进分母也不进计数(worker.runs 上面已钉死没有多出来)
    for (const outside of ['x_sandbox', 'x_group_run', 'x_nomode', 'x_chat', 'x_chat_request', 'x_coding', 'x_group_session']) expect(worker.tools.has(outside), outside).toBe(false);
    expect(worker.tools.get('run_bash')?.last).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(worker.skills.get('local:foo')).toEqual(expect.objectContaining({ calls: 3 })); // 没带前缀的那次也算在它名下;坏参数那次不算
    expect([...worker.skills.keys()].sort()).toEqual(['foo', 'local:foo']);
    expect(usage.get('xyra')?.tools.get('get_datetime')?.calls).toBe(1);
    expect(usage.get('rookie')?.runs).toBe(3);
    expect(usage.has('muse')).toBe(false);
  });

  it('窗口放大就把 60 天前那次算进来(负对照:窗口是真的在起作用)', async () => {
    expect((await collectLoadoutUsage(USER, 90)).get('worker')!.tools.get('browser_task')?.calls).toBe(1);
  });
});

describe('review_loadout 报告', () => {
  it('列出常驻却没调过的、偶尔调的、在用的;数据不够的 agent 明说不判;技能按装载次数分', async () => {
    const out = await buildLoadoutReview(ctx(), { days: 30 });
    expect(out).toMatch(/nothing has been changed/);
    const worker = out.split('## ').find((b) => b.startsWith('worker'))!;
    expect(worker).toMatch(/^worker — 28 runs; \d+ always-loaded tools, [\d.]+ KB/);
    const line = (head: string): string => worker.split('\n').find((l) => l.startsWith(head)) || '';
    // 建议名单由报告定死:没调过的里最大的几个,最多 SUGGEST_MAX 个;调过的一个都不进
    const suggested = line('Suggested tools to shelve this time').split(': ').slice(1).join(': ').split(', ').map((x) => x.split(' ')[0]);
    expect(line('Suggested tools to shelve this time')).toMatch(/^Suggested tools to shelve this time \(\d+, [\d.]+ KB, each never called\): delegate \([\d.]+ KB\)/);
    expect(suggested.length).toBeLessThanOrEqual(SUGGEST_MAX);
    for (const called of ['run_bash', 'read_file', 'web_fetch', 'list_dir']) expect(suggested, called).not.toContain(called);
    expect(line('Not suggested — called 1-2 times')).toMatch(/web_fetch ×1 \(last \d{4}-\d{2}-\d{2}\)/);
    expect(line('Not suggested — in use')).toMatch(/run_bash ×25/);
    // 收不得的不出现在任何一栏(列出来只会诱导模型去建议收它)
    for (const fixed of ['load_tools', 'ask_user', 'manage_harness', 'use_skill', 'remember', 'manage_human', 'log_event', 'todo_write']) expect(worker.includes(fixed), fixed).toBe(false);
    // 目录里除了这两个桩技能,还有播种 agent 共享出来的(local:@owner/name);只钉这两个各在哪一栏
    expect(line('Suggested skills to shelve this time')).toMatch(/\(\d+ of \d+ never loaded, \d+ listed; [\d.]+ KB of catalog lines\): .*local:bar/);
    expect(line('Suggested skills to shelve this time')).not.toMatch(/local:foo/);
    expect(line('Not suggested — skills loaded')).toBe('Not suggested — skills loaded: local:foo ×3');
    const rookie = out.split('## ').find((b) => b.startsWith('rookie'))!;
    expect(rookie).toMatch(/Too few runs to judge/);
    expect(rookie).not.toMatch(/Never called/);
    expect(out).toMatch(/1 agent\(s\) have enough runs to judge\. The "Suggested … this time" lines are the whole suggestion for this review \(at most 8 tools and 8 skills per agent\): pass them on exactly, add nothing\./);
    // 「执行步骤」段由报告给出(只有 propose 这一支:Muse 巡检完当场代收),不交给模型现写
    expect(out.endsWith(LOADOUT_APPLY_STEPS)).toBe(true);
    expect(LOADOUT_APPLY_STEPS).toMatch(/action "propose", agent = its slug, tools and skills = exactly its listed items/);
    expect(LOADOUT_APPLY_STEPS).not.toMatch(/upsert|todo|inbox/); // 「自己收」「转交卡片」那两支随卡片一起去掉了
    // 步骤是给 Muse 读的,不落在用户界面上:中文界面下也是同一段英文
    setUiLocale('zh');
    const zh = await buildLoadoutReview(ctx(), { days: 30 });
    setUiLocale('en');
    expect(zh.endsWith(LOADOUT_APPLY_STEPS)).toBe(true);
    expect(/[一-鿿]/.test(LOADOUT_APPLY_STEPS)).toBe(false);
  });

  it('上限由报告执行:没调过的再多也只列最大的 8 个,其余连名字都不给;太小的不建议', async () => {
    const worker = (await buildLoadoutReview(ctx(), { days: 30, agent: 'worker' })).split('## ').find((b) => b.startsWith('worker'))!;
    const face = getToolDefinitions({ userId: USER, sessionId: '', appId: 'tangu', execMode: 'host', profile: deps().profile, agentSlug: 'worker', unlockTools: () => {} } as any)
      .map((t) => ({ name: t.function.name, bytes: Buffer.byteLength(JSON.stringify(t)) }));
    const called = new Set(['run_bash', 'read_file', 'web_fetch', 'list_dir', 'use_skill']);
    const never = face.filter((t) => isShelvable(t.name) && !called.has(t.name)).sort((a, b) => b.bytes - a.bytes);
    expect(never.length, '前提:没调过的比上限多,否则本条空转').toBeGreaterThan(SUGGEST_MAX);
    const line = worker.split('\n').find((l) => l.startsWith('Suggested tools to shelve this time'))!;
    expect(line.split(': ').slice(1).join(': ').split(', ').map((x) => x.split(' ')[0])).toEqual(never.slice(0, SUGGEST_MAX).map((t) => t.name));
    for (const t of never.slice(SUGGEST_MAX)) expect(worker.includes(t.name), `${t.name} 不该被点名`).toBe(false);
    expect(worker).toMatch(new RegExp(`Not suggested this time: ${never.length - SUGGEST_MAX} more never-called tool\\(s\\)`));
  });

  it('已经收起的单列,不再当「没调过」重复建议', async () => {
    await applyHarnessEdit('worker', { action: 'upsert', kind: 'equip', title: 'Shelf', body: 'unused', evidence: 'review', tools: ['delegate'], skills: ['local:bar'] });
    const worker = (await buildLoadoutReview(ctx(), { days: 30, agent: 'worker' })).split('## ').find((b) => b.startsWith('worker'))!;
    expect(worker.split('\n').find((l) => l.startsWith('Suggested tools'))).not.toMatch(/delegate/);
    expect(worker).toMatch(/Already shelved for this agent: delegate/);
    expect(worker).toMatch(/Skills already shelved: local:bar/);
    expect(worker.split('\n').find((l) => l.startsWith('Suggested skills'))).not.toMatch(/local:bar/);
  });

  it('没有任何用量 / 点名的 agent 不存在 → 明说数据不够,不给名单', async () => {
    expect(await buildLoadoutReview({ ...ctx(), userId: 'nobody' }, {})).toMatch(/not enough data.*Do not recommend anything/);
    expect(await buildLoadoutReview({ ...ctx(), userId: 'nobody' }, {})).not.toContain(LOADOUT_APPLY_STEPS); // 没有可判的 agent 就不给步骤
    expect(await buildLoadoutReview(ctx(), { agent: 'rookie' })).not.toContain(LOADOUT_APPLY_STEPS);
    expect(await buildLoadoutReview(ctx(), { agent: 'ghost' })).toMatch(/No user-session runs for agent "ghost"/);
  });

  it('只有 Muse 看得见(周期或手聊),普通 agent 的工具面与按需目录里都没有它', async () => {
    const base = { userId: USER, sessionId: 's', appId: 'tangu', execMode: 'host' as const, profile: deps().profile, unlockTools: () => {} };
    const names = (extra: Record<string, unknown>) => [...getToolDefinitions({ ...base, ...extra } as any).map((t) => t.function.name), ...listDeferredTools({ ...base, ...extra } as any).map((t) => t.name)];
    expect(names({ agentSlug: 'worker' })).not.toContain('review_loadout');
    expect(names({ muse: true })).toContain('review_loadout');
    expect(names({ agentSlug: 'muse' })).toContain('review_loadout');
    expect(names({ muse: true, execMode: 'sandbox' })).not.toContain('review_loadout');
    const out = String(await reviewLoadoutProvider.tools()[0].execute({ days: 30, agent: 'worker' }, ctx()));
    expect(out).toMatch(/^Loadout usage over the last 30 days/);
  });
});

// 10-04 用户裁决「Muse 也开放自动采纳」:Muse 的装备建议不再躺在对方的候选收件箱里等 /refine,直接替对方收起。
// 能收什么由代码此刻重算的巡检名单把关;接着上面的用例跑(worker 自己已经收了 delegate / local:bar)。
describe('Muse 代收:propose 带 tools / skills 直接生效', () => {
  const tool = manageHarnessProvider.tools()[0];
  const propose = (args: Record<string, unknown>, as = 'muse', extra: Record<string, unknown> = {}) =>
    runWithAgentSlug(as, async () => String(await tool.execute({ action: 'propose', ...args }, { ...ctx(), ...extra })));
  const suggested = async () => (await suggestedLoadout(ctx(), 'worker'))!;
  /** 把时钟拨到一周之后再算一次名单(本周的量按编辑史里的时间算)。只假 Date,文件 / 数据库 I/O 照常。 */
  const nextWeek = async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 7 * 86_400_000 });
    try { return await suggested(); } finally { vi.useRealTimers(); }
  };
  const museEntry = async () => (await loadHarness('worker')).find((e) => e.title === MUSE_EQUIP_TITLE);

  it('只收巡检名单里的:多填的(在用的 / 收不得的 / 不存在的)不认并点名;回执与 agent 自己写的同形 → 出带撤销的更新卡', async () => {
    const now = await suggested();
    expect(now).toMatchObject({ runs: 28, days: 30 });
    expect(now.tools).toHaveLength(SUGGEST_MAX);
    expect(now.tools).not.toContain('delegate'); // worker 自己收过的不在名单里
    const give = now.tools.slice(0, 3);
    const out = JSON.parse(await propose({ agent: 'worker', tools: [...give, 'run_bash', 'load_tools', 'no_such_tool'], skills: ['local:foo'], evidence: 'x'.repeat(900) }));
    expect(out.kind).toBe('harness_update');
    expect(out.change).toMatchObject({ agent: 'worker', action: 'create', kind: 'equip', title: MUSE_EQUIP_TITLE, tools: give, version: 1 });
    expect(out.change.rev).toMatch(/^[a-f0-9-]{36}$/);
    expect(out.change.evidence).toBe('30-day usage review: 28 runs, none of these was called'); // 依据由代码拼,模型给的长句不进条目
    expect(out.message).toContain(`Shelved for "worker": ${give.join(', ')}.`);
    expect(out.message).toContain('Left out, not in the current review for that agent: run_bash, load_tools, no_such_tool, local:foo.');
    const entry = (await museEntry())!;
    expect(entry.tools).toEqual(give);
    expect(entry.skills ?? []).toEqual([]);
    expect((await readJournal('worker')).at(-1)).toMatchObject({ by: 'muse', sessionId: 's-muse', entryId: entry.id });
    expect(vi.mocked(scheduleAgentFilesSync)).toHaveBeenLastCalledWith(USER, 'worker'); // 同步的是对方的文件夹
    expect(await peekHarnessCandidates('worker')).toEqual([]); // 没有再往收件箱里放一份
  });

  it('一个名字都不在名单里 → 报错、什么都不收', async () => {
    const before = await loadHarness('worker');
    expect(await propose({ agent: 'worker', tools: ['run_bash', 'load_tools'], skills: ['local:foo'] })).toMatch(/^Error: none of these is in the current usage review for "worker" \(run_bash, load_tools, local:foo\)\..*Nothing was shelved\.$/);
    // 用户直接跟 Muse 对话(不是后台周期)走的是同一支:换成「转交」那一支的话,没带依据会先报「needs evidence」
    expect(await propose({ agent: 'worker', tools: ['run_bash', 'load_tools'], skills: ['local:foo'] }, 'muse', { muse: false })).toMatch(/^Error: none of these is in the current usage review for "worker"/);
    expect(await loadHarness('worker')).toEqual(before);
  });

  it('一周一批:本周的量用完后,下一批的名字这周不认(Muse 再跑一遍巡检也越不过上限);一周后才轮到', async () => {
    let now = await suggested();
    expect(now.tools).toHaveLength(SUGGEST_MAX - 3); // 本周已经代收了 3 个
    const out = JSON.parse(await propose({ agent: 'worker', tools: now.tools, skills: now.skills }, 'muse', { muse: false })); // 这一批由手聊的 Muse 收:同样当场生效
    expect(out.change).toMatchObject({ action: 'revise', version: 2 }); // 并进同一条:撤销卡撤的正是这一次
    expect(out.change.tools).toHaveLength(SUGGEST_MAX);
    now = await suggested();
    expect(now).toMatchObject({ tools: [], skills: [] });
    const later = await nextWeek();
    expect(later.tools.length, '前提:下周还有可建议的,否则下面的拒绝是空转').toBeGreaterThan(0);
    const shelved = (await museEntry())!.tools!;
    for (const n of later.tools) expect(shelved, n).not.toContain(n);
    expect(await propose({ agent: 'worker', tools: [later.tools[0]] })).toMatch(/^Error: nothing is open to shelve for "worker" right now/);
    expect((await museEntry())!.tools).toEqual(shelved);
    // 报告与代收用的是同一份名单
    expect((await buildLoadoutReview(ctx(), { days: 30, agent: 'worker' })).split('\n').find((l) => l.startsWith('Suggested tools'))).toBe('Suggested tools to shelve this time: none');
  });

  it('对方拿回来的不再建议:撤掉 Muse 那一条之后,同样的名字下周也不回到名单里(否则每周收一次、撤一次)', async () => {
    const entry = (await museEntry())!;
    const taken = [...entry.tools!];
    await applyHarnessEdit('worker', { action: 'delete', id: entry.id }); // worker 自己删,或用户在面板 / 撤销卡上撤
    const later = await nextWeek();
    expect(later.tools.length, '前提:名单不是空的,否则「不包含」是空转').toBeGreaterThan(0);
    for (const n of taken) expect(later.tools, n).not.toContain(n);
  });

  it('数据不够的 agent、不存在的 agent → 明确报错', async () => {
    expect(await propose({ agent: 'rookie', tools: ['delegate'] })).toMatch(/^Error: no usage review covers "rookie"/);
    expect(await loadHarness('rookie')).toEqual([]);
    expect(await propose({ agent: 'ghost', tools: ['delegate'] })).toMatch(/^Error: agent "ghost" does not exist/);
  });

  it('不是 Muse 的 agent 转交同样的建议 → 只留一条由代码拼全的候选,对方的笔记不动', async () => {
    const before = await loadHarness('worker');
    const args = { agent: 'worker', tools: ['sketch', 'browser_task'], skills: ['local:baz'], evidence: '28 runs in 30 days; none called' };
    expect(await propose({ ...args, evidence: '' }, 'rookie', { muse: false })).toMatch(/^Error: an equipment suggestion needs evidence/);
    expect(await propose(args, 'rookie', { muse: false })).toMatch(/^Left the equipment suggestion in "worker"'s candidate inbox/);
    expect(await loadHarness('worker')).toEqual(before);
    const inbox = await peekHarnessCandidates('worker');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].endsWith('(proposed by rookie) Equipment suggestion from a usage review: shelve tools sketch, browser_task and skills local:baz (evidence: 28 runs in 30 days; none called). To adopt: manage_harness upsert, kind "equip", with these tools / skills.')).toBe(true);
    expect(await propose(args, 'rookie', { muse: false })).toBe('"worker" already has this suggestion waiting.');
  });

  it('用户关掉了对方的 manage_harness → 报告不给它建议、不给步骤,Muse 也不代收(它自己撤不了别人替它收的东西)', async () => {
    const before = await loadHarness('worker');
    expect(await nextWeek(), '前提:没关的时候下周是有名单的').toMatchObject({ runs: 28 });
    await saveAgent({ slug: 'worker', name: 'Worker', systemPrompt: 'Work.', toolsMode: 'deny', toolsList: ['manage_harness'] } as any);
    try {
      expect(await nextWeek()).toBeNull();
      const report = await buildLoadoutReview(ctx(), { days: 30, agent: 'worker' });
      expect(report).toMatch(/## worker — 28 runs\nThe user turned off this agent's notes/);
      expect(report).not.toMatch(/Suggested tools/);
      expect(report).not.toContain(LOADOUT_APPLY_STEPS);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 7 * 86_400_000 });
      try { expect(await propose({ agent: 'worker', tools: ['delegate'] })).toMatch(/^Error: no usage review covers "worker"/); } finally { vi.useRealTimers(); }
      expect(await loadHarness('worker')).toEqual(before);
    } finally {
      await saveAgent({ slug: 'worker', name: 'Worker', systemPrompt: 'Work.', toolsMode: null, toolsList: null } as any);
    }
    expect(await nextWeek(), '恢复之后名单回来').toMatchObject({ runs: 28 });
  });
});

describe('agentNotesOff:与运行期的工具名单同一口径', () => {
  it('黑名单里有 / 白名单里没有 = 关;名单缺失当空(手改或导入的 allow 缺名单 = 全禁,运行期 manage_harness 也不可见)', () => {
    expect(agentNotesOff({ toolsMode: 'deny', toolsList: ['manage_harness'] })).toBe(true);
    expect(agentNotesOff({ toolsMode: 'deny', toolsList: ['run_bash'] })).toBe(false);
    expect(agentNotesOff({ toolsMode: 'deny' })).toBe(false);
    expect(agentNotesOff({ toolsMode: 'allow', toolsList: ['manage_harness', 'run_bash'] })).toBe(false);
    expect(agentNotesOff({ toolsMode: 'allow', toolsList: ['run_bash'] })).toBe(true);
    expect(agentNotesOff({ toolsMode: 'allow', toolsList: [] })).toBe(true);
    expect(agentNotesOff({ toolsMode: 'allow' })).toBe(true);
    expect(agentNotesOff({})).toBe(false);
    expect(agentNotesOff(null)).toBe(false);
  });
});

describe('每周装备巡检的日程条目', () => {
  it('只播一次:建一条每 7 天的 auto 条目且当场到期;再调不重复;用户删掉后不补种', async () => {
    expect(await seedLoadoutReviewOnce()).toBe(true);
    const entries = entriesOf((await loadSchedule('muse'))!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'Weekly loadout review', repeat: '7d', auto: true, prompt: LOADOUT_REVIEW_PROMPT });
    expect(entries[0].description).not.toMatch(/^todo /); // 不能被当成「批准 TODO 建的条目」拦下
    expect(existsSync(join(home, 'agents', 'muse', '.seeded-loadout-review-v1'))).toBe(true);
    expect((await museDueSchedules()).map((e) => e.name)).toEqual(['Weekly loadout review']);
    expect(await seedLoadoutReviewOnce()).toBe(false);
    expect(entriesOf((await loadSchedule('muse'))!)).toHaveLength(1);
    await removeEntry('muse', entries[0].id);
    expect(await seedLoadoutReviewOnce()).toBe(false);
    expect(entriesOf((await loadSchedule('muse'))!)).toHaveLength(0);
  });

  it('标记丢了但条目还在(换机 / 同步过来的日程):认名字,不再建第二条', async () => {
    rmSync(join(home, 'agents', 'muse', '.seeded-loadout-review-v1'));
    expect(await seedLoadoutReviewOnce()).toBe(true);
    rmSync(join(home, 'agents', 'muse', '.seeded-loadout-review-v1'));
    setUiLocale('zh'); // 换了界面语言:中文名也认得出是同一条
    expect(await seedLoadoutReviewOnce()).toBe(false);
    setUiLocale('en');
    expect(entriesOf((await loadSchedule('muse'))!)).toHaveLength(1);
  });

  it('条目的 prompt 是英文、够短、说清「当场代收、不出卡片、不问」', () => {
    expect(LOADOUT_REVIEW_PROMPT.length).toBeLessThan(4000);
    expect(/[一-鿿]/.test(LOADOUT_REVIEW_PROMPT)).toBe(false);
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/shelve the suggested items for each agent yourself, now/);
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/do not file a todo for it and do not ask/);
    expect(LOADOUT_REVIEW_PROMPT).not.toMatch(/add_muse_todo/);
    // 步骤不由 Muse 现写:prompt 点的段名要与报告末尾那一段对得上,否则它找不到
    expect(LOADOUT_REVIEW_PROMPT).toContain(`"${LOADOUT_APPLY_STEPS.slice(0, LOADOUT_APPLY_STEPS.indexOf(':'))}" paragraph`);
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/never remove a capability/);
  });
});
