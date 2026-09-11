/**
 * 无人值守 run 的异步审批(2026-09-10,Muse 权限档 ask / agent 的地基)。
 *
 * 同步审批(approvals.ts requestApproval)靠订阅者把决定送回**正在等待**的 run;后台 run 没有订阅者,
 * 非 full-auto 会永久卡 'running'——这是自动化管道当年强制 full-auto 的原因。本模块换一条路:
 *
 *   gateToolCall(ctx.approvalDeferral 有值)→ deferApproval:
 *     'agent' → 先让默认 agent 代用户裁决**一次**(judgeApproval;批准=放行并留审计行,否决=转排队)
 *     'queue' → 落 pending_approvals(同会话同工具同参数去重)→ 给模型一条「已排队,勿重试」的拒绝
 *   用户在 MuseView 批准 → decideApproval → executeApproved:按**原参数**直接 executeTool
 *     (与自动化 tool_call 动作同一条执行路;写类工具先留检查点 pre-image,可回退)→ 结果写回行、
 *     追加该 agent LOG 的 `[approval]` 行(下周期 read_log 即见)、收件箱通知、叫醒 Muse。
 *
 * 只在 host 形态有意义(云端没有 host 写工具);表在 migrate.ts,本地特性。
 * ⚠️ 对 tools/registry.js 与 muse.js 一律动态 import:approvals.ts → 本模块 → registry → builtin 工具 →
 *    (某些工具)→ approvals.ts,静态引用会成环。
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { displayText } from '../core/displayText.js';
import { deps } from '../seams/runtime.js';
import type { ToolCall, ChatMessage } from '../core/types.js';
import type { ToolContext } from '../tools/toolTypes.js';
import type { ApprovalDecision, ApprovalReason } from './approvals.js';
import { WRITE_TOOLS, writeTargetsOf } from '../tools/writeTargets.js';
import { snapshotBeforeWrite, recordPostWrite } from './checkpoints.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { DEFAULT_AGENT_SLUG, readUserMd } from '../core/tanguHome.js';
import { getAgent, MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { loadSpecialAgentsConfig, resolveBackgroundModelId } from './specialAgentsConfig.js';
import { sendInboxMessage } from '../tools/builtin/inboxSend.js';
import { backgroundClientTag } from '../core/version.js';

export type ApprovalDeferral = 'queue' | 'agent';

export interface PendingApprovalRow {
  id: string;
  user_id: string;
  session_id: string;
  run_id: string | null;
  agent_slug: string | null;
  tool: string;
  args: string;
  preview: string;
  reason: string | null;
  cwd: string | null;
  /** executing = 已被某次 approve 抢占、工具在跑(CAS 闸:并发双击只有一方拿到行);进程半途崩溃的 executing
   *  行由 recoverStaleExecuting 在 10 分钟后改判 failed。 */
  status: 'pending' | 'executing' | 'approved' | 'rejected' | 'failed';
  decided_by: string | null;
  note: string | null;
  result: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface DeferCtx {
  userId?: string;
  sessionId: string;
  agentSlug?: string;
  cwd?: string;
  approvalDeferral?: ApprovalDeferral;
}

function log(msg: string): void {
  try { deps().host.log(`[approvals] ${msg}`); } catch { console.log(`[approvals] ${msg}`); }
}

function parseArgs(call: ToolCall): Record<string, any> {
  try { return call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { return {}; }
}

/** 可执行载荷的上限:超过不排队(截断会把参数截成非法 JSON → 批准后按 {} 执行,违反「按原参数执行」)。 */
export const MAX_DEFERRED_ARGS = 100_000;

/** 去重键 = 工具名 + 规范化 cwd + 完整参数的 SHA-256:同一相对路径在不同 cwd 下是两件事;定长便于建唯一索引。 */
export function dedupeKeyOf(tool: string, cwd: string | undefined, args: string): string {
  const c = cwd ? path.resolve(cwd) : '';
  return createHash('sha256').update(`${tool}\n${c}\n${args}`).digest('hex');
}

/** 落一条待批行;同用户同 (工具, cwd, 参数) 已有 pending 行 → 复用(模型同一周期重试不会刷出一排)。
 *  并发插入靠 idx_pending_approvals_dedupe(部分唯一索引)兜底:撞索引就改读已有行。 */
export async function queueApproval(input: {
  userId: string; sessionId: string; runId?: string; agentSlug?: string; call: ToolCall;
  preview: string; reason?: ApprovalReason; cwd?: string; note?: string;
}): Promise<{ id: string; existing: boolean } | { tooLarge: true }> {
  const tool = input.call.function.name;
  const args = String(input.call.function.arguments || '{}');
  if (args.length > MAX_DEFERRED_ARGS) return { tooLarge: true };
  const key = dedupeKeyOf(tool, input.cwd, args);
  const findExisting = async (): Promise<string | null> => {
    const dup = await query<any[]>(
      `SELECT id FROM pending_approvals WHERE user_id = ? AND status = 'pending' AND dedupe_key = ? LIMIT 1`,
      [input.userId, key],
    );
    return dup?.[0]?.id ? String(dup[0].id) : null;
  };
  const existing = await findExisting();
  if (existing) return { id: existing, existing: true };
  const id = uuidv4();
  try {
    await query(
      `INSERT INTO pending_approvals (id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, note, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.userId, input.sessionId, input.runId || null, input.agentSlug || null, tool, args,
        displayText(input.preview, 2000), input.reason ? JSON.stringify(input.reason) : null,
        input.cwd || null, input.note ? displayText(input.note, 1000) : null, key],
    );
  } catch (e) {
    const raced = await findExisting(); // 并发插入撞了唯一索引 → 用赢家的行
    if (raced) return { id: raced, existing: true };
    throw e;
  }
  return { id, existing: false };
}

/** 按 id 读一行(桌面审批卡用:列表接口缺省 100 行,按 id 在列表里找会把老记录判成「找不到」—— Codex 09-11 P1)。 */
export async function getApproval(userId: string, id: string): Promise<PendingApprovalRow | null> {
  const rows = await query<any[]>(
    `SELECT id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, decided_by, note, result, created_at, decided_at
     FROM pending_approvals WHERE user_id = ? AND id = ? LIMIT 1`,
    [userId, id],
  );
  return (rows?.[0] as PendingApprovalRow | undefined) ?? null;
}

export async function listApprovals(userId: string, status?: string, limit = 100): Promise<PendingApprovalRow[]> {
  const lim = Math.min(500, Math.max(1, limit));
  const rows = await query<any[]>(
    `SELECT id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, decided_by, note, result, created_at, decided_at
     FROM pending_approvals WHERE user_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT ${lim}`,
    status ? [userId, status] : [userId],
  );
  return (rows || []) as PendingApprovalRow[];
}

export async function countPendingApprovals(userId: string): Promise<number> {
  const rows = await query<any[]>(`SELECT COUNT(*) AS n FROM pending_approvals WHERE user_id = ? AND status = 'pending'`, [userId]);
  return Number(rows?.[0]?.n) || 0;
}

/** 该 agent 的 LOG 追加一行(英文,下周期 read_log 喂给模型)。绝不抛。 */
async function appendAgentLog(agentSlug: string, userId: string, line: string): Promise<void> {
  try {
    await runWithAgentSlug(agentSlug, () => deps().brain.memory.appendLogEntry(userId, line));
  } catch { /* 反馈写失败不阻断 */ }
}

async function kickMuseSafe(): Promise<void> {
  try { (await import('./muse.js')).kickMuse(); } catch { /* supervisor 未起 */ }
}

/** 只有核心内置工具能延后执行:MCP / 自定义 / 插件工具的实现随会话与进程变(重建 ctx 时拿不到当时的
 *  mcpTools/customTools 快照,同名也可能已换绑),排了也执行不了或执行到别的实现 —— 一律不排队,直接告诉模型。 */
export async function isDeferrableTool(name: string): Promise<boolean> {
  if (name.startsWith('mcp__')) return false;
  const { listToolProviders } = await import('../tools/toolRegistry.js');
  return listToolProviders().some((p) => p.origin !== 'plugin' && p.tools().some((t) => t.name === name));
}

/** 半途崩溃留下的 executing 行(抢占后进程死了):超过 10 分钟改判 failed,免得永远卡「执行中」。 */
async function recoverStaleExecuting(userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  await query(
    `UPDATE pending_approvals SET status = 'failed', note = 'interrupted: the engine restarted while executing'
     WHERE user_id = ? AND status = 'executing' AND decided_at < ?`,
    [userId, cutoff],
  ).catch(() => {});
}

/** 按原参数直接执行一条已批准的行。返回工具结果文本(错误也以文本返回,调用方据 isError 标状态)。 */
async function executeApproved(row: PendingApprovalRow): Promise<{ result: string; isError: boolean }> {
  const call: ToolCall = { id: uuidv4(), type: 'function', function: { name: row.tool, arguments: row.args || '{}' } };
  const agentSlug = row.agent_slug || DEFAULT_AGENT_SLUG;
  // 检查点用独立 runId:checkpoints 每 run 每路径只记首次 pre-image,复用原 Muse run 的 id 会让
  // 「原 run 早先写过同一文件」的旧快照顶掉批准那一刻的现状,回退就回过头了。会话仍是 Muse 的(回退按会话找)。
  const cpRunId = `approval-${row.id}`;
  const ctx: ToolContext = {
    userId: row.user_id, sessionId: row.session_id, appId: deps().profile.appId,
    runId: cpRunId, agentSlug,
    execMode: 'host', approvalMode: 'full-auto', cwd: row.cwd || undefined,
    muse: agentSlug === MUSE_AGENT_SLUG,
    // 活动行 o=muse:Muse 盯 agent.edit 的规则不被自己(经用户批准)的写入唤醒。
    automationOrigin: agentSlug === MUSE_AGENT_SLUG ? MUSE_AGENT_SLUG : undefined,
  };
  const { executeTool } = await import('../tools/registry.js');
  return runWithAgentSlug(agentSlug, async () => {
    // 写类工具先留 pre-image:用户「回退到该时刻」仍覆盖这次代执行(run_bash 不在内,与 checkpoints.ts 同口径)。
    let undo: (() => Promise<void>) | null = null;
    let targets: string[] = [];
    if (WRITE_TOOLS.has(row.tool)) {
      const cwd = row.cwd || process.cwd();
      targets = writeTargetsOf(call).map((t) => (path.isAbsolute(t) ? t : path.resolve(cwd, t)));
      if (targets.length) {
        try { undo = await snapshotBeforeWrite(row.session_id, cpRunId, targets); } catch { undo = null; }
      }
    }
    const res = await executeTool(call, ctx);
    const isError = !!res.isError || String(res.result).startsWith('Error');
    if (isError && undo) await undo().catch(() => {});
    if (!isError && targets.length) await recordPostWrite(row.session_id, cpRunId, targets).catch(() => {});
    return { result: String(res.result ?? ''), isError };
  });
}

/**
 * 用户(或代批 agent)裁决。approve → 立刻执行并写回;reject → 标记 + LOG 行。
 * 返回 ok=false 的情形:行不存在 / 非本人 / 已裁决过(幂等:重复点击不重复执行)。
 */
export async function decideApproval(
  id: string, userId: string, decision: 'approve' | 'reject', by: 'user' | 'agent', note?: string,
): Promise<{ ok: boolean; status?: PendingApprovalRow['status']; result?: string; error?: string }> {
  await recoverStaleExecuting(userId);
  const noteStr = note ? displayText(note, 1000) : null;
  // CAS 抢占:只有把 pending 翻成 executing/rejected 的那一次调用拿到行。并发双击 / approve 与 reject 同时到
  // 都只有一方赢(第二方读回空 → 查当前状态回报)。RETURNING 在 SQLite(≥3.35)与 Postgres 都可用;
  // 进程内 mutex 挡不住共享 Postgres 的多进程,所以闸必须在数据库里。
  const claimed = await query<any[]>(
    `UPDATE pending_approvals SET status = ?, decided_by = ?, note = COALESCE(?, note), decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'pending' RETURNING *`,
    [decision === 'reject' ? 'rejected' : 'executing', by, noteStr, id, userId],
  );
  const row = claimed?.[0] as PendingApprovalRow | undefined;
  if (!row) {
    const cur = await query<any[]>(`SELECT status FROM pending_approvals WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
    const st = cur?.[0]?.status as PendingApprovalRow['status'] | undefined;
    return st ? { ok: false, status: st, error: `already ${st}` } : { ok: false, error: 'approval not found' };
  }
  const agentSlug = row.agent_slug || DEFAULT_AGENT_SLUG;
  const shownPreview = displayText(row.preview, 300);
  if (decision === 'reject') {
    await appendAgentLog(agentSlug, userId, `[approval] rejected by ${by}: ${shownPreview}${noteStr ? ` — ${noteStr}` : ''}`);
    if (agentSlug === MUSE_AGENT_SLUG) await kickMuseSafe();
    return { ok: true, status: 'rejected' };
  }
  let exec: { result: string; isError: boolean };
  try {
    exec = await executeApproved(row);
  } catch (e: any) {
    exec = { result: `Error: ${e?.message || e}`, isError: true };
  }
  const status: PendingApprovalRow['status'] = exec.isError ? 'failed' : 'approved';
  await query(
    `UPDATE pending_approvals SET status = ?, result = ? WHERE id = ? AND status = 'executing'`,
    [status, exec.result.slice(0, 4000), id],
  );
  await appendAgentLog(agentSlug, userId,
    `[approval] approved by ${by} and executed (${status}): ${shownPreview} → ${displayText(exec.result, 300)}`);
  // 收件箱回执(Muse 发信人缺省不转通道;标题沿用预览=模型/工具原文经净化,不硬编码语言)。
  await sendInboxMessage(userId, {
    title: `${status === 'approved' ? '✓' : '✗'} ${displayText(row.preview, 180)}`,
    body: exec.result.slice(0, 2000),
    senderId: agentSlug,
  }).catch(() => {});
  if (agentSlug === MUSE_AGENT_SLUG) await kickMuseSafe();
  log(`${id} ${status} by ${by}: ${row.tool}`);
  return { ok: true, status, result: exec.result };
}

/** 代批裁决(mode='agent'):默认 agent 的人格 + USER.md + 用户长期记忆,一次补全,输出 JSON。任何失败 → 否决(转排队)。 */
export async function judgeApproval(input: {
  userId: string; agentSlug: string; call: ToolCall; preview: string; reason?: ApprovalReason;
}): Promise<{ approve: boolean; reason: string }> {
  try {
    const def = await getAgent(DEFAULT_AGENT_SLUG).catch(() => null);
    const modelId = def?.model || (await resolveBackgroundModelId(loadSpecialAgentsConfig().muse.modelId));
    if (!modelId) return { approve: false, reason: 'no model available for the approving agent' };
    let memory = '';
    try {
      const m = await runWithAgentSlug(DEFAULT_AGENT_SLUG, () => deps().brain.memory.getMemory(input.userId));
      memory = String(m?.content || '').trim().slice(0, 3000);
    } catch { /* 无记忆也能判 */ }
    const userMd = readUserMd().trim().slice(0, 2000);
    const system =
      `You are ${def?.name || 'the user\'s default agent'}, deciding ON BEHALF OF THE USER whether a background agent may perform one action. ` +
      'The user is not present; you get exactly one chance. Approve ONLY if the action is clearly aligned with the user\'s known goals and preferences, ' +
      'stays inside their own workspaces, and is reversible (file edits are checkpointed; shell commands are not). ' +
      'Deny anything external (sending, publishing, purchasing), destructive (deleting, force-pushing, installing software), or that you are unsure about — a denial simply queues the request for the user. ' +
      'Respond with JSON only: {"approve": true|false, "reason": "<one short sentence>"}.' +
      (userMd ? `\n\n[USER.md]\n${userMd}` : '') +
      (memory ? `\n\n[User's long-term memory]\n${memory}` : '');
    const args = parseArgs(input.call);
    const user =
      `Background agent "${input.agentSlug}" requests an action.\n` +
      `Tool: ${input.call.function.name}\nPreview: ${input.preview}\n` +
      `Why approval is needed: ${input.reason ? `${input.reason.kind}${input.reason.rule ? ` (${input.reason.rule})` : ''}` : 'policy'}\n` +
      `Arguments: ${JSON.stringify(args).slice(0, 4000)}`;
    const llm = deps().brain.llm;
    const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(modelId);
    const payload = await llm.buildProviderPayload({
      model, apiModelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] as ChatMessage[],
      projectSource: '', usageSource: 'tangu', client: backgroundClientTag('muse'),
      temperature: 0, maxTokens: 300, stream: true, provider: (model as any)?.provider,
    } as any);
    const res = await llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider });
    try {
      const cost = await deps().billing.calculateCost(modelId, res?.usage?.prompt_tokens || 0, res?.usage?.completion_tokens || 0);
      const u = await deps().brain.users.getUserById(input.userId);
      await (deps().billing.logApiUsage as any)(
        u?.username || input.userId, modelId, (model as any)?.name, (model as any)?.provider,
        res?.usage?.prompt_tokens || 0, res?.usage?.completion_tokens || 0, true, undefined, 'tangu-muse', cost,
      );
    } catch { /* 记账失败不阻断 */ }
    const text = String(res?.content || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { approve: false, reason: 'approving agent gave no verdict' };
    const parsed = JSON.parse(m[0]);
    return { approve: parsed?.approve === true, reason: String(parsed?.reason || '').slice(0, 300) || (parsed?.approve === true ? 'approved' : 'denied') };
  } catch (e: any) {
    log(`代批裁决失败:${e?.message || e}`);
    return { approve: false, reason: 'approving agent unavailable' };
  }
}

/** 正文里的 tool / preview / note 是模型或工具原文:转义 markdown 活语法(`![x](url)` 会渲染成远程图片 = 追踪像素,
 *  `[[…]]` 会成双链),只让引擎自己追加的 forsion-approval 围栏是活的(Codex 09-11 P2)。 */
export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+!|<>~]/g, (c) => `\\${c}`);
}

/** 审批请求的收件箱正文(2026-09-11):工具 + 预览 + 代批意见,**围栏放最后** —— 转发到微信/TG 的纯文本副本
 *  前半段仍可读。围栏只带行 id:桌面「消息阅读」按 id 从 pending_approvals 读工具/预览/理由渲染审批卡,
 *  绝不信正文(正文可被任何发信人伪造,行只有引擎自己写得出)。 */
export function approvalRequestBody(a: { id: string; tool: string; preview: string; note?: string }): string {
  return [
    `${escapeMd(a.tool)} · ${escapeMd(displayText(a.preview, 1000))}`,
    a.note ? escapeMd(displayText(a.note, 500)) : '',
    '```forsion-approval\n' + JSON.stringify({ id: a.id }) + '\n```',
  ].filter(Boolean).join('\n\n');
}

/** 入队即发一封收件箱消息(只在 queueApproval 新建行时:existing=true 不重发,去重与行同源)。
 *  刻意绕过 notify=digest —— 审批是等用户拍板的请求,不是通知。发送失败(小时上限 / 落库失败)不阻断排队,
 *  但在该 agent 的 LOG 留痕,否则请求就只剩 Muse 面板一处可见。 */
async function notifyApprovalRequest(a: { userId: string; agentSlug: string; id: string; tool: string; preview: string; note?: string }): Promise<void> {
  const sent = await sendInboxMessage(a.userId, {
    title: `⏸ ${displayText(a.preview, 180)}`,
    body: approvalRequestBody(a),
    senderId: a.agentSlug,
  }).catch((e: any) => ({ ok: false as const, error: String(e?.message || e) }));
  if (!sent.ok) {
    await appendAgentLog(a.agentSlug, a.userId, `[approval] request ${a.id} queued, but the inbox message was not delivered: ${sent.error || 'send failed'}`);
  }
}

/**
 * approvals.gateToolCall 的无人值守分支:代替 `await requestApproval(...)`。
 * 返回 approve(代批放行)或带说明的 reject(已排队)。
 */
export async function deferApproval(
  runId: string, call: ToolCall, preview: string, reason: ApprovalReason | undefined, ctx: DeferCtx,
): Promise<ApprovalDecision> {
  const userId = ctx.userId || process.env.TANGU_USER_ID || 'local';
  const agentSlug = ctx.agentSlug || DEFAULT_AGENT_SLUG;
  let note: string | undefined;
  if (ctx.approvalDeferral === 'agent') {
    const v = await judgeApproval({ userId, agentSlug, call, preview, reason });
    if (v.approve) {
      // 审计行:代批放行也留痕(status=approved, decided_by=agent),面板能看到「谁替你点的头」。
      await query(
        `INSERT INTO pending_approvals (id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, decided_by, note, decided_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'agent', ?, CURRENT_TIMESTAMP, ?)`,
        [uuidv4(), userId, ctx.sessionId, runId || null, agentSlug, call.function.name,
          String(call.function.arguments || '{}').slice(0, MAX_DEFERRED_ARGS), displayText(preview, 2000),
          reason ? JSON.stringify(reason) : null, ctx.cwd || null, displayText(v.reason, 1000), null],
      ).catch(() => {});
      await appendAgentLog(agentSlug, userId, `[approval] approved on the user's behalf by the default agent: ${displayText(preview, 300)} — ${displayText(v.reason, 300)}`);
      return { action: 'approve' };
    }
    note = `declined by the approving agent: ${displayText(v.reason, 300)}`;
  }
  if (!(await isDeferrableTool(call.function.name))) {
    return {
      action: 'reject',
      rejectReason:
        `This action needs the user's approval, and "${call.function.name}" is an external/custom tool that cannot be queued for later approval. ` +
        'Skip it (or use a built-in alternative) and continue with other work.',
    };
  }
  const q = await queueApproval({
    userId, sessionId: ctx.sessionId, runId, agentSlug, call, preview, reason, cwd: ctx.cwd, note,
  });
  if ('tooLarge' in q) {
    return {
      action: 'reject',
      rejectReason: `This action needs the user's approval, but its arguments are too large to queue (${String(call.function.arguments || '').length} chars > ${MAX_DEFERRED_ARGS}). Split it into smaller steps.`,
    };
  }
  const { id, existing } = q;
  if (!existing) {
    log(`queued ${id} (${call.function.name}) for ${agentSlug}${note ? ` — ${note}` : ''}`);
    await notifyApprovalRequest({ userId, agentSlug, id, tool: call.function.name, preview, note });
  }
  return {
    action: 'reject',
    rejectReason:
      `Deferred for the user's approval (request ${id}): ${displayText(preview, 300)}. ` +
      (note ? `${note}. ` : '') +
      'Do not retry this action in this cycle — continue with other work. If the user approves, it will be executed with these exact arguments and the outcome will appear in your log as an [approval] entry.',
  };
}

