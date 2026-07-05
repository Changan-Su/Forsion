/**
 * 收件箱广播拉取调度器:定期从 Forsion 云端拉服务端广播,落进本地 inbox_messages(sender='forsion')。
 *
 * 只在本地形态(hostExec)且装配了 brain.inbox seam(httpBrain,即配置了 TANGU_CLOUD_URL+TOKEN)时启动;
 * 云端 worker / 微服务进程 no-op。到期定时消息的「投递」不在这里——读端 SQL 过滤 deliver_at 即投递。
 *
 * 游标 = 本地 MAX(created_at) WHERE origin_broadcast_id IS NOT NULL(零额外状态;**含软删行**——
 * 用户删了广播不等于没拉过,软删行继续锚住游标与去重,防止下轮把它复活)。created_at 存服务端
 * to_char 微秒原文,原样回传 since,服务端自己跟自己严格 `>` 比较,零时区换算、零重发。
 */
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';

let timer: ReturnType<typeof setInterval> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const POLL_MS = 5 * 60_000;

function isLocal(): boolean {
  try { return !!deps().profile.capabilities.hostExec; } catch { return false; }
}
function seam() {
  try { return deps().brain.inbox; } catch { return undefined; }
}
/** ponytail: 与 muse.museUserId 同款取法;config.json 自定义 userId 且未设 env 时会落错行(muse 同病,一起修)。 */
function pullUserId(): string {
  return process.env.TANGU_USER_ID || 'local';
}

/** 拉一轮广播(手动 POST /agent/inbox/pull 复用)。返回本轮新落库条数。 */
export async function pullBroadcastsOnce(userId: string): Promise<{ added: number }> {
  const s = seam();
  if (!s) return { added: 0 };
  let added = 0;
  // 翻页护栏:单轮最多 5×200 条;积压更多留给下个 tick,防病态同游标死循环。
  for (let page = 0; page < 5; page++) {
    const curRows = await query<any[]>(
      `SELECT MAX(created_at) AS cursor FROM inbox_messages WHERE user_id = ? AND origin_broadcast_id IS NOT NULL`,
      [userId],
    );
    const rawCursor = curRows?.[0]?.cursor;
    // PG host 回 Date、SQLite 回字符串;服务端契约要「原文」,Date 已失真但仅在云端形态出现(此处恒本地 SQLite)。
    const since = rawCursor == null ? undefined : String(rawCursor);
    const rows = await s.listBroadcasts(since);
    if (!rows.length) break;
    for (const b of rows) {
      if (!b?.id || !b?.created_at) continue; // 脏行防御
      const dup = await query<any[]>(
        `SELECT 1 AS x FROM inbox_messages WHERE user_id = ? AND origin_broadcast_id = ? LIMIT 1`,
        [userId, b.id],
      );
      if (dup?.length) continue;
      // 无 conflict target 的 ON CONFLICT DO NOTHING:SQLite/PGlite/PG 同一写法合法,兜并发重复。
      await query(
        `INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id, origin_broadcast_id, created_at)
         VALUES (?, ?, ?, ?, 'server', 'forsion', ?, ?) ON CONFLICT DO NOTHING`,
        [uuidv4(), userId, String(b.title || '').slice(0, 500), String(b.body || ''), b.id, String(b.created_at)],
      );
      added++;
    }
    if (rows.length < 200) break; // 未满页=已到头
  }
  return { added };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await pullBroadcastsOnce(pullUserId());
  } catch (e: any) {
    // 静默策略:单行日志,不抛、不额外重试(5min 间隔本身即温和退避)、不打扰用户。
    try { deps().host.log(`[inbox] pull failed: ${e?.message || e}`); } catch { /* 日志失败也不抛 */ }
  } finally {
    running = false;
  }
}

/** 启动广播拉取(幂等)。每 5 分钟一轮;开机 15s 后首拉。 */
export function startInboxPull(): void {
  if (timer) return;
  if (!isLocal()) return;
  if (!seam()) return;
  timer = setInterval(() => { void tick(); }, POLL_MS);
  (timer as any).unref?.();
  kickTimer = setTimeout(() => { void tick(); }, 15_000);
  (kickTimer as any).unref?.();
}

export function stopInboxPull(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
}
