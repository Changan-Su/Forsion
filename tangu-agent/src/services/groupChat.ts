import { resolveHostSandboxPolicy } from '../sandbox/hostSandboxPolicy.js';
/**
 * 群聊模式(Group Chat)编排:用户选 ≥2 个 Normal Agent,发一条消息后 agents **轮流进入 run 并发言**。
 *
 * 设计要点:
 *   - 整个群聊 = **一个 run**(一条事件流):前端订阅同一 runId,事件带 `agentId` 路由到各发言人气泡。
 *   - 每个 agent 一份**私有持久上下文**(`ctxByAgent`),跨轮累积自己的思考;轮到它时只注入「别人这轮
 *     新说的话」delta —— 只见他人**公开发言**,不见他人私有 reasoning/tool 轮。
 *   - 顺序执行(非并发):后发言者经工作区 + 公开记录看到先前改动。工具走完整集(host),审批闸照走。
 *   - 调度只有一套(09-16 用户拍板:不再分会议 / 协作,也没有缺省轮数上限):被 @ 者 FIFO 优先,
 *     否则按成员序轮转本周期还没发言、也没表态 DONE 的成员;每位成员**发言末尾自己决定还聊不聊**
 *     (DONE 独占一行 = 我这边完了,之后不再轮到它,除非被 @ 或用户再开口);全员 DONE → 结束。
 *     没有「投票」这一步。上界只剩:显式 groupMaxRounds(讨论 / Historian 辅助等内部调用方传)、
 *     MAX_GROUP_ROUNDS 兜底天花板、run 成本上限、用户中止。
 *   - 结束后 ask_user「是否总结?」→ 是则固定「主持人」persona 一次性总结。
 *   - 仅 standalone/desktop(host)形态触达(由 agentLoop 的 hostExec 闸门把守);云端 worker 不调本模块。
 *
 * 不从 ./agentLoop import(agentLoop import 本模块 → 避免循环);所需 brain/billing/state 直接走 deps()。
 */
import { v4 as uuidv4 } from 'uuid';
import { projectDocSection } from './projectDoc.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import type { StreamResult } from '../seams/cloudBrain.js';
import { THINKING_LEVELS } from '../llm/modelCapabilities.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { ToolContext } from '../tools/registry.js';
import { getToolDefinitions, executeTool, listDeferredTools } from '../tools/registry.js';
import { gateToolCall, type ApprovalMode } from './approvals.js';
import { publish, drain } from './eventBus.js';
import { updateRunStatus } from './runStore.js';
import { requestInquiry } from './inquiries.js';
import { agentCapOf, getAgent, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';
import { enterRunContext } from '../seams/runContext.js';
import { runCostCeiling, isOverRunCost } from './runBudget.js';
import { capToolResult } from './contextBudget.js';
import { compactSession, getLatestSummary } from './compaction.js';

/** 兜底天花板(周期数;每周期 = 还想聊的成员各说一次)。不是缺省上限:没传 groupMaxRounds 时团队只靠成员自己的 DONE 收场,这里只防失控。 */
const MAX_GROUP_ROUNDS = 30;
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
  /** 与主 loop 同一套额外可写根(含 Forsion 注入的活动 Amadeus Vault)。 */
  extraRoots?: string[];
  /** 云端 Project 工作区名(主 loop 已按 host 门/合法性算好);群聊发言人工具与主 loop 落同一工作区。 */
  wsProject?: string | null;
  profile: AppProfile;
  agentConfig: any;
  message: string;
  userMessageId?: string;
  attachments?: any[];
  signal: AbortSignal;
  /** 由 agentLoop 注入(本模块不 import agentLoop):取出本 run 已排队的用户插话。缺省 = 没有插话通道(与旧行为一致)。 */
  drainSteer?: () => Array<{ id: string; content: string; attachments?: any[] }>;
}

export interface TranscriptEntry { round: number; slug: string; name: string; text: string }

export interface TeamState {
  participants: string[];
  /** 被 @ 的成员 FIFO(含已表态 DONE 的:被点名即重新入场)。 */
  pending: string[];
  cycleSpoken: Set<string>;
  /** 已表态 DONE 的成员:轮转时跳过,直到被 @ 或用户再开口。 */
  done: Set<string>;
}
/** 下一位发言人(纯函数,可测):被 @ 者 FIFO(已不在场的点名跳过)→ 本周期未发言且未表态 DONE 的成员按序轮转 → null = 本周期结束。 */
export function teamNext(st: TeamState): string | null {
  while (st.pending.length) {
    const s = st.pending.shift()!;
    if (st.participants.includes(s)) return s;
  }
  return st.participants.find((s) => !st.cycleSpoken.has(s) && !st.done.has(s)) ?? null;
}
/** 从一段发言里按出现顺序解析被 @ 的成员(按 @<name> 或 @<slug>;排除自己;去重)。模型不守约定 = 无人被点名。 */
export function parseMentions(text: string, participants: Array<{ slug: string; name: string }>, selfSlug: string): string[] {
  // 词法边界:@Ann 不能命中 @Anna(名字 / slug 后面不能紧跟字母数字 _ -);同一位置多个命中取最长;重叠命中只算一个。
  const esc = (k: string): string => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits: Array<{ i: number; len: number; slug: string }> = [];
  for (const a of participants) {
    if (a.slug === selfSlug) continue;
    for (const key of new Set([a.name, a.slug].filter(Boolean))) {
      const re = new RegExp(`@${esc(key)}(?![\\p{L}\\p{N}_-])`, 'gu');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) { hits.push({ i: m.index, len: m[0].length, slug: a.slug }); if (!m[0].length) re.lastIndex++; }
    }
  }
  hits.sort((x, y) => x.i - y.i || y.len - x.len);
  const out: string[] = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.i < lastEnd) continue;
    lastEnd = h.i + h.len;
    if (!out.includes(h.slug)) out.push(h.slug);
  }
  return out;
}
/** DONE 只认发言的最后一个非空行(约定:独占一行、写在末尾);正文中间 / 代码块里的 DONE、「NOT DONE」「done」都不算(Codex 09-16 r3 #1)。 */
export const isDoneSpeech = (text: string): boolean => (text.trimEnd().split('\n').pop() || '').trim() === 'DONE';

/** 本次群聊 run 的真实 token 累计(usage 事件的 total + 终态 tokens_total 用)。 */
// cost/limit 挂在 meter 上随处可达:usage 事件要带「本 run 累计成本+上限」(H3 成本闸可见,与 agentLoop 同口径)。
// meter.cost 计入 host 总结轮,与 round 级 costTotal(执法口径)最多差最后一轮总结——展示口径,可接受。
interface Meter { tokens: number; cost: number; limit: number }

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
    // 保序去重:重复 slug(TUI `/groupchat a a`)会让 done.size 永远追不上 participants.length → 周期边界取不到发言人(Codex 09-16 r3 #2)。
    const slugs: string[] = [...new Set<string>(Array.isArray(p.agentConfig.groupAgents) ? p.agentConfig.groupAgents.map(String) : [])];
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
    // 播种源缺省是本会话;私聊里「拉起群聊」建的独立团队首个 run 可指定 groupSeedSessionId = 那条私聊(拍板 ⑬:私聊摘要播种进团队首会话)。
    // 这是 run 事实(客户端只在首条消息带一次,不落库);只能指向同一用户的会话 —— 由 buildHistorySeed 只读消息表、不改任何东西兜住。
    let seedFrom = typeof p.agentConfig.groupSeedSessionId === 'string' && p.agentConfig.groupSeedSessionId ? p.agentConfig.groupSeedSessionId : sessionId;
    if (seedFrom !== sessionId) {
      // 越权红线:播种源必须是同一用户的会话(否则任何人填个 UUID 就能把别人的对话喂给模型、还往那条会话写压缩检查点)。校验失败整条 run 拒绝,不静默回退。
      const owner = await state.getSessionOwner(seedFrom).catch(() => null);
      if (owner !== userId) {
        await publish(runId, 'error', { error: 'seed_session_forbidden' });
        await drain(runId);
        await updateRunStatus(runId, 'failed', { error: 'seed_session_forbidden' });
        return;
      }
    }
    const seedEntry = p.agentConfig.groupSeedHistory !== false
      ? await buildHistorySeed(seedFrom, modelId, p.appId).catch(() => null)
      : null;

    // ② 用户消息落库(group 分支早于 runLoop 的 insertUserMessage 点,故此处补上)
    if (p.userMessageId && p.message) {
      await state.insertUserMessage({
        id: p.userMessageId, sessionId, content: String(p.message), modelId,
        attachments: Array.isArray(p.attachments) && p.attachments.length ? p.attachments : null,
      }).catch(() => {});
    }

    const maxRounds = roundCap(p.agentConfig.groupMaxRounds);
    const roster = participants.map((a) => `- ${a.name}(${a.slug})：${a.description || '——'}`).join('\n');

    // ③ 每 agent 私有持久上下文 + 已读指针(seen[slug] = transcript 中已注入到该 agent 的条数)
    // deferred 工具目录段(P0-2):群聊发言人与主 loop 同款按需装载——目录进各自 system,
    // load_tools 解锁(per-turn,见 runGroupTurn)。不注入则 deferred 工具被静默砍掉。
    const groupDeferred = listDeferredTools({
      userId: p.userId, sessionId, appId: p.appId, profile: p.profile, execMode: p.execMode, cwd: p.cwd,
    });
    const deferSection = groupDeferred.length
      ? '\n\n## Additional Tools (load on demand)\nThese tools exist but are not loaded yet. When needed, FIRST call `load_tools` with the exact names, wait for the result, then call them normally.\n' +
        groupDeferred.map((d) => `- ${d.name}: ${d.hint}`).join('\n')
      : '';
    const ctxByAgent = new Map<string, ChatMessage[]>();
    const seen = new Map<string, number>();
    for (const a of participants) {
    // 群聊发言人与子代理同理:同一个 cwd、同一套文件工具 → 项目约定必须在场(codex)。
    const groupProjectDoc = p.execMode === 'host' ? ((s) => (s ? '\n\n---\n' + s : ''))(projectDocSection(p.cwd)) : '';
      // 独立团队:TEAM.md(全员共识、逐字不变 → 前缀缓存友好)+ 本成员的 role,显式注入 system;PROJECT_DOC_FILENAMES 是封闭白名单,
      // 工作目录里放 TEAM.md 不会被自动读到。项目轨道的团队模式两者都空。
      const role = p.agentConfig.teamRoles && typeof p.agentConfig.teamRoles === 'object' ? String(p.agentConfig.teamRoles[a.slug] || '') : '';
      const teamDoc = [typeof p.agentConfig.teamDoc === 'string' && p.agentConfig.teamDoc.trim() ? '## Team\n' + p.agentConfig.teamDoc.trim() : '', role ? `## Your role\n${role}` : '']
        .filter(Boolean).join('\n\n') || undefined;
      ctxByAgent.set(a.slug, [{ role: 'system', content: buildGroupSystem(a, roster, teamDoc) + deferSection + groupProjectDoc } as ChatMessage]);
      seen.set(a.slug, 0);
    }
    const transcript: TranscriptEntry[] = [
      ...(seedEntry ? [seedEntry] : []),
      { round: 0, slug: USER_SLUG, name: 'User', text: String(p.message) },
    ];

    let costTotal = 0;
    const runCostLimit = runCostCeiling();
    const meter: Meter = { tokens: 0, cost: 0, limit: runCostLimit };
    let stopReason = 'max_rounds';
    let roundsRun = 0;

    const bySlug = new Map(participants.map((a) => [a.slug, a]));
    let lastMessageId: string | undefined;
    let steps = 0;

    // 发言人边界:先消费用户插话(落库 + 进 transcript + 通知前端离开等待区),再给本发言人算 delta。
    // 只在边界注入、不打断正在跑的发言(不提供 expediteSteer)。返回条数(据此让全员重新回应)。
    const drainUserSteer = async (round: number): Promise<number> => {
      const steered = p.drainSteer?.() ?? [];
      if (!steered.length) return 0;
      for (const m of steered) {
        await state.insertUserMessage({
          id: m.id, sessionId, content: m.content, modelId,
          attachments: Array.isArray(m.attachments) && m.attachments.length ? m.attachments : null,
        }).catch(() => {});
        transcript.push({ round, slug: USER_SLUG, name: 'User', text: m.content });
      }
      await publish(runId, 'turn_boundary', {
        finalizedAssistantId: lastMessageId, userMessages: steered.map((m) => ({ id: m.id, content: m.content })),
      });
      return steered.length;
    };

    /** 一位成员发言一次(= 一步)。返回发言文本;stop 非空 = 整场要停(额度/成本)。 */
    const speak = async (agent: NormalAgentDef, round: number): Promise<{ text: string; stop?: string }> => {
      // 本发言人的记忆作用域:其 remember/log_event 落到自己的 agent 文件夹(顺序执行,enterWith 即时生效)。
      // 展示身份必须带上发言人自己:shareDefaultMemory 的参与者记忆域是 xyra,不传第 4 参 manage_agent/manage_harness 就把它
      // 当成「别人」—— 能改自己的人格、能给自己调低轮数;主 loop 一直是传 activeAgentSlug 的(Codex 09-13 #2)。
      enterRunContext(p.userId, p.runId, resolveMemorySlug(agent), agent.slug);
      // 额度复查(标准计费才有意义;standalone 为 noop → 恒 ok)
      const can = await deps().billing.canConsumeTokenPoints(userId, 1).catch(() => ({ ok: true } as any));
      if (!can.ok) {
        await publish(runId, 'error', { error: 'token_quota_exceeded' });
        return { text: '', stop: 'quota' };
      }
      // delta = 该 agent 上次发言以来的新条目 → 作为一条 user 消息注入它的私有上下文
      const from = seen.get(agent.slug) ?? 0;
      const ctx = ctxByAgent.get(agent.slug)!;
      ctx.push({ role: 'user', content: formatDelta(transcript.slice(from), agent.name) } as ChatMessage);
      // 持久消息 id 下发给前端,使实时气泡 id 与落库 uuid 对齐 → 轮询/重载按 id 合并不产生重复气泡。
      const messageId = uuidv4();
      steps++;
      await publish(runId, 'group_speaker', { slug: agent.slug, name: agent.name, round, step: steps, phase: 'start', messageId });
      const turn = await runGroupTurn(ctx, agent, p, meter);
      costTotal += turn.cost;
      await publish(runId, 'group_speaker', { slug: agent.slug, name: agent.name, round, step: steps, phase: 'end', messageId });
      lastMessageId = messageId;
      transcript.push({ round, slug: agent.slug, name: agent.name, text: turn.text });
      seen.set(agent.slug, transcript.length); // 含自己这条 → 下次 delta 自动排除自己
      // 每条发言 = 一条独立 model 消息(前缀发言人,reload/网页可读;agent_slug 落列供归属/头像)。复用 finalizeAssistantMessage。
      await state.finalizeAssistantMessage({
        messageId, sessionId, modelId: agent.model || modelId, agentSlug: agent.slug,
        content: `**🗣 ${agent.name}**\n\n${turn.text}`, reasoning: '', toolCalls: [], toolResults: [],
      }).catch(() => {});
      if (runCostLimit > 0 && isOverRunCost(costTotal, runCostLimit)) {
        await publish(runId, 'status', { phase: 'group_cost_limit', costTotal });
        return { text: turn.text, stop: 'cost_limit' };
      }
      return { text: turn.text };
    };

    // ── 调度(两条轨道共用,只有这一套):一「步」一位发言人;被 @ 者 FIFO → 轮转本周期未发言且未 DONE 的成员 →
    //    周期边界:全员 DONE → done 停,否则开新周期(DONE 的成员跳过)。没有投票、没有缺省轮数;
    //    maxRounds 只是显式上限(内部调用方)或兜底天花板,折算成最大步数(= 周期数 × 成员数)。
    const maxSteps = maxRounds * participants.length;
    const st: TeamState = { participants: participants.map((a) => a.slug), pending: [], cycleSpoken: new Set(), done: new Set() };
    let cycle = 1;
    stopReason = 'max_rounds';
    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) throw new AbortLikeError();
      // 用户插话先于「要不要停」:它是对全员的新输入 —— 谁的 DONE 都作废,本周期重来,大家重新回应。
      // 预算尾巴上(剩余步数不够全员各回应一次)不在这里消费:留给收尾那趟(全员各回应一次,有界),否则最后几步只够
      // 一两位回应、其余成员没见到这条插话就到顶了(Codex 09-16 r3 #3);上限本身不因插话突破。
      const injected = step + st.participants.length - 1 <= maxSteps ? await drainUserSteer(cycle) : 0;
      if (injected) { st.cycleSpoken = new Set(); st.done = new Set(); }
      let slug = teamNext(st);
      if (!slug) {
        cycle++; st.cycleSpoken = new Set();
        await publish(runId, 'group_cycle', { cycle });
        slug = teamNext(st);
        if (!slug) { stopReason = 'done'; break; } // 去重后到不了这里(全员 DONE 在下面即刻判定);守住而不是断言
      }
      roundsRun = cycle;
      const agent = bySlug.get(slug)!;
      st.done.delete(slug); // 被 @ 的 DONE 成员重新入场:这次发言重新表态
      const r = await speak(agent, cycle);
      st.cycleSpoken.add(slug);
      if (isDoneSpeech(r.text)) {
        // 写 DONE 的那条发言里的 @ 不再排队(收尾致谢式的「@某某 谢了,DONE」不该把对方重新拉回来 —— live 台架 09-16 实测两人互相致谢无限循环)。
        st.done.add(slug);
      } else {
        for (const m of parseMentions(r.text, participants, slug)) if (!st.pending.includes(m)) st.pending.push(m);
      }
      if (r.stop) { stopReason = r.stop; break; }
      // 全员 DONE 即刻判定(不等下一步的周期边界):最后一步上全员 DONE 才不会被记成 max_rounds(Codex 09-16 r3 #5)。
      if (st.done.size === st.participants.length) { stopReason = 'done'; break; }
    }

    // 收尾前再消费一次插话:最后一位发言 / 投票 / 收场判定期间进来的消息,enqueueSteer 已经答应「收到了」,
    // 不能在 finally 清队列时直接丢掉 —— 有就再让全员回应一遍(有界:一趟),然后把趟内又来的持久化进对话。
    if (!signal.aborted && stopReason !== 'quota' && stopReason !== 'cost_limit') {
      const late = await drainUserSteer(roundsRun);
      if (late > 0) {
        for (const agent of participants) {
          if (signal.aborted) throw new AbortLikeError();
          const r = await speak(agent, roundsRun);
          if (r.stop) { stopReason = r.stop; break; }
        }
        await drainUserSteer(roundsRun);
      }
    }

    await publish(runId, 'group_ended', {
      rounds: roundsRun, reason: stopReason, steps,
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
  const { runId, sessionId, appId, execMode, cwd, extraRoots, profile, signal } = p;
  const llm = deps().brain.llm;
  const effModelId = agent.model || p.modelId;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(effModelId);
  const approvalMode: ApprovalMode =
    agent.approvalMode || (execMode === 'host' ? 'auto-edit' : 'full-auto');

  // deferred 解锁:per-turn 空集起步(与主 loop 的 per-run 同构,粒度更小;turn 内 load_tools 后下一迭代生效)。
  const turnUnlocked = new Set<string>();
  let turnDefsDirty = false;
  const toolCtx: ToolContext = {
    userId: p.userId, sessionId, appId, runId, signal,
    execMode, cwd, extraRoots, approvalMode, profile, hostSandbox: execMode === 'host' ? resolveHostSandboxPolicy() : undefined, modelId: effModelId, planMode: false, muse: false,
    wsProject: p.wsProject,
    // 群聊发言人不可再起讨论(start_discussion/wait_discussion 隐藏)——防递归裂变。
    inDiscussion: true,
    unlockedTools: turnUnlocked,
    unlockTools: (names) => {
      let changed = false;
      for (const n of names) if (!turnUnlocked.has(n)) { turnUnlocked.add(n); changed = true; }
      if (changed) turnDefsDirty = true;
    },
    // ponytail: v1 群聊每 agent 用内置工具集(读/写/执行已够「完整工具」);custom/MCP per-agent 暂不接,
    // 需要时按 agent.tools 走 loadCustomTools 即可补上。
  };
  let toolDefs = getToolDefinitions(toolCtx);
  const maxIter = Math.min(agentCapOf(agent) || GROUP_TURN_MAX_ITER, GROUP_TURN_MAX_ITER); // 低于下限的定义值按未设(与主 loop 同口径)

  let text = '';
  let cost = 0;
  for (let iteration = 0; iteration < maxIter; iteration++) {
    if (signal.aborted) throw new AbortLikeError();
    if (turnDefsDirty) { toolDefs = getToolDefinitions(toolCtx); turnDefsDirty = false; } // load_tools 解锁生效
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
      const decision = await gateToolCall(runId, call, { sessionId, execMode, approvalMode, cwd, extraRoots }, signal);
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
  meter.cost += cost;
  await publish(p.runId, 'usage', { prompt: promptT, completion: compT, cached, cost, total: meter.tokens, costTotal: meter.cost, costLimit: meter.limit, agentId: agentSlug }).catch(() => {});
  return cost;
}

/** 显式 groupMaxRounds(内部调用方:讨论 / Historian 辅助)钳 1..MAX;没传 = 兜底天花板本身,不是缺省上限。 */
function roundCap(v: any): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return MAX_GROUP_ROUNDS;
  return Math.min(n, MAX_GROUP_ROUNDS);
}

const THINK_LEVELS: readonly string[] = THINKING_LEVELS;
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

function buildGroupSystem(agent: NormalAgentDef, roster: string, teamDoc?: string): string {
  return (
    (agent.systemPrompt ? agent.systemPrompt.trim() + '\n\n' : '') +
    (agent.soul && agent.soul.trim() ? '## Persona\n' + agent.soul.trim() + '\n\n' : '') +
    '## Group Chat Mode\n' +
    'You are participating in a multi-agent group discussion. Members present:\n' +
    roster +
    '\n\n' +
    `You are "${agent.name}". Rules:\n` +
    "- Each time you first see other members' new remarks, then it is your turn. Give **your own** view based on the whole discussion: you may agree, challenge, add to, or propose something new, but keep your professional perspective and persona — do not blindly agree.\n" +
    '- Address a member with @<name>; quote their words with a markdown blockquote (starting with >). The member you @-mention speaks next.\n' +
    '- Be concise and well-grounded; address the issue, not the person. Use tools (read files/search/run, etc.) to support your view when needed, but your remark is the deliverable.\n' +
    '- After every remark, decide for yourself whether you still need to speak. If your part is finished and nobody else needs to act, end the remark with DONE on its own line as the last line — you then stay silent unless a member @-mentions you or the user speaks again. Otherwise leave DONE out (and @-mention whoever should act next). The discussion ends once every member has ended with DONE; there is no round limit and no vote.' +
    (teamDoc ? '\n\n' + teamDoc : '')
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
