/**
 * 云端 Historian(网关进程跑;worker 恒 historian:false,本地形态由 localHistorian 负责)。两条路:
 * ① AI Studio 会话:周期扫描「空闲超过 idleMinutes 且自上次复盘后有新活动」的会话,有值得留痕的就追加一条日志。
 * ② tangu 会话(web/安卓):与桌面一样**按轮**触发 —— thin worker 跑完一轮经 state-API 把 run 写成 done,
 *    SqlStateStore 的 run-done 监听回调 onCloudRunDone,按用户自己的设置(默认每 3 轮、首轮也触发)维护标题 / LOG / 记忆,
 *    按实际用量扣用户主额度(与桌面 Historian 同一个桶)。
 *
 * 触发标记：每趟（含判定为「无内容」）都置 chat_sessions.historian_last_summary_at=NOW()，
 * 配合扫描谓词 `last IS NULL OR last < updated_at`，保证只在会话有**新活动**后才再扫，不重复处理。
 * 成本：背景任务、用户未主动发起 → 只记 usage（projectSource='ai-studio-historian'），默认不扣用户配额。
 */
import { query, getOlderThanSql } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { historianConfig } from './historianConfig.js';
import { runWithUserAgentScope } from '../seams/runContext.js';
import { loadUserHistorianConfig } from './historianConfig.js';
import { setRunDoneListener } from './stateStore/sqlStateStore.js';
import { isRoundDue } from './localHistorian.js';
import { cloudGetAgent } from '../agents/cloudAgentStore.js';
import { resolveMemorySlug } from '../agents/agentRegistry.js';
import { redactSecrets } from '../core/redact.js';
import { REMEMBER_FACT_MAX_CHARS } from '../tools/builtin/memoryLog.js';

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const resolveModelAndKey = (modelId: string) => deps().brain.llm.resolveModelAndKey(modelId);
const buildProviderPayload = (opts: any) => deps().brain.llm.buildProviderPayload(opts);
const streamProviderCompletion = (opts: any) => deps().brain.llm.streamProviderCompletion(opts);
const calculateCost = (modelId: string, tin: number, tout: number, model?: any) => deps().billing.calculateCost(modelId, tin, tout, model);
const consumeTokenPoints = (userId: string, amount: number) => deps().billing.consumeTokenPoints(userId, amount);
const canConsumeTokenPoints = (userId: string, amount: number) => deps().billing.canConsumeTokenPoints(userId, amount);
const logApiUsage = (...args: any[]) => (deps().billing.logApiUsage as any)(...args);
const getUserById = (id: string) => deps().brain.users.getUserById(id);
const appendLogEntry = (userId: string, text: string) => deps().brain.memory.appendLogEntry(userId, text);

const BATCH = 20;
const MAX_TRANSCRIPT_CHARS = 6000;
// 只复盘近 24h 有活动的会话:开关打开那一刻,historian_last_summary_at 为空的历史会话全都满足谓词,
// 不设回看窗就会把几个月前的会话重新起标题、把旧对话当「今天」写进 LOG。
const LOOKBACK_MINUTES = 24 * 60;
const MEMORY_MAX_PER_PASS = 3;
const MEMORY_CONTEXT_CHARS = 3000; // 注入现有记忆的**尾部**(最新条目),防重复;头部是最老的条目
// redactSecrets 只认得出 sk-/ghp_ 之类的令牌形状;「数据库密码是 hunter2」这种自由文本靠提示词不可靠 → 提到凭据的候选整条丢。
// ponytail: 关键词黑名单,会误杀「用户偏好用 1Password」这类无害条目;误杀只是少记一条,漏放是凭据进长期记忆。
const CREDENTIAL_RE = /password|passwd|passphrase|secret|token|api[ _-]?key|private key|credential|密码|口令|密钥|私钥|令牌|验证码/i;
const HISTORIAN_CHARGE_USER = false; // AI Studio 空闲复盘:背景任务默认不扣用户配额;置 true 则按 cost 扣(tangu 按轮版恒扣)
const JUDGE_TIMEOUT_MS = 90_000; // 与桌面 Historian 的执行槽预算一致;上游挂住不能把网关的并发槽永久占住
const MAX_CONCURRENT = 8;        // 全网关同时在跑的按轮维护上限;满了本轮跳过(不排队),下个到点轮再来

const HISTORIAN_PROMPT =
  'You are a "historian". Below is a recent conversation between a user and an AI. ' +
  'If it contains facts, conclusions, or outputs worth recording long-term (e.g. a task was completed, a clear conclusion was reached, a file was generated, or the user expressed a clear long-term preference), ' +
  "write a single concise log entry in the user's language (≤60 characters; no pleasantries, do not restate the whole text, no quotes). " +
  'If there is nothing worth recording, reply with a single word: NOTHING. ' +
  'Do not output anything other than the log entry or NOTHING.';

type Resolved = Awaited<ReturnType<typeof resolveModelAndKey>>;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** 启动 historian:AI Studio 周期扫描(默认每 2min)+ tangu 按轮监听。幂等;admin enabled=false 时两路都空跑。 */
export function startHistorian(intervalMs = 120_000): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  setRunDoneListener((runId) => { void onCloudRunDone(runId); });
}

/** 停止 historian(dispose/热加载用)。 */
export function stopHistorian(): void {
  if (timer) { clearInterval(timer); timer = null; }
  setRunDoneListener(null);
}

/** 单趟扫描(startHistorian 的定时体;导出供台架直接驱动)。 */
export async function tick(): Promise<void> {
  const cfg = historianConfig();
  if (!cfg.enabled || !cfg.modelId) return; // admin 未开启 / 未配模型 → 空跑
  if (running) return; // 防 tick 重叠
  running = true;
  try {
    const rows = await query<any[]>(
      `SELECT s.id, s.user_id
         FROM chat_sessions s
        WHERE s.app_id = 'ai-studio'
          AND s.archived = FALSE
          AND ${getOlderThanSql('s.updated_at', cfg.idleMinutes)}
          AND NOT (${getOlderThanSql('s.updated_at', LOOKBACK_MINUTES)})
          AND (s.historian_last_summary_at IS NULL OR s.historian_last_summary_at < s.updated_at)
        ORDER BY s.updated_at ASC
        LIMIT ?`,
      [BATCH],
    );
    if (!rows.length) return;

    // 整批共用一次模型解析；失败（如配置的模型被禁用）则本 tick 跳过，下 tick 重试（不标记，不丢会话）。
    let resolved: Resolved;
    try {
      resolved = await resolveModelAndKey(cfg.modelId);
    } catch (e: any) {
      console.warn('[historian] 解析摘要模型失败（检查 admin 配置的模型是否启用）:', e?.message || e);
      return;
    }

    for (const r of rows) {
      try {
        await summarizeSession(r.id, r.user_id, cfg.modelId, resolved);
      } catch (e: any) {
        console.warn(`[historian] session ${r.id} 复盘失败:`, e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('[historian] tick failed:', e?.message || e);
  } finally {
    running = false;
  }
}

const markPass = (sessionId: string) =>
  query(`UPDATE chat_sessions SET historian_last_summary_at = CURRENT_TIMESTAMP WHERE id = ?`, [sessionId]).catch(() => {});

/** 最近消息（去空 / 去 tool 行）拼 transcript 并截断兜成本；空串 = 无可复盘内容。 */
async function buildTranscript(sessionId: string): Promise<string> {
  const msgs = await query<any[]>(
    `SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 30`,
    [sessionId],
  );
  msgs.reverse();
  const lines: string[] = [];
  for (const m of msgs) {
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').trim();
    if (!content) continue;
    lines.push(`${role === 'user' ? '用户' : 'AI'}：${content}`);
  }
  let transcript = lines.join('\n').trim();
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  return transcript;
}

async function summarizeSession(sessionId: string, userId: string, modelId: string, resolved: Resolved): Promise<void> {
  const transcript = await buildTranscript(sessionId);
  if (!transcript) { await markPass(sessionId); return; } // 无可复盘内容，仍标记避免重扫

  const { model, apiKey, baseUrl, apiModelId } = resolved;
  const messages = [
    { role: 'system', content: HISTORIAN_PROMPT },
    { role: 'user', content: transcript },
  ] as ChatMessage[];
  const payload = await buildProviderPayload({
    model, apiModelId, messages,
    projectSource: '', // 不叠 ai-studio 项目层，保持 historian 指令干净
    temperature: 0.3,
    maxTokens: 300,
    stream: true,
  });
  const res = await streamProviderCompletion({ apiKey, baseUrl, payload });

  // 记 usage（默认不扣配额）。失败不阻断。
  try {
    const user = await getUserById(userId);
    const cost = await calculateCost(modelId, res.usage.prompt_tokens, res.usage.completion_tokens);
    await logApiUsage(
      user?.username || userId, modelId, model.name, model.provider,
      res.usage.prompt_tokens, res.usage.completion_tokens, true, undefined, 'ai-studio-historian', cost,
    );
    if (HISTORIAN_CHARGE_USER) await consumeTokenPoints(userId, cost).catch(() => {});
  } catch { /* 记账失败不阻断复盘 */ }

  const out = String(res.content || '').trim();
  const skip = !out || out.toUpperCase() === 'NOTHING' || out.length < 4 || out.length > 200;
  if (!skip) {
    await appendLogEntry(userId, out).catch((e: any) => console.warn('[historian] appendLog failed:', e?.message || e));
  }
  await markPass(sessionId); // 无论是否写日志都标记本趟
}

// ── tangu 云端会话(web/安卓)的按轮 Historian:标题 + 日志 + 长期记忆 ─────────────────────
// 桌面 localHistorian 挂在引擎的 run-done 钩子上;云端 run 在 thin worker 跑(无库、无持久文件),
// 所以由网关在 worker 上报 done 时触发,轮次判定与桌面同一个 isRoundDue。
// 记忆只追加、不改写:候选过与桌面同款的 No-op 门,经 seam 的 appendMemoryEntry(去重 + 软上限)落库;
// 云端没有桌面的 raw 层 + Dream 整固,所以每趟限 3 条、并把现有记忆尾部喂给判官防重复。

const busySessions = new Set<string>();
// ponytail: 同一会话最后维护过的轮次,防 done 重报(重试的状态 POST)重复写 LOG/记忆;进程内 Map,单网关够用,
// 多网关实例会各跑一次 —— 要跨实例去重得落库(如 special_agent_log 唯一键)。上限到了整表清空,代价是极少数重复一趟。
const lastRound = new Map<string, number>();

/** 模型:用户显式选的 → admin 配的 → tangu 的辅助模型槽 → tangu 对话默认。
 *  不用 resolveBackgroundModelId:网关的 profile.appId 是 ai-studio 基线,查到的是别的 app 的槽。 */
async function resolveModel(userModel: string, adminModel: string): Promise<string> {
  if (userModel || adminModel) return userModel || adminModel;
  try {
    const r = await deps().brain.models.listModelsForProject?.('tangu');
    return String(r?.backgroundModelId || r?.defaultModelId || '');
  } catch { return ''; }
}

/** run 落成 done 的回调(SqlStateStore 监听,fire-and-forget,绝不抛)。到点轮才维护。 */
export async function onCloudRunDone(runId: string): Promise<void> {
  try {
    const admin = historianConfig();
    if (!admin.enabled) return; // 平台总开关
    const run = (await query<any[]>(`SELECT session_id, user_id FROM agent_runs WHERE id = ? LIMIT 1`, [runId]))[0];
    if (!run?.session_id) return;
    const sessionId = String(run.session_id);
    const userId = String(run.user_id);
    const user = await loadUserHistorianConfig(userId);
    if (!user.enabled) return;
    const s = (await query<any[]>(
      `SELECT id, title, agent_config, kind, app_id, archived FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`,
      [sessionId, userId],
    ))[0];
    if (!s || s.app_id !== 'tangu' || (s.kind && s.kind !== 'user') || s.archived === true || s.archived === 1) return;
    const n = await query<any[]>(`SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ? AND status = 'done'`, [sessionId]);
    const round = Number(n[0]?.n) || 0;
    if (!isRoundDue(round, user.everyRounds, user.firstRoundTrigger)) return;
    if ((lastRound.get(sessionId) || 0) >= round) return;
    if (busySessions.has(sessionId) || busySessions.size >= MAX_CONCURRENT) return;
    busySessions.add(sessionId);
    try {
      const modelId = await resolveModel(user.modelId, admin.modelId);
      if (modelId) await summarizeTanguSession({ ...s, user_id: userId }, modelId);
      // 跑完才记轮次:超时 / 上游报错的这一轮,done 重报时还能再来(在飞期间的重报由 busySessions 挡)
      if (lastRound.size > 50_000) lastRound.clear();
      lastRound.set(sessionId, round);
    } finally {
      busySessions.delete(sessionId);
    }
  } catch (e: any) {
    console.warn(`[historian] tangu run ${runId} 维护失败:`, e?.message || e);
  }
}

const TANGU_HISTORIAN_PROMPT =
  'You are a "historian" maintaining a chat session between a user and an AI assistant. ' +
  'Based on the recent conversation below, output STRICT JSON (no markdown fence): {"title": string, "log": string, "memory": string[]}\n' +
  '- "title": a concise session title in the user\'s language (at most 20 characters, no quotes or decoration). ' +
  'Output an empty string if the current title already fits the conversation.\n' +
  '- "log": if the conversation contains facts, conclusions, completed tasks, or clear long-term preferences worth recording, ' +
  "write ONE concise log entry in the user's language (at most 60 characters, no pleasantries); otherwise an empty string.\n" +
  '- "memory": NEW long-term memory entries about the user (usually an empty array). ' +
  'Include an entry ONLY if a future conversation would plausibly go better because of it: stable facts or preferences the user stated or enforced, ' +
  'high-leverage procedural knowledge proven to work, landmines to avoid. ' +
  'Never include: one-off requests, temporary or task-status facts, summaries of what happened (that is the log), restated common knowledge, ' +
  'or anything already covered by [Existing memory]. ' +
  "One short self-contained sentence per entry, in the user's language; replace any token/key/password with [REDACTED]. " +
  `At most ${MEMORY_MAX_PER_PASS} entries. When in doubt, leave it out — an empty array is the normal outcome.\n` +
  'Output nothing other than the JSON object.';

/** 容错解析模型 JSON 输出(剥 ``` 围栏;失败 → null)。 */
function parseJudgement(raw: string): { title: string; log: string; memory: string[] } | null {
  let s = String(raw || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const j = JSON.parse(s);
    const memory = (Array.isArray(j?.memory) ? j.memory : [])
      .map((c: unknown) => redactSecrets(String(c ?? '').replace(/\s*[\r\n]+\s*/g, '; ').trim()))
      .filter((c: string) => c.length >= 4 && c.length <= REMEMBER_FACT_MAX_CHARS && c.toUpperCase() !== 'NOTHING' && !CREDENTIAL_RE.test(c))
      .slice(0, MEMORY_MAX_PER_PASS);
    return { title: String(j?.title ?? '').trim(), log: String(j?.log ?? '').trim(), memory };
  } catch {
    return null;
  }
}

async function summarizeTanguSession(
  row: { id: string; user_id: string; title: any; agent_config: any },
  modelId: string,
): Promise<void> {
  const sessionId = String(row.id);
  const userId = String(row.user_id);
  const transcript = await buildTranscript(sessionId);
  if (!transcript) return;

  // 会话绑定 agent → LOG/记忆落该 agent 的记忆域(cloudGetAgent 含内置预设兜底,resolveMemorySlug 折叠 shareDefaultMemory);
  // 解析失败/未绑定 → 默认记忆域。seams 的 memory 实现读 runContext 的 currentAgentSlug。
  // 绑了 agent 却解析不出(删了 / 读库失败)→ 记忆域未知:这一趟不写 LOG / 记忆,免得这段对话的事实落进默认记忆、串给无关会话。
  let memSlug: string | undefined;
  let scopeKnown = true;
  try {
    const raw = row.agent_config;
    const cfg0 = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (cfg0?.agentSlug) {
      const def = await cloudGetAgent(userId, String(cfg0.agentSlug)).catch(() => null);
      if (def) memSlug = resolveMemorySlug(def);
      else scopeKnown = false;
    }
  } catch { scopeKnown = false; }
  // 记忆域用 als.run 包住整段(不用 enterWith):回调跑在上报 done 的请求链上,不能改它的上下文,也不能串给别的会话。
  await runWithUserAgentScope(userId, memSlug || '', () => judgeAndWrite(row, modelId, transcript, scopeKnown, memSlug));
}

async function judgeAndWrite(
  row: { id: string; user_id: string; title: any },
  modelId: string,
  transcript: string,
  scopeKnown: boolean,
  memSlug: string | undefined,
): Promise<void> {
  const sessionId = String(row.id);
  const userId = String(row.user_id);
  const { model, apiKey, baseUrl, apiModelId } = await resolveModelAndKey(modelId);
  // 额度预检:刚跑完一轮的用户可能正好用尽 —— 用尽就静默跳过这一轮(不报错、不欠费)。
  const est = await calculateCost(modelId, (MEMORY_CONTEXT_CHARS + transcript.length + 2000) / 4, 800, model).catch(() => 0);
  const pre = await canConsumeTokenPoints(userId, est).catch(() => ({ ok: false }));
  if (!pre.ok) return;

  let existingMemory = '';
  try { existingMemory = String((await deps().brain.memory.getMemory(userId)).content || '').slice(-MEMORY_CONTEXT_CHARS); } catch { /* 读不到就不给 */ }

  const signal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  const sys = `${TANGU_HISTORIAN_PROMPT}\nCurrent session title: ${JSON.stringify(String(row.title || ''))}`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `[Existing memory]\n${existingMemory || '(empty)'}\n\n[Conversation]\n${transcript}` },
  ] as ChatMessage[];
  const payload = await buildProviderPayload({
    model, apiModelId, messages,
    projectSource: '',
    temperature: 0.3,
    maxTokens: 800,
    stream: true,
    signal,
    thinkingLevel: 'low', // 缺省档在 DeepSeek 类端点 = high,推理吃光 maxTokens 就只剩空正文
  });
  const res = await streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal });

  // 按实际用量扣用户主额度(与桌面 Historian 同一个桶),不论判断能否解析 —— 模型已经跑了。
  // 端列(client)留空:server 只认 muse/automation 后台标签,不给这里另造一个它解析不了的标签。
  try {
    const cost = await calculateCost(modelId, res.usage.prompt_tokens, res.usage.completion_tokens, model);
    await consumeTokenPoints(userId, cost).catch((e: any) => console.warn(`[historian] tangu 扣费失败 user=${userId} cost=${cost}:`, e?.message || e));
    const user = await getUserById(userId);
    await logApiUsage(
      user?.username || userId, modelId, model.name, model.provider,
      res.usage.prompt_tokens, res.usage.completion_tokens, true, undefined, 'tangu-historian', cost,
    );
  } catch { /* 记账失败不阻断维护 */ }

  const j = parseJudgement(String(res.content || ''));
  if (!j) console.warn(`[historian] tangu session ${sessionId} 判断输出不是 JSON(${String(res.content || '').length} 字,原文不进日志)`);
  if (j) {
    // 标题 / LOG 也可能把对话里的令牌复述出来 → 同样脱敏(记忆候选另有整条丢的凭据闸)
    const title = redactSecrets(j.title.replace(/^["'《「]+|["'》」]+$/g, '')).slice(0, 60);
    if (title && title.length >= 2) {
      // CAS:扫描到写回之间用户手改过标题就不覆盖。
      await query(`UPDATE chat_sessions SET title = ? WHERE id = ? AND COALESCE(title, '') = ?`, [title, sessionId, String(row.title || '')])
        .catch((e: any) => console.warn('[historian] tangu 标题更新失败:', e?.message || e));
    }
    const logText = redactSecrets(j.log);
    if (scopeKnown && logText && logText.length >= 2 && logText.length <= 200) {
      await appendLogEntry(userId, logText).catch((e: any) => console.warn('[historian] tangu appendLog failed:', e?.message || e));
    }
    for (const fact of scopeKnown ? j.memory : []) {
      const r = await deps().brain.memory.appendMemoryEntry(userId, fact, { dedup: true })
        .catch((e: any) => { console.warn('[historian] tangu appendMemory failed:', e?.message || e); return null; });
      if (r?.appended) console.log(`[historian] tangu session ${sessionId.slice(0, 8)} 记入长期记忆 1 条(${memSlug || 'default'})`); // 不打原文:记忆内容不进服务端日志
      if (r?.reason === 'full') break;
    }
  }
}
