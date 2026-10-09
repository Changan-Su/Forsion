/**
 * agent_run_events 保留期(2026-10-09):已结束 run 的**流式帧**(token / reasoning / tool_stream)只留 7 天;
 * 过期的 display_file 事件剥掉内嵌的 base64 `dataUrl`(图片正本在 chat_messages.display_files)。
 *
 * 为什么:这张表是「正在生成的那一轮」的续播录像 —— 断线 / 切会话 / 多设备时按 seq 回放。一轮结束后
 * 界面从 chat_messages 读,流式帧只剩 created_at 给卡顿时间线(routes/sessions.ts 时间线端点、
 * scripts/stall-timeline.mjs)用。dev 库实测 353MB 里 95% 的事件行是这些帧(行开销 + 索引里的 run_id
 * 才是体积大头,正文平均几十字),永不清理。留 7 天让近期 run 还能诊断。
 *
 * 不碰未结束 run(含 queued / running 一切非终态):续播靠它们。run 行已不存在的孤儿事件按已结束处理(只删流式帧)。
 * display_file 剥 dataUrl 的规则比删帧严:只在「run 状态 done + 它的 assistant 消息 display_files 里有同名条目(带 dataUrl 或
 * path)」时才剥 —— 终态不等于归档成功(finalize 前崩溃的 run 只会被标 failed,事件里那份就是唯一一份);团队成员会话
 * (kind='teamwork')的一律不剥:recoverTeamOutputs 不限年龄,事后还会从事件表回读成员 run 的 display_file。
 * 两方言(desktop sqlite / 云网关 PG)同一份代码:时间比较经 getOlderThanSql,JSON 剥键按方言各一句。
 * ⚠️ 别在这里的 SQL 里写字面 `?`(PG 侧 toPg 把每个 `?` 都当占位符):JSONB 判键用 jsonb_exists(),不用 `?` 运算符。
 */
import { query, getDbType, getOlderThanSql } from '../core/db.js';

export const RUN_EVENT_RETENTION_DAYS = 7;
export const RUN_EVENT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后多久跑第一遍:让 boot 和用户的第一轮先走。 */
export const RUN_EVENT_RETENTION_KICKOFF_MS = 30_000;

const STREAM_TYPES = "('token', 'reasoning', 'tool_stream')";
const TERMINAL = "('done', 'failed', 'aborted')";
/** 每条 DELETE 覆盖的主键区间:整表只过一遍,每句只扫自己那段;批间让出事件循环给在飞 run 的落库写链。 */
const ID_STEP = 50_000;
/** 释放量不到这个数不整理文件(VACUUM 期间整库独占,350MB 约 1-3s,还要同等临时磁盘)。 */
const VACUUM_MIN_FREED_BYTES = 64 * 1024 * 1024;

/** 「事件 e 所属的 run 已结束,或 run 行已不存在」。 */
const SETTLED = `NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = e.run_id AND r.status NOT IN ${TERMINAL})`;

export interface RunEventRetentionResult {
  framesDeleted: number;
  filesStripped: number;
  vacuumed: boolean;
}

export interface RunEventRetentionOptions {
  keepDays?: number;
  /** 测试用:降低触发 VACUUM 的释放量阈值。 */
  vacuumMinFreedBytes?: number;
  /** dispose 时中止:批间检查,不再发下一批(已发出去的那条语句照常跑完)。 */
  signal?: AbortSignal;
}

/** 「事件 e 的图片在落库消息里已有一份(同名,且带 dataUrl 或 path)、run 已 done、且不是团队成员会话」。 */
function archivedCopyExists(sqlite: boolean): string {
  const entry = sqlite
    ? `json_valid(m.display_files) AND EXISTS (SELECT 1 FROM json_each(m.display_files) f WHERE json_extract(f.value, '$.name') = json_extract(e.payload, '$.name')`
      + ` AND (json_type(f.value, '$.dataUrl') IS NOT NULL OR json_type(f.value, '$.path') IS NOT NULL))`
    : `jsonb_typeof(m.display_files) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.display_files) f WHERE f->>'name' = e.payload->>'name'`
      + ` AND (jsonb_exists(f, 'dataUrl') OR jsonb_exists(f, 'path')))`;
  return `EXISTS (SELECT 1 FROM agent_runs r JOIN chat_messages m ON m.id = r.assistant_message_id JOIN chat_sessions s ON s.id = r.session_id`
    + ` WHERE r.id = e.run_id AND r.status = 'done' AND s.kind <> 'teamwork' AND ${entry})`;
}

export async function pruneRunEvents(opts: RunEventRetentionOptions = {}): Promise<RunEventRetentionResult> {
  const keepDays = Math.max(1, Math.floor(opts.keepDays ?? RUN_EVENT_RETENTION_DAYS));
  const expired = getOlderThanSql('e.created_at', keepDays * 24 * 60);
  const sqlite = getDbType() === 'sqlite';

  let framesDeleted = 0;
  if (opts.signal?.aborted) return { framesDeleted: 0, filesStripped: 0, vacuumed: false };
  const [range] = await query<any[]>('SELECT MIN(id) AS lo, MAX(id) AS hi FROM agent_run_events');
  const lo = Number(range?.lo), hi = Number(range?.hi);
  if (Number.isFinite(lo) && Number.isFinite(hi) && range?.lo != null) {
    for (let from = lo; from <= hi; from += ID_STEP) {
      if (opts.signal?.aborted) return { framesDeleted, filesStripped: 0, vacuumed: false };
      const rows = await query<any[]>(
        `DELETE FROM agent_run_events WHERE id IN (SELECT e.id FROM agent_run_events e`
          + ` WHERE e.id >= ? AND e.id < ? AND e.type IN ${STREAM_TYPES} AND ${expired} AND ${SETTLED}) RETURNING id`,
        [from, from + ID_STEP],
      );
      framesDeleted += rows.length;
      if (from + ID_STEP <= hi) await new Promise((r) => setTimeout(r, 10));
    }
  }

  // display_file:只剥 dataUrl,name / mime 留着;且只剥「落库消息里确有一份」的(见头注:终态 ≠ 归档成功)。
  if (opts.signal?.aborted) return { framesDeleted, filesStripped: 0, vacuumed: false };
  const stripped = await query<any[]>(sqlite
    ? `UPDATE agent_run_events SET payload = json_remove(payload, '$.dataUrl') WHERE id IN (SELECT e.id FROM agent_run_events e`
      + ` WHERE e.type = 'display_file' AND ${expired} AND json_valid(e.payload) AND json_type(e.payload, '$.dataUrl') IS NOT NULL AND ${archivedCopyExists(true)}) RETURNING id`
    : `UPDATE agent_run_events SET payload = payload - 'dataUrl' WHERE id IN (SELECT e.id FROM agent_run_events e`
      + ` WHERE e.type = 'display_file' AND ${expired} AND jsonb_typeof(e.payload) = 'object' AND jsonb_exists(e.payload, 'dataUrl') AND ${archivedCopyExists(false)}) RETURNING id`);
  const filesStripped = stripped.length;

  // 每轮都看 freelist(不只在本轮删了东西时):上一轮因 run 在飞跳过的 VACUUM 要有机会补做。
  let vacuumed = false;
  if (sqlite && !opts.signal?.aborted) vacuumed = await vacuumIfWorthIt(opts.vacuumMinFreedBytes ?? VACUUM_MIN_FREED_BYTES);
  return { framesDeleted, filesStripped, vacuumed };
}

/** sqlite 删行只进 freelist(auto_vacuum=0),文件不缩;刚释放了一大块、且没有 run 在飞时整理一次。 */
async function vacuumIfWorthIt(minFreedBytes: number): Promise<boolean> {
  const freelist = Number((await query<any[]>('PRAGMA freelist_count'))?.[0]?.freelist_count ?? 0);
  const pageSize = Number((await query<any[]>('PRAGMA page_size'))?.[0]?.page_size ?? 0);
  if (freelist * pageSize < minFreedBytes) return false;
  const live = await query<any[]>(`SELECT 1 AS live FROM agent_runs WHERE status NOT IN ${TERMINAL} LIMIT 1`);
  if (live.length) return false;
  try {
    await query('VACUUM');
    return true;
  } catch (e: any) {
    // 只读脚本(remote-world / sqlite3 CLI)正开着库时 VACUUM 会 SQLITE_BUSY:删行已经成功,整理文件下次再说,别把保留期本身带停。
    console.warn('[tangu] run events vacuum skipped:', e?.message || e);
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let kickoff: ReturnType<typeof setTimeout> | null = null;
/** 每次 start 一代:dispose → 再 start(热重载)后,上一代还在飞的那一轮无论成败都不许碰新一代的定时器。 */
let generation = 0;
let aborter: AbortController | null = null;

/** 启动后 30s 跑一遍,之后每 6h。持库进程专用;thin worker 的 host.query 会抛 —— 从没成功过就失败视为「这里没库」,
 *  自停、只告一次;成功过之后的偶发失败(锁忙 / 磁盘满)只告警,下一轮照跑。 */
export function startRunEventRetention(): void {
  if (timer) return;
  const gen = ++generation;
  const ac = new AbortController();
  aborter = ac;
  let everSucceeded = false;
  const tick = () => pruneRunEvents({ signal: ac.signal })
    .then((r) => {
      if (gen !== generation) return;
      everSucceeded = true;
      if (r.framesDeleted || r.filesStripped) {
        console.log(`[tangu] run events pruned: ${r.framesDeleted} stream frames, ${r.filesStripped} display_file payloads${r.vacuumed ? ', db vacuumed' : ''}`);
      }
    })
    .catch((e: any) => {
      if (gen !== generation) return;
      if (everSucceeded) { console.warn('[tangu] run event retention failed this round:', e?.message || e); return; }
      console.warn('[tangu] run event retention stopped (no database here?):', e?.message || e);
      stopRunEventRetention();
    });
  kickoff = setTimeout(tick, RUN_EVENT_RETENTION_KICKOFF_MS);
  kickoff.unref?.();
  timer = setInterval(tick, RUN_EVENT_RETENTION_INTERVAL_MS);
  timer.unref?.();
}

export function stopRunEventRetention(): void {
  if (kickoff) clearTimeout(kickoff);
  if (timer) clearInterval(timer);
  aborter?.abort();
  aborter = null;
  kickoff = null;
  timer = null;
}
