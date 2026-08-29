/**
 * 会话上下文压缩 —— 一等公民、可持久化的「总结检查点」。
 *
 * compactSession：取会话历史 → 让模型生成简洁总结 → 写 session_summaries（through_timestamp 标到此为止）。
 * agentLoop.hydrateHistory 见检查点则用 [总结] + through_timestamp 之后的消息重建上下文——
 * **确定性、前缀稳定**（总结文本一旦写定不再变），守住 prompt-cache 前缀（2026-06-10 审计）。
 *
 * 与机械 compactContext() 分工：后者是运行内即时折叠（>50% 触发、不落库）；本服务是跨 run 持久压缩
 * （slash / 满载 95% 触发，落 session_summaries）。本地特性（桌面/TUI）；数据访问经 core query()
 * （standalone 本地库）。所有读 fail-safe → 退回未压缩行为；绝不抛（调用方多在 run 内）。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';

// 结构化交接(借 pi 的 checkpoint schema + Codex 的 handoff 框架):压缩摘要的消费者是「接手续做的
// 下一个 LLM」,无结构的一段话最容易丢的恰是 In-progress / Next steps——丢了它们,压缩后模型就
// 只会「总结成果」不会「接着干」,长任务在压缩点断头。
const COMPACT_SYSTEM_PROMPT =
  'You are performing a context checkpoint compaction: turn the conversation below into a handoff summary that another LLM will rely on to seamlessly CONTINUE the task (not just recall it). Write in the same language as the conversation. Structure:\n' +
  '## Goal — what the user ultimately wants. Keep the full objective; never shrink the scope.\n' +
  '## Done — completed steps, key decisions and conclusions (with exact file paths / identifiers / output locations).\n' +
  '## In progress / Next steps — what is unfinished and the concrete next actions, in order. This section matters most; never leave it empty if work remains.\n' +
  '## Facts & constraints — important facts, user preferences and corrections, pitfalls already discovered, exact names/paths/commands/error messages needed to continue.\n' +
  'Be concise but information-complete. Output only the summary itself — no pleasantries, no lead-in.';

// 增量压缩指令(借 pi 的 PRESERVE/UPDATE 变体):没有它,摘要模型面对 [Existing Summary] 最常见的
// 病是「重写一份更短的」——上一检查点里仍相关的路径/约束/未完项被静默蒸发,跨两次压缩后断头。
const COMPACT_INCREMENTAL_NOTE =
  '\nAn [Existing Summary] block precedes the new conversation: it is the previous checkpoint. UPDATE it instead of restarting — preserve every still-relevant fact, path, constraint and pending item from it; move items between sections as the new conversation completes or unblocks them; drop nothing merely to save space.';

/** 压缩系统提示(增量压缩时附 PRESERVE/UPDATE 指令)。导出仅为测试。 */
export function compactSystemPrompt(hasPrevSummary: boolean): string {
  return hasPrevSummary ? COMPACT_SYSTEM_PROMPT + COMPACT_INCREMENTAL_NOTE : COMPACT_SYSTEM_PROMPT;
}

const MAX_TRANSCRIPT_CHARS = 60_000; // 兜成本：超长历史只取尾部
const SUMMARY_MAX_TOKENS = 1200;

/** 组装喂给摘要模型的转写:上一检查点块**永不被截**——旧实现整体 slice(-MAX) 会在新对话超长时
 *  把头部的 [Existing Summary] 切掉,增量压缩静默丢失既有目标/约束/未完项(Codex 评审 07-30 #7)。
 *  预算只截新对话尾部;检查点块自身有 SUMMARY_MAX_TOKENS+FILE_OPS_CAP 兜底,天然远小于预算。导出仅为测试。 */
export function buildCompactTranscript(prevSummaryBody: string, convo: string): string {
  const prevBlock = prevSummaryBody.trim()
    ? `[Existing Summary]\n${prevSummaryBody.trim()}\n\n[New Conversation]\n`
    : '';
  const room = Math.max(MAX_TRANSCRIPT_CHARS - prevBlock.length, 10_000);
  return prevBlock + (convo.length > room ? convo.slice(-room) : convo);
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

export interface CompactResultPersisted {
  ok: boolean;
  summary?: string;
  throughTimestamp?: number;
  summarizedCount?: number;
  reason?: string;
}

/** 读会话最新压缩检查点（无则 null）。失败 → null（fail-safe）。 */
export async function getLatestSummary(
  sessionId: string,
): Promise<{ summary: string; throughTimestamp: number } | null> {
  try {
    const rows = await query<any[]>(
      `SELECT summary, through_timestamp FROM session_summaries
       WHERE session_id = ? ORDER BY through_timestamp DESC, created_at DESC LIMIT 1`,
      [sessionId],
    );
    const r = rows[0];
    if (!r || !r.summary) return null;
    return { summary: String(r.summary), throughTimestamp: Number(r.through_timestamp) || 0 };
  } catch {
    return null;
  }
}

/**
 * 生成并持久化一个压缩检查点。modelId 用于总结调用（通常同会话模型）。
 * 已有检查点 → 增量压缩（已有摘要 + 其后新消息），写一条更晚 through_timestamp 的新行。
 * 无可压缩内容 / 总结失败 → {ok:false}。绝不抛。
 */
export async function compactSession(sessionId: string, modelId: string, appId = 'tangu'): Promise<CompactResultPersisted> {
  if (!sessionId || !modelId) return { ok: false, reason: 'missing session or model' };

  let rows: any[];
  try {
    rows = await query<any[]>(
      `SELECT role, content, timestamp, tool_calls FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId],
    );
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'load messages failed' };
  }

  const prev = await getLatestSummary(sessionId);
  const prevThrough = prev?.throughTimestamp || 0;
  // 文件操作机械追踪:先从上一份摘要继承(单调累积),再叠加本窗口 tool_calls;
  // 喂给摘要模型的 [Existing Summary] 用剥掉该块的正文(块由本函数尾部机械重建,不劳模型抄)。
  const { ops: fileOps, stripped: prevSummaryBody } = parseFileOps(prev?.summary || '');
  const lines: string[] = [];
  let maxTs = prevThrough;
  for (const m of rows) {
    const ts = Number(m.timestamp) || 0;
    if (ts <= prevThrough) continue; // 增量：跳过已被前一检查点覆盖的消息
    extractFileOps(m.tool_calls, fileOps);
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').trim();
    if (content) lines.push(`${role === 'user' ? 'User' : 'AI'}: ${content}`);
    if (ts > maxTs) maxTs = ts;
  }
  if (lines.length < 2) return { ok: false, reason: 'nothing to compact' };

  const transcript = buildCompactTranscript(prevSummaryBody, lines.join('\n'));

  let summary = '';
  try {
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
    const payload = await deps().brain.llm.buildProviderPayload({
      model,
      apiModelId,
      messages: [
        { role: 'system', content: compactSystemPrompt(!!prevSummaryBody.trim()) },
        { role: 'user', content: transcript },
      ] as ChatMessage[],
      projectSource: '', // 不叠项目层提示词
      usageSource: appId, // 但记账归进应用桶(否则云端兜底记 tangu-brain)
      temperature: 0.3,
      maxTokens: SUMMARY_MAX_TOKENS,
      stream: true,
    } as any);
    const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload });
    summary = String(res?.content || '').trim();
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'summary generation failed' };
  }
  if (!summary || summary.length < 8) return { ok: false, reason: 'empty summary' };
  // 机械附加文件操作块(LLM 输出之后、落库之前;摘要模型抄没抄对不影响清单正确性)。
  summary += formatFileOps(fileOps);

  try {
    await query(
      `INSERT INTO session_summaries (id, session_id, summary, through_timestamp) VALUES (?, ?, ?, ?)`,
      [uuidv4(), sessionId, summary, maxTs],
    );
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'persist summary failed' };
  }
  return { ok: true, summary, throughTimestamp: maxTs, summarizedCount: lines.length };
}

/** hydrate 时把摘要折进内存消息数组（保头部 system 块 + 末尾 tail；中段替成摘要）。原地变更，幂等性由调用点保证。 */
export function foldWorkingWithSummary(msgs: ChatMessage[], summary: string, tail = 12): void {
  let head = 0;
  while (head < msgs.length && (msgs[head] as any).role === 'system') head++;
  if (msgs.length - head <= tail + 1) return; // 太短不值得折
  // 折叠边界不许落在工具结果批次中间:孤立的 role:'tool'(前面没有带 tool_calls 的 assistant)
  // 会被 OpenAI 协议校验直接拒、在 Anthropic 生成无 tool_use 配对的 tool_result。边界落在 tool 上
  // 就往前扩到该批次的 assistant(大批工具调用时 tail 实际保留数会多于名义值,正确性优先)。
  let cut = msgs.length - tail;
  while (cut > head && (msgs[cut] as any).role === 'tool') cut--;
  if (cut - head < 1) return; // 边界一路退到头:没有可折叠的前缀
  // 连续性契约(借 Codex compact 框架语):压缩点最常见的病是模型把摘要当「回忆」而非「已完成的工作」,
  // 从头重做已完成步骤。消费侧一句话点破。
  const summaryMsg = {
    role: 'system',
    content:
      '## Compacted Summary of Earlier Conversation\n' +
      'This summarizes work already completed earlier in this conversation. Continue from it — do not restart the task or redo finished work.\n' +
      summary,
  } as ChatMessage;
  msgs.splice(head, cut - head, summaryMsg);
}
