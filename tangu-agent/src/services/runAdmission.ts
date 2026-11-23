/**
 * 多账号模式(core/accountScope.ts)的任务准入:每个账号同时最多 runsPerAccount 个 run,整个引擎同时最多 concurrentRuns 个,
 * 多出来的按先来后到排队(数值见 core/multiAccountLimits.ts)。
 *
 * - 同一会话里的 run 本来就串行(agentLoop 的 sessionActive / sessionQueue);这里管的是跨会话、跨账号的那一层:轮到某个会话的 run
 *   要真正开跑时(startRunInAccount 的任务里)先来这里拿一个名额,收尾时(那个任务的 finally,唯一一定会跑到的出口)还回来。
 * - 因为整个引擎满了而排队,累计超过 queueTimeoutMinutes 还没轮到 → 回 ENGINE_BUSY。因为自己账号的另一个任务在跑而排队不算这个时间:
 *   那是在等自己的任务,任务本身有时长上限。
 * - 每个账号最多排着 queuedRunsPerAccount 个(超了当场回 ACCOUNT_QUEUE_FULL),别让一个账号占满整条队。
 * - 只数本进程内存里的名额,不数库里的行(库里 queued 的行可能是上个进程留下的,开户时另行收尾)。
 */
import { multiAccountLimits, minutesMs } from '../core/multiAccountLimits.js';

export type AdmissionCode = 'ENGINE_BUSY' | 'ACCOUNT_QUEUE_FULL';

export class RunAdmissionError extends Error {
  constructor(readonly code: AdmissionCode, message: string) {
    super(message);
    this.name = 'RunAdmissionError';
  }
}

export const ENGINE_BUSY_MESSAGE = 'The engine is busy: too many conversations are running right now. Please try again in a few minutes.';
export const ACCOUNT_QUEUE_FULL_MESSAGE = 'Too many of your tasks are already waiting. Wait for them to finish, then try again.';

/** 排队在等什么:自己账号的名额(account)还是整个引擎的名额(engine)。 */
export type WaitingFor = 'account' | 'engine';

interface Waiter {
  runId: string;
  account: string;
  /** 因为引擎满了开始等的时刻;正在等自己账号的名额时为 null(这段不计时)。 */
  engineSince: number | null;
  /** 引擎满了已经等了多久(不含当前这一段)。 */
  engineWaited: number;
  waitingFor: WaitingFor | null;
  onWaiting?: (why: WaitingFor) => void;
  resolve: () => void;
  reject: (e: unknown) => void;
  detach: () => void;
}

const holders = new Map<string, string>(); // runId → 账号(持有名额的)
const waiters: Waiter[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;

function heldBy(account: string): number {
  let n = 0;
  for (const a of holders.values()) if (a === account) n++;
  return n;
}

function remove(w: Waiter): void {
  const i = waiters.indexOf(w);
  if (i >= 0) waiters.splice(i, 1);
  w.detach();
  if (!waiters.length && ticker) { clearInterval(ticker); ticker = null; }
}

function note(w: Waiter, why: WaitingFor): void {
  if (w.waitingFor === why) return;
  w.waitingFor = why;
  try { w.onWaiting?.(why); } catch { /* 通知失败不影响排队 */ }
}

/** 按先来后到放行能放的;超时的回忙。名额变化、有人来排队、上限文件改了、每秒一次都会走这里。 */
function pump(): void {
  const l = multiAccountLimits();
  const timeout = minutesMs(l.queueTimeoutMinutes);
  const now = Date.now();
  for (const w of [...waiters]) {
    if (heldBy(w.account) >= l.runsPerAccount) {
      if (w.engineSince !== null) { w.engineWaited += now - w.engineSince; w.engineSince = null; }
      note(w, 'account');
      continue;
    }
    if (holders.size >= l.concurrentRuns) {
      if (w.engineSince === null) w.engineSince = now;
      if (w.engineWaited + (now - w.engineSince) >= timeout) {
        remove(w);
        w.reject(new RunAdmissionError('ENGINE_BUSY', ENGINE_BUSY_MESSAGE));
        continue;
      }
      note(w, 'engine');
      continue;
    }
    remove(w);
    holders.set(w.runId, w.account);
    w.resolve();
  }
}

/**
 * 给这个 run 拿一个名额(拿到才 resolve)。signal 中止 → 以它的原因 reject(AbortError 形状)。
 * 引擎满着等超时 → RunAdmissionError(ENGINE_BUSY);这个账号已经排满 → RunAdmissionError(ACCOUNT_QUEUE_FULL)。
 * onWaiting:开始等 / 等的原因变了时回调(调用方用它发「排队中」的状态事件;回调要自己绑好账号上下文)。
 */
export function admitRun(runId: string, account: string, signal: AbortSignal, onWaiting?: (why: WaitingFor) => void): Promise<void> {
  if (holders.has(runId)) return Promise.resolve();
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { remove(w); reject(abortError(signal)); };
    const w: Waiter = {
      runId, account, engineSince: null, engineWaited: 0, waitingFor: null, onWaiting, resolve, reject,
      detach: () => signal.removeEventListener('abort', onAbort),
    };
    signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(w);
    pump();
    if (!waiters.includes(w)) return; // 当场放行 / 当场回忙
    const queued = waiters.filter((x) => x.account === account).length;
    if (queued > multiAccountLimits().queuedRunsPerAccount) {
      remove(w);
      reject(new RunAdmissionError('ACCOUNT_QUEUE_FULL', ACCOUNT_QUEUE_FULL_MESSAGE));
      return;
    }
    if (!ticker) {
      ticker = setInterval(pump, 1000);
      ticker.unref?.();
    }
  });
}

/** 还回名额(没拿过 = no-op),并放行排着的。 */
export function releaseRun(runId: string): void {
  if (!holders.delete(runId)) return;
  pump();
}

/** 这个 run 拿着名额吗(拿到 = 已经开跑过)。 */
export function holdsAdmission(runId: string): boolean {
  return holders.has(runId);
}

function abortError(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** 测试 / 诊断:谁拿着名额、谁在排、在等什么。 */
export function admissionSnapshot(): { running: Array<{ runId: string; account: string }>; waiting: Array<{ runId: string; account: string; waitingFor: WaitingFor | null }> } {
  return {
    running: [...holders.entries()].map(([runId, account]) => ({ runId, account })),
    waiting: waiters.map((w) => ({ runId: w.runId, account: w.account, waitingFor: w.waitingFor })),
  };
}
