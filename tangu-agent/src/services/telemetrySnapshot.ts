/**
 * 遥测账本的每日快照与裁剪(契约 §7「快照(g*)」):引擎启动后约一分钟跑第一遍,之后每小时一遍。
 * - 给「今天」写一遍 g* 快照(set 幂等,每小时刷新一次 = 一天里最后一次的值留下;Extend 只读今天以前的日子)。
 * - dmReadIn24h / dmRepliedIn24h:**前天**发出的主动消息里,24 小时内被读到 / 被回复的条数,记在**今天**这一格。
 *   为什么不记在发出的那天:Extend 只读今天以前的日子、读过就不回头;昨天深夜发的消息,它的 24 小时窗口要到今天深夜才关,
 *   写回昨天那一格会被 Extend 先读走半截。前天的窗口到今天零点已经全部关上,值不会再变。
 * - 删掉 35 天以前的日子。
 * 由引擎自己数,Extend 不碰这些文件和表。每一段单独 try:一段失败不连累别的段。持库的本机进程专用(hostExec)。
 */
import { query } from '../core/db.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { ledger, pruneLedger, isCardKind, utcDay } from './telemetryLedger.js';
import { loadSpecialAgentsConfig } from './specialAgentsConfig.js';
import { onboardingActive, readMuseOnboarding } from './museState.js';
import { loadTriggers } from './museTriggers.js';

const DAY = 86_400_000;
export const TELEMETRY_SNAPSHOT_KICKOFF_MS = 60_000;
export const TELEMETRY_SNAPSHOT_INTERVAL_MS = 3600_000;

function log(msg: string): void {
  try { console.warn(`[telemetry-snapshot] ${msg}`); } catch { /* 无 */ }
}

/** Muse 设置档位、磨合期第几天、规则数(daily_muse 的 g*)。 */
export async function snapshotMuse(now = Date.now()): Promise<void> {
  const cfg = loadSpecialAgentsConfig().muse;
  ledger.set('daily_muse', 'gEnabled', cfg.enabled ? 1 : 0, { now });
  ledger.set('daily_muse', 'gModeAsk', cfg.mode === 'ask' ? 1 : 0, { now });
  ledger.set('daily_muse', 'gModeAgent', cfg.mode === 'agent' ? 1 : 0, { now });
  ledger.set('daily_muse', 'gModeAuto', cfg.mode === 'auto' ? 1 : 0, { now });
  ledger.set('daily_muse', 'gNotifyDigest', cfg.notify === 'digest' ? 1 : 0, { now });
  ledger.set('daily_muse', 'gHeartbeatMin', Math.max(0, Math.floor(Number(cfg.heartbeatMinutes) || 0)), { now });
  ledger.set('daily_muse', 'gMaxDmPerDay', Math.max(0, Math.floor(Number(cfg.maxDmPerDay) || 0)), { now });
  // 磨合期从 Muse 第一次开起来算(museState.MuseOnboarding.startedAt):开着的天数从这里数;第几天只在磨合期内有值
  const ob = await readMuseOnboarding().catch(() => null);
  const days = ob ? Math.max(0, Math.floor((now - ob.startedAt) / DAY)) : 0;
  ledger.set('daily_muse', 'gDaysEnabled', cfg.enabled && ob ? days : 0, { now });
  ledger.set('daily_muse', 'gOnboardingDay', onboardingActive(ob, now) ? days + 1 : 0, { now });
  const rules = await loadTriggers();
  ledger.set('daily_muse', 'gRulesObserving', rules.filter((t) => t.enabled && t.observe).length, { now });
  ledger.set('daily_muse', 'gRulesEnabled', rules.filter((t) => t.enabled && !t.observe).length, { now });
}

/** 每种卡里挂了三天以上没人理的(daily_muse_card.gPendingOver3d)。只写本机用过的卡种:从没出现过的卡种不发一行 0。 */
export async function snapshotMuseCards(now = Date.now()): Promise<void> {
  const used = await query<any[]>(`SELECT DISTINCT kind FROM muse_cards`);
  const stale = await query<any[]>(`SELECT kind, COUNT(*) AS n FROM muse_cards WHERE status = 'pending' AND created_at < ? GROUP BY kind`, [now - 3 * DAY]);
  const count = new Map((stale || []).map((r) => [String(r.kind), Number(r.n) || 0]));
  for (const r of used || []) {
    const kind = String(r.kind);
    if (isCardKind(kind)) ledger.set('daily_muse_card', 'gPendingOver3d', count.get(kind) ?? 0, { dim: kind, now });
  }
}

/**
 * 前天(UTC)Muse 发出的主动消息里,24 小时内读到 / 回复的条数,记在今天这一格(见文件头注)。回复 = 同一会话里之后 24 小时内有用户消息;
 * 读到 = 会话的 last_read_at 落在发出后 24 小时内,或者回复了。⚠️ 近似:last_read_at 只留最后一次读的时刻,
 * 24 小时内读过、之后又读过(超过 24 小时)的会被记成没读。
 */
export async function snapshotMuseDmReads(now = Date.now()): Promise<void> {
  const dayStart = Date.parse(`${utcDay(now - 2 * DAY)}T00:00:00.000Z`);
  const replied = `EXISTS (SELECT 1 FROM chat_messages u WHERE u.session_id = m.session_id AND u.role = 'user' AND u.timestamp > m.timestamp AND u.timestamp <= m.timestamp + ${DAY})`;
  const rows = await query<any[]>(
    `SELECT
       SUM(CASE WHEN ${replied} THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN ${replied} OR (s.last_read_at >= m.timestamp AND s.last_read_at <= m.timestamp + ${DAY}) THEN 1 ELSE 0 END) AS seen
     FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
     WHERE m.agent_slug = ? AND m.origin LIKE 'proactive%' AND m.timestamp >= ? AND m.timestamp < ?`,
    [MUSE_AGENT_SLUG, dayStart, dayStart + DAY],
  );
  ledger.set('daily_muse', 'dmReadIn24h', Math.max(0, Number(rows?.[0]?.seen) || 0), { now });
  ledger.set('daily_muse', 'dmRepliedIn24h', Math.max(0, Number(rows?.[0]?.replied) || 0), { now });
}

/** 一轮:各段单独兜错。 */
export async function runTelemetrySnapshot(now = Date.now()): Promise<void> {
  const steps: Array<[string, () => Promise<void>]> = [
    ['prune', () => pruneLedger(now)],
    ['muse', () => snapshotMuse(now)],
    ['muse cards', () => snapshotMuseCards(now)],
    ['muse dm reads', () => snapshotMuseDmReads(now)],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e: any) { log(`${name} failed: ${e?.message || e}`); }
  }
}

let kickoff: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;

export function startTelemetrySnapshots(): void {
  if (timer) return;
  const gen = ++generation;
  const tick = (): void => { if (gen === generation) void runTelemetrySnapshot().catch(() => {}); };
  kickoff = setTimeout(tick, TELEMETRY_SNAPSHOT_KICKOFF_MS);
  kickoff.unref?.();
  timer = setInterval(tick, TELEMETRY_SNAPSHOT_INTERVAL_MS);
  timer.unref?.();
}

export function stopTelemetrySnapshots(): void {
  generation++;
  if (kickoff) clearTimeout(kickoff);
  if (timer) clearInterval(timer);
  kickoff = null;
  timer = null;
}
