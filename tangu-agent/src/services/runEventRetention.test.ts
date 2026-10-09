/**
 * agent_run_events 保留期 × 真 sqlite(better-sqlite3,与 standalone 同一个 host):
 * 钉住「只删已结束 run 的过期流式帧」「display_file 只剥 dataUrl」「迁移删掉冗余索引」「幂等」「VACUUM 闸」。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { createEmbeddedHost } from '../adapters/standalone/embeddedHost.js';
import { deps } from '../seams/runtime.js';
import { pruneRunEvents, startRunEventRetention, stopRunEventRetention, RUN_EVENT_RETENTION_KICKOFF_MS, RUN_EVENT_RETENTION_INTERVAL_MS } from './runEventRetention.js';

describe('agent_run_events 保留期 × 真 sqlite', () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 't', userId: 'u' });
  const indexes = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_run_events'`).all() as any[]).map((r) => r.name);
  const count = (where = '1=1') => (db.prepare(`SELECT count(*) AS n FROM agent_run_events WHERE ${where}`).get() as any).n as number;
  const payloadOf = (runId: string, seq: number) => JSON.parse((db.prepare('SELECT payload FROM agent_run_events WHERE run_id = ? AND seq = ?').get(runId, seq) as any).payload);

  /** 往某 run 塞一串事件;ageDays 决定 created_at(0 = 现在)。 */
  let seqs = new Map<string, number>();
  const emit = (runId: string, type: string, payload: any, ageDays: number) => {
    const seq = (seqs.get(runId) ?? 0) + 1;
    seqs.set(runId, seq);
    db.prepare(`INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))`)
      .run(runId, seq, type, JSON.stringify(payload), `-${ageDays * 24 * 60} minutes`);
  };
  const run = (id: string, status: string) => db.prepare(`INSERT INTO agent_runs (id, session_id, user_id, status) VALUES (?, 's1', 'u', ?)`).run(id, status);

  beforeAll(async () => {
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    await runMigration();
    // 老库带着冗余索引进来 → 再跑一遍迁移应把它删掉
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_run_events(run_id)');
    expect(indexes()).toContain('idx_agent_events_run');
    await runMigration();

    run('old-done', 'done'); run('old-running', 'running'); run('fresh-done', 'done'); run('old-failed', 'failed');
    for (const [rid, age] of [['old-done', 9], ['old-running', 9], ['fresh-done', 2], ['old-failed', 30]] as const) {
      emit(rid, 'status', { phase: 'start' }, age);
      for (let i = 0; i < 20; i++) emit(rid, 'token', { delta: 'x' }, age);
      for (let i = 0; i < 5; i++) emit(rid, 'reasoning', { delta: 'r' }, age);
      emit(rid, 'tool_call', { id: 'c1', name: 'read_file' }, age);
      for (let i = 0; i < 5; i++) emit(rid, 'tool_stream', { id: 'c1', name: 'read_file', delta: '{' }, age);
      emit(rid, 'tool_result', { id: 'c1', text: 'ok' }, age);
      emit(rid, 'display_file', { name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }, age);
      emit(rid, 'usage', { total: 1 }, age);
      emit(rid, 'done', { ok: true }, age);
    }
    // run 行已不存在的孤儿帧(老)
    for (let i = 0; i < 7; i++) emit('orphan', 'token', { delta: 'o' }, 12);
    emit('orphan', 'done', {}, 12);
  });

  it('迁移把冗余索引 idx_agent_events_run 删了,UNIQUE(run_id, seq) 的自动索引还在', () => {
    const names = indexes();
    expect(names).not.toContain('idx_agent_events_run');
    expect(names.some((n) => n.startsWith('sqlite_autoindex_agent_run_events'))).toBe(true);
  });

  it('只删已结束 run 的过期流式帧;未结束 / 7 天内 / 非流式一律不动;孤儿帧按已结束处理', async () => {
    const before = count();
    const r = await pruneRunEvents();
    // old-done 30 帧 + old-failed 30 帧 + orphan 7 帧
    expect(r.framesDeleted).toBe(67);
    expect(count()).toBe(before - 67);
    expect(count(`run_id = 'old-done' AND type IN ('token','reasoning','tool_stream')`)).toBe(0);
    expect(count(`run_id = 'old-done'`)).toBe(6); // status / tool_call / tool_result / display_file / usage / done
    expect(count(`run_id = 'old-running' AND type IN ('token','reasoning','tool_stream')`)).toBe(30);
    expect(count(`run_id = 'fresh-done' AND type IN ('token','reasoning','tool_stream')`)).toBe(30);
    expect(count(`run_id = 'orphan'`)).toBe(1);
    // 流式帧没了,seq 留空洞:续播按 seq > fromSeq 不受影响,这里只确认 done 还是最大 seq
    expect((db.prepare(`SELECT max(seq) AS m FROM agent_run_events WHERE run_id = 'old-done'`).get() as any).m).toBe(seqs.get('old-done'));
  });

  it('display_file:过期且已结束的剥掉 dataUrl、留 name / mime;其余原样', async () => {
    expect(payloadOf('old-done', 34)).toEqual({ name: 'a.png', mime: 'image/png' });
    expect(payloadOf('old-failed', 34)).toEqual({ name: 'a.png', mime: 'image/png' });
    expect(payloadOf('old-running', 34).dataUrl).toBe('data:image/png;base64,AAAA');
    expect(payloadOf('fresh-done', 34).dataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('幂等:再跑一遍什么都不删、不改', async () => {
    const before = count();
    const r = await pruneRunEvents();
    expect(r).toEqual({ framesDeleted: 0, filesStripped: 0, vacuumed: false });
    expect(count()).toBe(before);
  });

  it('VACUUM 闸:释放量够且没有 run 在飞才整理;有 run 在飞就跳过', async () => {
    // 造一批过期帧再删,把 freelist 撑起来;阈值压到 1 字节
    for (let i = 0; i < 3000; i++) emit('old-done', 'token', { delta: 'y'.repeat(200) }, 9);
    let r = await pruneRunEvents({ vacuumMinFreedBytes: 1 });
    expect(r.framesDeleted).toBe(3000);
    expect(r.vacuumed).toBe(false); // old-running 还在飞
    expect((db.pragma('freelist_count', { simple: true }) as number) > 0).toBe(true);

    db.prepare(`UPDATE agent_runs SET status = 'done' WHERE id = 'old-running'`).run();
    for (let i = 0; i < 3000; i++) emit('old-done', 'token', { delta: 'z'.repeat(200) }, 9);
    r = await pruneRunEvents({ vacuumMinFreedBytes: 1 });
    expect(r.framesDeleted).toBe(3000 + 30); // 刚转终态的 old-running 那 30 帧也过期了
    expect(r.vacuumed).toBe(true);
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
  });
});

/** 同一套场景跑在 PGlite(云网关那半方言):INTERVAL 片段、RETURNING、子查询删自身表、jsonb_exists / `payload - 'dataUrl'`、BIGINT 回字符串。 */
describe('agent_run_events 保留期 × PGlite(PG 方言)', () => {
  let q: <T = any>(sql: string, params?: any[]) => Promise<T>;
  const count = async (where = '1=1') => Number((await q(`SELECT count(*) AS n FROM agent_run_events WHERE ${where}`))[0].n);
  const payloadOf = async (runId: string, seq: number) => {
    const p = (await q('SELECT payload FROM agent_run_events WHERE run_id = ? AND seq = ?', [runId, seq]))[0].payload;
    return typeof p === 'string' ? JSON.parse(p) : p;
  };
  const indexes = async () => (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'agent_run_events'`)).map((r: any) => r.indexname as string);
  const seqs = new Map<string, number>();
  const emit = async (runId: string, type: string, payload: any, ageDays: number) => {
    const seq = (seqs.get(runId) ?? 0) + 1;
    seqs.set(runId, seq);
    await q('INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      [runId, seq, type, JSON.stringify(payload), new Date(Date.now() - ageDays * 86_400_000).toISOString()]);
  };

  beforeAll(async () => {
    const { host, db } = await createEmbeddedHost({ dataDir: 'memory', localToken: 't', userId: 'u' });
    await db.exec(STANDALONE_SCHEMA);
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    q = (sql, params) => deps().host.query(sql, params);
    await runMigration();
    await q('CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_run_events(run_id)');
    expect(await indexes()).toContain('idx_agent_events_run');
    await runMigration();

    for (const [id, status] of [['old-done', 'done'], ['old-running', 'running'], ['fresh-done', 'done'], ['old-failed', 'failed']]) {
      await q(`INSERT INTO agent_runs (id, session_id, user_id, status) VALUES (?, 's1', 'u', ?)`, [id, status]);
    }
    for (const [rid, age] of [['old-done', 9], ['old-running', 9], ['fresh-done', 2], ['old-failed', 30]] as const) {
      await emit(rid, 'status', { phase: 'start' }, age);
      for (let i = 0; i < 20; i++) await emit(rid, 'token', { delta: 'x' }, age);
      for (let i = 0; i < 5; i++) await emit(rid, 'reasoning', { delta: 'r' }, age);
      await emit(rid, 'tool_call', { id: 'c1', name: 'read_file' }, age);
      for (let i = 0; i < 5; i++) await emit(rid, 'tool_stream', { id: 'c1', name: 'read_file', delta: '{' }, age);
      await emit(rid, 'tool_result', { id: 'c1', text: 'ok' }, age);
      await emit(rid, 'display_file', { name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }, age);
      await emit(rid, 'usage', { total: 1 }, age);
      await emit(rid, 'done', { ok: true }, age);
    }
    for (let i = 0; i < 7; i++) await emit('orphan', 'token', { delta: 'o' }, 12);
    await emit('orphan', 'done', {}, 12);
  }, 60_000);

  it('迁移删掉冗余索引,UNIQUE(run_id, seq) 的约束索引还在', async () => {
    const names = await indexes();
    expect(names).not.toContain('idx_agent_events_run');
    expect(names.some((n) => n.includes('run_id_seq'))).toBe(true);
  });

  it('PG 方言:同样只删已结束 run 的过期流式帧、剥 dataUrl,且幂等', async () => {
    expect(deps().host.getDbType()).toBe('postgres');
    const before = await count();
    const r = await pruneRunEvents();
    expect(r).toEqual({ framesDeleted: 67, filesStripped: 2, vacuumed: false });
    expect(await count()).toBe(before - 67);
    expect(await count(`run_id = 'old-done' AND type IN ('token','reasoning','tool_stream')`)).toBe(0);
    expect(await count(`run_id = 'old-done'`)).toBe(6);
    expect(await count(`run_id = 'old-running' AND type IN ('token','reasoning','tool_stream')`)).toBe(30);
    expect(await count(`run_id = 'fresh-done' AND type IN ('token','reasoning','tool_stream')`)).toBe(30);
    expect(await count(`run_id = 'orphan'`)).toBe(1);
    expect(await payloadOf('old-done', 34)).toEqual({ name: 'a.png', mime: 'image/png' });
    expect(await payloadOf('old-failed', 34)).toEqual({ name: 'a.png', mime: 'image/png' });
    expect((await payloadOf('old-running', 34)).dataUrl).toBe('data:image/png;base64,AAAA');
    expect((await payloadOf('fresh-done', 34)).dataUrl).toBe('data:image/png;base64,AAAA');
    expect(await pruneRunEvents()).toEqual({ framesDeleted: 0, filesStripped: 0, vacuumed: false });
  }, 60_000);
});

/** 定时器生命周期(假时钟 + 假 host):thin worker 自停只告一次;热重载后上一代的失败不许清掉新一代的定时器;成功过之后偶发失败照跑。 */
describe('agent_run_events 保留期 × 定时器生命周期', () => {
  afterEach(() => { stopRunEventRetention(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const fakeHost = (query: (...a: any[]) => Promise<any>) => {
    configureTangu({ host: { query, getDbType: () => 'sqlite', getNowSql: () => 'CURRENT_TIMESTAMP',
      getOlderThanSql: (c: string, m: number) => `${c} < datetime('now', '-${m} minutes')` } as any, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  };
  /** 一次成功的 pruneRunEvents 要几条 query:MIN/MAX → (空表,无 DELETE)→ UPDATE。 */
  const okQuery = vi.fn(async (sql: string) => (sql.startsWith('SELECT MIN') ? [{ lo: null, hi: null }] : []));

  it('thin worker:从没成功过就失败 → 自停、只告一次', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn(async () => { throw new Error('host.query 在 thin worker 不可用'); });
    fakeHost(query);
    startRunEventRetention();
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_KICKOFF_MS);
    await flush();
    expect(query).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('stopped');
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_INTERVAL_MS * 2);
    expect(query).toHaveBeenCalledTimes(1); // 没再跑
  });

  it('成功过之后的偶发失败只告警,下一轮照跑', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = false;
    const query = vi.fn(async (sql: string) => { if (fail) throw new Error('database is locked'); return okQuery(sql); });
    fakeHost(query);
    startRunEventRetention();
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_KICKOFF_MS); await flush();
    const afterFirst = query.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_INTERVAL_MS); await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('this round');
    fail = false;
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_INTERVAL_MS); await flush();
    expect(query.mock.calls.length).toBeGreaterThan(afterFirst + 1); // 第三轮跑了
  });

  it('热重载:上一代还在飞的失败不许清掉新一代的定时器', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectOld!: (e: Error) => void;
    const oldQuery = vi.fn(() => new Promise<any>((_, reject) => { rejectOld = reject; }));
    fakeHost(oldQuery);
    startRunEventRetention();
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_KICKOFF_MS);
    expect(oldQuery).toHaveBeenCalledTimes(1); // 旧一代首轮悬在 query 上
    stopRunEventRetention(); // dispose
    const newQuery = vi.fn(okQuery);
    fakeHost(newQuery);
    startRunEventRetention(); // 新一代
    rejectOld(new Error('old host disconnected'));
    await flush();
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_KICKOFF_MS); await flush();
    expect(newQuery.mock.calls.length).toBeGreaterThan(0); // 新一代首轮跑了
    const n = newQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RUN_EVENT_RETENTION_INTERVAL_MS); await flush();
    expect(newQuery.mock.calls.length).toBeGreaterThan(n); // 新一代的周期定时器还活着
  });
});
