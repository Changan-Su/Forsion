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
import { getAgent, type NormalAgentDef } from '../agents/agentRegistry.js';
import { runCostCeiling, isOverRunCost } from './runBudget.js';
import { capToolResult } from './contextBudget.js';

const MAX_GROUP_ROUNDS = 30;
const DEFAULT_ROUNDS = 7; // 中等
// ponytail: 单个发言「轮」的迭代上限 —— 讨论轮通常是「几次调研工具 + 发言」,不需要主 loop 的 90。
// agent.maxIterations 可往下压,但封顶 GROUP_TURN_MAX_ITER 防群聊里单 agent 烧穿。
const GROUP_TURN_MAX_ITER = 16;
const SPEECH_CAP = 16_000;

export const HOST_SLUG = '__host__';
const USER_SLUG = '__user__';

export interface GroupChatParams {
  runId: string;
  sessionId: string;
  userId: string;
  appId: string;
  /** 会话默认模型;agent.model 为空时回退到它。 */
  modelId: string;
  execMode: 'sandbox' | 'host';
  cwd?: string;
  profile: AppProfile;
  agentConfig: any;
  message: string;
  userMessageId?: string;
  attachments?: any[];
  signal: AbortSignal;
}

interface TranscriptEntry { round: number; slug: string; name: string; text: string }

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
    const transcript: TranscriptEntry[] = [{ round: 0, slug: USER_SLUG, name: '用户', text: String(p.message) }];

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

        await publish(runId, 'group_speaker', { slug: agent.slug, name: agent.name, round, phase: 'start' });
        const turn = await runGroupTurn(ctx, agent, p, meter);
        costTotal += turn.cost;
        await publish(runId, 'group_speaker', { slug: agent.slug, name: agent.name, round, phase: 'end' });

        transcript.push({ round, slug: agent.slug, name: agent.name, text: turn.text });
        seen.set(agent.slug, transcript.length); // 含自己这条 → 下次 delta 自动排除自己

        // 每条发言 = 一条独立 model 消息(前缀发言人,reload/网页可读)。复用 finalizeAssistantMessage。
        await state.finalizeAssistantMessage({
          messageId: uuidv4(), sessionId, modelId: agent.model || modelId,
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

    // ④ 询问用户是否要主持人总结(run 内 await,不结束 run)
    let summarized = false;
    if (!signal.aborted) {
      const ans = await requestInquiry(
        runId,
        { question: '群聊讨论已结束,需要主持人总结一下吗?', options: ['是,总结', '否,不用'], allowFreeText: false },
        signal,
      );
      if (ans.startsWith('是')) {
        const hostRound = roundsRun + 1;
        await publish(runId, 'group_speaker', { slug: HOST_SLUG, name: '主持人', round: hostRound, phase: 'start' });
        const summary = await runHostSummary(transcript, p, meter);
        await publish(runId, 'group_speaker', { slug: HOST_SLUG, name: '主持人', round: hostRound, phase: 'end' });
        await state.finalizeAssistantMessage({
          messageId: uuidv4(), sessionId, modelId,
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
    const payload = await llm.buildProviderPayload({
      model, apiModelId, messages: ctx, projectSource: appId,
      temperature: 0.7, tools: toolDefs, toolChoice: lastIter ? 'none' : 'auto',
      attachments: [], thinkingLevel: agent.thinkingLevel || 'off', stream: true,
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
        content = '用户拒绝了该操作。';
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
  return { text: (text || '(本轮未发言)').slice(0, SPEECH_CAP), cost };
}

/** 投票:在 agent 私有上下文末尾临时挂一条投票指令,强制调 cast_vote;不污染发言上下文(不回写)。 */
async function castVote(ctx: ChatMessage[], agent: NormalAgentDef, p: GroupChatParams, meter: Meter): Promise<{ end: boolean; reason: string; cost: number }> {
  const llm = deps().brain.llm;
  const effModelId = agent.model || p.modelId;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(effModelId);
  const messages: ChatMessage[] = [...ctx, { role: 'user', content: VOTE_PROMPT } as ChatMessage];
  const payload = await llm.buildProviderPayload({
    model, apiModelId, messages, projectSource: p.appId,
    temperature: 0, tools: [CAST_VOTE_DEF], toolChoice: { type: 'function', function: { name: 'cast_vote' } },
    attachments: [], thinkingLevel: 'off', stream: true, cacheKey: `${p.sessionId}:grp:${agent.slug}`,
  });
  const res = await llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: p.signal });
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
    { role: 'user', content: `以下是完整的群聊讨论记录:\n\n${body}` } as ChatMessage,
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
  return { text: (res.content || streamed || '(无总结)').slice(0, SPEECH_CAP), cost };
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
    '## 群聊模式\n' +
    '你正在参与一个多 Agent 群聊讨论。在场成员:\n' +
    roster +
    '\n\n' +
    `你是「${agent.name}」。规则:\n` +
    '- 每轮你会先看到其他成员的新发言,然后轮到你发言。基于全部讨论给出**你自己**的观点:可以赞同、质疑、补充或提出新方案,但要保持你的专业视角与人格,不要无脑附和。\n' +
    '- 称呼某位成员用 @<名字>;引用其原话用 markdown 引用块(以 > 开头)。\n' +
    '- 简洁、有据、对事不对人。必要时可用工具(读文件/搜索/执行等)佐证你的观点,但发言才是产出。\n' +
    `- 本次讨论的主题(用户最初的消息):${topic}`
  );
}

function formatDelta(delta: TranscriptEntry[], selfName: string): string {
  if (!delta.length) return `现在轮到你(${selfName})发言。`;
  const lines = delta
    .map((t) => (t.slug === USER_SLUG ? `【用户】${t.text}` : `@${t.name}:\n${t.text}`))
    .join('\n\n');
  return `群里的新发言:\n\n${lines}\n\n———\n现在轮到你(${selfName})发言。可以 @ 某位成员,或用 > 引用其发言。`;
}

const VOTE_PROMPT =
  '本轮讨论到此。综合目前所有发言,你认为这场群聊讨论是否应当结束了(议题已充分讨论 / 已达成共识 / 继续也无新增价值)?' +
  '请只调用 cast_vote 表态,不要输出其他文字。';

const CAST_VOTE_DEF: Tool = {
  type: 'function',
  function: {
    name: 'cast_vote',
    description: '对「是否结束本次群聊讨论」投票表态。',
    parameters: {
      type: 'object',
      properties: {
        end: { type: 'boolean', description: 'true=应当结束讨论;false=应当继续' },
        reason: { type: 'string', description: '一句话理由' },
      },
      required: ['end'],
    },
  },
};

const HOST_PROMPT =
  '你是这场多 Agent 群聊的主持人。请基于完整讨论记录,为用户做一份清晰、客观的总结:\n' +
  '1. 讨论的核心议题\n' +
  '2. 各方主要观点(按成员归纳)\n' +
  '3. 达成的共识与仍存在的分歧\n' +
  '4. 结论与可执行建议\n' +
  '用中文,条理清晰、简洁,不要逐字复述发言。';

class AbortLikeError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}
