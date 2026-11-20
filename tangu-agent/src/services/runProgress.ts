/**
 * 中断任务续跑(2026-11-20 方案 B,docs/ToBeImproved/中断任务续跑方案_2026-11-20)里**不依赖 agentLoop** 的那几块:
 *   - 本进程是不是「会做启动恢复」的引擎(markRecoveryHost):standalone 桌面引擎是,TUI / 云端 worker / 网关不是。
 *     建 run 时据此给 input 盖 hostRecovery 戳(runStore.createRun),自动续跑只认带戳的 run —— TUI 与桌面共用 state.db,
 *     TUI 起的 run 不带戳,桌面引擎永远不替它自动续(只给中断说明 + 「继续生成」)。
 *   - 边跑边落库(E2)的行写入串行器:同一 run 的进度写与段落库排成一条链,旧快照永远盖不住新的。
 *   - 回放时给「没有结果」的工具调用补的三分法合成结果(E3)。historyReplay 读,agentLoop 写。
 */

// ── 本进程会不会做启动恢复 ──
let recoveryHost = false;
/** startBackgroundTasks 在 recoverRuns 开着、且是本机形态(hostExec)时调;之后建的 run 才带 hostRecovery 戳。 */
export function markRecoveryHost(on = true): void { recoveryHost = on; }
export function isRecoveryHost(): boolean { return recoveryHost; }

// ── 工具调用的在飞记录(落在 tool_results 里那一项上)──
/**
 * 段落库时没有真结果的调用,在 tool_results 里占一项 `{ tool_call_id, name, inflight }`(没有 content):
 *   pending = 模型发了这批调用、引擎还没开始执行它;started = 已经开始执行(可能已生效),结果还没回来。
 * sideEffect 抄工具声明的 capabilities.sideEffect(none / read 才算「重跑无害」)。真结果回来就整项替换掉。
 */
export type InflightState = 'pending' | 'started';
export interface ToolInflight { state: InflightState; sideEffect: string }
export interface InflightResultEntry { tool_call_id: string; name: string; inflight: ToolInflight; content?: unknown }

export function isInflightEntry(r: any): r is InflightResultEntry {
  return !!r && typeof r === 'object' && !!r.inflight && typeof r.inflight === 'object'
    && (r.inflight.state === 'pending' || r.inflight.state === 'started');
}

/** 正在边跑边落库的助手段(本进程)。回放只对「它所属的 run 已经不在跑」的行用三分法;本进程在跑的段照旧当缺结果。 */
const liveRows = new Set<string>();
export function markLiveRow(messageId: string): void { liveRows.add(messageId); }
export function unmarkLiveRow(messageId: string): void { liveRows.delete(messageId); }
export function isLiveRow(messageId: string | undefined): boolean { return !!messageId && liveRows.has(messageId); }

// ── 回放的合成结果(给模型看,英文;措辞见方案 6.3)──
export const NOT_RUN_RESULT = '[Not run: the engine stopped before this call started. Run it again if it is still needed.]';
export const INTERRUPTED_READ_RESULT = '[Interrupted: the engine stopped before this call finished. It has no side effects; run it again if still needed.]';
export const OUTCOME_UNKNOWN_RESULT = '[Outcome unknown: the engine stopped while this call was running. It may have partially or fully taken effect. Check the current state before relying on it or running it again.]';
export const APPROVAL_EXPIRED_RESULT = '[Not completed: the approval request for this call expired when the engine stopped. Run it again if it is still needed; it will ask for approval again.]';
export const QUESTION_EXPIRED_RESULT = '[Not completed: this question expired unanswered when the engine stopped. Ask it again if you still need the answer.]';
/** 「已开始」没能落库、而这个调用可能有副作用时,引擎不执行它(评审 #4),给模型的结果。 */
export const CALL_NOT_STARTED_RESULT = 'Error: this call was not run. The engine could not record that it was starting, so it did not run a call that may have side effects. Nothing was executed; run it again if it is still needed.';

/** 在飞记录 → 合成结果。sideEffect 只有 none / read 算「没有副作用」;缺省 / unknown 一律按有副作用说。 */
export function inflightResultText(inflight: ToolInflight): string {
  if (inflight.state === 'pending') return NOT_RUN_RESULT;
  return inflight.sideEffect === 'none' || inflight.sideEffect === 'read' ? INTERRUPTED_READ_RESULT : OUTCOME_UNKNOWN_RESULT;
}

/** 挂起项(托盘 run 的待批 / 待答占位)所在的 run 已经结束:请求随引擎一起作废了。 */
export function expiredParkedText(toolName: string): string {
  return toolName === 'ask_user' ? QUESTION_EXPIRED_RESULT : APPROVAL_EXPIRED_RESULT;
}

// ── 同一 run 的行写入串行器 ──
/**
 * progress(write):合并式进度写。还没开始的那一次会在**开始时**现取快照,所以同时来的多次请求合成一次,也拿得到最新状态;
 *   已经在写的那次之后再来的请求,排一次新的。关闭(close)之后的进度写一律丢弃。
 * exclusive(fn):段落库(applySteering / 收尾 / 挂起项回填 / 图片交付)排进同一条链,保证不会有更早取的进度快照在它之后落地。
 *   close: true = 这是这一轮的最后一笔(收尾),此后进度写全部作废(中止后还在跑完的并行工具不能再写这一行)。
 * 写失败只记日志:进度写是尽力而为,不能拖垮 run。
 */
export interface RowWriter {
  /** 回 true = 这次请求所在的那一笔写成功落库了;false = 写失败 / 已关闭被丢弃。有副作用的调用据此决定能不能开始执行(评审 #4)。 */
  progress(write: () => Promise<void>): Promise<boolean>;
  exclusive<T>(fn: () => Promise<T>, opts?: { close?: boolean }): Promise<T>;
  readonly closed: boolean;
}

export function createRowWriter(onError?: (e: unknown) => void): RowWriter {
  let tail: Promise<unknown> = Promise.resolve();
  let queued: Promise<boolean> | null = null;
  let closed = false;
  const chain = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
  return {
    get closed() { return closed; },
    progress(write) {
      if (closed) return Promise.resolve(false);
      if (queued) return queued;
      const p = chain(async () => {
        queued = null; // 从这一刻起取快照:之后再来的请求要另排一次
        if (closed) return false;
        try { await write(); return true; } catch (e) { onError?.(e); return false; }
      });
      queued = p;
      return p;
    },
    exclusive(fn, opts) {
      if (opts?.close) closed = true;
      return chain(fn);
    },
  };
}

/** sideEffect 为 none / read 的调用重跑无害:进度写失败也照常执行。其余(含 unknown)要先确认「已开始」落库了。 */
export function harmlessSideEffect(sideEffect: string): boolean {
  return sideEffect === 'none' || sideEffect === 'read';
}
