/**
 * 装备用量巡检(10-04):Muse 每周看各 agent 的工具 / 技能用量,只出建议。
 * 真 SQLite(内存)+ 临时 TANGU_HOME;用量行直接插进 agent_runs / agent_run_events,不起模型。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { applyHarnessEdit } from '../src/agents/harnessStore.js';
import { collectLoadoutUsage, buildLoadoutReview, MIN_RUNS, LOADOUT_APPLY_STEPS } from '../src/services/loadoutUsage.js';
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

  // worker:25 次 run,只用 run_bash / read_file / use_skill(local:foo);一次坏参数的 use_skill 不算装载
  await session('s-worker', 'user', { agentSlug: 'worker' });
  for (let i = 0; i < MIN_RUNS + 5; i++) await run('s-worker', { agentConfig: { agentSlug: 'worker' } }, ['run_bash', 'read_file', ...(i < 3 ? [['use_skill', '{"skill_id":"local:foo"}'] as [string, string]] : [])]);
  await run('s-worker', { agentConfig: { agentSlug: 'worker' } }, [['use_skill', '{not json']]);
  await run('s-worker', { agentConfig: { agentSlug: 'worker' } }, ['web_fetch']); // 只调过 1 次 → 「偶尔」
  // 入参没写 agentSlug:按会话存档归到 worker
  await run('s-worker', {}, ['list_dir']);
  // rookie:3 次 run → 数据不够
  await session('s-rookie', 'user', { agentSlug: 'rookie' });
  for (let i = 0; i < 3; i++) await run('s-rookie', { agentConfig: { agentSlug: 'rookie' } }, ['run_bash']);
  // 默认 agent:会话与 run 都没写 slug;入参是坏 JSON 也不能把查询弄挂
  await session('s-default', 'user', null);
  await run('s-default', '{broken', ['get_datetime']);
  // 不该算进来的:Muse 会话、窗口之外、别的用户
  await session('s-musebg', 'muse', { agentSlug: 'muse' });
  await run('s-musebg', { agentConfig: { agentSlug: 'worker' } }, ['sketch', 'sketch']);
  await run('s-worker', { agentConfig: { agentSlug: 'worker' } }, ['browser_task'], ago(60));
  await session('s-other', 'user', { agentSlug: 'worker' }, 'u2');
  await run('s-other', { agentConfig: { agentSlug: 'worker' } }, ['delegate'], ago(1), 'u2');
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); setUiLocale(null);
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('collectLoadoutUsage', () => {
  it('按 run 入参 → 会话存档 → 默认 agent 归属;只数本用户、窗口内、用户会话', async () => {
    const usage = await collectLoadoutUsage(USER, 30);
    const worker = usage.get('worker')!;
    expect(worker.runs).toBe(MIN_RUNS + 5 + 3);
    expect(worker.tools.get('run_bash')?.calls).toBe(MIN_RUNS + 5);
    expect(worker.tools.get('list_dir')?.calls).toBe(1); // 靠会话存档归属的那次
    expect(worker.tools.get('web_fetch')?.calls).toBe(1);
    for (const outside of ['sketch', 'browser_task', 'delegate']) expect(worker.tools.has(outside), outside).toBe(false);
    expect(worker.tools.get('run_bash')?.last).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect([...worker.skills.entries()]).toEqual([['local:foo', expect.objectContaining({ calls: 3 })]]); // 坏参数那次不算
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
    expect(line('Never called')).toMatch(/web_search \([\d.]+ KB\)/);
    expect(line('Never called')).not.toMatch(/run_bash|read_file|web_fetch/);
    expect(line('Called 1-2 times')).toMatch(/web_fetch ×1 \([\d.]+ KB, last \d{4}-\d{2}-\d{2}\)/);
    expect(line('In use')).toMatch(/run_bash ×25/);
    // 收不得的不出现在任何一栏(列出来只会诱导模型去建议收它)
    for (const fixed of ['load_tools', 'ask_user', 'manage_harness', 'use_skill', 'remember', 'manage_human', 'log_event', 'todo_write']) expect(worker.includes(fixed), fixed).toBe(false);
    // 目录里除了这两个桩技能,还有播种 agent 共享出来的(local:@owner/name);只钉这两个各在哪一栏
    expect(line('Skills listed but never loaded')).toMatch(/\(\d+ of \d+, [\d.]+ KB of catalog lines\): .*local:bar/);
    expect(line('Skills listed but never loaded')).not.toMatch(/local:foo/);
    expect(line('Skills loaded')).toBe('Skills loaded: local:foo ×3');
    const rookie = out.split('## ').find((b) => b.startsWith('rookie'))!;
    expect(rookie).toMatch(/Too few runs to judge/);
    expect(rookie).not.toMatch(/Never called/);
    expect(out).toMatch(/1 agent\(s\) have enough runs to judge\. Lists are sorted largest first; suggest at most 8 tools and 8 skills per agent/);
    // 「执行步骤」段由报告给出(自己收 / 给别人提名两支都在),Muse 原样带进 TODO
    expect(out.endsWith(LOADOUT_APPLY_STEPS)).toBe(true);
    expect(LOADOUT_APPLY_STEPS).toMatch(/action "upsert", kind "equip"/);
    expect(LOADOUT_APPLY_STEPS).toMatch(/action "propose"/);
  });

  it('已经收起的单列,不再当「没调过」重复建议', async () => {
    await applyHarnessEdit('worker', { action: 'upsert', kind: 'equip', title: 'Shelf', body: 'unused', evidence: 'review', tools: ['web_search'], skills: ['local:bar'] });
    const worker = (await buildLoadoutReview(ctx(), { days: 30, agent: 'worker' })).split('## ').find((b) => b.startsWith('worker'))!;
    expect(worker.split('\n').find((l) => l.startsWith('Never called'))).not.toMatch(/web_search/);
    expect(worker).toMatch(/Already shelved by this agent: web_search/);
    expect(worker).toMatch(/Skills already shelved: local:bar/);
    expect(worker.split('\n').find((l) => l.startsWith('Skills listed but never loaded'))).not.toMatch(/local:bar/);
  });

  it('没有任何用量 / 点名的 agent 不存在 → 明说数据不够,不给名单', async () => {
    expect(await buildLoadoutReview({ ...ctx(), userId: 'nobody' }, {})).toMatch(/not enough data.*Do not recommend anything/);
    expect(await buildLoadoutReview({ ...ctx(), userId: 'nobody' }, {})).not.toContain('Steps for whoever runs this task'); // 没有可判的 agent 就不给步骤
    expect(await buildLoadoutReview(ctx(), { agent: 'rookie' })).not.toContain('Steps for whoever runs this task');
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

  it('条目的 prompt 是英文、够短、说清「只提建议」', () => {
    expect(LOADOUT_REVIEW_PROMPT.length).toBeLessThan(4000);
    expect(/[一-鿿]/.test(LOADOUT_REVIEW_PROMPT)).toBe(false);
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/exactly ONE add_muse_todo/);
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/nothing has been changed yet/);
    // 10-04 live 实翻:Muse 把「本周期别动任何东西」原样抄进了 TODO,接手的 agent 读到后就什么都不做
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/do not copy that restriction into the todo/);
    expect(LOADOUT_REVIEW_PROMPT).toMatch(/do not write your own steps/);
  });
});
