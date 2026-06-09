/**
 * 进程内事件总线：每个 run 一个 EventEmitter。
 * publish = 同步分配单调 seq（从 DB MAX 播种，跨重启安全）+ 立即 emit 给在线订阅者
 *           + 把 INSERT agent_run_events 串行排进 per-run 写链（保证落库 seq 有序）。
 * drain(runId) 等待该 run 所有事件落库（finalize 前调用，避免 done 后仍有 token 在途产生空洞）。
 *
 * 多实例扩展接缝：把 emit 换成 Redis pub/sub（host 已有 redis），SSE 订阅 channel agent:run:{id}。
 */
import { EventEmitter } from 'events';
import { query } from '../core/db.js';

export interface AgentEvent {
  seq: number;
  type: string;
  payload: any;
}

const emitters = new Map<string, EventEmitter>();
const seqCounters = new Map<string, number>();
const seedPromises = new Map<string, Promise<number>>();
const writeChains = new Map<string, Promise<void>>();

function getEmitter(runId: string): EventEmitter {
  let e = emitters.get(runId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(0);
    emitters.set(runId, e);
  }
  return e;
}

/** 首次为某 run 发布前，从 DB 播种 seq（COALESCE(MAX(seq),0)），保证跨进程重启单调、不撞 UNIQUE。 */
function seedSeq(runId: string): Promise<number> {
  let p = seedPromises.get(runId);
  if (!p) {
    p = query<any[]>(`SELECT COALESCE(MAX(seq), 0) AS m FROM agent_run_events WHERE run_id = ?`, [runId])
      .then((rows) => Number(rows?.[0]?.m) || 0)
      .catch(() => 0);
    seedPromises.set(runId, p);
  }
  return p;
}

export function subscribe(runId: string, listener: (ev: AgentEvent) => void): () => void {
  const e = getEmitter(runId);
  e.on('event', listener);
  return () => e.off('event', listener);
}

/** 发布一个事件：分配 seq → 立即 emit → 串行落库。返回 seq。 */
export async function publish(runId: string, type: string, payload: any): Promise<number> {
  if (!seqCounters.has(runId)) {
    const base = await seedSeq(runId);
    if (!seqCounters.has(runId)) seqCounters.set(runId, base);
  }
  const seq = (seqCounters.get(runId) ?? 0) + 1;
  seqCounters.set(runId, seq);

  // 立即 emit（低延迟、seq 有序：allocation 在本调用同步段完成）
  getEmitter(runId).emit('event', { seq, type, payload } as AgentEvent);

  // INSERT 串行排进 per-run 写链，保证落库 seq 有序、且可被 drain 等待
  const prev = writeChains.get(runId) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      await query(
        `INSERT INTO agent_run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id, seq) DO NOTHING`,
        [runId, seq, type, JSON.stringify(payload ?? null)],
      );
    } catch (err) {
      console.error(`[agent-core] persist event failed run=${runId} seq=${seq}:`, err);
    }
  });
  writeChains.set(runId, next);
  return seq;
}

/** 等待该 run 已发布事件全部落库（finalize / done 前调用）。 */
export async function drain(runId: string): Promise<void> {
  await (writeChains.get(runId) || Promise.resolve());
}

/** run 结束后清理内存（延迟，给订阅者收尾）。 */
export function cleanup(runId: string): void {
  const e = emitters.get(runId);
  if (e) e.removeAllListeners();
  emitters.delete(runId);
  seqCounters.delete(runId);
  seedPromises.delete(runId);
  writeChains.delete(runId);
}
