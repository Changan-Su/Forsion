/**
 * 「这一轮跑到哪了」:上下文窗口用了多少、还剩多少、本 run 花了多少 token、跑了几步、过了多久。
 * session_status 工具(让模型自己估预算)与 GET /agent/sessions/:id/status(界面 / 插件)读的是同一份。
 *
 * 这些数只活在主循环里,所以由循环自己记、按引用交出来,**不从库里凑**:
 *   - agent_runs.tokens_total 到终态才落,run 进行中恒为 0;
 *   - usage 事件异步落库,读之前要 drain;云端 worker(HttpStateStore)上读事件直接抛;
 *   - 实测的上下文占用(ContextUsageTracker)与压缩线只有循环自己知道。
 * 只有主 agentLoop 登记;子代理 / 群聊成员等旁路循环没有(子代理的 ctx 是父 run 的展开,读到的会是父 run 的数)。
 */
export interface RunStatus {
  runId: string;
  sessionId: string;
  modelId?: string;
  thinkingLevel?: string;
  /** 本 run 的循环开始时刻(ms epoch)。 */
  startedAt: number;
  /** 当前第几步(1 起);还没进循环时为 0。 */
  iteration: number;
  maxIterations: number;
  /** 已计入的模型调用次数(重试 / 中流续写不重复计)。 */
  llmCalls: number;
  tokens: { prompt: number; completion: number; cached: number; total: number };
  context: {
    /** 本 run 实际用的窗口(Ultra / 人填覆盖不封顶)。 */
    window: number;
    /** 现在的上下文占用。 */
    used: number;
    /** true = provider 上次实测的输入 + 之后新增的粗估;false = 整份粗估(本 run 还没拿到实测,或前缀刚被压缩改写)。 */
    measured: boolean;
    /** 自动压缩的触发线;compactionEnabled 为 false 时越线只走机械折叠。 */
    compactAt: number;
    compactionEnabled: boolean;
    /** 本 run 头一次与最近一次模型调用的实测输入:相减除以调用次数 = 每步涨多少。 */
    firstPrompt: number;
    lastPrompt: number;
  };
}

const live = new Map<string, { sessionId: string; get: () => RunStatus }>();

/** 主循环开始时登记;终态(runLoop 的 finally)按 runId 撤。 */
export function registerLiveRun(runId: string, sessionId: string, get: () => RunStatus): void {
  live.set(runId, { sessionId, get });
}
export function unregisterLiveRun(runId: string): void {
  live.delete(runId);
}
/** 这个会话此刻在跑的主循环(同会话的 run 是串行的;万一有两条,取后登记的)。 */
export function liveRunStatus(sessionId: string): RunStatus | undefined {
  let hit: (() => RunStatus) | undefined;
  for (const e of live.values()) if (e.sessionId === sessionId) hit = e.get;
  return hit?.();
}

const n = (v: number): string => Math.max(0, Math.round(v)).toLocaleString('en-US');
const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.min(100, Math.max(0, Math.round((part / whole) * 100)))}%` : '0%');

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface SessionTotals { earlierRuns: number; earlierTokens: number; startedAt?: number }

/** 库里的时间列 → ms epoch。SQLite 的 CURRENT_TIMESTAMP 是不带时区标记的 UTC(直接 new Date 会按本地时区读,差一个时区);
 *  PG 侧已是 Date。与 routes/sessions.ts 的 timelineIso 同口径。读不出 → undefined。 */
export function dbTimeMs(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = String(v);
  const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? undefined : t;
}

/** 模型读的那份(英文)。数字都带千分位;估出来的明说是估的。 */
export function renderRunStatus(s: RunStatus, now = Date.now(), session?: SessionTotals): string {
  const c = s.context;
  const lines: string[] = [];
  lines.push(`Model: ${s.modelId || '(unknown)'}${s.thinkingLevel ? ` · thinking: ${s.thinkingLevel}` : ''}`);
  const limit = c.compactionEnabled && c.compactAt > 0 && c.compactAt < c.window ? c.compactAt : c.window;
  const room = Math.max(0, limit - c.used);
  lines.push(
    `Context: ${c.measured ? 'about' : 'roughly (estimated)'} ${n(c.used)} of ${n(c.window)} tokens in use (${pct(c.used, c.window)}). ` +
    (limit < c.window
      ? `Older turns are summarized automatically once it passes ${n(limit)}, so about ${n(room)} tokens of room remain before that.`
      : `About ${n(room)} tokens of room remain.`),
  );
  lines.push(`This run: step ${Math.max(1, s.iteration)} of at most ${s.maxIterations} · ${s.llmCalls} model call${s.llmCalls === 1 ? '' : 's'} so far · ${formatDuration(now - s.startedAt)} elapsed`);
  lines.push(`Tokens this run: ${n(s.tokens.prompt)} in${s.tokens.cached > 0 ? ` (${n(s.tokens.cached)} served from cache)` : ''} + ${n(s.tokens.completion)} out = ${n(s.tokens.total)}`);
  // 每步涨多少:头一次到最近一次实测输入之差 ÷ 间隔步数。压缩后会变负 → 不报。
  const steps = s.llmCalls - 1;
  const growth = steps >= 1 ? (c.lastPrompt - c.firstPrompt) / steps : 0;
  if (growth >= 1) {
    lines.push(`Context growth: about ${n(growth)} tokens per step so far; at this pace roughly ${n(Math.floor(room / growth))} more steps fit in the remaining room.`);
  }
  if (session && (session.earlierRuns > 0 || session.startedAt)) {
    const parts: string[] = [];
    if (session.earlierRuns > 0) parts.push(`${n(session.earlierRuns)} earlier run${session.earlierRuns === 1 ? '' : 's'} used ${n(session.earlierTokens)} tokens`);
    if (session.startedAt && now > session.startedAt) parts.push(`it started ${formatDuration(now - session.startedAt)} ago`);
    lines.push(`This conversation: ${parts.join('; ')}.`);
  }
  lines.push('These numbers are about this conversation only. They are not the user\'s account quota or plan allowance.');
  return lines.join('\n');
}
