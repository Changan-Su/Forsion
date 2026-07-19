/**
 * 群聊模式(Group Chat)编排:用户选 ≥2 个 Normal Agent,发一条消息后 agents **轮流进入 run 并发言**。
 *
 * 设计要点:
 *   - 整个群聊 = **一个 run**(一条事件流):前端订阅同一 runId,事件带 `agentId` 路由到各发言人气泡。
 *   - 每个 agent 一份**私有持久上下文**(`ctxByAgent`),跨轮累积自己的思考;轮到它时只注入「别人这轮
 *     新说的话」delta —— 只见他人**公开发言**,不见他人私有 reasoning/tool 轮。
 *   - 顺序执行(非并发):后发言者经工作区 + 公开记录看到先前改动。工具走完整集(host),审批闸照走。
 *   - 每轮末(未到上限)全员投票,`endCount*2 > total` 即停;否则跑满 maxRounds。
 *   - 结束后 ask_user「是否总结?」→ 是则固定「主持人」persona 一次性总结。
 *   - 仅 standalone/desktop(host)形态触达(由 agentLoop 的 hostExec 闸门把守);云端 worker 不调本模块。
 *
 * 不从 ./agentLoop import(agentLoop import 本模块 → 避免循环);所需 brain/billing/state 直接走 deps()。
 */
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import type { ChatMessage, Tool } from '../core/types.js';
import type { StreamResult } from '../seams/cloudBrain.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { ToolContext } from '../tools/registry.js';
import { getToolDefinitions, executeTool } from '../tools/registry.js';
import { gateToolCall } from './approvals.js';
import { publish, drain } from './eventBus.js';
import { updateRunStatus } from './runStore.js';
import { requestInquiry } from './inquiries.js';
import { getAgent, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';
import { enterRunContext } from '../seams/runContext.js';
import { runCostCeiling, isOverRunCost } from './runBudget.js';
import { capToolResult } from './contextBudget.js';
import { compactSession, getLatestSummary } from './compaction.js';

const MAX_GROUP_ROUNDS = 30;
const DEFAULT_ROUNDS = 7; // 中等
// ponytail: 单个发言「轮」的迭代上限 —— 讨论轮通常是「几次调研工具 + 发言」,不需要主 loop 的 90。
// agent.maxIterations 可往下压,但封顶 GROUP_TURN_MAX_ITER 防群聊里单 agent 烧穿。
const GROUP_TURN_MAX_ITER = 16;
const SPEECH_CAP = 16_000;

export const HOST_SLUG = '__host__';
const USER_SLUG = '__user__';
/** 播种的「此前对话」上下文条目(默认播种,groupSeedHistory:false 显式关):不属于任何发言人,formatDelta 原样呈现。 */
export const CONTEXT_SLUG = '__context__';

export interface GroupChatParams {
  runId: string;
  sessionId: string;
  userId: string;
  appId: string;
  /** 会话默认模型;agent.model 为空时回退到它。 */
  modelId: string;
  execMode: 'sandbox' | 'host';
  cwd?: string;
  /** 云端 Project 工作区名(主 loop 已按 host 门/合法性算好);群聊发言人工具与主 loop 落同一工作区。 */
  wsProject?: string | null;
  profile: AppProfile;
  agentConfig: any;
  message: string;
  userMessageId?: string;
  attachments?: any[];
  signal: AbortSignal;
}

export interface TranscriptEntry { round: number; slug: string; name: string; text: string }

/** 本次群聊 run 的真实 token 累计(usage 事件的 total + 终态 tokens_total 用)。 */
interface Meter { tokens: number }

/**
 * 群聊主编排。由 agentLoop.runLoop 在 try 内调用(hostExec 闸门已把守),return 后 runLoop 的 finally
 * 负责推进会话队列/快照。本函数自管终态(done/failed/aborted),不碰队列。
 */
export async function runGroupChat(p: GroupChatParams): Promise<void> {
  const { runId, sessionId, userId, modelId, signal } = p;
  const state = deps().state;

  try {
    // ① 载入参与者:groupAgents 是有序 slug 列表(已存 Normal Agent + 临时 Agent 混合);
    // 临时 Agent 定义随会话 agentConfig.groupTempAgents 传来(不落 ~/.tangu/agents,仅本会话用),按 slug 优先命中。
    const slugs: string[] = Array.isArray(p.agentConfig.groupAgents) ? p.agentConfig.groupAgents.map(String) : [];
    const tempBySlug = new Map(sanitizeTempAgents(p.agentConfig.groupTempAgents).map((a) => [a.slug, a]));
    const loaded = await Promise.all(slugs.map(async (s) => tempBySlug.get(s) || (await getAgent(s).catch(() => null))));
    const participants = loaded.filter((a): a is NormalAgentDef => !!a);
    if (participants.length < 2) {
      await publish(runId, 'error', { error: 'group_needs_2_agents', detail: '群聊至少需要选择 2 个有效的 Agent。' });
      await drain(runId);
      await updateRunStatus(runId, 'failed', { error: 'group_needs_2_agents' });
      return;
    }

    // 被 @ 的 agent 优先发言:把它移到队首(整场讨论每轮都先发)。不在群内则忽略。
    const prioritySlug = typeof p.agentConfig.priorityAgent === 'string' ? p.agentConfig.priorityAgent : '';
    if (prioritySlug) {
      const idx = participants.findIndex((a) => a.slug === prioritySlug);
      if (idx > 0) participants.unshift(participants.splice(idx, 1)[0]);
    }

    // ①.5 播种既有会话历史(**默认开**,groupSeedHistory:false 显式关):聊到一半开群聊/群聊里发后续
    // 消息,参与者要看得到此前对话。先经 compactSession 压缩再注入(用户口径「先 Compact 再注入」),
    // 摘要作为一条上下文条目进 transcript → 每个参与者首轮 delta 自然看到。必须在 ② 落库开场白
    // **之前**读,否则开场白会在上下文块里重复出现。历史为空 → 无条目,与旧行为一致。
    const seedEntry = p.agentConfig.groupSeedHistory !== false
      ? await buildHistorySeed(sessionId, modelId, p.appId).catch(() => null)
      : null;

    // ② 用户消息落库(group 分支早于 runLoop 的 insertUserMessage 点,故此处补上)
    if (p.userMessageId && p.message) {
      await state.insertUserMessage({
        id: p.userMessageId, sessionId, content: String(p.message), modelId,
        attachments: Array.isArray(p.attachments) && p.attachments.length ? p.attachments : null,
      }).catch(() => {});
    }

    const maxRounds = clampRounds(p.agentConfig.groupMaxRounds);
    const roster = participants.map((a) => `- ${a.name}(${a.slug})：${a.description || '——'}`).join('\n');

    // ③ 每 agent 私有持久上下文 + 已读指针(seen[slug] = transcript 中已注入到该 agent 的条数)
    const ctxByAgent = new Map<string, ChatMessage[]>();
    const seen = new Map<string, number>();
    for (const a of participants) {
      ctxByAgent.set(a.slug, [{ role: 'system', content: buildGroupSystem(a, roster, p.message) } as ChatMessage]);
      seen.set(a.slug, 0);
    }
    const transcript: TranscriptEntry[] = [
      ...(seedEntry ? [seedEntry] : []),
      { round: 0, slug: USER_SLUG, name: 'User', text: String(p.message) },
    ];

    let costTotal = 0;
    const meter: Meter = { tokens: 0 };
    const runCostLimit = runCostCeiling();
    let stopReason = 'max_rounds';
    let roundsRun = 0;

    outer:
    for (let round = 1; round <= maxRounds; round++) {
      roundsRun = round;
      for (const agent of participants) {
        if (signal.aborted) throw new AbortLikeError();
        // 本发言人的记忆作用域:其 remember/log_event 落到自己的 agent 文件夹(顺序执行,enterWith 即时生效)。
        enterRunContext(p.userId, p.runId, resolveMemorySlug(agent));
        // 额度复查(标准计费才有意义;standalone 为 noop → 恒 ok)
        const can = await deps().billing.canConsumeTokenPoints(userId, 1).catch(() => ({ ok: true } as any));
        if (!can.ok) {
          await publish(runId, 'error', { error: 'token_quota_exceeded' });
          stopReason = 'quota';
          break outer;
        }

        // delta = 该 agent 上次发言以来的新条目 → 作为一条 user 消息注入它的私有上下文
        const from = seen.get(agent.slug) ?? 0;
        const ctx = ctxByAgent.get(agent.slug)!;
        ctx.push({ role: 'user', content: formatDelta(transcript.slice(from), agent.name) } as ChatMessage);

        // 持久消息 id 下发给前端,使实时气泡 id 与落库 uuid 对齐 → 轮询/重载按 id 合并不产生重复气泡。
        const messageId = uuidv4();
        await publish(runId, 'group_speaker', { slug: agent.slug, name: agent.name, round, phase: 'start', messageId });
        const turn = await runGroupTurn(ctx, agent, p, meter);
        costTotal += turn.cost;
        await publish(runId, 'group_speaker', { slug: agent.slug, name: agent.name, round, phase: 'end', messageId });

        transcript.push({ round, slug: agent.slug, name: agent.name, text: turn.text });
        seen.set(agent.slug, transcript.length); // 含自己这条 → 下次 delta 自动排除自己

        // 每条发言 = 一条独立 model 消息(前缀发言人,reload/网页可读)。复用 finalizeAssistantMessage。
        await state.finalizeAssistantMessage({
          messageId, sessionId, modelId: agent.model || modelId,
          content: `**🗣 ${agent.name}**\n\n${turn.text}`, reasoning: '', toolCalls: [], toolResults: [],
        }).catch(() => {});

        if (runCostLimit > 0 && isOverRunCost(costTotal, runCostLimit)) {
          await publish(runId, 'status', { phase: 'group_cost_limit', costTotal });
          stopReason = 'cost_limit';
          break outer;
        }
      }

      // 每轮末投票(最后一轮无需投 —— 反正要停)
      if (round < maxRounds) {
        // 投票开始信号:前端据此显示「正在投票」动画,收到下方 group_vote 结果即结束。
        await publish(runId, 'group_voting', { round });
        const votes: Array<{ slug: string; name: string; end: boolean; reason: string }> = [];
        let endCount = 0;
        for (const agent of participants) {
          if (signal.aborted) throw new AbortLikeError();
          const v = await castVote(ctxByAgent.get(agent.slug)!, agent, p, meter);
          costTotal += v.cost;
          if (v.end) endCount++;
          votes.push({ slug: agent.slug, name: agent.name, end: v.end, reason: v.reason });
        }
        await publish(runId, 'group_vote', { round, votes, endCount, total: participants.length });
        if (endCount * 2 > participants.length) { stopReason = 'vote'; break; }
        if (runCostLimit > 0 && isOverRunCost(costTotal, runCostLimit)) { stopReason = 'cost_limit'; break; }
      }
    }

    await publish(runId, 'group_ended', {
      rounds: roundsRun, reason: stopReason,
      participants: participants.map((a) => ({ slug: a.slug, name: a.name })),
    });

    // ④ 主持人总结。groupNoSummary(Historian 辅助讨论等:结论=主 agent 的工具动作,无需总结)→ 整步跳过;
    // groupAutoSummary(后台 @讨论:无交互用户)→ 直接总结;否则询问用户(run 内 await,不结束 run)。
    let summarized = false;
    if (!signal.aborted && !p.agentConfig.groupNoSummary) {
      const ans = p.agentConfig.groupAutoSummary
        ? '是,总结'
        : await requestInquiry(
            runId,
            { question: '群聊讨论已结束,需要主持人总结一下吗?', options: ['是,总结', '否,不用'], allowFreeText: false },
            signal,
          );
      if (ans.startsWith('是')) {
        const hostRound = roundsRun + 1;
        const hostMessageId = uuidv4();
        await publish(runId, 'group_speaker', { slug: HOST_SLUG, name: '主持人', round: hostRound, phase: 'start', messageId: hostMessageId });
        const summary = await runHostSummary(transcript, p, meter);
        await publish(runId, 'group_speaker', { slug: HOST_SLUG, name: '主持人', round: hostRound, phase: 'end', messageId: hostMessageId });
        await state.finalizeAssistantMessage({
          messageId: hostMessageId, sessionId, modelId,
          content: `**🗣 主持人**\n\n${summary.text}`, reasoning: '', toolCalls: [], toolResults: [],
        }).catch(() => {});
        summarized = true;
      }
    }

    await drain(runId);
    await publish(runId, 'done', { content: '', group: true });
    await updateRunStatus(runId, 'done', { result: { group: true, rounds: roundsRun, reason: stopReason, summarized }, tokensTotal: meter.tokens });
  } catch (err: any) {
    const aborted = err?.name === 'AbortError' || err instanceof AbortLikeError;
    const status = aborted ? 'aborted' : 'failed';
    const msg = aborted ? 'aborted' : (err?.message || String(err));
    console.error(`[agent-core] group chat run ${runId} ${status}:`, msg);
    await publish(runId, 'error', { error: msg, aborted }).catch(() => {});
    await drain(runId).catch(() => {});
    await updateRunStatus(runId, status, { error: msg }).catch(() => {});
  }
}

/** 一个 agent 的「发言」轮:私有上下文上的小 agentic loop(完整工具 + 流式),返回最终发言文本。 */
async function runGroupTurn(ctx: ChatMessage[], agent: NormalAgentDef, p: GroupChatParams, meter: Meter): Promise<{ text: string; cost: number }> {
  const { runId, sessionId, appId, execMode, cwd, profile, signal } = p;
  const llm = deps().brain.llm;
  const effModelId = agent.model || p.modelId;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(effModelId);
  const approvalMode: 'readonly' | 'auto-edit' | 'full-auto' =
    agent.approvalMode || (execMode === 'host' ? 'auto-edit' : 'full-auto');

  const toolCtx: ToolContext = {
    userId: p.userId, sessionId, appId, runId, signal,
    execMode, cwd, approvalMode, profile, modelId: effModelId, planMode: false, muse: false,
    wsProject: p.wsProject,
    // 群聊发言人不可再起讨论(start_discussion/wait_discussion 隐藏)——防递归裂变。
    inDiscussion: true,
    // ponytail: v1 群聊每 agent 用内置工具集(读/写/执行已够「完整工具」);custom/MCP per-agent 暂不接,
    // 需要时按 agent.tools 走 loadCustomTools 即可补上。
  };
  const toolDefs = getToolDefinitions(toolCtx);
  const maxIter = Math.min(agent.maxIterations || GROUP_TURN_MAX_ITER, GROUP_TURN_MAX_ITER);

  let text = '';
  let cost = 0;
  for (let iteration = 0; iteration < maxIter; iteration++) {
    if (signal.aborted) throw new AbortLikeError();
    const lastIter = iteration === maxIter - 1;
    // 最后一轮不发 tools(而非 toolChoice:'none'):思考模式渠道(DeepSeek 等)会以
    // "Thinking mode does not support this tool_choice" 拒绝显式 tool_choice,整场讨论直接失败。
    const payload = await llm.buildProviderPayload({
      model, apiModelId, messages: ctx, projectSource: appId,
      temperature: 0.7, tools: lastIter ? undefined : toolDefs, toolChoice: lastIter ? undefined : 'auto',
      attachments: [], thinkingLevel: agent.thinkingLevel || 'medium', stream: true, // 参与者发言默认思考·中(与会话默认一致);投票/主持收尾仍 off
      cacheKey: `${sessionId}:grp:${agent.slug}`,
    });
    const res = await llm.streamProviderCompletion({
      apiKey, baseUrl, payload, provider: (model as any)?.provider, signal,
      onToken: (d) => { void publish(runId, 'token', { delta: d, agentId: agent.slug }); },
      onReasoning: (d) => { void publish(runId, 'reasoning', { delta: d, agentId: agent.slug }); },
      onToolCallDelta: (info) => {
        if (info.argsDelta) void publish(runId, 'tool_stream', { id: info.id, name: info.name, delta: info.argsDelta, agentId: agent.slug });
      },
    });
    cost += await account(p, res, effModelId, model, agent.slug, meter);

    if (!res.toolCalls?.length || lastIter) {
      text = res.content || text;
      if (res.content) ctx.push({ role: 'assistant', content: res.content } as ChatMessage);
      break;
    }

    ctx.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls } as ChatMessage);
    for (const call of res.toolCalls) {
      if (signal.aborted) throw new AbortLikeError();
      await publish(runId, 'tool_call', { id: call.id, name: call.function.name, arguments: call.function.arguments, agentId: agent.slug });
      const decision = await gateToolCall(runId, call, { sessionId, execMode, approvalMode, cwd }, signal);
      let content: string;
      let isError = false;
      if (decision.action === 'reject') {
        content = 'The user rejected this operation.';
        isError = true;
      } else {
        const execCall = decision.argsOverride
          ? { ...call, function: { ...call.function, arguments: JSON.stringify(decision.argsOverride) } }
          : call;
        const r = await executeTool(execCall, toolCtx);
        content = capToolResult(r.result);
        isError = r.isError;
      }
      await publish(runId, 'tool_result', { id: call.id, name: call.function.name, result: content, isError, agentId: agent.slug });
      ctx.push({ role: 'tool', content, tool_call_id: call.id } as ChatMessage);
    }
  }
  return { text: (text || '(no remark this round)').slice(0, SPEECH_CAP), cost };
}

/** 投票:在 agent 私有上下文末尾临时挂一条投票指令,强制调 cast_vote;不污染发言上下文(不回写)。 */
async function castVote(ctx: ChatMessage[], agent: NormalAgentDef, p: GroupChatParams, meter: Meter): Promise<{ end: boolean; reason: string; cost: number }> {
  const llm = deps().brain.llm;
  const effModelId = agent.model || p.modelId;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(effModelId);
  const messages: ChatMessage[] = [...ctx, { role: 'user', content: VOTE_PROMPT } as ChatMessage];
  const attempt = async (toolChoice: any) => {
    const payload = await llm.buildProviderPayload({
      model, apiModelId, messages, projectSource: p.appId,
      temperature: 0, tools: [CAST_VOTE_DEF], toolChoice,
      attachments: [], thinkingLevel: 'off', stream: true, cacheKey: `${p.sessionId}:grp:${agent.slug}`,
    });
    return llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: p.signal });
  };
  // 投票是收束手段不是硬需求:强制 tool_choice 被渠道拒绝(思考模式模型)→ 降级 'auto' 再试;
  // 仍失败 → 默认「继续」,绝不让投票把整场群聊/讨论打挂。
  let res;
  try {
    res = await attempt({ type: 'function', function: { name: 'cast_vote' } });
  } catch (e: any) {
    if (p.signal.aborted || e?.name === 'AbortError' || e instanceof AbortLikeError) throw e;
    try {
      res = await attempt('auto');
    } catch {
      return { end: false, reason: '', cost: 0 };
    }
  }
  const cost = await account(p, res, effModelId, model, agent.slug, meter);
  let end = false;
  let reason = '';
  try {
    const call = res.toolCalls?.find((c) => c.function.name === 'cast_vote') || res.toolCalls?.[0];
    if (call) {
      const args = JSON.parse(call.function.arguments || '{}');
      end = !!args.end;
      reason = String(args.reason || '');
    }
  } catch { /* 解析失败 → 默认继续 */ }
  return { end, reason, cost };
}

/** 主持人总结:一次性流式,tag agentId=__host__。 */
async function runHostSummary(transcript: TranscriptEntry[], p: GroupChatParams, meter: Meter): Promise<{ text: string; cost: number }> {
  const llm = deps().brain.llm;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(p.modelId);
  const body = transcript.map((t) => `【${t.name}】\n${t.text}`).join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: HOST_PROMPT } as ChatMessage,
    { role: 'user', content: `Here is the full record of the group discussion:\n\n${body}` } as ChatMessage,
  ];
  const payload = await llm.buildProviderPayload({
    model, apiModelId, messages, projectSource: p.appId, temperature: 0.4,
    attachments: [], thinkingLevel: 'off', stream: true, cacheKey: `${p.sessionId}:grp:host`,
  });
  let streamed = '';
  const res = await llm.streamProviderCompletion({
    apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: p.signal,
    onToken: (d) => { streamed += d; void publish(p.runId, 'token', { delta: d, agentId: HOST_SLUG }); },
  });
  const cost = await account(p, res, p.modelId, model, HOST_SLUG, meter);
  return { text: (res.content || streamed || '(no summary)').slice(0, SPEECH_CAP), cost };
}

/** 计费 + 发 usage 事件(usage 取自真实 provider 用量,即使 noop 计费也让前端 token 表生效)。 */
async function account(p: GroupChatParams, res: StreamResult, effModelId: string, model: any, agentSlug: string, meter: Meter): Promise<number> {
  const cached = res.usage?.cached_tokens || 0;
  const promptT = res.usage?.prompt_tokens || 0;
  const compT = res.usage?.completion_tokens || 0;
  meter.tokens += promptT + compT;
  const cost = await deps().billing.calculateCost(effModelId, promptT, compT, model, cached).catch(() => 0);
  await deps().billing.consumeTokenPoints(p.userId, cost).catch(() => ({ ok: true } as any));
  await publish(p.runId, 'usage', { prompt: promptT, completion: compT, cached, cost, total: meter.tokens, agentId: agentSlug }).catch(() => {});
  return cost;
}

function clampRounds(v: any): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ROUNDS;
  return Math.min(n, MAX_GROUP_ROUNDS);
}

const THINK_LEVELS = ['off', 'low', 'medium', 'high'];
const APPROVAL_MODES = ['readonly', 'auto-edit', 'full-auto'];

/** 临时 Agent 定义来自客户端(本会话用,不落盘):校验必填 + 钳制各字段,复刻 agentRegistry.saveAgent 的口径。 */
function sanitizeTempAgents(raw: any): NormalAgentDef[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalAgentDef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const slug = String(r.slug || '').trim();
    const name = String(r.name || '').trim();
    const systemPrompt = String(r.systemPrompt || '').trim();
    if (!slug || !name || !systemPrompt) continue;
    const maxIter = Number(r.maxIterations);
    out.push({
      slug,
      name: name.slice(0, 120),
      version: '1.0.0', // 临时群聊 agent,不落盘,版本仅占位
      description: String(r.description || '').slice(0, 300),
      model: String(r.model || '').trim(),
      tools: Array.isArray(r.tools) ? r.tools.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 100) : [],
      thinkingLevel: THINK_LEVELS.includes(r.thinkingLevel) ? r.thinkingLevel : '',
      maxIterations: Number.isFinite(maxIter) && maxIter > 0 ? Math.min(200, Math.floor(maxIter)) : null,
      approvalMode: APPROVAL_MODES.includes(r.approvalMode) ? r.approvalMode : '',
      createdBy: 'user',
      createdAt: '',
      systemPrompt: systemPrompt.slice(0, 100_000),
    });
  }
  return out;
}

function buildGroupSystem(agent: NormalAgentDef, roster: string, topic: string): string {
  return (
    (agent.systemPrompt ? agent.systemPrompt.trim() + '\n\n' : '') +
    (agent.soul && agent.soul.trim() ? '## Persona\n' + agent.soul.trim() + '\n\n' : '') +
    '## Group Chat Mode\n' +
    'You are participating in a multi-agent group discussion. Members present:\n' +
    roster +
    '\n\n' +
    `You are "${agent.name}". Rules:\n` +
    "- Each round you first see other members' new remarks, then it is your turn. Give **your own** view based on the whole discussion: you may agree, challenge, add to, or propose something new, but keep your professional perspective and persona — do not blindly agree.\n" +
    '- Address a member with @<name>; quote their words with a markdown blockquote (starting with >).\n' +
    '- Be concise and well-grounded; address the issue, not the person. Use tools (read files/search/run, etc.) to support your view when needed, but your remark is the deliverable.\n' +
    `- The topic of this discussion (the user's initial message): ${topic}`
  );
}

export function formatDelta(delta: TranscriptEntry[], selfName: string): string {
  if (!delta.length) return `It is now your turn (${selfName}) to speak.`;
  const lines = delta
    .map((t) => (t.slug === CONTEXT_SLUG ? t.text : t.slug === USER_SLUG ? `[User] ${t.text}` : `@${t.name}:\n${t.text}`))
    .join('\n\n');
  return `New remarks in the group:\n\n${lines}\n\n———\nIt is now your turn (${selfName}) to speak. You may @ a member, or quote their remark with >.`;
}

/**
 * 把本会话已有历史拼成一条 CONTEXT transcript 条目。先压缩再注入:复用 /compact 通道
 * (compactSession:增量、检查点落 session_summaries、绝不抛)→ 摘要即种子;压缩不可用
 * (历史太短 <2 条 / 模型失败 / 云端 worker 无本地库)→ 退回原始尾窗(单条 cap 2000、
 * 总量尾部 8000,对齐 localHistorian.recentTranscript 量级),已有检查点则摘要拼在尾窗前。
 * 无有效历史 → null。
 */
export async function buildHistorySeed(sessionId: string, modelId: string, appId: string): Promise<TranscriptEntry | null> {
  const state = deps().state;
  const n = await state.countSessionMessages(sessionId);
  if (!n) return null;
  const wrap = (body: string): TranscriptEntry => ({
    round: 0,
    slug: CONTEXT_SLUG,
    name: 'Context',
    text: `[Context — the conversation so far in this session]\n\n${body}\n\n[End of context]`,
  });
  const c = await compactSession(sessionId, modelId, appId).catch(() => null);
  if (c?.ok && c.summary) return wrap(c.summary);
  const take = Math.min(n, 30);
  const rows = await state.listSessionMessagesWindow(sessionId, take, n - take);
  const lines: string[] = [];
  for (const r of rows || []) {
    const role = r.role === 'model' ? 'assistant' : r.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(r.content || '').trim();
    if (!content) continue;
    lines.push(`${role === 'user' ? '[User]' : '[Assistant]'} ${content.slice(0, 2000)}`);
  }
  // 兜底也别丢已压缩掉的早期上下文:有历史检查点(如用户手动 /compact 过)就把摘要拼在尾窗前。
  const prev = await getLatestSummary(sessionId).catch(() => null);
  if (!lines.length && !prev?.summary) return null;
  let block = lines.join('\n\n');
  if (block.length > 8000) block = block.slice(-8000);
  const body = prev?.summary ? `[Summary of earlier conversation]\n${prev.summary}${block ? '\n\n' + block : ''}` : block;
  return wrap(body);
}

const VOTE_PROMPT =
  'This round ends here. Considering all remarks so far, do you think this group discussion should end (the topic has been discussed thoroughly / consensus reached / continuing adds no new value)? ' +
  'Only call cast_vote to indicate your position; do not output any other text.';

const CAST_VOTE_DEF: Tool = {
  type: 'function',
  function: {
    name: 'cast_vote',
    description: 'Vote on whether to end this group discussion.',
    parameters: {
      type: 'object',
      properties: {
        end: { type: 'boolean', description: 'true = should end the discussion; false = should continue' },
        reason: { type: 'string', description: 'One-sentence reason' },
      },
      required: ['end'],
    },
  },
};

const HOST_PROMPT =
  'You are the moderator of this multi-agent group chat. Based on the full discussion record, give the user a clear, objective summary:\n' +
  '1. The core topic of the discussion\n' +
  '2. Each side\'s main points (grouped by member)\n' +
  '3. Consensus reached and remaining disagreements\n' +
  '4. Conclusions and actionable recommendations\n' +
  "Write in the user's language, well-organized and concise; do not restate remarks verbatim.";

class AbortLikeError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}
