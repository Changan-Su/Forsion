/**
 * session_status —— 让 agent 知道这段对话「跑到哪了」:上下文窗口用了多少 / 还剩多少、本 run 花了多少 token、
 * 跑了几步、过了多久。用户问「上下文还剩多少」时能答,开长任务前也能自己估预算。
 *
 * 数从主循环按引用拿(ctx.getRunStatus,见 services/runStatus.ts 头注为什么不读库)。
 * 只读、零副作用、不过审批;三端同形(mode 缺省 both,chat 预设在按需面上)。
 * 可见性只看门禁字段(目录与工具面同一份 ctx):子代理的 ctx 是父 run 的展开,读到的会是父 run 的数 → 不给;
 * 讨论成员 / Muse / 自动化 / 一次性 run 没有「用户在看这一轮」的前提,也不给(Muse、自动化还会把 deferred 定义整份带上)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { query } from '../../core/db.js';
import { dbTimeMs, renderRunStatus, type SessionTotals } from '../../services/runStatus.js';

function enabledFor(_p: unknown, ctx: ToolContext): boolean {
  return !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.inDiscussion && !ctx.muse && !ctx.automationOrigin && !ctx.ephemeral;
}

/** 本会话更早的 run 花了多少。云端 worker 没有本地库(query 抛)→ 不报这一行,别的照常。 */
async function sessionTotals(sessionId: string, runId: string | undefined): Promise<SessionTotals | undefined> {
  try {
    const rows = await query<any[]>(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_total), 0) AS total, MIN(created_at) AS first FROM agent_runs WHERE session_id = ? AND id <> ?`,
      [sessionId, runId || ''],
    );
    const r = rows[0] || {};
    const first = dbTimeMs(r.first);
    return { earlierRuns: Number(r.runs) || 0, earlierTokens: Number(r.total) || 0, ...(first !== undefined ? { startedAt: first } : {}) };
  } catch {
    return undefined;
  }
}

export const sessionStatusProvider: ToolProvider = {
  id: 'builtin:session_status',
  tools: () => [
    {
      name: 'session_status',
      deferred: true,
      deferHint: "How much of this conversation's context window is used and left, plus tokens, steps and time spent in this run. Check it when the user asks how much context is left, or before a long task to budget your steps.",
      isEnabledFor: enabledFor,
      definition: {
        type: 'function',
        function: {
          name: 'session_status',
          description:
            "Read where this conversation stands right now: context window size, how much is in use and how much room is left before older turns get summarized, " +
            'tokens spent in this run (input / cached / output), the current step and the step limit, elapsed time, and how fast the context is growing per step. ' +
            "Read-only. This is about this conversation's context and token use, not the user's account quota or plan.",
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async (_args, ctx) => {
        const status = ctx.getRunStatus?.();
        if (!status) return 'Session status is not available in this kind of run.';
        return renderRunStatus(status, Date.now(), await sessionTotals(ctx.sessionId, ctx.runId));
      },
    },
  ],
};
