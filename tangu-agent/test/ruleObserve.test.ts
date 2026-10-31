/**
 * 规则观察档:真 SQLite + 真 triggers.json + 真 evaluateTriggers。
 * 观察中的规则照常判定、照常走游标,动作一律不做;转成启用后不补做;Muse 建的规则满 7 天发一张结果卡。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { launchAutomationTriggers, listExecutions, observedSteps } from '../src/services/automation.js';
import { drainAutomation, type DrainDeps } from '../src/services/automationDrain.js';
import { decideMuseCard, getMuseCard, postMuseCard, postObservedRuleCards } from '../src/services/museCards.js';
import { evaluateTriggers, loadTriggers, removeTrigger, upsertTrigger, validateTriggerInput, type DbLike, type MuseTrigger, type TriggerInput } from '../src/services/museTriggers.js';
import type { DbCursor } from '../src/services/dbCursors.js';

const { dms } = vi.hoisted(() => ({ dms: [] as string[] }));
vi.mock('../src/services/museDm.js', async (orig) => ({ ...(await orig<any>()), postMuseDm: async (_u: string, text: string) => { dms.push(text); return { ok: true, id: 'm' }; } }));
vi.mock('../src/channels/forward.js', () => ({ forwardInboxToChannels: vi.fn() }));

const USER = 'local';
const DAY = 86_400_000;
const daily = { desc: 'digest', cond_type: 'daily_at', time: '09:00' };
const agentStep = [{ type: 'agent_run', agentSlug: 'writer', prompt: 'summarize' }];
const soon = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 16).replace('T', ' ');

beforeAll(async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-observe-test-'));
  delete process.env.TANGU_USER_ID;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});

async function save(input: TriggerInput, id?: string, opts: Parameters<typeof upsertTrigger>[2] = { actor: 'user' }): Promise<MuseTrigger> {
  const v = validateTriggerInput(input);
  if (!v.ok) throw new Error(v.error);
  const r = await upsertTrigger(v.value, id, opts);
  if (!r.ok) throw new Error(r.error);
  return r.trigger;
}
const rule = async (id: string): Promise<MuseTrigger | undefined> => (await loadTriggers()).find((t) => t.id === id);
const obs = (over: Partial<MuseTrigger>): MuseTrigger => ({
  id: `w-${Math.random().toString(36).slice(2, 8)}`, desc: 'watch', cond: { type: 'daily_at', time: '09:00' }, cooldownHours: 0,
  lastFiredAt: null, enabled: true, createdAt: '2020-01-01T00:00:00.000Z', observe: true, ...over,
});
const neverRuns = { runActions: async (): Promise<never> => { throw new Error('observed rule ran an action'); } };

describe('规则状态', () => {
  it('一次性和手动规则不能观察,其余都能', () => {
    expect(validateTriggerInput({ desc: 'x', cond_type: 'at', datetime: soon, observe: true }).ok).toBe(false);
    expect(validateTriggerInput({ desc: 'x', cond_type: 'manual', observe: true, actions: [{ type: 'notify', title: 'n' }] }).ok).toBe(false);
    expect(validateTriggerInput({ ...daily, observe: true }).ok).toBe(true);
    expect(validateTriggerInput({ desc: 'x', cond_type: 'at', datetime: soon, observe: false }).ok).toBe(true);
  });

  it('启停和编辑不带这个键:观察留着,显式 false 才转成启用', async () => {
    const t = await save({ ...daily, observe: true });
    expect(t.observe).toBe(true);
    expect(t.observeSince).toBeTruthy();
    expect((await save({ ...daily, enabled: false }, t.id)).observe).toBe(true);
    const back = await save({ ...daily, enabled: true, desc: 'renamed' }, t.id);
    expect(back).toMatchObject({ observe: true, observeSince: t.observeSince });
    const live = await save({ ...daily, observe: false }, t.id);
    expect(live.observe).toBeUndefined();
    expect(live.observeSince).toBeUndefined();
  });

  it('改成一次性条件:观察不留着', async () => {
    const t = await save({ ...daily, observe: true });
    const at = await save({ desc: 'once', cond_type: 'at', datetime: soon }, t.id);
    expect(at.observe).toBeUndefined();
  });

  it('存盘的 cond 形状不变', async () => {
    const t = await save({ ...daily, observe: true });
    expect(t.cond).toEqual({ type: 'daily_at', time: '09:00' });
  });
});

describe('命中', () => {
  it('动作一律不做;账本记本应执行,模板按这次命中展开;算作已消费', async () => {
    const t = obs({ actions: [
      { type: 'notify', title: 'New {{row.c1}}' },
      { type: 'agent_run', agentSlug: 'writer', prompt: 'summarize' },
      { type: 'tool_call', tool: 'safe', args: { a: 1 } },
      { type: 'db_row_add', path: 'P.db', cells: { Title: '{{row.c1}}' } },
    ] as any });
    const r = await launchAutomationTriggers([{ t, ctx: { row: { id: 'r1', cells: { c1: 'Attention' } } } }], neverRuns as any);
    expect(r.launched).toEqual([t.id]);
    const [exec] = await listExecutions(t.id);
    expect(exec).toMatchObject({ status: 'observed', origin: 'auto' });
    expect(exec.steps.map((s: any) => s.type)).toEqual(['notify', 'agent_run', 'tool_call', 'db_row_add']);
    expect(exec.steps[0]).toMatchObject({ observed: true, summary: 'New Attention', row: 'Attention' });
    expect(exec.steps[1]).toMatchObject({ target: 'writer', summary: 'summarize' });
    expect(exec.steps[2]).toMatchObject({ tool: 'safe', summary: '{"a":1}' });
    expect(exec.steps[3]).toMatchObject({ target: 'P.db', summary: 'Title: Attention' });
    expect(await query(`SELECT 1 FROM chat_sessions WHERE title = ?`, [t.desc])).toHaveLength(0);
    expect(await query(`SELECT 1 FROM inbox_messages WHERE title LIKE 'New%'`)).toHaveLength(0);
  });

  it('叫醒类规则记成 wake,别的 Agent 记成 agent_run', () => {
    expect(observedSteps(obs({ prompt: 'catch up' }))[0]).toMatchObject({ type: 'wake', summary: 'catch up' });
    expect(observedSteps(obs({ agentSlug: 'writer', prompt: 'go' }))[0]).toMatchObject({ type: 'agent_run', target: 'writer' });
  });

  it('用户有 run 在跑:观察不用让位,普通规则照旧让位', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, title, kind) VALUES ('s-busy', ?, 't', 'user')`, [USER]);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, app_id, model_id, assistant_message_id, status) VALUES ('r-busy', 's-busy', ?, 'tangu', 'm', 'a-busy', 'running')`, [USER]);
    try {
      const watching = obs({ actions: [{ type: 'notify', title: 'n' }] });
      const seen: string[] = [];
      const r = await launchAutomationTriggers([{ t: watching }, { t: obs({ id: 'w-live', observe: undefined, actions: [{ type: 'notify', title: 'n' }] }) }],
        { runActions: async (t: MuseTrigger) => { seen.push(t.id); return { execId: 'x', status: 'done' as const, steps: [], touched: {} }; } });
      expect(seen).toEqual([]);
      expect(r.launched).toEqual([watching.id]);
    } finally {
      await query(`DELETE FROM agent_runs WHERE id = 'r-busy'`);
    }
  });
});

/** 一张表 + 一条盯它的规则,跑真 evaluate 和真 launch。 */
function world(over: Partial<MuseTrigger>) {
  const VAULT = '/v', table: DbLike = { columns: [{ id: 'c1', name: 'A', type: 'text' }], rows: [] };
  const t: MuseTrigger = obs({ id: `w-db-${Math.random().toString(36).slice(2, 8)}`, cond: { type: 'db_changed', path: 'A.db', vault: VAULT, event: 'row_added' }, ...over });
  const cursors: Record<string, DbCursor> = { [t.id]: { v: 2, path: 'A.db', event: 'row_added', vault: VAULT, rowIds: [] } };
  const ran: string[] = [];
  const deps: DrainDeps = {
    loadTriggers: async () => [{ ...t }],
    loadCursors: async () => ({ ...cursors }),
    setCursors: async (p) => { Object.assign(cursors, p); },
    evaluate: evaluateTriggers,
    launch: (hits) => launchAutomationTriggers(hits, { runActions: (async (r: MuseTrigger) => { ran.push(r.id); return { execId: 'x', status: 'done', steps: [], touched: {} }; }) as any }),
    advanceSelfCursors: async () => {},
    markTriggersFired: async () => {},
    currentVault: VAULT,
    readDbFile: async () => table,
    activityLines: [],
    log: () => {},
  } as any;
  return { t, ran, deps, cursors, add: (id: string) => table.rows.push({ id, cells: { c1: id } }) };
}

describe('排空循环', () => {
  it('观察的叫醒规则不叫醒 Muse;游标推进,转成启用后不补做,只响应之后的行', async () => {
    const w = world({});
    w.add('r1');
    const first = await drainAutomation(w.deps);
    expect(first.museFired).toEqual([]);
    expect(first.launched).toEqual([w.t.id]);
    expect(await listExecutions(w.t.id)).toHaveLength(1);
    expect(w.cursors[w.t.id].rowIds).toContain('r1');

    w.t.observe = false;
    expect((await drainAutomation(w.deps)).museFired).toEqual([]);
    w.add('r2');
    expect((await drainAutomation(w.deps)).museFired.map((t) => t.id)).toEqual([w.t.id]);
  });

  it('动作规则同理:观察期的行转成启用后不跑,新行才跑', async () => {
    const w = world({ actions: [{ type: 'notify', title: 'n' }] });
    w.add('r1');
    await drainAutomation(w.deps);
    expect(w.ran).toEqual([]);
    delete w.t.observe;
    await drainAutomation(w.deps);
    expect(w.ran).toEqual([]);
    w.add('r2');
    await drainAutomation(w.deps);
    expect(w.ran).toEqual([w.t.id]);
  });

  it('撞到轮数上限时,只停真写表的规则,不停观察的', async () => {
    const live = obs({ id: 'w-live', observe: undefined, actions: [{ type: 'notify', title: 'n' }] }), watching = obs({ id: 'w-obs', actions: [{ type: 'notify', title: 'n' }] });
    const off: string[][] = [];
    const r = await drainAutomation({
      loadTriggers: async () => [live, watching], evaluate: async (ts: MuseTrigger[]) => ts,
      launch: async () => ({ launched: ['w-live', 'w-obs'], touched: { 'w-live': { 'A.db': { addedIds: ['n'], edited: [] } } } }),
      disableTriggers: async (ids: string[]) => { off.push(ids); },
      loadCursors: async () => ({}), setCursors: async () => {}, advanceSelfCursors: async () => {}, markTriggersFired: async () => {}, log: () => {},
      activityLines: [],
    } as any, { maxRounds: 1 });
    expect(r.capHit).toBe(true);
    expect(off).toEqual([['w-live']]);
  });
});

describe('结果卡', () => {
  const hit = (id: string, at: string) => query(`INSERT INTO automation_executions (id, user_id, trigger_id, origin, status, steps) VALUES (?, ?, ?, 'auto', 'observed', '[]')`, [`${id}-${at}-${Math.random()}`, USER, id]);
  const byMuse = () => save({ ...daily, actions: agentStep, observe: true }, undefined, { actor: 'user', observeBy: 'muse' });
  const later = (t: MuseTrigger, days: number) => Date.parse(t.observeSince!) + days * DAY;
  const cards = async (t: MuseTrigger) => query<any[]>(`SELECT id, status, result FROM muse_cards WHERE kind = 'rule-observed' AND target_key LIKE ?`, [`rule-observed:${t.id}:%`]);

  beforeEach(() => { dms.length = 0; });

  it('满 7 天且有命中才发,一段观察只发一张', async () => {
    const t = await byMuse();
    await hit(t.id, 'a');
    await postObservedRuleCards(USER, later(t, 6));
    expect(await cards(t)).toHaveLength(0);
    await postObservedRuleCards(USER, later(t, 7));
    expect(await cards(t)).toHaveLength(1);
    expect((await rule(t.id))?.observeReportedAt).toBeTruthy();
    await postObservedRuleCards(USER, later(t, 8));
    expect(await cards(t)).toHaveLength(1);
    expect((await rule(t.id))?.observe).toBe(true); // 绝不自动转正
  });

  it('没命中不发,之后有了命中再发;用户自己写的和暂停的不发', async () => {
    const t = await byMuse();
    await postObservedRuleCards(USER, later(t, 7));
    expect(await cards(t)).toHaveLength(0);
    await hit(t.id, 'a');
    await postObservedRuleCards(USER, later(t, 8));
    expect(await cards(t)).toHaveLength(1);

    const mine = await save({ ...daily, observe: true });
    await hit(mine.id, 'a');
    await postObservedRuleCards(USER, later(mine, 7));
    expect(await cards(mine)).toHaveLength(0);

    const paused = await byMuse();
    await hit(paused.id, 'a');
    await save({ ...daily, enabled: false, actions: agentStep }, paused.id);
    await postObservedRuleCards(USER, later(paused, 7));
    expect(await cards(paused)).toHaveLength(0);
  });

  it('三个按钮', async () => {
    const posted = async () => {
      const t = await byMuse();
      await hit(t.id, 'a');
      await postObservedRuleCards(USER, later(t, 7));
      return { t, id: (await cards(t))[0].id };
    };
    const a = await posted();
    expect((await decideMuseCard(USER, a.id, 'enable')).ok).toBe(true);
    expect((await rule(a.t.id))).toMatchObject({ enabled: true });
    expect((await rule(a.t.id))?.observe).toBeUndefined();

    const b = await posted();
    expect((await decideMuseCard(USER, b.id, 'extend')).ok).toBe(true);
    const extended = await rule(b.t.id);
    expect(extended).toMatchObject({ enabled: true, observe: true, observeBy: 'muse' });
    expect(extended?.observeReportedAt).toBeUndefined();
    expect(Date.parse(extended!.observeSince!)).toBeGreaterThanOrEqual(Date.parse(b.t.observeSince!));

    const c = await posted();
    expect((await decideMuseCard(USER, c.id, 'pause')).ok).toBe(true);
    expect((await rule(c.t.id))).toMatchObject({ enabled: false, observe: true, disabledBy: 'user' });
  });

  it('手机上不能启用无人值守的规则,其他按钮和只发提醒的规则可以', async () => {
    const t = await byMuse();
    await hit(t.id, 'a');
    await postObservedRuleCards(USER, later(t, 7));
    const [{ id }] = await cards(t);
    expect(await decideMuseCard(USER, id, 'enable', { remote: true })).toMatchObject({ ok: false, status: 403, error: 'local_only' });
    expect((await rule(t.id))?.observe).toBe(true);
    expect((await getMuseCard(USER, id))?.status).toBe('pending');
    expect((await decideMuseCard(USER, id, 'pause', { remote: true })).ok).toBe(true);

    const notify = await save({ ...daily, actions: [{ type: 'notify', title: 'n' }], observe: true }, undefined, { actor: 'user', observeBy: 'muse' });
    await hit(notify.id, 'a');
    await postObservedRuleCards(USER, later(notify, 7));
    expect((await decideMuseCard(USER, (await cards(notify))[0].id, 'enable', { remote: true })).ok).toBe(true);
  });

  it('规则已经删了或转正了:卡直接收掉', async () => {
    const t = await byMuse();
    await hit(t.id, 'a');
    await postObservedRuleCards(USER, later(t, 7));
    const [{ id }] = await cards(t);
    await removeTrigger(t.id);
    expect((await decideMuseCard(USER, id, 'enable')).ok).toBe(true);
    expect(await getMuseCard(USER, id)).toMatchObject({ status: 'dismissed', result: 'gone' });
  });

  it('规则卡的「先观察」建成观察中,算 Muse 建的', async () => {
    const r = await postMuseCard(USER, { kind: 'rule', payload: { input: { ...daily, actions: [{ type: 'notify', title: 'n' }] }, rule: { desc: 'digest' } }, text: 'x' });
    if (!r.ok) throw new Error(r.error);
    const d = await decideMuseCard(USER, r.id, 'observe');
    if (!d.ok) throw new Error(d.error);
    expect(await rule(d.trigger!.id)).toMatchObject({ enabled: true, observe: true, observeBy: 'muse' });
    expect(d.card.result).toBe('observing');
  });
});
