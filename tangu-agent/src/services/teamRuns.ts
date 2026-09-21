/**
 * 团队成员的「工作载体」(方案 §6.4 A;09-16 第四轮拍板 ⑭「子会话 + 子 run」):
 *   - 每位成员在团队会话下有一条自己的后台工作会话(kind='teamwork',parent_session_id = 团队会话,一人一条、跨 run 复用)
 *     —— 这就是成员的私有持久上下文(压缩 / 召回都走既有机制;第三轮的「每条用户消息成员失忆」随之消失)。
 *   - 每次激活 = 该会话里一条子 run,走 agentLoop 的完整主循环(完整工具、并行工具批、deferred、delegate、各自的 enterRunContext);
 *     发言 = 子 run 的最终助手消息(agent_runs.result.content),由团队 run 抄回团队会话。
 *   - 团队 run(runGroupChat)只做协调:算 delta → 起激活 → 等终态 → 抄回发言;与 discussion.ts 同一族(独立会话 + createRun + enqueueRun)。
 * 不静态 import agentLoop(会成环:agentLoop → groupChat → teamRuns → agentLoop);enqueueRun / abortRun 走动态 import。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { createRun, getRun, updateRunStatus } from './runStore.js';
import { subscribe, type AgentEvent } from './eventBus.js';
import { storedApprovalMode } from './approvals.js';
import type { NormalAgentDef } from '../agents/agentRegistry.js';

/** 成员工作会话的 kind(引擎内部隐藏种类,与 'discussion' 同列:不进会话列表,只经 /background 出现在 Team Desk)。 */
export const TEAMWORK_KIND = 'teamwork';
/** 一次激活最长等待(防挂死的子 run 拖住整个团队;到点中止该子 run,按 failed 处理)。 */
const WAIT_MAX_MS = 2 * 60 * 60 * 1000;
/** 团队 run 中止后给子 run 收尾的宽限(abortRun 后等它发 error/done)。 */
const ABORT_GRACE_MS = 10_000;
/** 终态事件(done / error)先于 agent_runs.status 落库(agentLoop 先 publish 再 updateRunStatus):收到事件后等库里也到终态,最多这么久。 */
const STATUS_SETTLE_MS = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MemberActivation {
  teamRunId: string;
  teamSessionId: string;
  userId: string;
  appId: string;
  /** 团队会话的模型;成员定义带 model 时以成员为准。 */
  modelId: string;
  member: NormalAgentDef;
  /** 临时成员(不在 ~/.tangu/agents;讨论的临时对象 / 桌面「临时 Agent」):定义随子 run 的 agentConfig.teamMember.def 下发。 */
  inlineDef: boolean;
  /** 这次激活注入成员的用户消息(= formatDelta 的结果)。 */
  delta: string;
  cycle: number;
  roster: string;
  teamDoc?: string;
  execMode: 'sandbox' | 'host';
  cwd?: string;
  extraRoots?: string[];
  wsProject?: string | null;
  approvalMode?: string;
  /** 团队 run 的审批档来自团队会话的设置(客户端发起):成员子 run 在审批时现读团队会话此刻的档(用户中途切档当场生效)。 */
  followSessionMode?: boolean;
  signal: AbortSignal;
  /** 子会话 / 子 run 建好、入队之前回调(团队 run 据此发 team_member start,带上 id)。 */
  onStarted?: (ids: { sessionId: string; runId: string }) => void;
  /** 子 run 的每一条事件(团队 run 从中转发审批 / 询问 / 工具活动 / 用量)。 */
  onEvent?: (ev: AgentEvent) => void;
}

export interface MemberOutcome {
  status: 'done' | 'failed' | 'aborted';
  /** 发言正文(status='done' 时才有意义)。 */
  text: string;
  error?: string;
  sessionId?: string;
  runId?: string;
}

/** 载体接口:runGroupChat 缺省用下面的真实实现;单测注入假实现(只验调度,不碰库)。 */
export type ActivateMember = (a: MemberActivation) => Promise<MemberOutcome>;

function parseJson(v: unknown): any {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** 该团队会话下这位成员的工作会话(没有就建)。按 parent + kind 查,再在 JS 里比 agent_config.agentSlug(行数 ≤ 成员数,不加列不加索引)。 */
const preparingMembers = new Map<string, Promise<string>>();
export function ensureMemberSession(a: Pick<MemberActivation, 'teamSessionId' | 'userId' | 'appId' | 'modelId' | 'member'>): Promise<string> {
  const key = `${a.userId}:${a.teamSessionId}:${a.member.slug}`;
  const pending = preparingMembers.get(key);
  if (pending) return pending;
  const created = findOrCreateMemberSession(a).finally(() => preparingMembers.delete(key));
  preparingMembers.set(key, created);
  return created;
}
async function findOrCreateMemberSession(a: Pick<MemberActivation, 'teamSessionId' | 'userId' | 'appId' | 'modelId' | 'member'>): Promise<string> {
  const rows = await query<any[]>(
    `SELECT id, agent_config FROM chat_sessions WHERE parent_session_id = ? AND user_id = ? AND kind = ? ORDER BY created_at ASC`,
    [a.teamSessionId, a.userId, TEAMWORK_KIND],
  );
  for (const r of rows || []) {
    const cfg = parseJson(r?.agent_config);
    if (cfg && cfg.agentSlug === a.member.slug) return String(r.id);
  }
  const id = uuidv4();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, a.userId, a.appId, `${a.member.name} · teamwork`.slice(0, 200), a.member.model || a.modelId || null, TEAMWORK_KIND, a.teamSessionId,
      JSON.stringify({ agentSlug: a.member.slug, teamMember: { teamSessionId: a.teamSessionId } }),
    ],
  );
  return id;
}

/** 子 run 的 agentConfig(与 discussion.ts 的 run 输入同形):身份 + 工作区 + 审批档 + 团队段;preset 显式 null(成员会话绝不套预设)。 */
export function memberRunConfig(a: MemberActivation): Record<string, unknown> {
  return {
    agentSlug: a.member.slug,
    execMode: a.execMode,
    cwd: a.cwd,
    extraRoots: a.extraRoots,
    workspaceProject: a.wsProject || undefined,
    // 团队会话的档优先,成员定义只在会话没设时由 applyAgentActivation 补(与主循环「会话显式值优先」同口径)。
    // 反过来(旧 runGroupTurn 口径)= 会话选了完全通行、成员 config.toml 里一句 auto-edit 照样逐次弹;会话选自动编辑、成员写 full-auto 则被它自己提权。
    approvalMode: a.approvalMode || undefined,
    thinkingLevel: a.member.thinkingLevel || undefined,
    preset: null,
    teamMember: {
      teamSessionId: a.teamSessionId,
      teamRunId: a.teamRunId,
      name: a.member.name,
      roster: a.roster,
      teamDoc: a.teamDoc,
      cycle: a.cycle,
      def: a.inlineDef ? a.member : undefined,
      followSessionMode: a.followSessionMode || undefined,
    },
  };
}

/** 真实载体:建 / 复用工作会话 → 建子 run → 先订阅再入队 → 等终态(中止 / 超时都收成 outcome,绝不 reject)→ 读发言。 */
export const activateMember: ActivateMember = async (a) => {
  let sessionId: string | undefined;
  let runId: string | undefined;
  let off: (() => void) | undefined;
  let enqueued = false;
  const aborted = (): boolean => a.signal.aborted;
  // 子 run 行一旦建了,要么成功入队、要么显式终态化:否则它留在 queued,Team Desk 显示忙碌、引擎重启后恢复器还会把它跑起来(Codex 09-16 r4 #4)。
  const settleUnqueued = async (status: 'aborted' | 'failed', error: string): Promise<void> => {
    if (runId && !enqueued) await updateRunStatus(runId, status, { error }).catch(() => {});
  };
  try {
    sessionId = await ensureMemberSession(a);
    // 团队 run 可能已跑了几小时:按团队会话此刻的档下发,子聊天里显示的档 / 成员会话里直接追问用的档才与实际一致(审批闸另外现读)。
    // 只管显示与直接追问的快照,读失败就保留原值(审批闸另外现读、读失败按只读,安全兜底在那边)。
    if (a.followSessionMode) a = { ...a, approvalMode: (await storedApprovalMode(a.teamSessionId).catch(() => undefined)) || a.approvalMode };
    // Direct follow-ups in the child Chat View retain its team identity and execution scope.
    // model_id 一起写穿:会话级调档(teamMemberConfigs)让成员模型逐次可变,只在建会话时写一次的话,
    // 子聊天里直接追问会退回上一个模型(建会话那次的值)。
    await query('UPDATE chat_sessions SET agent_config = ?, model_id = ? WHERE id = ?', [JSON.stringify(memberRunConfig(a)), a.member.model || a.modelId || null, sessionId]);
    runId = uuidv4();
    await createRun({
      id: runId,
      sessionId,
      userId: a.userId,
      appId: a.appId,
      modelId: a.member.model || a.modelId,
      assistantMessageId: uuidv4(),
      input: { message: a.delta, userMessageId: uuidv4(), attachments: [], agentConfig: memberRunConfig(a) },
    });
    // 先订阅再入队:子 run 的首批事件(status / 审批)不能漏。
    let settle!: () => void;
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    off = subscribe(runId, (ev) => {
      try { a.onEvent?.(ev); } catch { /* 转发方的错误不影响子 run */ }
      if (ev.type === 'done' || ev.type === 'error') settle();
    });
    const loop = await import('./agentLoop.js');
    if (aborted()) { await settleUnqueued('aborted', 'aborted before start'); return { status: 'aborted', text: '', sessionId, runId }; }
    a.onStarted?.({ sessionId, runId });
    loop.enqueueRun(sessionId, runId);
    enqueued = true;

    const childId = runId;
    const waited = await new Promise<'terminal' | 'aborted' | 'timeout'>((resolve) => {
      let done = false;
      const finish = (why: 'terminal' | 'aborted' | 'timeout'): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.signal.removeEventListener('abort', onAbort);
        resolve(why);
      };
      const onAbort = (): void => {
        // 团队 run 被中止:级联到子 run,再给它一点收尾时间(它会发 error{aborted}),不无限等。
        loop.abortRun(childId);
        setTimeout(() => finish('aborted'), ABORT_GRACE_MS);
      };
      const timer = setTimeout(() => { loop.abortRun(childId); finish('timeout'); }, WAIT_MAX_MS);
      void terminal.then(() => finish('terminal'));
      if (a.signal.aborted) onAbort();
      else a.signal.addEventListener('abort', onAbort, { once: true });
      // 订阅后再查一次:防 done 在 subscribe 之前就已发布(竞态;与 discussion.waitForTerminal 同款)。
      void getRun(childId).then((r) => { if (r && isTerminal(r.status)) finish('terminal'); }).catch(() => {});
    });
    if (waited === 'aborted') return { status: 'aborted', text: '', sessionId, runId };
    if (waited === 'timeout') return { status: 'failed', text: '', error: 'activation timed out', sessionId, runId };

    // 终态事件先于状态落库:等库里也到终态再读结果,否则成功的发言会被读成 failed: running(Codex 09-16 r4 #1)。
    let run = await getRun(runId);
    for (let waited = 0; run && !isTerminal(run.status) && waited < STATUS_SETTLE_MS; waited += 50) {
      await sleep(50);
      run = await getRun(runId);
    }
    if (!run) return { status: 'failed', text: '', error: 'run row missing', sessionId, runId };
    if (!isTerminal(run.status)) return { status: 'failed', text: '', error: `run status did not settle (${run.status})`, sessionId, runId };
    if (run.status === 'aborted') return { status: aborted() ? 'aborted' : 'failed', text: '', error: 'aborted', sessionId, runId };
    if (run.status !== 'done') return { status: 'failed', text: '', error: String(run.error || run.status), sessionId, runId };
    const result = parseJson(run.result);
    return { status: 'done', text: String(result?.content ?? ''), sessionId, runId };
  } catch (err: any) {
    await settleUnqueued(aborted() ? 'aborted' : 'failed', err?.message || String(err));
    return { status: aborted() ? 'aborted' : 'failed', text: '', error: err?.message || String(err), sessionId, runId };
  } finally {
    off?.();
  }
};

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'aborted';
}
