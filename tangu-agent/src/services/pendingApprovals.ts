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
import { previewText, deferredPreview, deferredSummary } from './approvals.js';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { displayText } from '../core/displayText.js';
import { deps } from '../seams/runtime.js';
import type { ToolCall, ChatMessage } from '../core/types.js';
import type { ToolContext } from '../tools/toolTypes.js';
import type { ApprovalDecision, ApprovalReason } from './approvals.js';
import { WRITE_TOOLS, writeTargetsOf } from '../tools/writeTargets.js';
import { AGENT_SCOPED_TOOLS } from '../tools/toolRegistry.js';
import { snapshotBeforeWrite, recordPostWrite } from './checkpoints.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { DEFAULT_AGENT_SLUG, readUserMd } from '../core/tanguHome.js';
import { getAgent, MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { loadSpecialAgentsConfig, resolveBackgroundModelId } from './specialAgentsConfig.js';
import { sendInboxMessage } from '../tools/builtin/inboxSend.js';
import { backgroundClientTag } from '../core/version.js';
import { publishBackgroundUsage } from './backgroundUsage.js';

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
  /** 预览口径版本(见 PREVIEW_VERSION)。NULL = 升级前的行(预览可能折叠 / 截断 / 只有一行摘要):永远批不了。 */
  preview_version: number | null;
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
  /** 此刻真正执行该调用的身份(具名子代理的展示 slug),与 agentSlug 不同才有值。
   *  唯一用途:挡住 AGENT_SCOPED_TOOLS 排队 —— 见 deferApproval 里那道闸。 */
  execAgentSlug?: string;
}

function log(msg: string): void {
  try { deps().host.log(`[approvals] ${msg}`); } catch { console.log(`[approvals] ${msg}`); }
}

function parseArgs(call: ToolCall): Record<string, any> {
  try { return call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { return {}; }
}

/** 可执行载荷的上限:超过不排队(截断会把参数截成非法 JSON → 批准后按 {} 执行,违反「按原参数执行」)。 */
export const MAX_DEFERRED_ARGS = 100_000;

/**
 * 行里预览的口径版本(pending_approvals.preview_version,Codex 09-26 四轮 #2)。批准的抢占要求 ≥ 本值,入队时写本值。
 *   1 = 待批动作全文可见:预览经 approvals.previewText 净化存全文,写类工具带完整改动(deferredPreview),放不下就不排队。
 * 升级前的行是 NULL:main 存的是 displayText(preview, 2000)(折成一行、静默截断),本分支早先的写类预览只有
 * `write /path (N chars)` 一行摘要 —— 批准却按完整参数执行。这些行一律撤回(retireLegacyPending),不给批。
 * 以后哪一版口径被判「看不全」,把本值加一:旧行在下一次触碰时自动撤回,不用再写迁移。
 */
export const PREVIEW_VERSION = 1;

/** 撤回旧行的 note(引擎写的数据串,同 recoverStaleExecuting / supersededNote 的英文口径;进该 agent 的 LOG 给模型读)。 */
export const LEGACY_PREVIEW_NOTE =
  'withdrawn by the system: it was queued by an older version whose approval card may not show the full action, ' +
  'so it cannot be approved. It did NOT run; the agent can request it again if it is still needed';
/** 批准撞上旧行时的回话(接口 409 的 detail;行本身已撤回)。 */
export const LEGACY_PREVIEW_REFUSAL =
  'cannot be approved: this request was queued by an older version whose approval card may not show the full action; it was withdrawn and did NOT run';

/**
 * 把本用户仍 pending、预览口径版本不够的行一律撤回(rejected / decided_by=system),每行在该 agent 的 LOG 留一行
 * (带工具名与闸门摘要)—— 它据此按需重新请求,新请求带完整预览、发新的收件箱卡;撤了 Muse 的行就叫醒 Muse。
 * 只会更严:撤回的行不执行,也不再能批。
 * 在 queueApproval / decideApproval / listApprovals / getApproval / countPendingApprovals 入口各跑一次:升级后第一次
 * 被任何一面(收件箱卡、Muse 清单、Muse 周期计数)碰到就撤,桌面看到的已是终态(已拒绝 + note),不会出现点了才报错的批准键。
 * 批准那一步的抢占另外再验一遍版本(decideApproval),本函数失败也放不过旧行 —— 所以这里吞错只记日志。
 * 不缓存「已扫过」:旧版引擎可能在降级 / 再升级之间又写进旧行;零命中的 UPDATE 很便宜。返回撤回的 id。
 */
async function retireLegacyPending(userId: string): Promise<string[]> {
  let rows: any[] = [];
  try {
    rows = (await query<any[]>(
      `UPDATE pending_approvals SET status = 'rejected', decided_by = 'system', note = ?, decided_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND status = 'pending' AND (preview_version IS NULL OR preview_version < ?) RETURNING id, agent_slug, tool, preview`,
      [LEGACY_PREVIEW_NOTE, userId, PREVIEW_VERSION],
    )) || [];
  } catch (e: any) {
    log(`撤回旧版审批行失败:${e?.message || e}`);
    return [];
  }
  const ids: string[] = [];
  let museTouched = false;
  for (const r of rows) {
    const id = String(r.id);
    const slug = r.agent_slug || DEFAULT_AGENT_SLUG;
    ids.push(id);
    if (slug === MUSE_AGENT_SLUG) museTouched = true;
    log(`withdrew ${id} (${r.tool}): queued before full approval previews (preview_version < ${PREVIEW_VERSION})`);
    // 带上撤的是哪件事(四轮复核 #3):只写 id,agent 读 LOG 不知道被撤的是什么,「可重新请求」无从下手。
    // 引擎的事实在前、模型派生的摘要在后(同 execBlock 的边界行):摘要被折叠 / 截断也截不掉「没执行、可重提」。
    await appendAgentLog(slug, userId,
      `[approval] request ${id} ${LEGACY_PREVIEW_NOTE}. The request was ${displayText(r.tool, 64)}: ${displayText(deferredSummary(String(r.tool ?? ''), r.preview), 300)}`);
  }
  // 与 decideApproval 的拒绝同口径:Muse 的请求被了结了就叫醒它,下个周期读到 LOG 按需重提(kickMuse 自带防重入)
  if (museTouched) await kickMuseSafe();
  return ids;
}

/** 去重键 = 工具名 + 规范化 cwd + 完整参数的 SHA-256:同一相对路径在不同 cwd 下是两件事;定长便于建唯一索引。 */
export function dedupeKeyOf(tool: string, cwd: string | undefined, args: string): string {
  const c = cwd ? path.resolve(cwd) : '';
  return createHash('sha256').update(`${tool}\n${c}\n${args}`).digest('hex');
}

/** 不排队的原因:参数超上限(截断会成非法 JSON),或预览净化后超 STORED_PREVIEW_MAX(卡上放不下全文)。
 *  retired = 同键、此前仍 pending 的旧行,已被撤回(见 queueApproval)。 */
export interface QueueTooLarge { tooLarge: 'args' | 'preview'; size: number; limit: number; retired: string[] }

/** 撤回行的 note(引擎写的数据串,同 recoverStaleExecuting / 代批否决的英文 note 口径)。 */
function supersededNote(kind: QueueTooLarge['tooLarge']): string {
  return `withdrawn by the system: the same action was requested again and ${kind === 'args' ? 'its arguments are too large to queue' : 'its preview cannot be shown in full on the approval card'}`;
}

/** 落一条待批行;同用户同 (工具, cwd, 参数) 已有 pending 行 → 复用(模型同一周期重试不会刷出一排)。
 *  并发插入靠 idx_pending_approvals_dedupe(部分唯一索引)兜底:撞索引就改读已有行。
 *  两道尺寸闸都在去重之前:放不下的请求连「复用已有行」也不回(不给模型一个看似已排队的 id)。
 *
 *  升级兼容(Codex 09-25 三轮 inbox-trunc #1):main 把预览存成 displayText(preview, 2000) —— 折成一行、静默截断。
 *  升级前留下的同键 pending 行,卡上是截断预览,批准却跑完整参数。所以:
 *   - 放不下(tooLarge):同键 pending 行一并撤回(rejected / decided_by=system)。否则告诉模型「没排队、没执行」
 *     是假话 —— 旧卡仍可批,且看不见尾巴;模型若再拆小重排,同一件事还可能跑两遍。撤回只会更严,不会更松。
 *   - 复用(去重命中,含并发撞索引):把旧行的预览刷新成这次的全文。去重键覆盖完整参数,换上的预览描述的是同一份参数。
 *
 *  存的预览 = deferredPreview(call, preview):写类工具接上完整改动(Codex 09-26 四轮 #1),尺寸闸按这份全文量。
 *  口径版本(四轮 #2):新行写 PREVIEW_VERSION;去重只复用同版本的行 —— 旧行(升级前,版本不够)**不**就地刷新升级:
 *  桌面早先按旧行渲染的卡(截断 / 一行摘要)还开着,刷新后它就变得可批,用户点的是没见过全文的那张卡。
 *  旧行在尺寸闸之后由 retireLegacyPending 撤回(先过尺寸闸:放不下时同键旧行按 supersededNote 撤、回报给模型),再插新行、发新卡。 */
export async function queueApproval(input: {
  userId: string; sessionId: string; runId?: string; agentSlug?: string; call: ToolCall;
  preview: string; reason?: ApprovalReason; cwd?: string; note?: string;
}): Promise<{ id: string; existing: boolean } | QueueTooLarge> {
  const tool = input.call.function.name;
  const args = String(input.call.function.arguments || '{}');
  const key = dedupeKeyOf(tool, input.cwd, args);
  const tooLarge: Omit<QueueTooLarge, 'retired'> | null = args.length > MAX_DEFERRED_ARGS
    ? { tooLarge: 'args', size: args.length, limit: MAX_DEFERRED_ARGS }
    : null;
  const fullPreview = tooLarge ? '' : deferredPreview(input.call, input.preview);
  const shown = tooLarge ? null : storedPreview(fullPreview);
  if (tooLarge || shown === null) {
    const refusal = tooLarge ?? { tooLarge: 'preview' as const, size: fullPreview.length, limit: STORED_PREVIEW_MAX };
    const note = supersededNote(refusal.tooLarge);
    const retired = await query<any[]>(
      `UPDATE pending_approvals SET status = 'rejected', decided_by = 'system', note = ?, decided_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND dedupe_key = ? AND status = 'pending' RETURNING id, agent_slug`,
      [note, input.userId, key],
    );
    const ids: string[] = [];
    for (const r of retired || []) {
      const id = String(r.id);
      ids.push(id);
      log(`withdrew ${id} (${tool}): re-requested, refused as too large (${refusal.tooLarge})`);
      await appendAgentLog(r.agent_slug || DEFAULT_AGENT_SLUG, input.userId, `[approval] request ${id} ${note}`);
    }
    return { ...refusal, retired: ids };
  }
  await retireLegacyPending(input.userId);
  // 只认同口径版本的行(旧行上面已撤;万一撤回失败,这里也不复用、不升级它 —— 插入撞唯一索引就报错,不排队)
  const findExisting = async (): Promise<string | null> => {
    const dup = await query<any[]>(
      `SELECT id FROM pending_approvals WHERE user_id = ? AND status = 'pending' AND dedupe_key = ? AND preview_version >= ? LIMIT 1`,
      [input.userId, key, PREVIEW_VERSION],
    );
    return dup?.[0]?.id ? String(dup[0].id) : null;
  };
  const reuse = async (id: string): Promise<{ id: string; existing: true }> => {
    await query(`UPDATE pending_approvals SET preview = ? WHERE id = ? AND status = 'pending' AND preview_version >= ?`, [shown, id, PREVIEW_VERSION]);
    return { id, existing: true };
  };
  const existing = await findExisting();
  if (existing) return reuse(existing);
  const id = uuidv4();
  try {
    await query(
      `INSERT INTO pending_approvals (id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, note, preview_version, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      // dedupe_key 保持最后一个参数(pendingApprovals.inbox / subagent 两份 mock 按 params 末位认键)
      [id, input.userId, input.sessionId, input.runId || null, input.agentSlug || null, tool, args,
        shown, input.reason ? JSON.stringify(input.reason) : null,
        input.cwd || null, input.note ? displayText(input.note, 1000) : null, PREVIEW_VERSION, key],
    );
  } catch (e) {
    const raced = await findExisting(); // 并发插入撞了唯一索引 → 用赢家的行
    if (raced) return reuse(raced);
    throw e;
  }
  return { id, existing: false };
}

/** 按 id 读一行(桌面审批卡用:列表接口缺省 100 行,按 id 在列表里找会把老记录判成「找不到」—— Codex 09-11 P1)。 */
export async function getApproval(userId: string, id: string): Promise<PendingApprovalRow | null> {
  await retireLegacyPending(userId); // 旧行先撤回:卡片直接渲染终态(已拒绝 + note),不摆一个点了才报错的批准键
  const rows = await query<any[]>(
    `SELECT id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, preview_version, decided_by, note, result, created_at, decided_at
     FROM pending_approvals WHERE user_id = ? AND id = ? LIMIT 1`,
    [userId, id],
  );
  return (rows?.[0] as PendingApprovalRow | undefined) ?? null;
}

export async function listApprovals(userId: string, status?: string, limit = 100): Promise<PendingApprovalRow[]> {
  const lim = Math.min(500, Math.max(1, limit));
  await retireLegacyPending(userId);
  const rows = await query<any[]>(
    `SELECT id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status, preview_version, decided_by, note, result, created_at, decided_at
     FROM pending_approvals WHERE user_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT ${lim}`,
    status ? [userId, status] : [userId],
  );
  return (rows || []) as PendingApprovalRow[];
}

export async function countPendingApprovals(userId: string): Promise<number> {
  await retireLegacyPending(userId);
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
 * 返回 ok=false 的情形:行不存在 / 非本人 / 已裁决过(幂等:重复点击不重复执行)/ 批准一条升级前的行(见下)。
 *
 * 升级前的行(preview_version 不够,Codex 09-26 四轮 #2):批准的抢占条件里带版本,旧行**永远抢不到** —— 这是闸,
 * 入口的 retireLegacyPending 只是让它们尽早落到终态。旧行批准 → ok=false、status=rejected、error=LEGACY_PREVIEW_REFUSAL
 * (接口回 409,桌面按 id 重拉即见「已拒绝」+ note);本次刚撤回的旧行上点拒绝 → ok=true(用户要的「不执行」已成立)。
 */
export async function decideApproval(
  id: string, userId: string, decision: 'approve' | 'reject', by: 'user' | 'agent', note?: string,
): Promise<{ ok: boolean; status?: PendingApprovalRow['status']; result?: string; error?: string }> {
  await recoverStaleExecuting(userId);
  const retired = await retireLegacyPending(userId);
  const noteStr = note ? displayText(note, 1000) : null;
  // CAS 抢占:只有把 pending 翻成 executing/rejected 的那一次调用拿到行。并发双击 / approve 与 reject 同时到
  // 都只有一方赢(第二方读回空 → 查当前状态回报)。RETURNING 在 SQLite(≥3.35)与 Postgres 都可用;
  // 进程内 mutex 挡不住共享 Postgres 的多进程,所以闸必须在数据库里。
  // 批准另要预览口径版本够(四轮 #2):用户在卡上看得见全文的行才抢得到;拒绝不设此条件。
  const approve = decision === 'approve';
  const claimed = await query<any[]>(
    `UPDATE pending_approvals SET status = ?, decided_by = ?, note = COALESCE(?, note), decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'pending'${approve ? ' AND preview_version >= ?' : ''} RETURNING *`,
    [approve ? 'executing' : 'rejected', by, noteStr, id, userId, ...(approve ? [PREVIEW_VERSION] : [])],
  );
  const row = claimed?.[0] as PendingApprovalRow | undefined;
  if (!row) {
    const cur = (await query<any[]>(
      `SELECT status, note, preview_version FROM pending_approvals WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId],
    ))?.[0];
    if (!cur) return { ok: false, error: 'approval not found' };
    let st = cur.status as PendingApprovalRow['status'];
    const legacy = !(Number(cur.preview_version) >= PREVIEW_VERSION); // NULL → Number(null)=0,也算旧
    // 入口撤回之后才落进来的旧行(降级过的旧版引擎还在写):再撤一次,绝不让它停在 pending 可批
    if (legacy && st === 'pending') {
      retired.push(...(await retireLegacyPending(userId)));
      if (retired.includes(id)) st = 'rejected';
    }
    // 本次刚撤回的旧行上点拒绝:用户要的「不执行」已成立
    if (legacy && !approve && retired.includes(id)) return { ok: true, status: 'rejected' };
    // 批准旧行:本次刚撤回 / 撤回失败仍 pending(抢占条件已挡住)/ 更早就撤回(桌面上还开着撤回前的卡)—— 都说清原因
    if (legacy && approve && (st === 'pending' || retired.includes(id) || cur.note === LEGACY_PREVIEW_NOTE)) {
      return { ok: false, status: st, error: LEGACY_PREVIEW_REFUSAL };
    }
    return { ok: false, status: st, error: `already ${st}` };
  }
  const agentSlug = row.agent_slug || DEFAULT_AGENT_SLUG;
  // 单行面(LOG / 回执标题)只用闸门那行摘要:写类行的 preview 带着完整改动(四轮 #1),整段折叠会把文件内容塞进来(复核 #2)
  const summary = deferredSummary(row.tool, row.preview);
  const shownPreview = displayText(summary, 300);
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
    title: `${status === 'approved' ? '✓' : '✗'} ${displayText(summary, 180)}`,
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
  /** 父 run(= 被代批的那个 Muse 周期)。判官的 token 必须挂在它身上,否则 tokensInWindow 的
   *  agent_run_events → agent_runs → chat_sessions(kind='muse')连接查不到,这笔钱对预算完全不可见。 */
  runId?: string;
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
    // 判官看的与用户卡上看的是同一份全文(写类 = 摘要 + 完整改动);看不全就不替用户批 —— 否决只是转排队(Codex 09-26 四轮复核)
    const fullPreview = deferredPreview(input.call, input.preview);
    if (fullPreview.length > STORED_PREVIEW_MAX) return { approve: false, reason: 'the change is too large to review in full' };
    const user =
      `Background agent "${input.agentSlug}" requests an action.\n` +
      `Tool: ${input.call.function.name}\nPreview: ${fullPreview}\n` +
      `Why approval is needed: ${input.reason ? `${input.reason.kind}${input.reason.rule ? ` (${input.reason.rule})` : ''}` : 'policy'}\n` +
      `Arguments: ${JSON.stringify(args).slice(0, 4000)}`;
    const llm = deps().brain.llm;
    const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(modelId);
    const payload = await llm.buildProviderPayload({
      model, apiModelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] as ChatMessage[],
      projectSource: '', usageSource: 'tangu', client: backgroundClientTag('muse'),
      temperature: 0, maxTokens: 300, stream: true, provider: (model as any)?.provider,
      // D3:判官只做一次 JSON 二选一,不需要思考预算(缺省档在 DeepSeek 这类端点上 = high)。
      thinkingLevel: 'low',
    } as any);
    const res = await llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider });
    // C-5 台账:放在解析之前 —— 模型没给出裁决(下面 return)也照样烧了 token。
    await publishBackgroundUsage('muse-judge', modelId, res?.usage, { runId: input.runId, model });
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
    const v = await judgeApproval({ userId, agentSlug, call, preview, reason, runId });
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
  // ALS 作用域的工具 × 执行身份≠本 run 的 agent:**不排队**。排队意味着事后由 executeApproved 重建
  // 上下文重放,而重建出来的身份是 row.agent_slug(本 run 的 agent),不是此刻发起调用的那个具名子代理 ——
  // 同一笔 manage_harness,当场执行写子代理的 HARNESS.md,事后批准却写到父代理头上(目标漂移)。
  // 行里只有一个 agent_slug 字段,它同时被 LOG/收件箱/叫醒 Muse 用着,不能改判成子代理身份;
  // 与其安静地写错文件,不如当场拒绝并告诉模型把结论写进最终报告。
  // (代批档 'agent' 不受影响:它在上面就地放行,执行仍发生在子代理的 ALS 作用域内。)
  if (ctx.execAgentSlug && ctx.execAgentSlug !== agentSlug && AGENT_SCOPED_TOOLS.has(call.function.name)) {
    return {
      action: 'reject',
      rejectReason:
        `"${call.function.name}" writes to whichever agent is running it, and it needs the user's approval, which can only happen after you have finished. ` +
        `Queuing it would apply it to "${agentSlug}" instead of "${ctx.execAgentSlug}", so it is refused here. ` +
        'Put what you wanted to record into your final report instead, and let the delegating agent decide.',
    };
  }
  const q = await queueApproval({
    userId, sessionId: ctx.sessionId, runId, agentSlug, call, preview, reason, cwd: ctx.cwd, note,
  });
  if ('tooLarge' in q) {
    // 两条入队路径(queue 档;agent 档代批否决后转排队)都经 queueApproval,在这里一并回话;代批否决的理由照样带上。
    // 「拆不开」的出路(Codex 09-25 三轮 inbox-trunc #2):manage_agent 的 system_prompt / soul 每次整字段替换,
    // 只说「拆小」会把模型逼去写一份删短的提示词或反复重试。
    const withdrawn = q.retired.length
      ? `An earlier identical request that was still waiting for approval (${q.retired.join(', ')}) was withdrawn for the same reason, so nothing is pending for it now. `
      : '';
    const unsplittable =
      'If it cannot be split (for example a single field that has to be written whole), do not retry it or shorten the content to fit; ' +
      'tell the user that it needs their approval in an interactive session, then continue with other work.';
    return {
      action: 'reject',
      rejectReason: (q.tooLarge === 'args'
        ? `This action needs the user's approval, but its arguments are too large to queue (${q.size} chars > ${q.limit}). ` +
          (note ? `${note}. ` : '') + withdrawn + 'It was NOT queued and did NOT run. Split it into smaller steps. '
        : `This action needs the user's approval, but its preview is too long to show in full on the approval card (${q.size} chars > ${q.limit}), ` +
          'and the user must be able to see everything they approve. ' + (note ? `${note}. ` : '') + withdrawn +
          'It was NOT queued and did NOT run. Split it into smaller steps whose content is short enough to review, then continue with other work. ') +
        unsplittable,
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


/** 收件箱存的审批预览上限(净化**之后**的字符数;previewText 会把一个伪装字符写成 6 个字的 `\u202E`)。 */
export const STORED_PREVIEW_MAX = 20_000;
/** 收件箱存的审批预览:沿用 approvals.previewText(保留换行 / 缩进、转义伪装字符、超长空白标成 [N spaces]),
 *  存**全文**;放不下返回 null,queueApproval 据此不排队。
 *  不变式:能被批准的,卡上一个字都看得见。旧版在 2 万字处截断、标一句 `[truncated N chars]` 照样入队 ——
 *  批准执行的却是完整参数(至多 MAX_DEFERRED_ARGS),长命令尾部的动作用户批了却看不见(Codex 09-25 三轮 #3)。
 *  不改成「把上限抬到覆盖最长参数」:预览相对参数没有干净的上界 —— previewText 把单个伪装字符扩成 6 字、
 *  manage_automation 省略 actions 时会带上库里旧动作链(不在参数里)—— 所以按实测长度拒,而不是按参数长度推。 */
export function storedPreview(preview: unknown): string | null {
  const p = previewText(preview);
  return p.length > STORED_PREVIEW_MAX ? null : p;
}
