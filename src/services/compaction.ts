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

const COMPACT_SYSTEM_PROMPT =
  '请把下面整段对话压缩成简洁、信息完整的中文要点总结，供后续延续对话使用，需覆盖：用户目标、' +
  '关键决定/结论、已完成与待办、产出的文件路径与重要事实。只输出总结本身，不要寒暄、不要加引导语。';

const MAX_TRANSCRIPT_CHARS = 60_000; // 兜成本：超长历史只取尾部
const SUMMARY_MAX_TOKENS = 1200;

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
export async function compactSession(sessionId: string, modelId: string): Promise<CompactResultPersisted> {
  if (!sessionId || !modelId) return { ok: false, reason: 'missing session or model' };

  let rows: any[];
  try {
    rows = await query<any[]>(
      `SELECT role, content, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId],
    );
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'load messages failed' };
  }

  const prev = await getLatestSummary(sessionId);
  const prevThrough = prev?.throughTimestamp || 0;
  const lines: string[] = [];
  let maxTs = prevThrough;
  for (const m of rows) {
    const ts = Number(m.timestamp) || 0;
    if (ts <= prevThrough) continue; // 增量：跳过已被前一检查点覆盖的消息
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').trim();
    if (content) lines.push(`${role === 'user' ? '用户' : 'AI'}：${content}`);
    if (ts > maxTs) maxTs = ts;
  }
  if (lines.length < 2) return { ok: false, reason: 'nothing to compact' };

  let transcript = lines.join('\n');
  if (prev?.summary) transcript = `【已有摘要】\n${prev.summary}\n\n【新对话】\n${transcript}`;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);

  let summary = '';
  try {
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
    const payload = await deps().brain.llm.buildProviderPayload({
      model,
      apiModelId,
      messages: [
        { role: 'system', content: COMPACT_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ] as ChatMessage[],
      projectSource: '',
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
  const summaryMsg = { role: 'system', content: '## 此前对话的压缩摘要\n' + summary } as ChatMessage;
  msgs.splice(head, msgs.length - head - tail, summaryMsg);
}
