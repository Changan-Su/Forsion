/**
 * 遥测计数账本(帮助改进 Forsion v2,契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §7)。
 *
 * 引擎在事情发生的地方 +1,写进 state.db 的 telemetry_ledger(day, event, dim, field, n);Extend 每 10 分钟只读完整的日子、
 * 照白名单 v2 过一遍再发。这里只写**非负整数**:事件名 / 字段名 / 维度值都是下面手抄的字面量联合(引擎不读 telemetry-schema.json),
 * 拼错编译不过;外面来的字符串(卡片 kind、客户端传的 action)进账本前用 isLedgerField / isCardKind 再挡一道。
 *
 * - 不管遥测开没开都记(只在本机、没有内容);发不发由 Extend 决定。
 * - 只在本机形态(hostExec)写:云端是多用户共用的库、表里没有 user_id,thin worker 根本没有库。
 * - 写失败只记日志,绝不影响业务路径:inc / set 返回 void,调用方不 await;同步代码里也能直接调。
 * - 保留 35 天(telemetrySnapshot 每天顺手删更早的)。
 */
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import type { MuseCardKind } from '../contracts/clientTypes.js';

/** 白名单 v2(telemetry-schema.json version 2)里五个 daily_* 事件的 int 字段,逐字手抄。改这里先改 schema(两仓逐字节副本)。 */
export const LEDGER_FIELDS = {
  daily_muse: [
    'cyclesRule', 'cyclesSchedule', 'cyclesHeartbeat', 'cyclesRunEnd', 'cyclesModeAsk', 'cyclesModeAgent', 'cyclesModeAuto',
    'cyclesDone', 'cyclesError', 'cyclesAborted', 'cyclesSilent', 'cycleTokens', 'cycleMs',
    'producedCards', 'producedDms', 'producedTodos', 'producedStarters', 'inboxMarked', 'inboxUnmarked',
    'skipNoModel', 'skipOutsideHours', 'skipUserActive', 'skipNothingDue', 'skipAlreadyRunning', 'skipBudgetBillable',
    'skipBudgetGross', 'skipRestartCap', 'skipRemoteLock', 'skipSleepCleared',
    'dmProactive', 'dmTodo', 'dmApproval', 'dmCard', 'dmNotice', 'dmRemind', 'dmSuppressed', 'dmAwaitingUser',
    'dmReadIn24h', 'dmRepliedIn24h', 'feedbackUp', 'feedbackDown', 'feedbackText',
    'todoCreated', 'todoApproved', 'todoInjected', 'todoDone', 'todoDismissed',
    'starterCreated', 'starterUsed', 'starterDismissed', 'starterMuted',
    'ruleCreatedMuse', 'ruleCreatedUser', 'ruleObserveForced', 'rulePromoted', 'ruleExtended', 'rulePaused', 'ruleObservedHits',
    'approvalByAgent', 'approvalUserApproved', 'approvalUserRejected',
    'introAnswered', 'introSkipped', 'introWhenAnytime', 'introWhenDaytime', 'introWhenOpen',
    'introPaceAsNeeded', 'introPaceDaily', 'introPaceFree',
    'introFocusSchedule', 'introFocusStudy', 'introFocusProjects', 'introFocusInbox', 'introFocusCustom',
    'summarySent', 'summaryProposed', 'summaryAdopted', 'summaryAskUpgrade', 'sleepSet', 'digestSent',
    'gEnabled', 'gDaysEnabled', 'gModeAsk', 'gModeAgent', 'gModeAuto', 'gNotifyDigest', 'gHeartbeatMin', 'gMaxDmPerDay',
    'gOnboardingDay', 'gRulesObserving', 'gRulesEnabled',
  ],
  daily_muse_card: [
    'created', 'accept', 'observe', 'edit', 'dismiss', 'open', 'apply', 'yes', 'later', 'ignore', 'ack', 'item',
    'enable', 'extend', 'pause', 'answer', 'skip', 'ok', 'remove', 'installed', 'gone',
    'decideSecTotal', 'decidedRemote', 'gPendingOver3d',
  ],
  daily_memory: [
    'addAgent', 'addProject', 'addPerson', 'updateAgent', 'updateProject', 'updatePerson', 'forgetAgent', 'forgetProject', 'forgetPerson',
    'moveScope', 'srcExplicit', 'srcHistorian', 'srcDream', 'srcManual', 'srcRestore', 'srcExternalEdit', 'srcSync', 'srcMigration',
    'errFull', 'errVersionConflict', 'errPortraitFull',
    'userEditAgentWritten7d', 'userForgetAgentWritten7d', 'userRestoreDreamRetired', 'userEdit', 'userForget', 'userAdd',
    'retellExisting', 'retellForgotten', 'candidatesAdded',
    'dreamAuto', 'dreamManual', 'dreamArchive', 'dreamCompleted', 'dreamSkipped', 'dreamFailed', 'dreamCancelled',
    'dreamCalls', 'dreamSources', 'dreamGroups', 'dreamMerges', 'dreamDiscarded', 'dreamToPortrait', 'dreamPending',
    'dreamDeferred', 'dreamVerifyFail', 'dreamRetried', 'dreamMs',
    'harnessUpsertAgent', 'harnessUpsertHistorian', 'harnessUpsertMuse', 'harnessUpsertUser', 'harnessDelete', 'harnessRollback',
    'gEntries', 'gCharsPct', 'gTombstones', 'gCandidatesPending', 'gCandidatesOldestDays', 'gHarnessEntries',
  ],
  daily_judge: [
    'rounds', 'roundsIndependent', 'roundsAssist', 'roundsFork', 'isolationSkips', 'memCandidates',
    'projCandidatesAuto', 'projCandidatesQueued', 'projAdopted', 'projDismissed', 'projForgotten', 'projRestored', 'projCompacted',
    'harnessCandidatesAuto', 'harnessCandidatesQueued',
    'signalStop', 'signalToolLoop', 'signalNudge', 'signalCorrectionDecision', 'signalCorrectionLexical',
    'titleUpdated', 'summaryUpdated', 'iconUpdated',
  ],
  daily_human: [
    'wAgentShared', 'wAgentAgent', 'wAgentProject', 'wAgentPortrait', 'wAgentAgentMd', 'wAgentMemory',
    'wUserShared', 'wUserAgent', 'wUserProject', 'wUserPortrait', 'wUserAgentMd', 'wUserMemory',
    'srcRemember', 'srcDream', 'srcMove', 'srcPromote', 'srcUser', 'userUndoAgentWrite7d',
    'moveScan', 'moveMoved', 'moveKept', 'moveUndo', 'promoteToAgentMd',
    'coldstartAgents', 'coldstartPersonWrites', 'coldstartRelearned', 'mirrorConflicts', 'syncConflictCopies',
    'gHumanMdEntries', 'gAgentMdEntries', 'gPortraitEntries', 'gMemoryEntries', 'gCalendarRows', 'gAgentsWithHumanMd', 'gAgentsTotal',
  ],
} as const;

/** daily_muse_card 的维度(白名单 cardKind 枚举)。 */
export const CARD_KINDS = ['plugin', 'feature', 'inbox-ask', 'inbox-list', 'channel', 'settings', 'intro', 'summary', 'rule', 'rule-observed'] as const;
/** daily_memory 的维度:内置 slug 原样,史官 = historian,其余(用户自建)一律 custom —— 自建 Agent 的 slug / 名字绝不进账本。 */
export const AGENT_ROLES = ['xyra', 'aria', 'recita', 'coding', 'muse', 'historian', 'custom'] as const;

export type LedgerEvent = keyof typeof LEDGER_FIELDS;
export type LedgerField<E extends LedgerEvent> = (typeof LEDGER_FIELDS)[E][number];
/** g 开头 = 快照(只能 set);其余是计数(inc)。 */
export type LedgerCounter<E extends LedgerEvent> = Exclude<LedgerField<E>, `g${string}`>;
export type CardKind = (typeof CARD_KINDS)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
type DimOf<E extends LedgerEvent> = E extends 'daily_muse_card' ? CardKind : E extends 'daily_memory' ? AgentRole : never;
/** 有维度的事件必须给 dim,没维度的不许给。 */
type DimOpts<E extends LedgerEvent, X> = [DimOf<E>] extends [never] ? [opts?: X & { dim?: never }] : [opts: X & { dim: DimOf<E> }];
type IncExtra = { n?: number; now?: number };
type SetExtra = { now?: number };

// 手抄的 cardKind 与引擎自己的 MuseCardKind 必须是同一组:谁多一个都编译不过(新卡种先进白名单再进这里)。
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const cardKindsMatch: Same<CardKind, MuseCardKind> = true;
void cardKindsMatch;

const FIELD_SETS: { [E in LedgerEvent]: ReadonlySet<string> } = Object.fromEntries(
  Object.entries(LEDGER_FIELDS).map(([e, fs]) => [e, new Set<string>(fs)]),
) as any;
const DIMS: Partial<Record<LedgerEvent, ReadonlySet<string>>> = { daily_muse_card: new Set(CARD_KINDS), daily_memory: new Set(AGENT_ROLES) };

export function isLedgerField<E extends LedgerEvent>(event: E, field: unknown): field is LedgerField<E> {
  return typeof field === 'string' && FIELD_SETS[event].has(field);
}
export function isCardKind(x: unknown): x is CardKind {
  return typeof x === 'string' && DIMS.daily_muse_card!.has(x);
}

const BUILTIN_ROLES = new Set<string>(['xyra', 'aria', 'recita', 'coding', 'muse']);
/** slug → 账本维度。没有 slug = 默认 Agent。 */
export function agentRoleOf(slug?: string | null): AgentRole {
  const s = String(slug || DEFAULT_AGENT_SLUG);
  if (BUILTIN_ROLES.has(s)) return s as AgentRole;
  if (s === 'historian') return 'historian';
  return 'custom';
}

/** UTC 日期 YYYY-MM-DD。 */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
export const LEDGER_RETENTION_DAYS = 35;

let warned = 0;
function warn(e: unknown): void {
  if (warned++ >= 3) return; // 表缺失之类会每次都失败:告三次就够了
  try { deps().host.warn?.('[telemetry-ledger] write failed:', (e as any)?.message || e); } catch { console.warn('[telemetry-ledger] write failed:', (e as any)?.message || e); }
}
function localEngine(): boolean {
  try { return !!deps().profile.capabilities.hostExec; } catch { return false; }
}

function write(mode: 'inc' | 'set', event: LedgerEvent, field: string, n: number, dim: string | undefined, now: number | undefined): void {
  try {
    if (!Number.isSafeInteger(n) || n < 0 || (mode === 'inc' && n === 0)) return;
    if (!FIELD_SETS[event]?.has(field)) return;
    const dims = DIMS[event];
    if (dims ? !dims.has(String(dim)) : dim !== undefined && dim !== '') return;
    if (!localEngine()) return;
    const update = mode === 'inc' ? 'telemetry_ledger.n + excluded.n' : 'excluded.n';
    void query(
      `INSERT INTO telemetry_ledger (day, event, dim, field, n) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (day, event, dim, field) DO UPDATE SET n = ${update}`,
      [utcDay(now), event, dims ? String(dim) : '', field, n],
    ).catch(warn);
  } catch (e) {
    warn(e);
  }
}

export const ledger = {
  /** 计数 +n(缺省 1)。绝不抛、不用 await。 */
  inc<E extends LedgerEvent>(event: E, field: LedgerCounter<E>, ...opts: DimOpts<E, IncExtra>): void {
    const o = (opts[0] ?? {}) as IncExtra & { dim?: string };
    write('inc', event, field, o.n ?? 1, o.dim, o.now);
  },
  /** 快照 = n(g* 字段,以及按日重算的 dmReadIn24h / dmRepliedIn24h)。绝不抛、不用 await。 */
  set<E extends LedgerEvent>(event: E, field: LedgerField<E>, n: number, ...opts: DimOpts<E, SetExtra>): void {
    const o = (opts[0] ?? {}) as SetExtra & { dim?: string };
    write('set', event, field, n, o.dim, o.now);
  },
};

/** 删掉保留期(35 天)之前的日子。由 telemetrySnapshot 每轮调;失败抛给调用方(它自己 catch)。 */
export async function pruneLedger(now = Date.now()): Promise<void> {
  if (!localEngine()) return;
  await query(`DELETE FROM telemetry_ledger WHERE day < ?`, [utcDay(now - LEDGER_RETENTION_DAYS * 86_400_000)]);
}

/** @internal 测试用:复位告警计数。 */
export function resetLedgerWarningsForTest(): void { warned = 0; }
