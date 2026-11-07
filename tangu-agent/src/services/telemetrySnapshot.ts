/**
 * 遥测账本的每日快照与裁剪(契约 §7「快照(g*)」):引擎启动后约一分钟跑第一遍,之后每小时一遍。
 * - 给「今天」写一遍 g* 快照(set 幂等,每小时刷新一次 = 一天里最后一次的值留下;Extend 只读今天以前的日子)。
 * - dmReadIn24h / dmRepliedIn24h = 当天记录的、关于**前一天**(UTC)消息的数:前一天 Muse 发出的主动消息里,发出后 24 小时内
 *   被读到 / 被回复的条数,记在**今天**这一格,绝不回写昨天那一格 —— Extend 过了 UTC 零点第一跳就把昨天整行发走、不回头。
 *   前一天的消息,窗口在今天之内陆续关上:每小时重算一遍、set 覆盖,今天最后一次快照的值留下。
 *   ⚠️ 少算的一角:前一天深夜发的消息,窗口要到今天深夜才关,今天最后一次快照之后(至多一小时)才读到 / 回复的,不计。
 * - 记忆(按 agentRole)与 human/ 的 g* 快照、今天满 7 天的 Agent 数(冷启动分母)。只数条目 / 行数,原文不出本机。
 * - 删掉 35 天以前的日子。
 * 由引擎自己数,Extend 不碰这些文件和表。每一段单独 try:一段失败不连累别的段。持库的本机进程专用(hostExec)。
 */
import { query } from '../core/db.js';
import { listAgents, MUSE_AGENT_SLUG, resolveMemorySlug } from '../agents/agentRegistry.js';
import { agentRoleOf, ledger, pruneLedger, isCardKind, utcDay, type AgentRole } from './telemetryLedger.js';
import { loadSpecialAgentsConfig } from './specialAgentsConfig.js';
import { onboardingActive, readMuseOnboarding } from './museState.js';
import { loadTriggers } from './museTriggers.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir, humanDir } from '../core/tanguHome.js';
import { createMemoryRepository, isMemoryTombstoneActive, MEMORY_CHAR_BUDGET } from './memoryRepository.js';
import { readCandidates } from './memoryCandidates.js';
import { loadHarness } from '../agents/harnessStore.js';
import { portraitEntries } from '../agents/humanPortrait.js';
import './memoryTelemetry.js'; // 启动时挂上记忆提交的旁听者(daily_memory 的 src* 计数)

const DAY = 86_400_000;
const WEEK = 7 * DAY;
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
 * 前一天(UTC)Muse 发出的主动消息里,截至现在、发出后 24 小时内读到 / 回复的条数,记在今天这一格(见文件头注)。回复 = 同一会话里之后 24 小时内有用户消息;
 * 读到 = 会话的 last_read_at 落在发出后 24 小时内,或者回复了。⚠️ 近似:last_read_at 只留最后一次读的时刻,
 * 24 小时内读过、之后又读过(超过 24 小时)的会被记成没读。
 */
export async function snapshotMuseDmReads(now = Date.now()): Promise<void> {
  const dayStart = Date.parse(`${utcDay(now - DAY)}T00:00:00.000Z`);
  const replied = `EXISTS (SELECT 1 FROM chat_messages u WHERE u.session_id = m.session_id AND u.role = 'user' AND u.timestamp > m.timestamp AND u.timestamp <= m.timestamp + ${DAY} AND u.timestamp <= ${Math.floor(now)})`;
  const rows = await query<any[]>(
    `SELECT
       SUM(CASE WHEN ${replied} THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN ${replied} OR (s.last_read_at >= m.timestamp AND s.last_read_at <= m.timestamp + ${DAY} AND s.last_read_at <= ${Math.floor(now)}) THEN 1 ELSE 0 END) AS seen
     FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
     WHERE m.agent_slug = ? AND m.origin LIKE 'proactive%' AND m.timestamp >= ? AND m.timestamp < ?`,
    [MUSE_AGENT_SLUG, dayStart, dayStart + DAY],
  );
  ledger.set('daily_muse', 'dmReadIn24h', Math.max(0, Number(rows?.[0]?.seen) || 0), { now });
  ledger.set('daily_muse', 'dmRepliedIn24h', Math.max(0, Number(rows?.[0]?.replied) || 0), { now });
}

// ── 记忆 / human 的快照(daily_memory / daily_human 的 g*)──
const isItem = (l: string): boolean => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l);
const countItems = (raw: string): number => raw.split('\n').filter(isItem).length;
/** 没有这个文件 → null;有但读不了 → 抛(读失败 ≠ 空,调用方跳过这一项)。 */
function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** 每个 Agent 记忆域(共用默认记忆的折叠成一份)按 agentRole 汇总:条目、墓碑、候选积压、工作笔记条目;占预算百分比取这个角色里最满的那份。
 *  还没有 .memory-state.json 的记忆目录不读(读一次会触发迁移落盘,快照不该替用户写东西)。读不了的那一类整个角色都不写
 *  (读失败 ≠ 空:少加一份的和数比不写更糟,记成 NaN、最后跳过)。
 *  记忆走仓库的正常读口(同打开记忆页):盘上有外部改动时,这次读会照常把它提交进仓库。 */
export async function snapshotMemory(now = Date.now()): Promise<void> {
  const agents = await listAgents();
  const seen = new Set<string>();
  type Acc = { mem?: { entries: number; pct: number; tombstones: number }; cand?: { pending: number; oldest: number }; harness?: number };
  const acc = new Map<AgentRole, Acc>();
  for (const def of agents) {
    const memSlug = resolveMemorySlug(def);
    const role = agentRoleOf(memSlug);
    const a: Acc = acc.get(role) ?? {};
    acc.set(role, a);
    if (!seen.has(memSlug)) {
      seen.add(memSlug);
      const dir = join(agentsDir(), memSlug);
      if (existsSync(join(dir, '.memory-state.json'))) {
        try {
          const s = createMemoryRepository(dir).snapshot();
          const m = (a.mem ??= { entries: 0, pct: 0, tombstones: 0 });
          m.entries += s.entries.length;
          m.pct = Math.max(m.pct, Math.floor((s.content.length * 100) / MEMORY_CHAR_BUDGET));
          m.tombstones += s.tombstones.filter(isMemoryTombstoneActive).length;
        } catch { a.mem = { entries: NaN, pct: NaN, tombstones: NaN }; }
      }
      try {
        const list = readCandidates(memSlug);
        const c = (a.cand ??= { pending: 0, oldest: 0 });
        c.pending += list.length;
        for (const x of list) { const t = Date.parse(`${x.date}T00:00:00Z`); if (Number.isFinite(t)) c.oldest = Math.max(c.oldest, Math.floor((now - t) / DAY)); }
      } catch { a.cand = { pending: NaN, oldest: NaN }; }
    }
    try { a.harness = (a.harness ?? 0) + (await loadHarness(def.slug)).length; } catch { a.harness = NaN; }
  }
  for (const [dim, a] of acc) {
    if (a.mem && Number.isFinite(a.mem.entries)) {
      ledger.set('daily_memory', 'gEntries', a.mem.entries, { dim, now });
      ledger.set('daily_memory', 'gCharsPct', a.mem.pct, { dim, now });
      ledger.set('daily_memory', 'gTombstones', a.mem.tombstones, { dim, now });
    }
    if (a.cand && Number.isFinite(a.cand.pending)) {
      ledger.set('daily_memory', 'gCandidatesPending', a.cand.pending, { dim, now });
      ledger.set('daily_memory', 'gCandidatesOldestDays', a.cand.oldest, { dim, now });
    }
    if (a.harness !== undefined && Number.isFinite(a.harness)) ledger.set('daily_memory', 'gHarnessEntries', a.harness, { dim, now });
  }
}

/** human/ 那几份的条数、日历行数、有自己 HUMAN.md 的 Agent 数、Agent 总数,以及今天满 7 天的 Agent 数(冷启动的分母)。
 *  只数条目 / 行数,原文不出本机;某一项读不了就不写那一项。 */
export async function snapshotHuman(now = Date.now()): Promise<void> {
  const dir = humanDir();
  const each = (fn: () => void): void => { try { fn(); } catch { /* 这一项不写 */ } };
  const item = (file: string, field: 'gHumanMdEntries' | 'gAgentMdEntries' | 'gMemoryEntries'): void => each(() => {
    const raw = readText(join(dir, file));
    if (raw !== null) ledger.set('daily_human', field, countItems(raw), { now });
  });
  item('HUMAN.md', 'gHumanMdEntries');
  item('AGENT.md', 'gAgentMdEntries');
  item('MEMORY.md', 'gMemoryEntries');
  each(() => {
    const soul = readText(join(dir, 'SOUL.md'));
    if (soul !== null) ledger.set('daily_human', 'gPortraitEntries', portraitEntries(soul).length, { now });
  });
  each(() => {
    const cal = readText(join(dir, 'CALENDAR.db'));
    const db = cal === null ? null : JSON.parse(cal); // 读不懂 ≠ 0 行:抛出去,这一项不写
    if (Array.isArray(db?.rows)) ledger.set('daily_human', 'gCalendarRows', db.rows.length, { now });
  });
  const agents = await listAgents();
  ledger.set('daily_human', 'gAgentsTotal', agents.length, { now });
  each(() => ledger.set('daily_human', 'gAgentsWithHumanMd', agents.filter((a) => (readText(join(agentsDir(), a.slug, 'HUMAN.md')) ?? '').trim().length > 0).length, { now }));
  const turning = utcDay(now - WEEK);
  ledger.set('daily_human', 'coldstartAgents', agents.filter((a) => { const t = Date.parse(String(a.createdAt || '')); return Number.isFinite(t) && utcDay(t) === turning; }).length, { now });
}

/** 一轮:各段单独兜错。 */
export async function runTelemetrySnapshot(now = Date.now()): Promise<void> {
  const steps: Array<[string, () => Promise<void>]> = [
    ['prune', () => pruneLedger(now)],
    ['muse', () => snapshotMuse(now)],
    ['muse cards', () => snapshotMuseCards(now)],
    ['muse dm reads', () => snapshotMuseDmReads(now)],
    ['memory', () => snapshotMemory(now)],
    ['human', () => snapshotHuman(now)],
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
