/**
 * 在飞 run 登记表(设备能力 MCP 方案 P1 · K2 §3.2):「这台电脑此刻有哪些不是我在键盘前发起的任务在跑」。
 *
 * 读者:
 *   - GET /agent/remote/activity(+ /events SSE,本机专用)→ 桌面主进程:托盘「远程会话运行中 · 设备名」、keepAwake 强制通道、
 *     新调用方开始远程会话的通知;
 *   - POST /agent/remote/estop → 按分类中止非本机 run;
 *   - agentLoop.dispatchRun 的锁定扼流点(runCategory)。
 *
 * 分类只看**引擎自己写**的 input 字段(路由不透传 background / source,远端的 automationOrigin 已被 sanitizeRemoteAgentConfig 剥掉),
 * 请求体伪造不出 channel / unattended 豁免,也伪造不出 local(远程污点由路由按 x-forsion-remote 头盖,见 remoteOrigin.ts):
 *   remoteOf(input) || 中途被远端 steer 染色  → remote
 *   input.source.channel                      → channel
 *   input.background==='muse' || automationOrigin → unattended
 *   其余                                        → local
 * 分类在**快照时**按当前染色现算:本机起的 run 被手机 steer 之后立刻按远程列出(taintedMidRun)。
 *
 * 只登记已 dispatch 的 run(排队中的不列 —— 锁定时由 dispatchRun 的扼流点兜住)。纯内存,与 run 同寿命。
 * 待批计数来自 K3 的 pendingPromptIndex(按 runId),本模块**不碰** approvals.ts(INTEGRATION R-13)。
 * ⚠️ 不进任何工具、不进模型上下文(方案 §6.4-4)。变更通知去抖 200ms,定时器 unref(不拖住测试进程与引擎退出)。
 */
import { randomUUID } from 'node:crypto';
import { effectiveRemote, onRunTainted, remoteOf, type RemoteCallerKind, type RemoteVia } from './remoteOrigin.js';
import { listPrompts, onPromptChange } from './pendingPromptIndex.js';
import { remoteLockState, type RemoteLockState } from './remoteLock.js';
import { listTaggedProcesses, onProcessChange, type ProcessOrigin } from '../tools/processRegistry.js';

export type RunCategory = 'remote' | 'channel' | 'unattended' | 'local';

export interface ActivityRun {
  runId: string;
  sessionId: string;
  category: RunCategory;
  /** 仅 remote:来路 + 调用方(K1;缺席即缺席)。marked=false = 本机进程自己加的头(未盖章的远程)。 */
  remote?: { via?: RemoteVia; marked: boolean; callerUnit?: string; callerKind?: RemoteCallerKind; callerName?: string };
  /** 仅 channel:'wechat' | 'telegram' | 'qq' …(引擎内通道 kind)。 */
  channel?: string;
  /** 仅 unattended。 */
  unattended?: 'muse' | 'automation';
  agentSlug?: string;
  startedAt: number;
  /** 这条 run 上正在等人的审批 / 计划拍板(K3 pendingPromptIndex,按 runId)。 */
  pendingApprovals: number;
  /** 这条 run 上正在等人回答的询问。 */
  pendingInquiries: number;
  /** 本机起、后被远端 steer / 答询问染色。 */
  taintedMidRun?: true;
}

export interface ActivityProcess {
  id: string;
  sessionId: string;
  runId?: string;
  origin: Exclude<RunCategory, 'local'>;
  pid: number | null;
  /** 截 80。 */
  command: string;
  startedAt: number;
}

export interface ActivitySnapshot {
  v: 1;
  /** 本次引擎启动的标识:变了 = 引擎重启,消费方整份替换。 */
  bootId: string;
  /** 本次启动内单调递增。 */
  seq: number;
  lock: RemoteLockState;
  runs: ActivityRun[];
  processes: ActivityProcess[];
}

interface Entry {
  runId: string;
  sessionId: string;
  input: any;
  startedAt: number;
}

const BOOT_ID = randomUUID().slice(0, 8);
let seq = 0;
const runs = new Map<string, Entry>();
const listeners = new Set<() => void>();
let debounce: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 200;

const plain = (v: unknown): any => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * run 分类。按构造**不抛**(dispatchRun 的扼流点依赖这一点:外层 catch 会回落 runLoop = fail open)。
 * runId 给了就再看中途染色表(本机起、被远端 steer 过的 run 按远程算)。
 */
export function runCategory(input: any, runId?: string): RunCategory {
  try {
    const i = plain(input);
    if (remoteOf(i) || (runId && effectiveRemote({ runId }))) return 'remote';
    const src = plain(i.source);
    if (typeof src.channel === 'string' && src.channel) return 'channel';
    if (i.background === 'muse') return 'unattended';
    const cfg = plain(i.agentConfig);
    if (typeof cfg.automationOrigin === 'string' && cfg.automationOrigin) return 'unattended';
    return 'local';
  } catch {
    // 读不出来(畸形 input 的 getter 抛等):按非本机算 —— 锁定时拒它比放它安全
    return 'remote';
  }
}

function emitNow(): void {
  debounce = null;
  seq++;
  for (const cb of [...listeners]) {
    try { cb(); } catch { /* 订阅者的错误不影响登记表 */ }
  }
}

/** 标记一次变更(去抖 200ms 后通知订阅者)。 */
export function notifyActivity(): void {
  if (debounce) return;
  debounce = setTimeout(emitNow, DEBOUNCE_MS);
  (debounce as any).unref?.();
}

/** dispatchRun 读到 input 后登记。不抛。 */
export function registerRun(runId: string, sessionId: string, input: any): void {
  try {
    if (!runId || runs.has(runId)) return;
    runs.set(runId, { runId, sessionId: String(sessionId || ''), input: plain(input), startedAt: Date.now() });
    notifyActivity();
  } catch { /* 登记失败不影响 run(只影响托盘显示) */ }
}

/** run 的所有收尾路径(startRun 的 finally)。 */
export function unregisterRun(runId: string): void {
  if (runs.delete(runId)) notifyActivity();
}

/** remoteOrigin.taintRunRemote 首次染色时回调(onRunTainted 订阅):分类在快照时现算,这里只负责让订阅者及时看到。 */
export function noteRunTainted(runId: string): void {
  if (runs.has(runId)) notifyActivity();
}

function activityRun(e: Entry, prompts: Map<string, { approvals: number; inquiries: number }>): ActivityRun {
  const category = runCategory(e.input, e.runId);
  const cfg = plain(e.input.agentConfig);
  const counts = prompts.get(e.runId) ?? { approvals: 0, inquiries: 0 };
  const out: ActivityRun = {
    runId: e.runId, sessionId: e.sessionId, category, startedAt: e.startedAt,
    pendingApprovals: counts.approvals, pendingInquiries: counts.inquiries,
    ...(typeof cfg.agentSlug === 'string' && cfg.agentSlug ? { agentSlug: cfg.agentSlug } : {}),
  };
  if (category === 'remote') {
    const origin = remoteOf(e.input);
    const r = origin ?? effectiveRemote({ runId: e.runId });
    if (r) {
      out.remote = {
        ...(r.via ? { via: r.via } : {}), marked: r.marked,
        ...(r.callerUnit ? { callerUnit: r.callerUnit } : {}),
        ...(r.callerKind ? { callerKind: r.callerKind } : {}),
        ...(r.callerName ? { callerName: r.callerName } : {}),
      };
    }
    if (!origin) out.taintedMidRun = true;
  } else if (category === 'channel') {
    out.channel = String(plain(e.input.source).channel);
  } else if (category === 'unattended') {
    out.unattended = e.input.background === 'muse' ? 'muse' : 'automation';
  }
  return out;
}

/** 全量快照(每次现算:分类、待批计数、锁状态、后台进程)。 */
export function activitySnapshot(): ActivitySnapshot {
  const prompts = new Map<string, { approvals: number; inquiries: number }>();
  try {
    for (const p of listPrompts()) {
      const c = prompts.get(p.runId) ?? { approvals: 0, inquiries: 0 };
      if (p.kind === 'inquiry') c.inquiries++;
      else c.approvals++; // approval + plan(计划拍板也是在等人批)
      prompts.set(p.runId, c);
    }
  } catch { /* 索引读失败:计数为 0 */ }
  let processes: ActivityProcess[] = [];
  try { processes = listTaggedProcesses(); } catch { /* 注册表读失败:不列 */ }
  return {
    v: 1, bootId: BOOT_ID, seq, lock: remoteLockState(),
    runs: [...runs.values()].sort((a, b) => a.startedAt - b.startedAt).map((e) => activityRun(e, prompts)),
    processes,
  };
}

/** 订阅变更(去抖后回调,回调里自己取 activitySnapshot())。返回退订。 */
export function onActivityChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// 待批进出、后台进程起落、中途染色都会改快照:订一次,永不退订(模块单例,与引擎同寿命)。
// 依赖方向单向(本模块 → remoteOrigin / pendingPromptIndex / processRegistry,它们都不 import 本模块),模块求值期订阅安全。
onPromptChange(() => notifyActivity());
onProcessChange(() => notifyActivity());
onRunTainted(noteRunTainted);

export type { ProcessOrigin };

/** @internal 测试用:清空登记表与订阅者(不发事件)。 */
export function __resetActivityForTests(): void {
  runs.clear();
  listeners.clear();
  if (debounce) clearTimeout(debounce);
  debounce = null;
}
