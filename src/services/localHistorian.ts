/**
 * 本地 Historian（Special Agent）—— 按「轮」触发，区别于云端 historian.ts 的空闲扫描。
 *
 * 一应一和 = 1 轮（= 1 个 done run）。每个用户会话 run 完成后（agentLoop done 钩子）：
 *   - 每 everyTitleRounds 轮：总结并更新会话标题；
 *   - 每 everyMemoryRounds 轮：判断是否更新用户 LOG/memory（经 brain.memory），有则写入；
 *   - 首轮（roundN===1 且 firstRoundTrigger）必触发两者。
 * 配置见 special-agents.json（enabled 默认关、需选 modelId）。活动写 special_agent_log（隔离记录，
 * 驱动 Historian 工作视图），不进用户会话列表。本地特性：仅 host-exec profile 形态启用，云端 no-op。
 *
 * 成本：背景任务、用户未主动发起 → 只记 usage（projectSource='tangu-historian'），默认不扣配额。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { loadSpecialAgentsConfig, DEFAULT_HISTORIAN_PROMPT } from './specialAgentsConfig.js';

const MAX_TRANSCRIPT_CHARS = 8000;
const CHARGE_USER = false;

const TITLE_PROMPT =
  '用一个不超过 16 字的简洁中文短语概括下面这段对话的主题，作为会话标题。只输出标题本身，不要标点包裹、不要前后缀。';

/** 纯判定:第 roundN 轮是否触发(首轮可强制 + 每 every 轮)。roundN<1 不触发。 */
export function isRoundDue(roundN: number, every: number, firstRoundTrigger: boolean): boolean {
  if (roundN < 1) return false;
  if (roundN === 1 && firstRoundTrigger) return true;
  return every > 0 && roundN % every === 0;
}

async function recentTranscript(sessionId: string, limit = 30): Promise<string> {
  const rows = await query<any[]>(
    `SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [sessionId, limit],
  );
  rows.reverse();
  const lines: string[] = [];
  for (const m of rows) {
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').trim();
    if (content) lines.push(`${role === 'user' ? '用户' : 'AI'}：${content}`);
  }
  let s = lines.join('\n');
  if (s.length > MAX_TRANSCRIPT_CHARS) s = s.slice(-MAX_TRANSCRIPT_CHARS);
  return s;
}

/** 单次轻量补全（系统提示 + transcript）。失败返回 ''(并打日志说明原因)。记 usage（默认不扣配额）。 */
async function complete(label: string, modelId: string, system: string, transcript: string, userId: string, maxTokens: number): Promise<string> {
  try {
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
    const payload = await deps().brain.llm.buildProviderPayload({
      model, apiModelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }] as ChatMessage[],
      projectSource: '', temperature: 0.3, maxTokens, stream: true,
      provider: (model as any)?.provider,
    } as any);
    const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider });
    try {
      const cost = await deps().billing.calculateCost(modelId, res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
      const u = await deps().brain.users.getUserById(userId);
      await (deps().billing.logApiUsage as any)(
        u?.username || userId, modelId, model.name, model.provider,
        res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0, true, undefined, 'tangu-historian', cost,
      );
      if (CHARGE_USER) await deps().billing.consumeTokenPoints(userId, cost).catch(() => {});
    } catch { /* 记账失败不阻断 */ }
    const out = String(res?.content || '').trim();
    if (!out) log(`${label} 模型返回空内容(model=${modelId})`);
    return out;
  } catch (e: any) {
    log(`${label} 模型调用失败(model=${modelId}): ${e?.message || e}`);
    return '';
  }
}

async function logActivity(userId: string, action: string, detail: string, sessionRef: string): Promise<void> {
  try {
    await query(
      `INSERT INTO special_agent_log (id, user_id, agent, action, detail, session_ref) VALUES (?, ?, 'historian', ?, ?, ?)`,
      [uuidv4(), userId, action, detail.slice(0, 1000), sessionRef],
    );
  } catch (e: any) {
    log(`写 special_agent_log 失败(${action}): ${e?.message || e}`);
  }
}

function log(msg: string): void {
  try { deps().host.log(`[historian] ${msg}`); } catch { console.log(`[historian] ${msg}`); }
}
/** 是否本地形态(host-exec profile)。云端 baseline 无 hostExec → Historian 整体 no-op。 */
function isLocal(): boolean {
  try { return !!deps().profile.capabilities.hostExec; } catch { return false; }
}

/**
 * run 完成钩子：判断并执行标题/记忆更新。fire-and-forget（agentLoop void 调用），绝不抛。
 * 仅处理 kind='user' 的会话；Historian 自身不产生 run，无递归风险。
 */
export async function onUserRunDone(sessionId: string, userId: string): Promise<void> {
  if (!isLocal()) return;
  let cfg;
  try { cfg = loadSpecialAgentsConfig().historian; } catch { return; }
  if (!cfg.enabled || !cfg.modelId) return;

  try {
    // 仅用户会话；并发安全：roundN 由 done run 计数推出（幂等）。
    const skRows = await query<any[]>(`SELECT kind, title FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
    const sk = skRows[0];
    if (!sk || (sk.kind && sk.kind !== 'user')) return;

    // 注意:不能用 `COUNT(*)::int`(PG cast)——standalone 是 SQLite,`::` 会报 unrecognized token。
    const cntRows = await query<any[]>(
      `SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ? AND status = 'done'`,
      [sessionId],
    );
    const roundN = Number(cntRows[0]?.n) || 0;
    if (roundN < 1) return;

    const titleDue = isRoundDue(roundN, cfg.everyTitleRounds, cfg.firstRoundTrigger);
    const memoryDue = isRoundDue(roundN, cfg.everyMemoryRounds, cfg.firstRoundTrigger);
    if (!titleDue && !memoryDue) return;
    log(`第 ${roundN} 轮触发(标题:${titleDue} 记忆:${memoryDue},模型 ${cfg.modelId})`);

    const transcript = await recentTranscript(sessionId);
    if (!transcript.trim()) { log('无可用对话内容,跳过'); return; }

    if (titleDue) {
      const title = (await complete('标题', cfg.modelId, TITLE_PROMPT, transcript, userId, 40))
        .replace(/^["'《「]+|["'》」]+$/g, '')
        .slice(0, 60);
      if (title && title.toUpperCase() !== 'NOTHING') {
        await query(`UPDATE chat_sessions SET title = ? WHERE id = ?`, [title, sessionId]).catch((e: any) => log(`更新标题失败: ${e?.message || e}`));
        await logActivity(userId, 'title_updated', title, sessionId);
        log(`已更新标题: ${title}`);
      }
    }

    if (memoryDue) {
      const out = await complete('记忆', cfg.modelId, cfg.prompt || DEFAULT_HISTORIAN_PROMPT, transcript, userId, 300);
      const skip = !out || out.toUpperCase() === 'NOTHING' || out.length < 4 || out.length > 400;
      log(`记忆判断: ${out ? `"${out.slice(0, 40)}"` : '(空)'} → ${skip ? '跳过' : '写入'}`);
      if (!skip) {
        // 同步进用户 LOG 与 memory（共享云端记忆经 brain）。任一失败不连坐另一。
        await deps().brain.memory.appendLogEntry(userId, out).then(() => log('已写入 LOG')).catch((e: any) => log(`写 LOG 失败: ${e?.message || e}`));
        await logActivity(userId, 'log_appended', out, sessionId);
        try {
          await deps().brain.memory.appendMemoryEntry(userId, out, { dedup: true });
          await logActivity(userId, 'memory_appended', out, sessionId);
          log('已写入 memory');
        } catch (e: any) { log(`写 memory 失败: ${e?.message || e}`); }
      }
    }
  } catch (e: any) {
    log(`onUserRunDone 异常: ${e?.message || e}`);
  }
}
