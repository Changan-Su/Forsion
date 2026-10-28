/**
 * 进程内询问(inquiry)登记表——ask_user / exit_plan_mode 工具的用户交互通道。
 * 机制与 approvals.ts 同款:loop 发 `inquiry_request` 事件 + 登记 resolver,await 答案;
 * TUI 同进程直调 resolveInquiry,桌面端经 SSE 收事件后 POST /agent/runs/:id/inquiries/:inquiryId 兑现。
 * 中止信号触发按「(用户中止了运行)」兑现,loop 随后正常收尾。
 */
import { randomUUID } from 'node:crypto';
import { publish } from './eventBus.js';
import { trackPrompt, untrackPrompt, type AnswerBy } from './pendingPromptIndex.js';
import { isChildBriefRun, isSiblingMessageRun, isUnattendedRun } from './remoteActivity.js';

export interface InquiryRequestPayload {
  question: string;
  /** 候选项(≤6;可空=纯自由输入)。 */
  options: string[];
  /** 是否允许自由文本(选项之外自己输入)。 */
  allowFreeText: boolean;
  /** 询问种类:'plan'=计划审阅(客户端渲染专属计划卡,含「编辑后批准」);缺省=通用问答。 */
  kind?: 'plan';
}

interface PendingInquiry {
  runId: string;
  resolve: (answer: string) => void;
}

const pending = new Map<string, PendingInquiry>(); // inquiryId -> resolver

// id 即兑现凭据 → 随机(同 approvals.ts)。前缀 inq_ 保留,且**不得**以 ui_ 开头(兑现路由按该前缀分流到 uiAck)。
function nextInquiryId(): string {
  return `inq_${randomUUID()}`;
}

/** 无人值守 run 的询问当场兑现的系统说明(英文,[No answer] 开头;interaction.ts 把它登记为系统代答,不贴「User answered」)。 */
export const INQUIRY_UNATTENDED_ANSWER =
  "[No answer] This is an unattended background run, so nobody is available to answer questions. This is a system note, not the user's reply and not permission: do not assume an answer; continue with what is safe without one, or leave the open question in your final result.";

/** 子会话(主会话派的那一轮)里的询问当场兑现:用户多半不在子会话里,挂着等就卡住主会话的回报;问题改为收尾时送回主会话,
 *  主会话自己答(send_to_session)或再问用户(方案「子会话与任务卡」第 2 步:子会话先问主会话)。 */
export const INQUIRY_CHILD_ANSWER =
  "[No answer] You are a child session started by another session, so ask_user can't reach the user from here. This is a system note, not an answer: do not assume one. Finish what you can, then end your turn with the question as your last line; it goes back to the session that started you, which will answer it or ask the user.";

/** 兄弟会话发来消息的那一轮里的询问当场兑现(同上:用户不在这个子会话里)。 */
export const INQUIRY_SIBLING_ANSWER =
  "[No answer] This turn was started by a message from a sibling session, so ask_user can't reach the user from here. This is a system note, not an answer: do not assume one. If the sender should answer, ask it with send_to_session; otherwise finish what you can and end your turn with the question as your last line.";

// 子会话那一轮短路掉的问题(runId → 问题):收尾送回主会话时一并带上(childSessions.deliverNow 读,回报落库后清)。
// ponytail: 只在内存,引擎重启前没送出的问题丢失(回报本身重启后照样补送);要跨重启得落列。
const childAsked = new Map<string, string[]>();
export const peekChildQuestions = (runId: string): string[] => childAsked.get(runId) || [];
export const clearChildQuestions = (runId: string): void => { childAsked.delete(runId); };

/** 登记一次询问:发事件 + await 用户答案。 */
export function requestInquiry(
  runId: string,
  payload: InquiryRequestPayload,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.resolve('(用户中止了运行)');
  if (isUnattendedRun(runId)) return Promise.resolve(INQUIRY_UNATTENDED_ANSWER);
  // 计划审批不短路:用户在子会话里开了计划模式,批准卡照常挂在子会话里等用户(Codex 评审 P1)
  if (isChildBriefRun(runId) && payload.kind !== 'plan') {
    const q = String(payload.question || '').trim().slice(0, 2_000);
    if (q) childAsked.set(runId, [...(childAsked.get(runId) || []), q].slice(-5));
    return Promise.resolve(INQUIRY_CHILD_ANSWER);
  }
  if (isSiblingMessageRun(runId) && payload.kind !== 'plan') return Promise.resolve(INQUIRY_SIBLING_ANSWER);
  const inquiryId = nextInquiryId();
  return new Promise<string>((resolve) => {
    const onAbort = (): void => {
      pending.delete(inquiryId);
      untrackPrompt(inquiryId, 'expired'); // 中止不发 inquiry_result:索引(通知 / 角标)在这里撤(P1 · K3)
      resolve('(用户中止了运行)');
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending.set(inquiryId, {
      runId,
      resolve: (answer) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(answer);
      },
    });
    void publish(runId, 'inquiry_request', { inquiryId, ...payload });
    trackPrompt({ id: inquiryId, kind: payload.kind === 'plan' ? 'plan' : 'inquiry', runId });
  });
}

/** TUI 直调 / HTTP 端点调用:兑现某询问。false = 该 id 已不在等待(重复/过期)。
 *  ⚠️ HTTP 路由必须传 runId(理由同 approvals.resolveApproval):不比对 = 拿任意 run 的 URL 替别的 run 回答 / 批计划。 */
export function resolveInquiry(inquiryId: string, answer: string, runId?: string, by?: AnswerBy): boolean {
  const p = pending.get(inquiryId);
  if (!p || (runId !== undefined && p.runId !== runId)) return false;
  pending.delete(inquiryId);
  p.resolve(answer);
  const answeredBy: AnswerBy = by ?? { via: 'local' }; // 谁答的(P1 · K3);进程内调用方不传 = 本机
  // 广播结果:SSE 回放/多端订阅者据此知道该询问已被消化(未知事件类型各端自动忽略)。
  void publish(p.runId, 'inquiry_result', { inquiryId, answer, by: answeredBy });
  untrackPrompt(inquiryId, 'answered', answeredBy);
  return true;
}
