/**
 * 遥测计数账本(契约 §7 / §12):inc 累加、set 覆盖、只收非负整数、UTC 日边界、35 天裁剪、未知字段 / 维度在运行时也挡掉、
 * 云端形态零写入、表不存在时不抛给调用方。类型层的「拼错编译不过」在 telemetryLedger.compileCheck.ts(进 tsc)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { runMigration } from '../db/migrate.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { ledger, pruneLedger, agentRoleOf, utcDay, isLedgerField, isCardKind, resetLedgerWarningsForTest, LEDGER_RETENTION_DAYS } from './telemetryLedger.js';

let db: Database.Database;

async function setup(opts: { cloud?: boolean; migrate?: boolean } = {}) {
  const made = createSqliteHost({ dataDir: 'memory', localToken: 't', userId: 'u' });
  db = made.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const profile = opts.cloud ? createAiStudioProfile() : createTanguProfile({ sandboxMode: 'none' });
  configureTangu({ host: { ...made.host, warn: () => {}, log: () => {} }, brain: {} as any, billing: {} as any, profile });
  if (opts.migrate !== false) await runMigration();
  resetLedgerWarningsForTest();
}
/** 写是 fire-and-forget:等一拍让排队的 query 落库。 */
const settle = () => new Promise((r) => setTimeout(r, 5));
const rows = () => db.prepare(`SELECT day, event, dim, field, n FROM telemetry_ledger ORDER BY day, event, dim, field`).all() as any[];
const cell = (event: string, field: string, dim = '', day = utcDay()) =>
  (db.prepare(`SELECT n FROM telemetry_ledger WHERE day = ? AND event = ? AND dim = ? AND field = ?`).get(day, event, dim, field) as any)?.n;

describe('telemetry ledger', () => {
  beforeEach(async () => { await setup(); });

  it('inc 累加,set 覆盖', async () => {
    ledger.inc('daily_muse', 'cyclesDone');
    ledger.inc('daily_muse', 'cyclesDone');
    ledger.inc('daily_muse', 'cycleTokens', { n: 1234 });
    ledger.set('daily_muse', 'gHeartbeatMin', 120);
    ledger.set('daily_muse', 'gHeartbeatMin', 60);
    await settle();
    expect(cell('daily_muse', 'cyclesDone')).toBe(2);
    expect(cell('daily_muse', 'cycleTokens')).toBe(1234);
    expect(cell('daily_muse', 'gHeartbeatMin')).toBe(60);
  });

  it('维度分开记;没维度的事件 dim = 空串', async () => {
    ledger.inc('daily_muse_card', 'created', { dim: 'plugin' });
    ledger.inc('daily_muse_card', 'created', { dim: 'rule' });
    ledger.inc('daily_muse_card', 'created', { dim: 'rule' });
    ledger.inc('daily_memory', 'addPerson', { dim: 'xyra' });
    ledger.inc('daily_judge', 'rounds');
    await settle();
    expect(cell('daily_muse_card', 'created', 'plugin')).toBe(1);
    expect(cell('daily_muse_card', 'created', 'rule')).toBe(2);
    expect(cell('daily_memory', 'addPerson', 'xyra')).toBe(1);
    expect(cell('daily_judge', 'rounds', '')).toBe(1);
  });

  it('只收非负整数;inc 0 不落行,set 0 落行', async () => {
    ledger.inc('daily_muse', 'cycleMs', { n: -5 });
    ledger.inc('daily_muse', 'cycleMs', { n: 1.5 });
    ledger.inc('daily_muse', 'cycleMs', { n: Number.NaN });
    ledger.inc('daily_muse', 'cycleMs', { n: Number.POSITIVE_INFINITY });
    ledger.inc('daily_muse', 'cycleMs', { n: 0 });
    ledger.set('daily_muse', 'gEnabled', -1);
    ledger.set('daily_muse', 'gModeAsk', 0);
    await settle();
    expect(rows()).toEqual([{ day: utcDay(), event: 'daily_muse', dim: '', field: 'gModeAsk', n: 0 }]);
  });

  it('运行时也挡未知字段 / 维度(外面来的字符串绕过类型时)', async () => {
    const anyLedger = ledger as any;
    anyLedger.inc('daily_muse', 'some free text');
    anyLedger.inc('daily_nope', 'cyclesDone');
    anyLedger.inc('daily_muse_card', 'created', { dim: 'remember the user is allergic to nuts' });
    anyLedger.inc('daily_memory', 'addPerson', { dim: 'my-private-agent' });
    anyLedger.inc('daily_memory', 'addPerson'); // 有维度的事件缺维度
    anyLedger.inc('daily_judge', 'rounds', { dim: 'xyra' }); // 没维度的事件带维度
    await settle();
    expect(rows()).toEqual([]);
    expect(isLedgerField('daily_muse_card', 'installed')).toBe(true);
    expect(isLedgerField('daily_muse_card', 'bogus')).toBe(false);
    expect(isCardKind('rule-observed')).toBe(true);
    expect(isCardKind('note')).toBe(false);
  });

  it('按 UTC 日分格:23:59:59.999Z 与次日 00:00:00Z 落在两天', async () => {
    const late = Date.UTC(2026, 10, 6, 23, 59, 59, 999);
    const early = Date.UTC(2026, 10, 7, 0, 0, 0, 0);
    ledger.inc('daily_muse', 'cyclesDone', { now: late });
    ledger.inc('daily_muse', 'cyclesDone', { now: early });
    ledger.inc('daily_muse', 'cyclesDone', { now: early + 1000 });
    await settle();
    expect(cell('daily_muse', 'cyclesDone', '', '2026-11-06')).toBe(1);
    expect(cell('daily_muse', 'cyclesDone', '', '2026-11-07')).toBe(2);
  });

  it('35 天裁剪:更早的日子删掉,保留期内的留着', async () => {
    const now = Date.UTC(2026, 10, 7, 12);
    const day = 86_400_000;
    ledger.inc('daily_muse', 'cyclesDone', { now: now - (LEDGER_RETENTION_DAYS + 1) * day });
    ledger.inc('daily_muse', 'cyclesDone', { now: now - LEDGER_RETENTION_DAYS * day });
    ledger.inc('daily_muse', 'cyclesDone', { now: now - 3 * day });
    await settle();
    await pruneLedger(now);
    expect(rows().map((r) => r.day)).toEqual([utcDay(now - LEDGER_RETENTION_DAYS * day), utcDay(now - 3 * day)]);
  });

  it('云端形态(hostExec=false)零写入', async () => {
    await setup({ cloud: true });
    ledger.inc('daily_muse', 'cyclesDone');
    ledger.set('daily_muse', 'gEnabled', 1);
    await settle();
    expect(rows()).toEqual([]);
  });

  it('表不存在(写失败)不抛给调用方', async () => {
    await setup({ migrate: false });
    expect(() => ledger.inc('daily_muse', 'cyclesDone')).not.toThrow();
    await settle(); // 被拒的 promise 已经 catch 掉:没有 unhandled rejection
  });

  it('agentRole:内置原样、史官 historian、自建一律 custom、缺省按默认 Agent', () => {
    for (const s of ['xyra', 'aria', 'recita', 'coding', 'muse']) expect(agentRoleOf(s)).toBe(s);
    expect(agentRoleOf('historian')).toBe('historian');
    expect(agentRoleOf('my-research-buddy')).toBe('custom');
    expect(agentRoleOf(undefined)).toBe('xyra');
    expect(agentRoleOf('')).toBe('xyra');
  });
});
