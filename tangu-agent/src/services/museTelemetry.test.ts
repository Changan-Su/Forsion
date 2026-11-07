/**
 * Muse 的遥测落点(契约 §7 daily_muse / daily_muse_card):真 SQLite + 本机 profile,走真的写口,看账本里落了什么。
 * - 点卡:动作名按 cardKind 计;插件卡新动作 installed(宿主装成后回写)= done / installed;认不得的动作不进账本。
 * - 周期产出只算 Muse 周期 run 里的;0 产出的周期在收尾时记 cyclesSilent(muse.ts flushJournal 用 museCycleFinished 判)。
 * - 每日快照:三天以上没人理的卡、前一天主动消息 24 小时内读到 / 回复的条数(记在今天那一格)、Muse 设置档位。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { configureTangu } from '../seams/runtime.js';
import { enterRunContext } from '../seams/runContext.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { runMigration } from '../db/migrate.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { utcDay } from './telemetryLedger.js';
import { decideMuseCard } from './museCards.js';
import { museCycleStarted, museCycleFinished, noteMuseProduced, noteMuseIntroAnswered } from './museTelemetry.js';
import { snapshotMuse, snapshotMuseCards, snapshotMuseDmReads } from './telemetrySnapshot.js';
import { saveSpecialAgentsConfig } from './specialAgentsConfig.js';

const DAY = 86_400_000;
let db: Database.Database;
let home: string;
let prevHome: string | undefined;
/** Muse 的 LOG / 记忆写口的替身:收下 [feedback] 行,看理由有没有写进去。 */
let logLines: string[] = [];

beforeEach(async () => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'tangu-ledger-'));
  process.env.TANGU_HOME = home;
  const made = createSqliteHost({ dataDir: 'memory', localToken: 't', userId: 'u' });
  db = made.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  logLines = [];
  const brain = { memory: { appendLogEntry: async (_u: string, line: string) => { logLines.push(line); }, appendMemoryEntry: async () => {} } };
  configureTangu({ host: { ...made.host, log: () => {}, warn: () => {} }, brain: brain as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const cell = (event: string, field: string, dim = '', day = utcDay()) =>
  (db.prepare(`SELECT n FROM telemetry_ledger WHERE day = ? AND event = ? AND dim = ? AND field = ?`).get(day, event, dim, field) as any)?.n;
const card = (id: string, kind: string, createdAt = Date.now() - 90_000, status = 'pending') =>
  db.prepare(`INSERT INTO muse_cards (id, user_id, kind, target_key, payload, status, created_at) VALUES (?, 'u', ?, ?, '{}', ?, ?)`).run(id, kind, `${kind}:x`, status, createdAt);

describe('daily_muse_card', () => {
  it('插件卡 installed:卡收成 done / installed,账本记 installed 与决定耗时', async () => {
    card('c1', 'plugin');
    const r = await decideMuseCard('u', 'c1', 'installed');
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT status, result FROM muse_cards WHERE id = 'c1'`).get() as any;
    expect(row).toEqual({ status: 'done', result: 'installed' });
    await settle();
    expect(cell('daily_muse_card', 'installed', 'plugin')).toBe(1);
    expect(cell('daily_muse_card', 'decideSecTotal', 'plugin')).toBeGreaterThanOrEqual(89);
    expect(cell('daily_muse_card', 'decidedRemote', 'plugin')).toBeUndefined();
  });

  it('installed 只收本机的回写:远端 403,卡不动', async () => {
    card('c5', 'plugin');
    expect(await decideMuseCard('u', 'c5', 'installed', { remote: true })).toMatchObject({ ok: false, status: 403 });
    expect((db.prepare(`SELECT status FROM muse_cards WHERE id = 'c5'`).get() as any).status).toBe('pending');
  });

  it('规则已经对不上的观察结果卡:收掉记 gone(gone 是计数,不是快照)', async () => {
    card('c6', 'rule-observed');
    const r = await decideMuseCard('u', 'c6', 'enable');
    expect(r).toMatchObject({ ok: true, card: { status: 'dismissed', result: 'gone' } });
    await settle();
    expect(cell('daily_muse_card', 'gone', 'rule-observed')).toBe(1);
    expect(cell('daily_muse_card', 'enable', 'rule-observed')).toBeUndefined();
  });

  it('installed 只给插件卡;认不得的动作 400、不进账本', async () => {
    card('c2', 'feature');
    const bad = await decideMuseCard('u', 'c2', 'installed');
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const bogus = await decideMuseCard('u', 'c2', 'remember this text');
    expect(bogus).toMatchObject({ ok: false, status: 400 });
    await settle();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM telemetry_ledger`).get()).toEqual({ n: 0 });
  });

  it('远端点的记 decidedRemote;第二下 409 不重复记', async () => {
    card('c3', 'channel');
    expect((await decideMuseCard('u', 'c3', 'open', { remote: true })).ok).toBe(true);
    expect((await decideMuseCard('u', 'c3', 'open', { remote: true })).ok).toBe(false);
    await settle();
    expect(cell('daily_muse_card', 'open', 'channel')).toBe(1);
    expect(cell('daily_muse_card', 'decidedRemote', 'channel')).toBe(1);
  });

  it('拒绝理由(P3):dismiss 带理由按 cardKind 计,理由也写进 Muse 的 [feedback] 行', async () => {
    card('r1', 'feature');
    card('r2', 'plugin');
    card('r3', 'settings');
    card('r4', 'channel');
    expect((await decideMuseCard('u', 'r1', 'dismiss', { reason: 'timing' })).ok).toBe(true);
    expect((await decideMuseCard('u', 'r4', 'dismiss', { reason: 'timing' })).ok).toBe(true);
    expect((await decideMuseCard('u', 'r2', 'dismiss', { reason: 'frequent', remote: true })).ok).toBe(true);
    expect((await decideMuseCard('u', 'r3', 'dismiss', { reason: 'known' })).ok).toBe(true);
    await settle();
    expect(cell('daily_muse_card', 'dismiss', 'feature')).toBe(1);
    expect(cell('daily_muse_card', 'dismissTiming', 'feature')).toBe(1);
    expect(cell('daily_muse_card', 'dismissFrequent', 'plugin')).toBe(1);
    expect(cell('daily_muse_card', 'dismissKnown', 'settings')).toBe(1);
    expect(cell('daily_muse_card', 'dismissTiming', 'channel')).toBe(1);
    expect(logLines).toContain('[feedback] chat channel suggestion dismissed by user (reason: bad timing)');
    expect(cell('daily_muse_card', 'dismissIrrelevant', 'feature')).toBeUndefined();
    expect(logLines).toContain('[feedback] recommendation feature:x dismissed by user: bad timing');
    expect(logLines).toContain('[feedback] recommendation plugin:x dismissed by user: too many suggestions like this');
    expect(logLines).toContain('[feedback] settings change turned down by user: keep things as they are (reason: they already knew about it)');
  });

  it('拒绝理由:不给 / 认不得的当没给(只记 dismiss,LOG 照旧);别的动作带理由不计;第二下 409 不重复记', async () => {
    card('r4', 'feature');
    card('r5', 'channel');
    card('r6', 'feature');
    expect((await decideMuseCard('u', 'r4', 'dismiss', { reason: 'the user is allergic to nuts' as any })).ok).toBe(true);
    expect((await decideMuseCard('u', 'r5', 'open', { reason: 'irrelevant' })).ok).toBe(true);
    expect((await decideMuseCard('u', 'r6', 'dismiss')).ok).toBe(true);
    expect((await decideMuseCard('u', 'r6', 'dismiss', { reason: 'irrelevant' })).ok).toBe(false);
    await settle();
    expect(cell('daily_muse_card', 'dismiss', 'feature')).toBe(2);
    expect(cell('daily_muse_card', 'open', 'channel')).toBe(1);
    const fields = (db.prepare(`SELECT DISTINCT field FROM telemetry_ledger`).all() as any[]).map((r) => r.field);
    expect(fields.filter((f) => f.startsWith('dismiss') && f !== 'dismiss')).toEqual([]);
    expect(fields.some((f) => /allergic|nuts/.test(f))).toBe(false);
    expect(logLines.filter((l) => l.includes('feature:x dismissed by user: not interested'))).toHaveLength(2);
    expect(logLines.join('\n')).not.toMatch(/allergic/);
  });

  it('规则卡「不用」带理由:理由进账本和 LOG 行', async () => {
    db.prepare(`INSERT INTO muse_cards (id, user_id, kind, target_key, payload, status, created_at) VALUES ('r7', 'u', 'rule', 'rule:x', ?, 'pending', ?)`)
      .run(JSON.stringify({ rule: { desc: 'Remind me before standup' } }), Date.now() - 1000);
    expect((await decideMuseCard('u', 'r7', 'dismiss', { reason: 'irrelevant' })).ok).toBe(true);
    await settle();
    expect(cell('daily_muse_card', 'dismissIrrelevant', 'rule')).toBe(1);
    expect(logLines).toContain('[feedback] proposed automation "Remind me before standup" declined by user (reason: not relevant to them)');
  });

  it('第一次见面:答案按枚举拆开计;卡上没有自由文本可进账本', async () => {
    card('c4', 'intro');
    await decideMuseCard('u', 'c4', 'answer', { answers: { when: 'daytime', pace: 'daily', focus: ['study', 'inbox', 'not-an-option'] } });
    noteMuseIntroAnswered({ when: 'open', focus: [] }, true);
    await settle();
    expect(cell('daily_muse_card', 'answer', 'intro')).toBe(1);
    expect(cell('daily_muse', 'introAnswered')).toBe(2);
    expect(cell('daily_muse', 'introWhenDaytime')).toBe(1);
    expect(cell('daily_muse', 'introWhenOpen')).toBe(1);
    expect(cell('daily_muse', 'introPaceDaily')).toBe(1);
    expect(cell('daily_muse', 'introFocusStudy')).toBe(1);
    expect(cell('daily_muse', 'introFocusInbox')).toBe(1);
    expect(cell('daily_muse', 'introFocusCustom')).toBe(1);
    const fields = (db.prepare(`SELECT DISTINCT field FROM telemetry_ledger`).all() as any[]).map((r) => r.field);
    expect(fields.some((f) => f.includes('not-an-option'))).toBe(false);
  });
});

describe('Muse 周期产出', () => {
  it('只算周期 run 里的;0 产出 = 静默周期', async () => {
    museCycleStarted('run-a');
    museCycleStarted('run-b');
    enterRunContext('u', 'run-a');
    noteMuseProduced('producedCards');
    noteMuseProduced('producedStarters', 2);
    enterRunContext('u', 'not-a-cycle');
    noteMuseProduced('producedDms'); // 用户手聊 Muse:不算
    expect(museCycleFinished('run-a')).toBe(3);
    expect(museCycleFinished('run-b')).toBe(0);
    expect(museCycleFinished('run-b')).toBeUndefined();
    await settle();
    expect(cell('daily_muse', 'producedCards')).toBe(1);
    expect(cell('daily_muse', 'producedStarters')).toBe(2);
    expect(cell('daily_muse', 'producedDms')).toBeUndefined();
  });
});

describe('每日快照', () => {
  it('三天以上没人理的卡按卡种;没用过的卡种不写行', async () => {
    const now = Date.now();
    card('p1', 'plugin', now - 4 * DAY);
    card('p2', 'plugin', now - 1 * DAY);
    card('r1', 'rule', now - 5 * DAY, 'done');
    await snapshotMuseCards(now);
    await settle();
    expect(cell('daily_muse_card', 'gPendingOver3d', 'plugin')).toBe(1);
    expect(cell('daily_muse_card', 'gPendingOver3d', 'rule')).toBe(0);
    expect(cell('daily_muse_card', 'gPendingOver3d', 'intro')).toBeUndefined();
  });

  it('前一天的主动消息:截至现在 24 小时内回复 / 读到的条数记在今天那一格,不回写昨天', async () => {
    const now = Date.UTC(2026, 10, 8, 23);
    const y = Date.UTC(2026, 10, 7, 10);
    db.prepare(`INSERT INTO chat_sessions (id, user_id, app_id, title, kind, last_read_at) VALUES ('s', 'u', 'tangu', 'Muse', 'user', ?)`).run(y + 2 * 3600_000);
    const msg = db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, agent_slug, origin) VALUES (?, 's', ?, 'x', ?, ?, ?)`);
    msg.run('m1', 'model', y, 'muse', 'proactive'); // 2 小时后读到
    msg.run('m2', 'model', y + 3600_000, 'muse', 'proactive:card'); // 读到 + 回复
    msg.run('u1', 'user', y + 3 * 3600_000, null, null);
    msg.run('m3', 'model', y + 5 * 3600_000, 'muse', 'proactive'); // 回复在它之前、读也在它之前:都不算
    msg.run('m4', 'model', y - DAY, 'muse', 'proactive'); // 前天的:不算
    msg.run('m5', 'model', y, 'xyra', 'proactive'); // 不是 Muse:不算
    await snapshotMuseDmReads(now);
    await settle();
    expect(cell('daily_muse', 'dmRepliedIn24h', '', '2026-11-08')).toBe(2);
    expect(cell('daily_muse', 'dmReadIn24h', '', '2026-11-08')).toBe(2);
    expect(cell('daily_muse', 'dmReadIn24h', '', '2026-11-07')).toBeUndefined();
  });

  it('窗口还没关的:只算到现在为止的(之后一小时再刷新)', async () => {
    const y = Date.UTC(2026, 10, 7, 22);
    db.prepare(`INSERT INTO chat_sessions (id, user_id, app_id, title, kind, last_read_at) VALUES ('s2', 'u', 'tangu', 'Muse', 'user', ?)`).run(y + 10 * 3600_000);
    db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, agent_slug, origin) VALUES ('n1', 's2', 'model', 'x', ?, 'muse', 'proactive')`).run(y);
    await snapshotMuseDmReads(Date.UTC(2026, 10, 8, 1)); // 读在 08:00,这时还没发生
    await settle();
    expect(cell('daily_muse', 'dmReadIn24h', '', '2026-11-08')).toBe(0);
    await snapshotMuseDmReads(Date.UTC(2026, 10, 8, 9));
    await settle();
    expect(cell('daily_muse', 'dmReadIn24h', '', '2026-11-08')).toBe(1);
  });

  it('Muse 设置档位一热编码;没开过的磨合期 = 0', async () => {
    saveSpecialAgentsConfig({ muse: { enabled: true, mode: 'agent', heartbeatMinutes: 60, notify: 'digest', maxDmPerDay: 2 } } as any);
    await snapshotMuse();
    await settle();
    expect(cell('daily_muse', 'gEnabled')).toBe(1);
    expect(cell('daily_muse', 'gModeAgent')).toBe(1);
    expect(cell('daily_muse', 'gModeAsk')).toBe(0);
    expect(cell('daily_muse', 'gHeartbeatMin')).toBe(60);
    expect(cell('daily_muse', 'gNotifyDigest')).toBe(1);
    expect(cell('daily_muse', 'gMaxDmPerDay')).toBe(2);
    expect(cell('daily_muse', 'gOnboardingDay')).toBe(0);
    expect(cell('daily_muse', 'gRulesEnabled')).toBe(0);
  });
});
