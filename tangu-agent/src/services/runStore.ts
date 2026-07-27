/**
 * agent_runs / agent_steps / agent_run_events 的存取层。
 *
 * 自 thin-worker 改造起,这些函数是 **`deps().state` 的薄封装**(SQL 收敛进 SqlStateStore):
 * 持库进程 = SqlStateStore(直连),thin worker = HttpStateStore(走 server)。调用点 import 路径不变。
 */
import { deps } from '../seams/runtime.js';
import type { AgentEvent } from './eventBus.js';
import type { ActiveRunRow, StepInput, StepRow } from '../seams/stateStore.js';

export interface AgentRun {
  id: string;
  session_id: string;
  user_id: string;
  app_id: string;
  status: string;
  current_step: number;
  model_id: string | null;
  sandbox_id: string | null;
  assistant_message_id: string | null;
  input: any;
  result: any;
  error: string | null;
  tokens_total: number;
}

export const createRun = (run: {
  id: string;
  sessionId: string;
  userId: string;
  appId: string;
  modelId: string;
  assistantMessageId: string;
  input: any;
}): Promise<void> => deps().state.createRun(run);

export const getRun = (id: string): Promise<AgentRun | null> => deps().state.getRun(id);

/** ownership 校验版：只返回属于该用户的 run。 */
export const getRunForUser = (id: string, userId: string): Promise<AgentRun | null> =>
  deps().state.getRunForUser(id, userId);

// ── run 终态收敛点:全部引擎调用方(agentLoop/groupChat)都经此写终态,单点发 run.done 活动行。
// 供 event_seen 盯「某 agent 的 run 结束」;automation run 带 o=triggerKey(评估侧防自激)。
// muse 周期跳过(高频噪音);仅本地形态(活动日志=hostExec 专属)。监听器由 muse.ts 注册(kickMuse,避免 import 环)。
const TERMINAL_STATUSES = new Set(['done', 'failed', 'aborted']);
let runTerminalListener: (() => void) | null = null;
export function setRunTerminalListener(cb: (() => void) | null): void {
  runTerminalListener = cb;
}

async function emitRunTerminal(id: string, status: string): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return;
  const run = await deps().state.getRun(id);
  if (!run) return;
  let input: any = run.input;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
  const cfg = (input && typeof input === 'object' ? input.agentConfig : null) || {};
  if (cfg.muse) return;
  const { appendActivityLine } = await import('./userActivity.js');
  await appendActivityLine('run.done', {
    agent: typeof cfg.agentSlug === 'string' ? cfg.agentSlug : undefined,
    s: String(run.session_id || '').slice(0, 6),
    status,
    o: typeof cfg.automationOrigin === 'string' ? cfg.automationOrigin : undefined,
  });
  runTerminalListener?.();
}

export const updateRunStatus = async (
  id: string,
  status: string,
  extra?: { result?: any; error?: string; currentStep?: number; tokensTotal?: number },
): Promise<void> => {
  await deps().state.updateRunStatus(id, status, extra);
  if (TERMINAL_STATUSES.has(status)) {
    emitRunTerminal(id, status).catch(() => {}); // 尽力而为,绝不影响 run 收尾
  }
};

export const appendStep = (step: StepInput): Promise<void> => deps().state.appendStep(step);

export const listEventsFrom = (runId: string, fromSeq: number): Promise<AgentEvent[]> =>
  deps().state.listEventsFrom(runId, fromSeq);

/** 列出某 run 的所有步骤（含 llm 输出/工具调用/结果），供 admin 查看会话输出内容。 */
export const listSteps = (runId: string): Promise<StepRow[]> => deps().state.listSteps(runId);

export const listActiveRunsBySession = (
  sessionId: string,
  userId: string,
): Promise<ActiveRunRow[]> => deps().state.listActiveRunsBySession(sessionId, userId);

/** 进程重启自愈用：列出仍在飞的 run（须在 failStaleRuns() 之后调用）。 */
export const listPendingRunsForRecovery = (): Promise<Array<{ id: string; session_id: string }>> =>
  deps().state.listPendingRunsForRecovery();

/** 启动时把超时仍 running 的 run 标 failed（进程重启自愈）。 */
export const failStaleRuns = (olderThanMinutes = 30): Promise<number> =>
  deps().state.failStaleRuns(olderThanMinutes);
