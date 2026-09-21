/**
 * 会话上下文压缩 —— 一等公民、可持久化的「总结检查点」(09-15 对标 pi / Codex 重做)。
 *
 * 两条入口共用一套转写 + 摘要 + 文件操作追踪:
 *  - compactWorkingMessages:run 内满载(或上游报溢出)时,按 token 预算把工作上下文的前段总结成一条
 *    system 摘要、原样保留最近 keepRecentTokens 的消息。**不碰 DB**;返回 boundary(总结覆盖到了哪一行 /
 *    行内哪个调用),由 agentLoop 决定何时落 session_summaries(已落库的行立刻落;尚未落库的助手段等
 *    它 finalize 后补落)。此前自动压缩只活在本 run 内存里,下个 run 把整段原样回放再总结一遍。
 *  - compactSession:手动 /compact(总结到最后一行)与 run 收尾后的「窗口外老行」惰性检查点
 *    (总结到指定时间戳),都直接落库。
 *
 * 检查点语义(hydrate / rowCoverage 同一把尺):through_timestamp 及之前的行整体被摘要覆盖;
 * through_message_id 指向的那一行只覆盖到 through_tool_call_id(含),其后的工具轮原样回放。
 * 摘要文本一旦写定不再变,summaryMessage 的字节 run 内与 hydrate 时逐字相同 → 压缩后的前缀可跨 run 命中缓存。
 * 所有读 fail-safe → 退回未压缩行为;用户取消会抛出,调用方须终结 run 而非继续机械折叠。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { publishBackgroundUsage } from './backgroundUsage.js';
import {
  compactionThreshold, estimateMessageTokens, estimateMessagesTokens, estimateTokensRough,
  isLossy, modelContextWindow, HISTORY_MSG_MAX_CHARS,
} from './contextBudget.js';
import { dropCoveredCalls, loadReplaySteps, replayAssistantHistory } from './historyReplay.js';
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from './compactionSettings.js';
import { historyRevision } from './historyRevision.js';
import type { ChatMessage, ThinkingLevel } from '../core/types.js';

// 结构化交接(借 pi 的 checkpoint schema + Codex 的 handoff 框架):压缩摘要的消费者是「接手续做的
// 下一个 LLM」,无结构的一段话最容易丢的恰是 In-progress / Next steps——丢了它们,压缩后模型就
// 只会「总结成果」不会「接着干」,长任务在压缩点断头。Goal 段要求逐字引用用户当前请求:被压掉的
// 那条 user 消息是任务的唯一原文(Codex 的做法是整条保留 user 消息,这里用引用换掉重放成本)。
const COMPACT_SYSTEM_PROMPT =
  'You are performing a context checkpoint compaction: turn the conversation below into a handoff summary that another LLM will rely on to seamlessly CONTINUE the task (not just recall it). Write in the same language as the conversation. Structure:\n' +
  '## Goal — what the user ultimately wants. Start by quoting the user\'s current request verbatim (their exact wording matters), then the overall objective. Keep the full objective; never shrink the scope.\n' +
  '## Done — completed steps, key decisions and conclusions (with exact file paths / identifiers / output locations).\n' +
  '## In progress / Next steps — what is unfinished and the concrete next actions, in order. This section matters most; never leave it empty if work remains.\n' +
  '## Facts & constraints — important facts, user preferences and corrections, pitfalls already discovered, exact names/paths/commands/error messages needed to continue.\n' +
  'Be concise but information-complete. Output only the summary itself — no pleasantries, no lead-in.';

// 增量压缩指令(借 pi 的 PRESERVE/UPDATE 变体):没有它,摘要模型面对 [Existing Summary] 最常见的
// 病是「重写一份更短的」——上一检查点里仍相关的路径/约束/未完项被静默蒸发,跨两次压缩后断头。
const COMPACT_INCREMENTAL_NOTE =
  '\nAn [Existing Summary] block precedes the new conversation: it is the previous checkpoint. UPDATE it instead of restarting — preserve every still-relevant fact, path, constraint and pending item from it; move items between sections as the new conversation completes or unblocks them; drop nothing merely to save space.';

/** 压缩系统提示:内置指令(或 settings.prompt 整体替换)+ 增量附注 + Additional focus(持久 instructions 与
 *  一次性 /compact <focus> 都走这里)。导出仅为测试。 */
export function compactSystemPrompt(hasPrevSummary: boolean, settings?: Partial<CompactionSettings>, focus?: string): string {
  const base = settings?.prompt?.trim() || COMPACT_SYSTEM_PROMPT;
  const extra = [settings?.instructions?.trim(), focus?.trim()].filter(Boolean).join('\n');
  return base + (hasPrevSummary ? COMPACT_INCREMENTAL_NOTE : '') + (extra ? `\n\nAdditional focus: ${extra}` : '');
}

// ── 文件操作机械追踪(借 pi compaction,07-30 归因轮 P2)────────────────────────
// 摘要模型会抄丢文件清单;这里与 LLM 摘要**并联**一条确定性通道:从被压缩窗口的 tool_calls
// 机械提取 read/modified 两个集合,以固定 XML 块附加在摘要尾部;下次增量压缩先解析上一块
// 继承、再叠加新窗口——跨任意多次压缩单调累积,清单正确性与摘要模型脱钩(pi 五件套)。
// 工具名→路径参数映射表:新增文件类工具时在此登记(amadeus 云端笔记工具也走 path)。
const FILE_READ_TOOLS: Record<string, string> = { read_file: 'path', read_document: 'path', view_image: 'path', view_video: 'path', amadeus_read_note: 'path' };
const FILE_WRITE_TOOLS: Record<string, string> = { write_file: 'path', edit_file: 'path', multi_edit: 'path', amadeus_write_note: 'path' };
const FILE_OPS_CAP = 200; // 每清单封顶,防跨多次压缩无界膨胀

export interface FileOps { read: Set<string>; modified: Set<string> }

/** 从一条消息的 tool_calls(JSONB 对象或 JSON 字符串)机械提取文件操作,累加进 into。绝不抛。 */
export function extractFileOps(toolCalls: unknown, into: FileOps): void {
  let calls: any = toolCalls;
  if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch { return; } }
  if (!Array.isArray(calls)) return;
  for (const c of calls) {
    const name = c?.function?.name;
    if (!name) continue;
    let args: any = c.function.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
    if (name === 'apply_patch') {
      const patch = String(args?.patch ?? args?.input ?? '');
      for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) into.modified.add(m[1].trim());
      for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) into.modified.add(m[1].trim());
      continue;
    }
    const readArg = FILE_READ_TOOLS[name];
    if (readArg && args?.[readArg]) into.read.add(String(args[readArg]));
    const writeArg = FILE_WRITE_TOOLS[name];
    if (writeArg && args?.[writeArg]) into.modified.add(String(args[writeArg]));
  }
}

/** 集合 → 摘要尾部 XML 块(readOnly = read − modified,排序 + 封顶);两清单皆空返回 ''。 */
export function formatFileOps(ops: FileOps): string {
  const modified = [...ops.modified].sort().slice(0, FILE_OPS_CAP);
  const readOnly = [...ops.read].filter((p) => !ops.modified.has(p)).sort().slice(0, FILE_OPS_CAP);
  if (!modified.length && !readOnly.length) return '';
  const block = (tag: string, items: string[]) => (items.length ? `<${tag}>\n${items.join('\n')}\n</${tag}>` : '');
  return (
    '\n\n<file-operations>\n' +
    [block('modified-files', modified), block('read-files', readOnly)].filter(Boolean).join('\n') +
    '\n</file-operations>'
  );
}

/** 从上一份摘要解析出文件操作块(继承用),并返回剥掉该块的摘要正文(防摘要模型看到后复述/篡改)。 */
export function parseFileOps(summary: string): { ops: FileOps; stripped: string } {
  const ops: FileOps = { read: new Set(), modified: new Set() };
  const m = summary.match(/\n*<file-operations>[\s\S]*?<\/file-operations>/);
  if (!m) return { ops, stripped: summary };
  const grab = (tag: string): string[] => {
    const mm = m[0].match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
    return mm ? mm[1].split('\n').filter(Boolean) : [];
  };
  for (const p of grab('read-files')) ops.read.add(p);
  for (const p of grab('modified-files')) ops.modified.add(p);
  return { ops, stripped: summary.replace(m[0], '') };
}

// ── 摘要消息(单一来源:run 内替换与 hydrate 注入逐字相同)────────────────────
const SUMMARY_HEADING = '## Compacted Summary of Earlier Conversation\n';
const SUMMARY_CONTINUITY = 'This summarizes work already completed earlier in this conversation. Continue from it — do not restart the task or redo finished work.\n';

export function summaryMessage(summary: string): ChatMessage {
  return { role: 'system', content: SUMMARY_HEADING + SUMMARY_CONTINUITY + summary } as ChatMessage;
}

export function isSummaryMessage(m: ChatMessage | undefined): boolean {
  return !!m && m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEADING);
}

/** 摘要消息正文 → 上一检查点的纯摘要(去头、去连续性一句;文件操作块由调用方另行解析)。 */
function summaryBodyOf(content: string): string {
  let s = content.startsWith(SUMMARY_HEADING) ? content.slice(SUMMARY_HEADING.length) : content;
  if (s.startsWith(SUMMARY_CONTINUITY)) s = s.slice(SUMMARY_CONTINUITY.length);
  return s;
}

// ── 消息来源标记(hydrate 出来的消息 ↔ chat_messages 行)────────────────────────
// WeakMap 按对象身份挂,不进 wire、不破坏前缀缓存(同 contextBudget.pinMessage)。agentLoop 在
// hydrate 时给每条回放消息打上来源行;run 内新落库的段(steer 拆段 / 收尾)也在落库后补打。
// 没有标记的非 system 消息 = 本 run 尚未落库的内容。
export interface MessageSource { id: string; ts: number }
const sourceTags = new WeakMap<object, MessageSource>();
export function tagMessageSource<T extends object>(m: T, src: MessageSource): T {
  if (m && src?.id) sourceTags.set(m, { id: src.id, ts: Number(src.ts) || 0 });
  return m;
}
export function messageSource(m: unknown): MessageSource | undefined {
  return m && typeof m === 'object' ? sourceTags.get(m) : undefined;
}

// ── 检查点 ────────────────────────────────────────────────────────────────────
export interface Checkpoint {
  id: string;
  summary: string;
  throughTimestamp: number;
  /** 行内切点:该行只覆盖到 throughToolCallId(含)。 */
  throughMessageId?: string;
  throughToolCallId?: string;
}

/** 读会话最新压缩检查点(无则 null)。失败 → null(fail-safe)。 */
export async function getLatestSummary(sessionId: string): Promise<Checkpoint | null> {
  try {
    const rows = await query<any[]>(
      `SELECT id, summary, through_timestamp, through_message_id, through_tool_call_id FROM session_summaries
       WHERE session_id = ? ORDER BY through_timestamp DESC, created_at DESC LIMIT 1`,
      [sessionId],
    );
    const r = rows[0];
    if (!r || !r.summary) return null;
    return {
      id: String(r.id || ''),
      summary: String(r.summary),
      throughTimestamp: Number(r.through_timestamp) || 0,
      ...(r.through_message_id ? { throughMessageId: String(r.through_message_id) } : {}),
      ...(r.through_tool_call_id ? { throughToolCallId: String(r.through_tool_call_id) } : {}),
    };
  } catch {
    return null;
  }
}

export type RowCoverage = 'covered' | 'partial' | 'uncovered';

/**
 * 一行 chat_messages 相对检查点的覆盖状态(hydrate 与 compactSession 同一把尺)。
 * 时间戳只有毫秒、不是全序:同一毫秒里可以落两行(连着两条 steer 消息)。所以边界行**按 id 认**:
 *  - 严格早于 through_timestamp 的行 → covered;
 *  - through_message_id 那一行 → 有 tool_call 切点是 partial,否则 covered;
 *  - 与它**同一毫秒**的其它行 → uncovered(原样回放;重复安全,吞掉才是丢数据);
 *  - 时间戳缺失 / 非法(thin worker 旧端点)→ uncovered,绝不把「未知」当成最早(Codex 09-15 评审 #1/#3)。
 * 没有 through_message_id 的老检查点(09-15 之前的手动 /compact)维持 `<=` 语义。
 */
export function rowCoverage(row: { id: string; timestamp?: number | null }, cp: Checkpoint | null | undefined): RowCoverage {
  if (!cp || !(cp.throughTimestamp > 0)) return 'uncovered';
  if (cp.throughMessageId && row.id === cp.throughMessageId) return cp.throughToolCallId ? 'partial' : 'covered';
  const ts = Number(row.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return 'uncovered';
  if (cp.throughMessageId) return ts < cp.throughTimestamp ? 'covered' : 'uncovered';
  return ts <= cp.throughTimestamp ? 'covered' : 'uncovered';
}

/** 某条 chat_messages 行落库后的真实时间戳(店里是 Date.now() 写的,调用方拿不到);读不到 → 0。 */
export async function messageTimestamp(messageId: string): Promise<number> {
  try {
    const rows = await query<any[]>(`SELECT timestamp FROM chat_messages WHERE id = ? LIMIT 1`, [messageId]);
    return Number(rows[0]?.timestamp) || 0;
  } catch {
    return 0;
  }
}

/** 边界:ts = 覆盖到的最后一行的时间戳;messageId = 那一行(整行覆盖也带,用来区分同一毫秒的邻行);
 *  toolCallId = 行内切点(只覆盖到这个调用)。 */
export interface CheckpointThrough { ts: number; messageId?: string; toolCallId?: string }

/** 某调用在该行 tool_calls 里的序号(找不到 → -1;读不到行 → -1)。同一行两个切点比先后用。 */
async function toolCallOrdinal(messageId: string, toolCallId: string): Promise<number> {
  try {
    const rows = await query<any[]>(`SELECT tool_calls FROM chat_messages WHERE id = ? LIMIT 1`, [messageId]);
    let calls: any = rows[0]?.tool_calls;
    if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch { return -1; } }
    return Array.isArray(calls) ? calls.findIndex((c) => c?.id === toolCallId) : -1;
  } catch {
    return -1;
  }
}

/**
 * 落一个检查点。绝不把边界往回挪(更早的检查点会让已总结进后一份摘要的行重新原样回放):
 *  - 更晚的时间戳 → 插一行;
 *  - 同一时间戳、同一行 → 只允许「更完整」的边界就地更新:整行 > 靠后的切点 > 靠前的切点(相同切点 = 只换摘要);
 *  - 同一时间戳、不同行(同一毫秒的邻行)→ 插一行(两者都合法,hydrate 对邻行按 id 认、不按时间戳吞)。
 * revision:调用方在开始读历史时记下的 historyRevision;落库前不一致(中途有删改)→ 丢弃,不写。
 * 写失败返回 false,不抛。
 */
export async function persistCheckpoint(
  sessionId: string, summary: string, through: CheckpointThrough, opts: { revision?: number } = {},
): Promise<boolean> {
  if (!sessionId || !summary || !(through.ts > 0)) return false;
  try {
    if (opts.revision !== undefined && historyRevision(sessionId) !== opts.revision) {
      console.warn(`[agent-core] session=${sessionId} 历史在摘要期间被删改,丢弃这份检查点`);
      return false;
    }
    const latest = await getLatestSummary(sessionId);
    if (latest && latest.throughTimestamp > through.ts) return false;
    if (latest && latest.id && latest.throughTimestamp === through.ts && latest.throughMessageId && latest.throughMessageId === through.messageId) {
      if (!latest.throughToolCallId && through.toolCallId) return false; // 整行 → 切点 = 倒退
      if (latest.throughToolCallId && through.toolCallId && latest.throughToolCallId !== through.toolCallId) {
        const [prev, next] = await Promise.all([toolCallOrdinal(through.messageId!, latest.throughToolCallId), toolCallOrdinal(through.messageId!, through.toolCallId)]);
        if (next < 0 || (prev >= 0 && next < prev)) return false; // 切点往前挪 = 倒退;认不出新切点也不动
      }
      await query(
        `UPDATE session_summaries SET summary = ?, through_tool_call_id = ? WHERE id = ?`,
        [summary, through.toolCallId ?? null, latest.id],
      );
      return true;
    }
    await query(
      `INSERT INTO session_summaries (id, session_id, summary, through_timestamp, through_message_id, through_tool_call_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), sessionId, summary, through.ts, through.messageId ?? null, through.toolCallId ?? null],
    );
    return true;
  } catch (e: any) {
    console.warn('[agent-core] persist compaction checkpoint failed:', e?.message || e);
    return false;
  }
}

// ── 转写(自动 / 手动 / 惰性三路共用)────────────────────────────────────────────
// pi 式行格式:tool_calls 写成 name(args…) 而不是整段 JSON.stringify;工具结果头尾各留一截
// (报错/汇总几乎都在结尾)。文件清单另有机械通道,转写截掉的部分不影响清单。
const TRANSCRIPT_TOOL_RESULT_HEAD = 3_000;
const TRANSCRIPT_TOOL_RESULT_TAIL = 1_000;
const TRANSCRIPT_ARGS_MAX = 600;
const TRANSCRIPT_MIN_BUDGET = 4_000;
const TRANSCRIPT_OVERHEAD_TOKENS = 1_500; // 系统提示 + 分隔 + 安全边

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: any) => (p?.type === 'text' || p?.type === 'input_text') ? String(p.text ?? '') : `[${p?.type || 'attachment'} omitted; inspect the original artifact if needed]`)
    .join('\n');
}

function middle(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars omitted]…\n${text.slice(-tail)}`;
}

function callLine(c: any): string {
  const name = String(c?.function?.name || c?.name || 'tool');
  let args = typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? c?.arguments ?? '');
  if (args.length > TRANSCRIPT_ARGS_MAX) args = `${args.slice(0, TRANSCRIPT_ARGS_MAX)}…`;
  return `${name}(${args})`;
}

/** 消息 → 转写条目 + 上一检查点正文;顺手把 tool_calls 与上一检查点的文件操作块累进 fileOps。 */
function transcriptEntries(msgs: ChatMessage[], fileOps: FileOps): { prevSummary: string; entries: string[] } {
  const entries: string[] = [];
  const callNames = new Map<string, string>();
  let prevSummary = '';
  for (const m of msgs as any[]) {
    if (m.role === 'system') {
      if (!isSummaryMessage(m)) continue; // 注入的系统块不在压缩范围;万一进来也不转写
      const prev = parseFileOps(summaryBodyOf(String(m.content)));
      for (const p of prev.ops.read) fileOps.read.add(p);
      for (const p of prev.ops.modified) fileOps.modified.add(p);
      prevSummary = prev.stripped.trim();
      continue;
    }
    const text = textOf(m.content).trim();
    if (m.role === 'user') {
      if (text) entries.push(`[User]\n${text}`);
    } else if (m.role === 'assistant') {
      if (text) entries.push(`[Assistant]\n${text}`);
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (calls.length) {
        extractFileOps(calls, fileOps);
        for (const c of calls) if (c?.id) callNames.set(String(c.id), String(c?.function?.name || 'tool'));
        entries.push(`[Assistant tool calls]\n${calls.map(callLine).join('\n')}`);
      }
    } else if (m.role === 'tool') {
      const name = callNames.get(String(m.tool_call_id ?? '')) || 'tool';
      entries.push(`[Tool result: ${name}]\n${middle(text, TRANSCRIPT_TOOL_RESULT_HEAD, TRANSCRIPT_TOOL_RESULT_TAIL)}`);
    }
  }
  return { prevSummary, entries };
}

/**
 * 组装喂给摘要模型的转写。[Existing Summary] 块**永不被截**;新对话超预算时从最旧的条目开始丢并
 * 留标记(旧实现整体 slice(-MAX) 会把头部的上一检查点切掉,增量压缩静默丢失既有目标/约束——
 * Codex 评审 07-30 #7)。budgetTokens = 摘要模型可用的输入预算。导出仅为测试。
 */
export function buildTranscript(msgs: ChatMessage[], fileOps: FileOps, budgetTokens: number): { text: string; incremental: boolean; omitted: number } {
  const { prevSummary, entries } = transcriptEntries(msgs, fileOps);
  const prevBlock = prevSummary ? `[Existing Summary]\n${prevSummary}\n\n[New Conversation]\n` : '';
  const room = Math.max(budgetTokens - estimateTokensRough(prevBlock), TRANSCRIPT_MIN_BUDGET);
  const costs = entries.map((e) => estimateTokensRough(e) + 1);
  let total = costs.reduce((a, b) => a + b, 0);
  let start = 0;
  while (start < entries.length - 1 && total > room) { total -= costs[start]; start++; }
  const kept = entries.slice(start);
  // 最后一条自己就超预算(单条巨型正文):按头尾截到预算内,别让摘要请求本身撞窗口
  if (kept.length && total > room) {
    const last = kept[kept.length - 1];
    const budgetChars = Math.max(2_000, room * 2); // 粗估 ASCII 4 字符/token、CJK 1 字符/token,取 2 作保守换算
    if (last.length > budgetChars) kept[kept.length - 1] = middle(last, Math.floor(budgetChars * 0.7), Math.floor(budgetChars * 0.3));
  }
  const marker = start
    ? `[… ${start} earlier entries omitted from this compaction input to fit the summarizer's window; keep relying on the existing summary for them …]\n\n`
    : '';
  return { text: prevBlock + marker + kept.join('\n\n'), incremental: !!prevSummary, omitted: start };
}

// ── 摘要调用 ──────────────────────────────────────────────────────────────────
export interface SummarizeContext {
  modelId: string;
  appId: string;
  settings: CompactionSettings;
  /** 本 run 的思考档(settings.thinking === 'inherit' 时用)。 */
  runThinking?: ThinkingLevel;
  /** 一次性 Additional focus(/compact <focus>)。 */
  focus?: string;
}

/** 摘要模型:settings.model 优先,否则本 run 模型。 */
function summaryModelId(ctx: SummarizeContext): string {
  return ctx.settings.model || ctx.modelId;
}

/** 解析好的摘要目标:模型对象 + 真实窗口 + 按窗口算出的转写预算 / 输出上限。 */
interface SummaryTarget {
  modelId: string;
  model: any;
  apiKey: string;
  baseUrl: string;
  apiModelId: string;
  windowTokens: number;
  budgetTokens: number;
  maxTokens: number;
}

/**
 * 先 resolve 摘要模型,再按它**自己**的窗口(模型对象自带 / 覆盖表 / 族表)算预算 —— 换了便宜模型时不能拿本 run
 * 模型的窗口去估;4k/8k 小模型也不能照抄 6144 的输出上限(Codex 09-15 评审 #8)。
 * 输入预算 = 触发线 − 输出上限 − 提示开销;输出上限 = min(summaryMaxTokens, 有效预留/2, 窗口/4)。
 * resolve 结束后复查取消,不再启动后续请求。
 */
async function resolveSummaryTarget(ctx: SummarizeContext, runWindowTokens: number | undefined, signal?: AbortSignal): Promise<SummaryTarget> {
  signal?.throwIfAborted();
  const modelId = summaryModelId(ctx);
  const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
  signal?.throwIfAborted();
  const windowTokens = ctx.settings.model || !runWindowTokens ? modelContextWindow(modelId, model) : runWindowTokens;
  // 刻意不传 thresholdPercent:这里算的是摘要模型**吃得下**多少转写,不是「何时触发」。按用户的百分比收紧只会让
  // 转写从最旧处多丢内容(老会话首次越线时上下文可以远超那条线),换不来任何东西。
  const threshold = compactionThreshold(windowTokens, ctx.settings.reserveTokens);
  const effectiveReserve = Math.max(1, windowTokens - threshold);
  const maxTokens = Math.max(256, Math.min(ctx.settings.summaryMaxTokens, Math.floor(effectiveReserve / 2), Math.floor(windowTokens / 4)));
  const budgetTokens = Math.max(TRANSCRIPT_MIN_BUDGET, threshold - maxTokens - TRANSCRIPT_OVERHEAD_TOKENS);
  return { modelId, model, apiKey, baseUrl, apiModelId, windowTokens, budgetTokens, maxTokens };
}

/** build/stream 接缝支持真实取消;每步之后复查,不再启动后续请求或修改检查点。 */
async function summarizeWith(target: SummaryTarget, transcript: string, incremental: boolean, ctx: SummarizeContext, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const thinking = ctx.settings.thinking === 'inherit' ? ctx.runThinking : ctx.settings.thinking;
  const payload = await deps().brain.llm.buildProviderPayload({
    model: target.model, apiModelId: target.apiModelId,
    messages: [
      { role: 'system', content: compactSystemPrompt(incremental, ctx.settings, ctx.focus) },
      { role: 'user', content: transcript },
    ] as ChatMessage[],
    projectSource: '', usageSource: ctx.appId,
    temperature: 0.3, maxTokens: target.maxTokens, stream: true, signal,
    // 'off'(缺省)不发字段:与改前的 wire 字节一致;托管面的缺省档由服务端定,别替它决定。
    ...(thinking && thinking !== 'off' ? { thinkingLevel: thinking } : {}),
  });
  signal?.throwIfAborted();
  const res = await deps().brain.llm.streamProviderCompletion({ apiKey: target.apiKey, baseUrl: target.baseUrl, payload, signal });
  signal?.throwIfAborted();
  // 摘要调用上台账(A5):无 run 上下文(/compact 路由等)时静默跳过。
  await publishBackgroundUsage('compaction', target.modelId, (res as any)?.usage, { model: target.model });
  return String(res?.content || '').trim();
}

// ── run 内压缩 ────────────────────────────────────────────────────────────────
export interface CompactResult {
  ok: boolean;
  summary?: string;
  summarizedCount?: number;
  reason?: string;
}

export interface CompactResultPersisted extends CompactResult {
  throughTimestamp?: number;
}

/**
 * 压缩范围 [head, cut):head 跳过开头注入的系统块(摘要消息本身在范围内 → 增量更新);cut 由
 * keepRecentTokens 决定 —— 从最新往回累计估算 token,够数处取**其后最近的非 tool 消息**为切点
 * (工具调用与结果批次绝不拆开;pi findCutPoint 同款)。对话以工具结果收尾时(run 内最常见:刚跑完
 * 一批工具就满载)往前退到发起这批调用的 assistant,别把模型正要用的结果总结掉。
 * 范围里必须有摘要之外的内容,否则返回 null。
 * force:按估算全部都在保留预算内、但实测(或上游拒收)说明已经越线 —— 估算失真(截图按 4k 算、
 * 实际十几万)时仍要压,退到最小切法:只保留最后一条消息(或最后一批工具调用)。导出仅为测试。
 */
export function compactionRange(msgs: ChatMessage[], keepRecentTokens: number, force = false): { head: number; cut: number } | null {
  let head = 0;
  while (head < msgs.length && msgs[head].role === 'system' && !isSummaryMessage(msgs[head])) head++;
  const first = head + (isSummaryMessage(msgs[head]) ? 1 : 0); // 第一条可被总结的真实消息
  if (msgs.length - first < 2) return null;
  let acc = 0;
  let i = msgs.length - 1;
  for (; i > first; i--) {
    acc += estimateMessageTokens(msgs[i]);
    if (acc >= keepRecentTokens) break;
  }
  if (i <= first) {
    if (!force) return null; // 全部都在保留预算内,没有可总结的
    let j = msgs.length - 1;
    while (j > first && msgs[j].role === 'tool') j--;
    return j > first ? { head, cut: j } : null;
  }
  let cut = i;
  while (cut < msgs.length && msgs[cut].role === 'tool') cut++;
  if (cut >= msgs.length) {
    // 尾部是一批工具结果:退到发起这批调用的 assistant,从它起整批保留
    cut = i;
    while (cut > first && msgs[cut].role === 'tool') cut--;
  }
  return cut > first ? { head, cut } : null;
}

/** 总结覆盖到了哪里(供 agentLoop 落检查点)。 */
export interface CompactBoundary {
  /** 覆盖到的最后一条**已落库**行(整行覆盖):id + 时间戳。范围里没有已落库行 → undefined。 */
  through?: MessageSource;
  /** 行内切点:某已落库行只覆盖了一部分 → 该行 id + 已覆盖的最后一个调用 id。与 through 互斥。 */
  partialRow?: { id: string; ts: number; toolCallId: string };
  /** 覆盖到了尚未落库的助手段(带工具调用)→ 已覆盖的最后一个调用 id;该段 finalize 后再落检查点。 */
  pendingToolCallId?: string;
  /** 范围里有有损消息(机械折叠过 / hydrate 时按硬帽截过):摘要没见过原文,**不许**推进持久检查点。 */
  lossy?: boolean;
}

function computeBoundary(covered: ChatMessage[], kept: ChatMessage[]): CompactBoundary {
  let lastRow: MessageSource | undefined;
  let prevRow: MessageSource | undefined; // lastRow 之前那一行(行内切点又无可用调用 id 时退到它)
  let lastRowLastCall: string | undefined;
  let pendingToolCallId: string | undefined;
  let lossy = false;
  for (const m of covered as any[]) {
    if (isLossy(m)) lossy = true;
    const src = messageSource(m);
    if (src) {
      if (!lastRow || src.id !== lastRow.id) {
        if (lastRow) prevRow = !prevRow || lastRow.ts >= prevRow.ts ? lastRow : prevRow;
        lastRow = src;
        lastRowLastCall = undefined;
      }
      if (m.role === 'tool' && m.tool_call_id) lastRowLastCall = String(m.tool_call_id);
    } else if (m.role === 'tool' && m.tool_call_id) {
      pendingToolCallId = String(m.tool_call_id);
    }
  }
  const out: CompactBoundary = {};
  if (lossy) out.lossy = true;
  if (pendingToolCallId) out.pendingToolCallId = pendingToolCallId;
  if (!lastRow) return out;
  const partial = kept.some((m) => messageSource(m)?.id === lastRow!.id);
  if (!partial) { out.through = { id: lastRow.id, ts: lastRow.ts }; return out; }
  if (lastRowLastCall) {
    out.partialRow = { id: lastRow.id, ts: lastRow.ts, toolCallId: lastRowLastCall };
  } else if (prevRow) {
    out.through = { id: prevRow.id, ts: prevRow.ts }; // 该行整体重放(重复安全)
  }
  return out;
}

export interface CompactWorkingOptions {
  settings?: CompactionSettings;
  runThinking?: ThinkingLevel;
  focus?: string;
  /** 本 run 的真实窗口(带模型对象解析过的);缺省按 modelId 解析。 */
  windowTokens?: number;
  /**
   * **provider 实测**的上下文 token 数(或上游拒收时已知的下界 = 窗口)。粗估对图片/二进制按定额算,
   * 实测可能是它的十几倍;给了实测就按 实测/(粗估 + overheadTokens) 的比例把 keepRecentTokens 换算到估算口径。
   * 纯粗估**不要**冒充实测传进来(那会把固定的工具头当成消息膨胀比例)。
   */
  measuredTokens?: number;
  /** 不在消息里、却在 prompt_tokens 里的固定开销(工具定义头),换算比例时补进分母。 */
  overheadTokens?: number;
  /** 按估算全都装得下时仍压一次(最小切法):越线是实测 / 上游说的,不是估算说的。 */
  force?: boolean;
}

export interface CompactWorkingResult extends CompactResult {
  boundary?: CompactBoundary;
}

/**
 * 满载运行内压缩。不读取或写入 DB;生成失败/快照变化时保留原消息,取消则向上抛出。
 * 被替换的每一条消息都进入本次摘要输入(工具结果按头尾截、超预算按最旧丢并留标记)。
 */
export async function compactWorkingMessages(
  msgs: ChatMessage[], modelId: string, appId = 'tangu', signal?: AbortSignal, opts: CompactWorkingOptions = {},
): Promise<CompactWorkingResult> {
  signal?.throwIfAborted();
  const settings = opts.settings ?? DEFAULT_COMPACTION_SETTINGS;
  const rough = estimateMessagesTokens(msgs) + Math.max(0, opts.overheadTokens ?? 0);
  const scale = opts.measuredTokens && rough > 0 ? Math.max(1, opts.measuredTokens / rough) : 1;
  const range = compactionRange(msgs, settings.keepRecentTokens / scale, !!opts.force || opts.measuredTokens !== undefined);
  if (!modelId || !range) return { ok: false, reason: 'nothing to compact' };
  const original = msgs.slice();
  const { head, cut } = range;
  const prefix = structuredClone(original.slice(head, cut));
  const fileOps: FileOps = { read: new Set(), modified: new Set() };
  const ctx: SummarizeContext = { modelId, appId, settings, runThinking: opts.runThinking, focus: opts.focus };
  try {
    const target = await resolveSummaryTarget(ctx, opts.windowTokens, signal);
    const transcript = buildTranscript(original.slice(head, cut), fileOps, target.budgetTokens);
    const text = await summarizeWith(target, transcript.text, transcript.incremental, ctx, signal);
    if (!text || text.length < 8) return { ok: false, reason: 'empty summary' };
    // 压缩期间有外部改动时绝不把旧快照覆盖到新消息上;当前 loop 的 steer 是排队注入,通常不会命中。
    if (msgs.length !== original.length || msgs.some((m, i) => m !== original[i]) ||
      JSON.stringify(msgs.slice(head, cut)) !== JSON.stringify(prefix)) {
      return { ok: false, reason: 'working context changed during compaction' };
    }
    const boundary = computeBoundary(msgs.slice(head, cut), msgs.slice(cut));
    const summary = text + formatFileOps(fileOps);
    msgs.splice(head, cut - head, summaryMessage(summary));
    return { ok: true, summary, summarizedCount: cut - head, boundary };
  } catch (e: any) {
    signal?.throwIfAborted();
    if (e?.name === 'AbortError') throw e;
    return { ok: false, reason: e?.message || 'summary generation failed' };
  }
}

// ── 持久化压缩(手动 /compact、run 收尾后的窗口外老行)────────────────────────
export interface CompactSessionOptions {
  /** 只总结到这个时间戳(含);缺省 = 最后一行。 */
  throughTs?: number;
  focus?: string;
  settings?: CompactionSettings;
  runThinking?: ThinkingLevel;
}

/**
 * 生成并持久化一个压缩检查点。已有检查点 → 增量压缩(已有摘要 + 其后未覆盖的消息),写一条更晚
 * through_timestamp 的新行。无可压缩内容 / 总结失败 → {ok:false};用户取消向上抛出。
 * 转写按 hydrate 同款回放(assistant 行经 agent_steps 重建交错,行内切点照剥),工具调用与结果
 * 都进摘要输入 —— 此前手动压缩只看 user/assistant 正文,与 run 内压缩看到的不是同一份对话。
 */
export async function compactSession(
  sessionId: string, modelId: string, appId = 'tangu', signal?: AbortSignal, opts: CompactSessionOptions = {},
): Promise<CompactResultPersisted> {
  signal?.throwIfAborted();
  if (!sessionId || !modelId) return { ok: false, reason: 'missing session or model' };
  const settings = opts.settings ?? DEFAULT_COMPACTION_SETTINGS;
  const revision = historyRevision(sessionId); // 摘要期间历史被删改 → 落库前复核,丢弃陈旧结果

  let rows: any[];
  try {
    rows = await query<any[]>(
      `SELECT id, role, content, timestamp, tool_calls, tool_results FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId],
    );
  } catch (e: any) {
    signal?.throwIfAborted();
    return { ok: false, reason: e?.message || 'load messages failed' };
  }

  const prev = await getLatestSummary(sessionId);
  signal?.throwIfAborted();
  const limit = opts.throughTs && opts.throughTs > 0 ? opts.throughTs : Number.POSITIVE_INFINITY;
  const pending = rows.filter((r) => rowCoverage(r, prev) !== 'covered' && (Number(r.timestamp) || 0) <= limit);
  const steps = await loadReplaySteps(sessionId, pending);
  signal?.throwIfAborted();
  const messages: ChatMessage[] = [];
  let last: MessageSource | undefined; // 覆盖到的最后一行(时间戳 + id:同一毫秒的邻行靠 id 区分)
  for (const r of pending) {
    const role = r.role === 'model' ? 'assistant' : r.role;
    const raw = String(r.content || '');
    if (role === 'user') {
      if (raw.trim()) messages.push({ role: 'user', content: raw } as ChatMessage); // 持久摘要读原文,不经单条硬帽
    } else if (role === 'assistant') {
      let replayed: ChatMessage[];
      if (raw.length > HISTORY_MSG_MAX_CHARS) {
        // 超硬帽的行 replay 会按 2.5k 字符截断:持久摘要必须见到原文,否则检查点越过它之后原文再也回放不到
        replayed = replayAssistantHistory({ ...r, content: '' }, undefined);
        if (replayed[0]?.role === 'assistant') replayed[0] = { ...replayed[0], content: raw } as ChatMessage;
        else replayed.unshift({ role: 'assistant', content: raw } as ChatMessage);
      } else {
        replayed = replayAssistantHistory(r, steps.get(r.id));
      }
      if (rowCoverage(r, prev) === 'partial' && prev?.throughToolCallId) replayed = dropCoveredCalls(replayed, prev.throughToolCallId);
      messages.push(...replayed);
    } else continue;
    const ts = Number(r.timestamp) || 0;
    if (ts > 0 && (!last || ts >= last.ts)) last = { id: String(r.id), ts };
  }
  if (messages.length < 2 || !last) return { ok: false, reason: 'nothing to compact' };
  if (prev?.summary) messages.unshift(summaryMessage(prev.summary));

  const fileOps: FileOps = { read: new Set(), modified: new Set() };
  const ctx: SummarizeContext = { modelId, appId, settings, runThinking: opts.runThinking, focus: opts.focus };

  let summary = '';
  try {
    const target = await resolveSummaryTarget(ctx, undefined, signal);
    const transcript = buildTranscript(messages, fileOps, target.budgetTokens);
    summary = await summarizeWith(target, transcript.text, transcript.incremental, ctx, signal);
  } catch (e: any) {
    signal?.throwIfAborted();
    if (e?.name === 'AbortError') throw e;
    return { ok: false, reason: e?.message || 'summary generation failed' };
  }
  if (!summary || summary.length < 8) return { ok: false, reason: 'empty summary' };
  // 机械附加文件操作块(LLM 输出之后、落库之前;摘要模型抄没抄对不影响清单正确性)。
  summary += formatFileOps(fileOps);

  if (!(await persistCheckpoint(sessionId, summary, { ts: last.ts, messageId: last.id }, { revision }))) return { ok: false, reason: 'persist summary failed' };
  return { ok: true, summary, throughTimestamp: last.ts, summarizedCount: messages.length - (prev?.summary ? 1 : 0) };
}
