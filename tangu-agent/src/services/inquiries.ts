/**
 * 进程内询问(inquiry)登记表——ask_user / exit_plan_mode 工具的用户交互通道。
 * 机制与 approvals.ts 同款:loop 发 `inquiry_request` 事件 + 登记 resolver,await 答案;
 * TUI 同进程直调 resolveInquiry,桌面端经 SSE 收事件后 POST /agent/runs/:id/inquiries/:inquiryId 兑现。
 * 中止信号触发按「(用户中止了运行)」兑现,loop 随后正常收尾。
 */
import { randomUUID } from 'node:crypto';
import { publish } from './eventBus.js';
import { trackPrompt, untrackPrompt, type AnswerBy } from './pendingPromptIndex.js';

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

/** 登记一次询问:发事件 + await 用户答案。 */
export function requestInquiry(
  runId: string,
  payload: InquiryRequestPayload,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.resolve('(用户中止了运行)');
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
