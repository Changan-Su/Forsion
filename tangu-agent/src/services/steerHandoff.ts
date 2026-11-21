/**
 * 长命令不挡插话(借鉴 dsh-superagent 方案第 5 条 A,2026-11-20)。
 *
 * 平时和原来一样:run_bash 前台跑完才返回。只有**用户在它跑着时插话**,hostExec 才把正在跑的子进程原样移交进后台进程表
 * (processRegistry.adoptForegroundProcess,不重起),工具立刻返回已有输出,模型下一步就读到插话。这里管被移交命令的结局:
 *   - 结局表(endReasonOf):自己跑完 / 出错 / 移交后到了上限被停 → 要交回;被停(kill_process / 界面停止 / 急停 / 停掉那一轮 /
 *     引擎退出)→ 不交(停它的人知道)。只有被移交的命令才走这里,run_background 起的开发服务不唤醒任何东西。
 *   - 会话里有一轮在跑(本机交互 run):它在迭代边界 / 收尾闸门取走(takeHandoffUpdates),结局进这一轮。
 *   - 会话空闲(那一轮已经收尾):起一轮交回(deliverHandoffWake)。进程收尾、会话里任一轮收尾都会再查一次。
 *   - 结局行只带引擎自己的判定(进程号 / 退出码 / 时长 / 是否到点),**绝不带命令输出**:输出是不可信数据,拼进 user 行
 *     等于给它用户的身份(同 <approval_update>,Codex 09-27)。模型用 read_process_output 读。
 *   - 交没交记在进程记录上(handoff.delivered),**同步**翻:迭代边界、收尾闸门、起一轮三处谁先拿到算谁的,不会交两次。
 * ponytail: 引擎重启时被移交的命令随引擎一起停(disposeAllProcesses),不会有交回的那一轮。
 */
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';
import { createRun, getRun } from './runStore.js';
import { sessionRemoteTainted } from './remoteTaint.js';
import { killProcess, listAllProcesses, listProcesses, onHandoffClosed, type BackgroundProcess } from '../tools/processRegistry.js';

import { BACKGROUND_UPDATE_CLOSE, BACKGROUND_UPDATE_OPEN } from '../contracts/approvalQueue.js';

export { BACKGROUND_UPDATE_CLOSE, BACKGROUND_UPDATE_OPEN };

export type HandoffEnd = 'finished' | 'failed' | 'timed_out' | 'stopped';

/** 结局表。到点停的也是引擎停的,所以先判它。 */
export function endReasonOf(p: BackgroundProcess): HandoffEnd {
  if (p.handoff?.timedOut) return 'timed_out';
  if (p.killRequested) return 'stopped';
  if (p.status === 'error') return 'failed';
  return 'finished';
}
/** 这种结局要不要交回(起一轮 / 进当前轮)。被停的不交。 */
export const endWakes = (r: HandoffEnd): boolean => r !== 'stopped';

/** 收尾了、结局还没处理的被移交命令。 */
function pendingEnded(sessionId: string): BackgroundProcess[] {
  return listProcesses(sessionId).filter((p) => p.handoff?.closed && !p.handoff.delivered);
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** 结局行(user 行,落库;桌面按开头标记画成系统行)。只有引擎的判定,没有命令输出。 */
export function formatHandoffUpdate(procs: BackgroundProcess[]): string {
  const rows = procs.map((p) => {
    const h = p.handoff!;
    const reason = endReasonOf(p);
    const cmd = p.command.replace(/\s+/g, ' ').slice(0, 200);
    const total = dur((p.endedAt ?? Date.now()) - p.startedAt);
    const said = reason === 'timed_out'
      ? `It was still running ${dur(h.deadlineAt - h.movedAt)} after it was moved to the background, so it was stopped (ran ${total} in total).`
      : reason === 'failed' ? `It ended with a process error after ${total}.`
        : p.exitCode === null ? `It ended without an exit code (terminated by a signal) after ${total}.`
          : `It exited with code ${p.exitCode} after ${total} in total.`;
    return `[${reason}] process ${p.id} (run_bash call ${h.toolCallId}): ${cmd}\n${said}`;
  });
  return [
    BACKGROUND_UPDATE_OPEN,
    'Commands that were moved to the background when the user sent a message have ended:',
    '',
    rows.join('\n\n'),
    '',
    'Their output is not included here. Read it with read_process_output (the process_id above; ended processes are kept for 30 minutes), '
      + 'then carry on with the task — if the user was waiting for this result, tell them what it showed.',
    BACKGROUND_UPDATE_CLOSE,
  ].join('\n');
}

/** 当前轮取走已收尾、还没处理的结局(同步翻 delivered)。返回要注入的 user 行;只有被停的 / 没有 → null。 */
export function takeHandoffUpdates(sessionId: string): string | null {
  const ended = pendingEnded(sessionId);
  for (const p of ended) p.handoff!.delivered = true;
  const worth = ended.filter((p) => endWakes(endReasonOf(p)));
  return worth.length ? formatHandoffUpdate(worth) : null;
}

/** 收尾闸门用:有要交回的结局(被停的不算)。 */
export function hasHandoffUpdates(sessionId: string): boolean {
  return pendingEnded(sessionId).some((p) => endWakes(endReasonOf(p)));
}

/** 用户停掉了移交它的那一轮(这一轮还在跑):一并停。结局记成被停,不起轮。 */
export function stopRunHandoffs(runId: string): number {
  let n = 0;
  for (const p of listAllProcesses()) {
    if (p.handoff?.runId !== runId || p.status !== 'running') continue;
    if (!killProcess(p.sessionId, p.id).startsWith('Error')) n++;
  }
  return n;
}

const decode = (x: unknown): any => {
  if (typeof x === 'string') { try { return JSON.parse(x) || {}; } catch { return {}; } }
  return x && typeof x === 'object' ? x : {};
};
const loop = () => import('./agentLoop.js');

/** 同一会话的交回串行(两条命令前后脚收尾不会各起一轮)。 */
const chains = new Map<string, Promise<void>>();
export function deliverHandoffWake(sessionId: string): Promise<void> {
  const next = (chains.get(sessionId) || Promise.resolve()).catch(() => {}).then(() => wakeNow(sessionId));
  chains.set(sessionId, next);
  void next.finally(() => { if (chains.get(sessionId) === next) chains.delete(sessionId); }).catch(() => {});
  return next;
}

async function wakeNow(sessionId: string): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return;
  const { activeSessionIds, enqueueRun } = await loop();
  // 会话里有一轮(在跑或排着):它在迭代边界取走;它取不走(远程 / 通道那类轮)就等它收尾时 startRun 再叫这里
  if (activeSessionIds().has(sessionId)) return;
  const ended = pendingEnded(sessionId);
  if (!ended.length) return;
  for (const p of ended) p.handoff!.delivered = true; // 先于任何 await:同一批结局只会交一次
  const worth = ended.filter((p) => endWakes(endReasonOf(p)));
  if (!worth.length) return;
  const text = formatHandoffUpdate(worth);
  const owner = await getRun(worth[worth.length - 1].handoff!.runId);
  if (!owner) return; // 那一轮的行没了(会话删了):没处交
  const input = decode(owner.input);
  const modelId = String(owner.model_id || deps().profile.defaultModelId || '');
  // 会话后来被远端插话染过色:不起本机来源的一轮(那会绕过远程的审批上限),只写一行,等用户下一句再看
  if (input.remote || (await sessionRemoteTainted(sessionId))) {
    await deps().state.insertUserMessage({ id: uuidv4(), sessionId, content: text, modelId, attachments: null });
    await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sessionId]).catch(() => {});
    return;
  }
  const cfg = { ...decode(input.agentConfig) };
  delete cfg.remoteOrigin;
  const runId = uuidv4();
  await createRun({
    id: runId, sessionId, userId: owner.user_id, appId: owner.app_id, modelId, assistantMessageId: uuidv4(),
    input: {
      message: text, userMessageId: uuidv4(), attachments: [], agentConfig: cfg, backgroundUpdate: true,
      ...(typeof input.client === 'string' ? { client: input.client } : {}),
    },
  });
  enqueueRun(sessionId, runId);
}

let installed = false;
/** 进程收尾 → 会话空闲就起一轮交回(引擎启动装一次;有一轮在跑时 wakeNow 自己让开)。 */
export function installHandoffDelivery(): void {
  if (installed) return;
  installed = true;
  onHandoffClosed((p) => {
    void deliverHandoffWake(p.sessionId).catch((e) => console.error('[agent-core] background update delivery failed:', e?.message || e));
  });
}
