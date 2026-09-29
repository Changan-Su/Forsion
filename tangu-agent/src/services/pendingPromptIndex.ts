/**
 * 进程级「正在等人」索引(设备能力 MCP 方案 P1 · K3):审批 + 询问 + 计划拍板。
 *
 * 为什么要它:事件总线按 run 一个发射器(eventBus.ts),SSE 也只有按 run 的一条;审批 / 询问登记表是按 id 的 Map,
 * 不带会话 / 来源 / 工具。「这台电脑上现在有哪些会话在等人」没有任何现成的面 —— 桌面主进程要给远程 run 的待批弹系统通知、
 * 会话列表要画「等你处理」点、手机要知道 Mac 上哪条会话卡住了,都得从这里拿。
 *
 * 两个出口(routes/approvals.ts):
 *   GET /agent/approvals/pending  只给按**可见会话**聚合的计数(远端可读,不含 id / preview / 参数 / 工具名);
 *   GET /agent/approvals/stream   逐条变更的 SSE(本机专用,给主进程;含 id 与工具名,仍不含 preview / 参数)。
 *
 * 状态机(每条):tracked(未解析)→ [异步解析 run 行] → listed(发 added)→ removed(发 removed)。
 * tracked 期间被 untrack → 静默丢弃,不发 added / removed(订阅者从没见过它)。
 * 纯内存,与审批登记表同寿命:引擎重启 = 待批全失效(现状如此),rev 的前缀随启动换,客户端据此整份重拉。
 *
 * ⚠️ 不进任何工具、不进模型上下文(方案 §6.4-4):只有 approvals.ts / inquiries.ts 登记、routes/approvals.ts 读;
 * pendingPromptIndex.test.ts 扫 src/tools/** 钉住没有 import。
 * ⚠️ 本模块不起任何定时器:sweepTerminal 只在路由里惰性调用(≤ 每 30s 一次),否则会拖住测试进程与引擎退出。
 */
import { randomUUID } from 'node:crypto';
import { getRun } from './runStore.js';
import { query } from '../core/db.js';
import { effectiveRemote, remoteOf, type RemoteCallerKind, type RemoteInfo, type RemoteVia } from './remoteOrigin.js';

export type PromptKind = 'approval' | 'inquiry' | 'plan';
export type AnswerVia = 'local' | 'tunnel' | 'p2p' | 'lan' | 'remote' | 'channel';
/** 谁答的。remote = 带 x-forsion-remote 但 via 不在契约内;callerUnit / callerName 只在 K1 验过的隧道调用方上有。 */
export interface AnswerBy { via: AnswerVia; callerUnit?: string; callerName?: string }

export interface PendingRemote { via?: RemoteVia; callerUnit?: string; callerKind?: RemoteCallerKind; callerName?: string }
export interface PendingPrompt {
  /** approvalId | inquiryId */
  id: string;
  kind: PromptKind;
  /** 持有 resolver 的 run(团队成员 = 子 run)。 */
  runId: string;
  /** **可见**会话:teamMember.teamSessionId ?? run.session_id。解析失败 = ''(不进按会话的聚合)。 */
  sessionId: string;
  sessionTitle: string | null;
  /** 审批才有。 */
  tool: string | null;
  /** reason.kind==='protected':只能在执行设备本机批准(方案 §6.3)。 */
  localOnly: boolean;
  /** 远程污点(起跑时的 input.remote 或之后被远端 steer 染上的);本机 run = null。 */
  remote: PendingRemote | null;
  /** epoch ms */
  createdAt: number;
}
export type PromptOutcome = 'approved' | 'rejected' | 'answered' | 'expired';
export type PromptChange =
  | { type: 'added'; rev: string; item: PendingPrompt }
  | { type: 'removed'; rev: string; id: string; sessionId: string; outcome: PromptOutcome; by?: AnswerBy };
export interface SessionAttention { sessionId: string; approvals: number; inquiries: number; localOnly: number; oldestAt: string; remote: boolean }

/** 本次启动的前缀:引擎重启后 rev 必不相等(客户端的 ?rev= 短路不会把重启前的计数当成「未变」)。 */
const BOOT_ID = randomUUID().slice(0, 8);
let seq = 0;

interface Tracked {
  input: { id: string; kind: PromptKind; runId: string; tool?: string; localOnly?: boolean; origin?: RemoteInfo };
  createdAt: number;
  /** 解析完成、已发 added 的条目;未解析 = null。 */
  item: PendingPrompt | null;
}
const entries = new Map<string, Tracked>();
const listeners = new Set<(c: PromptChange) => void>();

const nextRev = (): string => `${BOOT_ID}:${++seq}`;
export function promptsRev(): string {
  return `${BOOT_ID}:${seq}`;
}

function emit(c: PromptChange): void {
  for (const cb of [...listeners]) {
    try { cb(c); } catch { /* 订阅者的错误不影响登记表 */ }
  }
}

function payloadOf(r: RemoteInfo | undefined | null): PendingRemote | null {
  if (!r) return null;
  return {
    ...(r.via ? { via: r.via } : {}),
    ...(r.callerUnit ? { callerUnit: r.callerUnit } : {}),
    ...(r.callerKind ? { callerKind: r.callerKind } : {}),
    ...(r.callerName ? { callerName: r.callerName } : {}),
  };
}

const parseInput = (v: unknown): any => {
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
};

/** 读 run 行 → 可见会话 / 标题 / 远程判定。任何一步失败都退回能拿到的(宁可有角标,也不因一次读失败丢条目)。 */
async function resolveMeta(t: Tracked): Promise<Pick<PendingPrompt, 'sessionId' | 'sessionTitle' | 'remote'>> {
  const { runId, origin } = t.input;
  let sessionId = '';
  let sessionTitle: string | null = null;
  let input: any = null;
  try {
    const run = await getRun(runId);
    input = parseInput(run?.input);
    const team = input?.agentConfig?.teamMember?.teamSessionId;
    sessionId = typeof team === 'string' && team ? team : String(run?.session_id || '');
  } catch { /* 没装配 / 读失败:会话未知,照样上架(通知与计数仍在) */ }
  if (sessionId) {
    try {
      const rows = await query<any[]>(`SELECT title FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
      const title = rows?.[0]?.title;
      sessionTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null;
    } catch { /* 标题缺席不影响 */ }
  }
  // 远程判定两路:审批带着闸里算好的有效污点(origin);询问没有,按 run 行 + 中途 steer 染色现算(与闸同一个 effectiveRemote)。
  const remote = payloadOf(origin ?? effectiveRemote({ remote: remoteOf(input), runId }));
  return { sessionId, sessionTitle, remote };
}

/** 登记一条正在等人的提示(approvals.ts / inquiries.ts 在发出请求事件之后调)。解析是异步的,完成后才发 added。 */
export function trackPrompt(p: { id: string; kind: PromptKind; runId: string; tool?: string; localOnly?: boolean; origin?: RemoteInfo }): void {
  if (!p?.id || entries.has(p.id)) return;
  const t: Tracked = { input: p, createdAt: Date.now(), item: null };
  entries.set(p.id, t);
  // Promise.resolve().then:deps() 没装配时 getRun 会**同步**抛,不包一层就漏成未处理的 rejection(审批单测不装配引擎)。
  void Promise.resolve()
    .then(() => resolveMeta(t))
    .catch(() => ({ sessionId: '', sessionTitle: null, remote: payloadOf(p.origin) }))
    .then((meta) => {
      if (entries.get(p.id) !== t) return; // 解析期间已被兑现 / 中止:静默丢弃(订阅者从没见过它)
      const item: PendingPrompt = {
        id: p.id, kind: p.kind, runId: p.runId, sessionId: meta.sessionId, sessionTitle: meta.sessionTitle,
        tool: p.kind === 'approval' ? (p.tool || null) : null, localOnly: p.localOnly === true, remote: meta.remote, createdAt: t.createdAt,
      };
      t.item = item;
      emit({ type: 'added', rev: nextRev(), item });
    });
}

/** 撤下一条(兑现 / 中止 / run 已终态)。未解析完的静默丢弃;不在表里 = no-op。 */
export function untrackPrompt(id: string, outcome: PromptOutcome, by?: AnswerBy): void {
  const t = entries.get(id);
  if (!t) return;
  entries.delete(id);
  if (!t.item) return;
  emit({ type: 'removed', rev: nextRev(), id, sessionId: t.item.sessionId, outcome, ...(by ? { by } : {}) });
}

/** 已上架(解析完)的条目快照,按登记时间升序。 */
export function listPrompts(): PendingPrompt[] {
  const out: PendingPrompt[] = [];
  for (const t of entries.values()) if (t.item) out.push({ ...t.item, remote: t.item.remote ? { ...t.item.remote } : null });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** 按可见会话聚合的计数(角标用):不带任何 id / 工具名 / 内容。会话未知的条目不进聚合。 */
export function sessionAttention(): SessionAttention[] {
  const by = new Map<string, { approvals: number; inquiries: number; localOnly: number; oldest: number; remote: boolean }>();
  for (const t of entries.values()) {
    const it = t.item;
    if (!it || !it.sessionId) continue;
    const s = by.get(it.sessionId) ?? { approvals: 0, inquiries: 0, localOnly: 0, oldest: it.createdAt, remote: false };
    if (it.kind === 'approval') s.approvals++;
    else s.inquiries++;
    if (it.localOnly) s.localOnly++;
    if (it.createdAt < s.oldest) s.oldest = it.createdAt;
    if (it.remote) s.remote = true;
    by.set(it.sessionId, s);
  }
  return [...by.entries()].map(([sessionId, s]) => ({
    sessionId, approvals: s.approvals, inquiries: s.inquiries, localOnly: s.localOnly, oldestAt: new Date(s.oldest).toISOString(), remote: s.remote,
  }));
}

/** 订阅变更;返回退订函数。 */
export function onPromptChange(cb: (c: PromptChange) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const TERMINAL = new Set(['done', 'failed', 'aborted']);
const SWEEP_EVERY_MS = 30_000;
const SWEEP_MIN_AGE_MS = 30_000;
let lastSweep = 0;
let sweeping: Promise<void> | null = null;

/**
 * 惰性清理:登记超过 30s 的条目,所属 run 已终态(或已不存在)→ expired。兜「loop 抛错但没 abort」这类泄漏 ——
 * 正常的中止分支由 approvals.ts / inquiries.ts 的 onAbort 显式撤下。≤ 每 30s 真跑一次;库读失败什么都不撤。
 */
export function sweepTerminal(): Promise<void> {
  if (sweeping) return sweeping;
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return Promise.resolve();
  lastSweep = now;
  const old = [...entries.entries()].filter(([, t]) => now - t.createdAt >= SWEEP_MIN_AGE_MS);
  if (!old.length) return Promise.resolve();
  const runIds = [...new Set(old.map(([, t]) => t.input.runId))];
  sweeping = (async () => {
    try {
      const rows = await query<any[]>(`SELECT id, status FROM agent_runs WHERE id IN (${runIds.map(() => '?').join(', ')})`, runIds);
      const status = new Map<string, string>((rows || []).map((r: any) => [String(r.id), String(r.status)]));
      for (const [id, t] of old) {
        const st = status.get(t.input.runId);
        if (st === undefined || TERMINAL.has(st)) untrackPrompt(id, 'expired');
      }
    } catch { /* 读失败:不撤任何条目(宁可多一个角标) */ }
  })().finally(() => { sweeping = null; });
  return sweeping;
}

/** @internal 测试用:清空登记表与节流时钟(不发任何事件)。 */
export function __resetPromptIndexForTests(): void {
  entries.clear();
  listeners.clear();
  lastSweep = 0;
  sweeping = null;
}
