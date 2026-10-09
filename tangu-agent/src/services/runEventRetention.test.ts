/**
 * agent_run_events 保留期 × 真 sqlite(better-sqlite3,与 standalone 同一个 host):
 * 钉住「只删已结束 run 的过期流式帧」「display_file 只剥 dataUrl」「迁移删掉冗余索引」「幂等」「VACUUM 闸」。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { pruneRunEvents } from './runEventRetention.js';

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
