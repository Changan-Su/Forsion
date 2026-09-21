/**
 * 团队运行模式(原「群聊」)编排:用户选 ≥2 个 Normal Agent,发一条消息后成员**各自在自己的工作会话里并行干活**,
 * 团队会话只是协调层(用户与成员、成员之间的「发言」落在这里)。09-16 第四轮(用户拍板 ⑭–㉓)。
 *
 * 设计要点:
 *   - 团队会话的 run(本函数)= 协调器,一条事件流;成员的实际工作 = 各自一条后台工作会话(kind='teamwork',父链接 = 团队会话,
 *     一人一条跨 run 复用 = 私有持久上下文)里的子 run(services/teamRuns.ts;走 agentLoop 完整主循环)。
 *   - 每次激活只注入「它上次之后团队里新说的话」delta(formatDelta),主动发言与最终报告按到达顺序抄回团队会话(`**🗣 name**` 消息 +
 *     group_speaker start/end,end 带 text —— 主聊天不再逐 token 流,过程在成员自己的流里,从 Pin Summary 成员行展开)。
 *   - 调度只有一套(teamDue,纯函数):全员起头(拍板 ⑮)+ 用户消息里的 @ 与 priorityAgent 先起;被 @ 者 FIFO 优先;
 *     并发上限 TEAM_MAX_CONCURRENT(内部调用方传 groupMaxConcurrent:1 即退化成旧的顺序交替,拍板 ⑯);
 *     成员发言末尾自己决定还聊不聊(最后一个非空行 DONE = 我这边完了,之后不再轮到它,除非被 @ 或用户再开口);
 *     周期边界 = 没人在跑也没人能起 → 全员 DONE 则停,否则新周期(未 DONE 的成员并行再来一轮)。没有投票、没有缺省轮数。
 *     上界:显式 groupMaxRounds(内部调用方)或 MAX_GROUP_ROUNDS 天花板 × 成员数 = 最大激活次数、团队成本天花板(子 run 用量求和,
 *     = 单 run 上限 × 成员数)、额度、用户中止(级联中止子 run)。
 *   - 子 run 的审批 / 询问转发到团队 run 的流上(带子 runId 与 messageId):用户在主聊天就能批,不必点开 Team Desk。
 *   - 用户插话:立刻落库 + 进 transcript + turn_boundary;全员 DONE 作废;空闲成员立刻再起,跑着的下次激活看到。
 *   - 成员可用 team_say 随时发言;收尾由本会话固定 Historian 生成底部摘要附件,不询问用户。
 *   - 仅 standalone/desktop(host)形态触达(由 agentLoop 的 groupChat 闸门把守)。
 *
 * 不从 ./agentLoop import(agentLoop import 本模块 → 避免循环);所需 brain/billing/state 直接走 deps(),steer / abort 经参数借入。
 */
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import type { StreamResult } from '../seams/cloudBrain.js';
import { THINKING_LEVELS } from '../llm/modelCapabilities.js';
import type { AppProfile } from '../seams/appProfile.js';
import { publish, drain, type AgentEvent } from './eventBus.js';
import { updateRunStatus } from './runStore.js';
import { completeHistorianTask } from './historianSession.js';
import { loadSpecialAgentsConfig, resolveBackgroundModelId } from './specialAgentsConfig.js';
import { getAgent, type NormalAgentDef } from '../agents/agentRegistry.js';
import { runCostCeiling, isOverRunCost } from './runBudget.js';
import { compactSession, getLatestSummary } from './compaction.js';
import { activateMember as realActivateMember, type ActivateMember, type MemberOutcome } from './teamRuns.js';
import { TEAM_OUTPUT_MODE, teamOutputCollector, teamOutputRecord } from './teamOutputs.js';

/** 兜底天花板(周期数;每周期 = 还想聊的成员各说一次)。不是缺省上限:没传 groupMaxRounds 时团队只靠成员自己的 DONE 收场,这里只防失控。 */
const MAX_GROUP_ROUNDS = 30;
/** 同时在跑的成员激活数上限(拍板 ⑱);内部调用方传 groupMaxConcurrent:1 = 顺序交替。环境变量 TANGU_TEAM_CONCURRENCY 可调。 */
const TEAM_MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.TANGU_TEAM_CONCURRENCY)) || 3);
const SPEECH_CAP = 16_000;

export const HOST_SLUG = '__host__';
const USER_SLUG = '__user__';
export const TEAM_SUMMARY_PREFIX = '**📋 Historian**\n\n';
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
  /** 本团队 run 的审批档来自团队会话设置(agentLoop 判定):成员子 run 审批时现读团队会话此刻的档。 */
  followSessionMode?: boolean;
  message: string;
  userMessageId?: string;
  attachments?: any[];
  signal: AbortSignal;
  /** 由 agentLoop 注入(本模块不 import agentLoop):取出本 run 已排队的用户插话。缺省 = 没有插话通道(与旧行为一致)。 */
  drainSteer?: () => Array<{ id: string; content: string; attachments?: any[] }>;
  /** 由 agentLoop 注入:下一条插话到达即 resolve(团队 run 在等子 run 时据此被唤醒)。缺省 = 只在调度点拉取。 */
  waitSteer?: () => Promise<void>;
  /** 由 agentLoop 注入:中止一个子 run(成本 / 额度停机时级联)。 */
  abortChild?: (runId: string) => void;
  /** 由 agentLoop 注入:调度结束后关掉本 run 的插话入口(enqueueSteer 返回 false → 客户端回退起新 run 排队),否则总结阶段收到的插话没人消费、收尾时被丢掉。 */
  closeSteer?: () => void;
  /** 成员激活载体;缺省 = teamRuns.activateMember(子会话 + 子 run)。单测注入假实现只验调度。 */
  activateMember?: ActivateMember;
}

export interface TranscriptEntry { round: number; slug: string; name: string; text: string }

export interface TeamState {
  participants: string[];
  /** 被 @ 的成员 FIFO(含已表态 DONE 的:被点名即重新入场;正在跑的留在队里,它下次激活的 delta 里自然有这条点名)。 */
  pending: string[];
  /** 本周期已经激活过的成员。 */
  cycleSpoken: Set<string>;
  /** 已表态 DONE 的成员:轮转时跳过,直到被 @ 或用户再开口。 */
  done: Set<string>;
  /** 正在跑的成员(同一成员同一时刻只有一次激活)。 */
  running: Set<string>;
}
/**
 * 现在该起哪些成员(纯函数,可测):被 @ 者 FIFO(已不在场的点名丢弃;正在跑的留队)→ 本周期未激活且未 DONE 的成员按序轮转,
 * 总数不超过 cap − 正在跑的。返回空且没人在跑 = 周期边界。cap=1 时逐字等于旧的 teamNext 顺序。
 */
export function teamDue(st: TeamState, cap: number): string[] {
  const out: string[] = [];
  const free = (): number => cap - st.running.size - out.length;
  st.pending = st.pending.filter((s) => st.participants.includes(s));
  for (const s of [...st.pending]) {
    if (free() <= 0) break;
    if (st.running.has(s) || out.includes(s)) continue;
    out.push(s);
    st.pending.splice(st.pending.indexOf(s), 1);
  }
  for (const s of st.participants) {
    if (free() <= 0) break;
    if (st.running.has(s) || out.includes(s) || st.cycleSpoken.has(s) || st.done.has(s)) continue;
    out.push(s);
  }
  return out;
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
/**
 * DONE 只看发言的最后一个非空行(约定:独占一行、写在末尾;正文中间 / 代码块里的 DONE 不算,Codex 09-16 r3 #1)。
 * 模型常把 DONE 缀在最后一句的句尾(live 09-16 第四轮实测:「@Alpha:确认,口号为“…”。 DONE」被判「没完」→ 两人互相点名跑满 60 步),
 * 所以行尾的 DONE 也认;「NOT DONE」「done」不算。宁可早停一位成员(被 @ / 用户开口即回来),不可整场空转到天花板。
 * 09-20:中文句子和 DONE 之间没有空格(「…并行配合。DONE」),旧的 `(?:^|\s)` 前置判不出来 → 中文团队永远不收场,
 * 成员被逐周期唤醒、每次把「我在待命」换个说法再说一遍(live 实测 20 轮)。改判据为「DONE 前不是拉丁字母 / 数字」,
 * 这样 UNDONE / predone 仍不算,中英文的句尾 DONE 都算。
 */
export const isDoneSpeech = (text: string): boolean => {
  const last = (text.trimEnd().split('\n').pop() || '').trim();
  if (last === 'DONE') return true;
  return /(?<![A-Za-z0-9_-])DONE[.。!！]?$/.test(last) && !/(?:\bnot\s+|[未没不][^\p{L}\p{N}]*)DONE[.。!！]?$/iu.test(last);
};

/**
 * 一次激活内「同一件事说两遍」的判据(09-20 修:成员先 team_say 广播一遍,最终答复又被抄回一遍 —— 提示词三处写了「别重复」仍每轮复发)。
 * 问的不是「两段话像不像」,而是**这条新发言有没有带来新东西**:把文本归一化成「CJK 单字 + 拉丁词」的记号流
 * (去代码块 / markdown 装饰 / 标点 / 末尾 DONE),看它的记号二元组有多少比例已经在本次激活已广播的内容里。
 * 非对称是关键:`team_say("API 修复完成")` 之后最终答复写「API 修复完成;补丁在 x.diff,@Beta 请合入」覆盖率只有 0.11
 * —— 对称的相似度(Dice / 包含即 1)会把这种「重复开头 + 真报告」整条吞掉(Codex 评审 #1)。
 */
export function speechTokens(text: string): string[] {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/(?:^|\s)DONE[.。!！]?\s*$/i, ' ')
    .toLowerCase();
  return flat.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || [];
}
function speechGrams(t: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < t.length; i++) { const g = t[i] + ' ' + t[i + 1]; m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
/**
 * `text` 里有多大比例的内容已经在 `posted`(本次激活已广播的记号流,取并集)里说过。0 = 全是新的,1 = 一点新东西都没有。
 * 切不出记号(纯代码块 / 纯 emoji / 一两个字)一律返回 0:宁可重复,不可把交付吞掉(Codex 评审 #6)。
 */
export function speechCoverage(posted: readonly (readonly string[])[], text: string): number {
  const tn = speechTokens(text);
  if (tn.length < 2 || !posted.length) return 0;
  const prev = new Map<string, number>();
  for (const p of posted) for (const [g, n] of speechGrams(p)) prev.set(g, Math.max(prev.get(g) || 0, n));
  if (!prev.size) return 0;
  let covered = 0, total = 0;
  for (const [g, n] of speechGrams(tn)) { total += n; const m = prev.get(g); if (m) covered += Math.min(n, m); }
  return total ? covered / total : 0;
}
/**
 * 阈值按真实语料标定(生产会话 7d8ed746 的 6 对「先 team_say 再最终答复」重复,覆盖率 0.23–1.00;
 * 「先报进度 / 重复开头,再交真报告」这类必须都发出去的负例实测 ≤0.12)。落在两者之间,宁可吞掉一点新东西都没有的那条
 * —— 内容读者已经看过,且成员的完整答复照常留在它自己的工作会话里(Team Desk 可看)。
 */
const SPEECH_DEDUP = 0.2;
/**
 * 本次激活里已经广播过的内容有没有把这条说完。`posted` 存**记号数组**(广播时切一次)——
 * 一次激活可能广播十几条、每条上限 16000 字,每次判重都重切一遍是白烧(Codex 评审 #7)。
 */
export const isRepeatSpeech = (text: string, posted: readonly (readonly string[])[]): boolean =>
  speechCoverage(posted, text) >= SPEECH_DEDUP;

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
    // ⓪ 载体是本地库 + 进程内事件总线(子会话 query()、子 run subscribe()):thin worker / 云端形态没有这两样,
    //    与其成员逐个失败或挂到超时,不如明确拒绝(Codex 09-16 r4 #2)。start_discussion / Historian 辅助本就 host-only。
    if (!p.profile.capabilities.hostExec) {
      await publish(runId, 'error', { error: 'team_mode_requires_local_engine', detail: 'Team mode runs members in local background sessions; it is not available on this engine.' });
      await drain(runId);
      await updateRunStatus(runId, 'failed', { error: 'team_mode_requires_local_engine' });
      return;
    }
    // ① 载入参与者:groupAgents 是有序 slug 列表(已存 Normal Agent + 临时 Agent 混合);
    // 临时 Agent 定义随会话 agentConfig.groupTempAgents 传来(不落 ~/.tangu/agents,仅本会话用),按 slug 优先命中。
    // 载入后套一层会话级调档(teamMemberConfigs):配队面板里给某成员换模型 / 调 Effort 只改本会话,不动 Agent 定义。
    // 保序去重:重复 slug(TUI `/groupchat a a`)会让 done.size 永远追不上 participants.length → 周期边界取不到发言人(Codex 09-16 r3 #2)。
    const slugs: string[] = [...new Set<string>(Array.isArray(p.agentConfig.groupAgents) ? p.agentConfig.groupAgents.map(String) : [])];
    const tempBySlug = new Map(sanitizeTempAgents(p.agentConfig.groupTempAgents).map((a) => [a.slug, a]));
    const loaded = await Promise.all(slugs.map(async (s) => tempBySlug.get(s) || (await getAgent(s).catch(() => null))));
    const participants = tuneMembers(loaded.filter((a): a is NormalAgentDef => !!a), p.agentConfig.teamMemberConfigs);
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

    // ③ 已读指针(seen[slug] = transcript 中已注入到该成员的条数);成员的私有上下文住在各自的工作会话里(teamRuns.ts),这里不再持有。
    const seen = new Map<string, number>();
    for (const a of participants) seen.set(a.slug, 0);
    const teamDocFor = (a: NormalAgentDef): string | undefined => {
      // 独立团队:TEAM.md(全员共识、逐字不变 → 前缀缓存友好)+ 本成员的 role;项目轨道的团队模式两者都空。
      const role = p.agentConfig.teamRoles && typeof p.agentConfig.teamRoles === 'object' ? String(p.agentConfig.teamRoles[a.slug] || '') : '';
      return [typeof p.agentConfig.teamDoc === 'string' && p.agentConfig.teamDoc.trim() ? '## Team\n' + p.agentConfig.teamDoc.trim() : '', role ? `## Your role\n${role}` : '']
        .filter(Boolean).join('\n\n') || undefined;
    };
    const transcript: TranscriptEntry[] = [
      ...(seedEntry ? [seedEntry] : []),
      { round: 0, slug: USER_SLUG, name: 'User', text: String(p.message) },
    ];

    const runCostLimit = runCostCeiling();
    // 团队成本天花板 = 单 run 上限 × 成员数(拍板 ⑱;子 run 各自还受主循环的单 run 上限)。0 = 关。
    const teamCostLimit = runCostLimit > 0 ? runCostLimit * participants.length : 0;
    const meter: Meter = { tokens: 0, cost: 0, limit: teamCostLimit };
    let stopReason = 'max_rounds';
    let roundsRun = 1;

    const bySlug = new Map(participants.map((a) => [a.slug, a]));
    await publish(runId, TEAM_OUTPUT_MODE, { version: 1 });
    const inlineSlugs = new Set(tempBySlug.keys());
    let lastMessageId: string | undefined;
    let steps = 0;
    const activate = p.activateMember ?? realActivateMember;
    const approvalMode = typeof p.agentConfig.approvalMode === 'string' ? p.agentConfig.approvalMode : undefined;

    let speechQueue: Promise<void> = Promise.resolve();
    let speechFailure: unknown;
    let wakeSpeech: (() => void) | undefined;
    let lastTimestamp = Date.now();
    const nextTimestamp = (): number => (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));
    const enqueueTranscript = (action: () => Promise<void>): Promise<void> => {
      speechQueue = speechQueue.then(() => {
        if (speechFailure) throw speechFailure;
        return action();
      }).catch((e) => { speechFailure = e; wakeSpeech?.(); });
      return speechQueue;
    };

    // 用户插话:立刻落库 + 进 transcript + 通知前端离开等待区。返回条数(据此让全员 DONE 作废、空闲成员再起)。
    const drainUserSteer = async (round: number): Promise<number> => {
      const steered = p.drainSteer?.() ?? [];
      if (!steered.length) return 0;
      await enqueueTranscript(async () => {
        for (const m of steered) {
          await state.insertUserMessage({
            id: m.id, sessionId, content: m.content, modelId, timestamp: nextTimestamp(),
            attachments: Array.isArray(m.attachments) && m.attachments.length ? m.attachments : null,
          });
          transcript.push({ round, slug: USER_SLUG, name: 'User', text: m.content });
        }
        await publish(runId, 'turn_boundary', {
          finalizedAssistantId: lastMessageId, userMessages: steered.map((m) => ({ id: m.id, content: m.content })),
        });
      });
      if (speechFailure) throw speechFailure;
      return steered.length;
    };

    type Settled = { slug: string; cycle: number; messageId: string; outcome: MemberOutcome; posted: string[][] };
    const childRuns = new Map<string, string>(); // slug → 正在跑的子 runId(级联中止用)
    const abortInFlight = (): void => { for (const id of childRuns.values()) p.abortChild?.(id); };
    // 团队成本天花板是硬上限:用量事件一越线就停止新激活并级联中止在跑的成员(不等某个子 run 自然结束才在 settle 里判;Codex 09-16 r4 #7)。
    let costExceeded = false;
    const trackCost = (): void => {
      if (costExceeded || !(teamCostLimit > 0) || !isOverRunCost(meter.cost, teamCostLimit)) return;
      costExceeded = true;
      void publish(runId, 'status', { phase: 'group_cost_limit', costTotal: meter.cost });
      abortInFlight();
    };

    // Serialize public remarks (including final reports): publication and persistence share one order.
    const postSpeech = (agent: NormalAgentDef, text: string, round: number, messageId = uuidv4(), requestReply = true): Promise<void> => {
      return enqueueTranscript(async () => {
        signal.throwIfAborted();
        const base = { slug: agent.slug, name: agent.name, round, messageId };
        await state.finalizeAssistantMessage({
          messageId, sessionId, modelId: agent.model || modelId, agentSlug: agent.slug, timestamp: nextTimestamp(),
          content: `**🗣 ${agent.name}**\n\n${text}`, reasoning: '', toolCalls: [], toolResults: [],
        });
        await publish(runId, 'group_speaker', { ...base, phase: 'start' });
        // Older discussion panels consume tokens; clients rendering end.text must ignore this mirror.
        await publish(runId, 'token', { delta: text, agentId: agent.slug, publicSpeech: true });
        await publish(runId, 'group_speaker', { ...base, phase: 'end', text });
        lastMessageId = messageId;
        transcript.push({ round, slug: agent.slug, name: agent.name, text });
        if (requestReply && !isDoneSpeech(text)) {
          for (const m of parseMentions(text, participants, agent.slug)) if (!st.pending.includes(m)) st.pending.push(m);
        }
        wakeSpeech?.();
      });
    };

    // 子 run 事件转发:审批 / 询问带上子 runId 与本次发言的 messageId(桌面在主聊天里就地批,不必点开 Team Desk);
    // 工具活动压成一行 team_activity(卡片那一行动态);用量并进团队计量(团队天花板据此判)。
    const forward = (agent: NormalAgentDef, messageId: string, cycle: number, childRunId: () => string | undefined, posted: string[][]) => (ev: AgentEvent): void => {
      const pl = ev.payload || {};
      const t = ev.type;
      const tag = { agentSlug: agent.slug, agentName: agent.name, messageId, runId: childRunId() };
      if (t === 'team_speech' && typeof pl.text === 'string' && pl.text.trim()) {
        const said = pl.text.trim().slice(0, SPEECH_CAP);
        // 同一次激活里把同一件事再广播一遍 = 噪音(模型偶尔 team_say 两次同样的话)。
        if (!isRepeatSpeech(said, posted)) { posted.push(speechTokens(said)); void postSpeech(agent, said, cycle, undefined, pl.requestReply === true); }
      } else if (t === 'desk_capture_request') {
        void publish(runId, t, { ...pl, runId: childRunId() });
      } else if (t === 'desk_present') {
        void publish(runId, t, pl);
      } else if (t === 'approval_request' || t === 'approval_result' || t === 'inquiry_request' || t === 'inquiry_result') {
        void publish(runId, t, { ...pl, ...tag });
      } else if (t === 'tool_call') {
        void publish(runId, 'team_activity', { slug: agent.slug, name: agent.name, messageId, tool: String(pl.name || ''), argsPreview: String(pl.arguments || '').slice(0, 160) });
      } else if (t === 'usage') {
        const promptT = Number(pl.prompt) || 0; const compT = Number(pl.completion) || 0; const cost = Number(pl.cost) || 0;
        meter.tokens += promptT + compT; meter.cost += cost;
        void publish(runId, 'usage', { prompt: promptT, completion: compT, cached: Number(pl.cached) || 0, cost, total: meter.tokens, costTotal: meter.cost, costLimit: meter.limit, agentId: agent.slug });
        trackCost();
      }
    };

    /**
     * 这位成员有没有「别人说的新话」要读。没有就不该被唤醒:成员的活只在一次激活里干完,两次激活之间它没有后台进展,
     * 醒来只能把上一轮换个说法再说一遍(09-20 live 实证:中文团队里一位成员被逐周期唤醒 20 次,每次重述「我在待命」)。
     * 「不写 DONE = 还想聊」照旧 —— 队友或用户一开口它就回来,只是不再被叫醒对着空气说话。
     */
    const hasNewsFor = (slug: string): boolean => transcript.slice(seen.get(slug) ?? 0).some((t) => t.slug !== slug);

    /** 起一次激活(不 await):算 delta、推进已读指针、起子 run。返回 settle 后的结果,绝不 reject。 */
    const launch = (slug: string, cycle: number): Promise<Settled> => {
      const agent = bySlug.get(slug)!;
      const from = seen.get(slug) ?? 0;
      // 自己的发言不回灌(它住在自己的工作会话里;并行下自己那条会在起了之后才进 transcript,靠指针排不掉)。
      const unread = transcript.slice(from).filter((t) => t.slug !== slug);
      const delta = formatDelta(unread, agent.name);
      seen.set(slug, transcript.length); // 起了就算读过:之后的新话留给下次激活
      const messageId = uuidv4();
      let childId: string | undefined;
      let collectOutput: ReturnType<typeof teamOutputCollector> | undefined;
      // 本次激活已经广播出去的内容(team_say 逐条进,存记号):最终答复据此去重。
      const posted: string[][] = [];
      const forwardEvent = forward(agent, messageId, cycle, () => childId, posted);
      const task = unread.filter((t) => t.slug !== CONTEXT_SLUG).map((t) => t.text).join(' ').replace(/\s+/g, ' ').slice(0, 160);
      const run = activate({
        teamRunId: runId, teamSessionId: sessionId, userId, appId: p.appId, modelId,
        member: agent, inlineDef: inlineSlugs.has(slug), delta, cycle, roster, teamDoc: teamDocFor(agent),
        execMode: p.execMode, cwd: p.cwd, extraRoots: p.extraRoots, wsProject: p.wsProject, approvalMode, followSessionMode: p.followSessionMode, signal,
        onStarted: (ids) => {
          childId = ids.runId; childRuns.set(slug, ids.runId);
          collectOutput = teamOutputCollector({ ...ids, slug, name: agent.name, modelId: agent.model || modelId });
          void publish(runId, 'team_member', { slug, name: agent.name, phase: 'start', messageId, cycle, sessionId: ids.sessionId, runId: ids.runId, task });
        },
        onEvent: (ev) => {
          const output = collectOutput?.(ev);
          if (output) void enqueueTranscript(async () => {
            const timestamp = nextTimestamp();
            await state.finalizeAssistantMessage({ ...output, sessionId, reasoning: '', timestamp });
            await publish(runId, 'team_output', { message: teamOutputRecord(output, timestamp) });
          });
          forwardEvent(ev);
        },
      }).catch((err: any): MemberOutcome => ({ status: signal.aborted ? 'aborted' : 'failed', text: '', error: err?.message || String(err) }));
      return run.then((outcome) => { childRuns.delete(slug); return { slug, cycle, messageId, outcome, posted }; });
    };

    /** 一次激活收场:发言抄回团队会话(消息 + 事件 + transcript),DONE / @ 记账。返回 true = 整场要停(成本)。 */
    const settle = async (r: Settled): Promise<boolean> => {
      const agent = bySlug.get(r.slug)!;
      steps++;
      // 本次激活排队中的 team_say 必须先落定(它会往 transcript / st.pending 里写):否则失败 / 中止分支会在
      // 「@某某 接手」还没入队时就按全员 DONE 收场,那条点名永远没人接(Codex 评审 #4)。
      await speechQueue;
      if (speechFailure) throw speechFailure;
      const base = { slug: r.slug, name: agent.name, round: r.cycle, step: steps, messageId: r.messageId };
      if (r.outcome.status === 'done') {
        const text = r.outcome.text.trim().slice(0, SPEECH_CAP);
        // A bare completion marker or empty turn has no public content. Keep it in the member status.
        // 已经 team_say 过同一件事的最终答复同样不抄回(DONE 记账照常走,完整答复留在成员自己的工作会话里)。
        const spoke = !!text && !/^DONE[.。!！]?$/.test(text) && !isRepeatSpeech(text, r.posted);
        if (spoke) await postSpeech(agent, text, r.cycle, r.messageId);
        else await speechQueue;
        if (speechFailure) throw speechFailure;
        await publish(runId, 'team_member', { ...base, phase: 'end', reason: 'done', sessionId: r.outcome.sessionId, runId: r.outcome.runId });
        if (isDoneSpeech(text)) {
          // 写 DONE 的那条发言里的 @ 不再排队(收尾致谢式的「@某某 谢了,DONE」不该把对方重新拉回来 —— live 台架 09-16 实测两人互相致谢无限循环)。
          st.done.add(r.slug);
        } else if (spoke) {
          // 没广播出去的那份(与已发言重复)里的 @ 也不排队:被点名的人在 delta 里根本看不到这段话。
          for (const m of parseMentions(text, participants, r.slug)) if (!st.pending.includes(m)) st.pending.push(m);
        }
      } else if (r.outcome.status === 'aborted') {
        await publish(runId, 'team_member', { ...base, phase: 'end', reason: 'aborted', sessionId: r.outcome.sessionId, runId: r.outcome.runId });
      } else {
        // 失败的成员按 DONE 记(否则每个周期反复失败地重起);队友在 transcript 里看得到,被 @ 或用户开口才再试。
        const text = `(activation failed: ${r.outcome.error || 'unknown error'})`;
        transcript.push({ round: r.cycle, slug: r.slug, name: agent.name, text });
        st.done.add(r.slug);
        await publish(runId, 'team_member', { ...base, phase: 'end', reason: 'failed', error: r.outcome.error, sessionId: r.outcome.sessionId, runId: r.outcome.runId });
      }
      trackCost();
      return costExceeded;
    };

    // ── 调度(只有这一套):全员起头,被 @ 者优先,并发上限内能起就起;周期边界 = 没人在跑也没人能起。──
    const cap = concurrencyCap(p.agentConfig.groupMaxConcurrent, participants.length);
    const maxActivations = maxRounds * participants.length;
    const st: TeamState = { participants: participants.map((a) => a.slug), pending: [], cycleSpoken: new Set(), done: new Set(), running: new Set() };
    // 入场种子:priorityAgent(内部调用方:讨论对象先回应话题)+ 用户消息里的 @(取代旧「本场优先发言」)。
    for (const slug of [prioritySlug, ...parseMentions(String(p.message), participants, '')]) {
      if (slug && st.participants.includes(slug) && !st.pending.includes(slug)) st.pending.push(slug);
    }
    let cycle = 1;
    let activations = 0;
    /** 本周期真正起了几次激活(整周期为 0 = 没人有新话可说 → 收场)。 */
    let activatedThisCycle = 0;
    const inFlight = new Map<string, Promise<Settled>>();
    const quotaOk = async (): Promise<boolean> => {
      const can = await deps().billing.canConsumeTokenPoints(userId, 1).catch(() => ({ ok: true } as any));
      return !!can.ok;
    };
    const abortWait = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      else signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    try {
      for (;;) {
        if (signal.aborted) throw new AbortLikeError();
        if (speechFailure) throw speechFailure;
        // 插话先于调度:队列里已有的立即消费(等待期间到达的靠 waitSteer 唤醒);它是对全员的新输入 —— 谁的 DONE 都作废,本周期重来。
        // 预算尾巴上(剩余激活数不够全员各回应一次)不在这里消费:留给收尾那趟(全员各回应一次,有界;Codex 09-16 r3 #3),
        // 否则最后几次激活只够一两位回应、其余成员没见到这条插话就到顶了;上限本身不因插话突破。
        const canDrain = activations + participants.length <= maxActivations;
        const injected = canDrain ? await drainUserSteer(cycle) : 0;
        if (injected) {
          st.cycleSpoken = new Set(); st.done = new Set();
          // 正在跑的成员这次激活看不到这条插话:留队,跑完立刻再起一次(delta 里才有它)—— 否则两人都带着 DONE 收场,用户的话没人回。
          for (const s of st.running) if (!st.pending.includes(s)) st.pending.push(s);
        }
        // 被跳过的成员已进 cycleSpoken、teamDue 不会再返回它 → 循环着要人,直到要不出候选(或并发位满)。
        // 只要一批就收手的话,cap 小于人数时可能整批都是「没有新话」的,而排在后面、手里有未读的成员永远起不来(Codex 评审 #2)。
        while (activations < maxActivations && !costExceeded && stopReason !== 'quota') {
          const due = teamDue(st, cap);
          if (!due.length) break;
          for (const slug of due) {
            if (activations >= maxActivations || costExceeded) break;
            // 没有新话可读 → 本周期跳过它(不计激活、不算发言);等谁开口再回来。
            if (!hasNewsFor(slug)) { st.cycleSpoken.add(slug); continue; }
            if (!(await quotaOk())) { await publish(runId, 'error', { error: 'token_quota_exceeded' }); stopReason = 'quota'; break; }
            activations++; activatedThisCycle++;
            st.running.add(slug); st.cycleSpoken.add(slug); st.done.delete(slug); // 被 @ 的 DONE 成员重新入场:这次激活重新表态
            inFlight.set(slug, launch(slug, cycle));
          }
        }
        if (stopReason === 'quota') { abortInFlight(); break; }
        if (costExceeded) { stopReason = 'cost_limit'; break; } // 用量事件里越线的:在跑的已级联中止,下面等它们收场
        if (!inFlight.size) {
          if (st.done.size === participants.length) { stopReason = 'done'; break; }
          if (activations >= maxActivations) { stopReason = 'max_rounds'; break; }
          // 整整一个周期谁都没有新话可读 = 这场聊完了(没写 DONE 的成员也没什么可说了),不空转到天花板。
          // 单列 'settled':不是「全员表示已完成」,桌面照原样显示这句会说谎;老客户端不认得这个值 → 回落中性文案。
          if (!activatedThisCycle) { stopReason = 'settled'; break; }
          cycle++; roundsRun = cycle; st.cycleSpoken = new Set(); activatedThisCycle = 0;
          await publish(runId, 'group_cycle', { cycle });
          continue;
        }
        const settled = await Promise.race<Settled | null>([
          ...inFlight.values(),
          new Promise<null>((resolve) => { wakeSpeech = () => resolve(null); }),
          ...(p.waitSteer && canDrain ? [p.waitSteer().then(() => null)] : []),
          abortWait,
        ]);
        if (!settled) continue; // 插话到了(回到循环顶消费)或被中止(循环顶抛)
        inFlight.delete(settled.slug); st.running.delete(settled.slug);
        if (await settle(settled)) { stopReason = 'cost_limit'; abortInFlight(); break; }
        if (st.done.size === participants.length && !inFlight.size && !st.pending.length) { stopReason = 'done'; break; }
      }
      // 停机后还有子 run 在跑(成本 / 额度停机已级联中止;done / max_rounds 时不会有):等它们收场,发言照样抄回。
      for (const r of await Promise.all(inFlight.values())) { st.running.delete(r.slug); await settle(r); }
      inFlight.clear();
      if (costExceeded && stopReason !== 'quota') stopReason = 'cost_limit';

      // 收尾前再消费一次插话:最后几次激活 / 收场判定期间进来的消息,enqueueSteer 已经答应「收到了」,
      // 不能在 finally 清队列时直接丢掉 —— 有就再让全员回应一趟(有界:一趟,并发上限内分批),然后把趟内又来的持久化进对话。
      // 收尾趟是有界的例外(每人至多一次,受成本天花板约束、不受激活数上限约束):不这么做,最后几次激活期间的插话会被
      // 丢在地上(Codex r2 曾判为缺陷);Codex r4 #8 指出它突破了激活数上限 —— 有意为之,记在方案 §6.4。
      if (!signal.aborted && stopReason !== 'quota' && !costExceeded) {
        const late = await drainUserSteer(roundsRun);
        if (late > 0) {
          const queue = participants.map((a) => a.slug);
          while (queue.length && !costExceeded) {
            if (signal.aborted) throw new AbortLikeError();
            const batch = queue.splice(0, cap);
            for (const r of await Promise.all(batch.map((slug) => launch(slug, roundsRun)))) {
              if (await settle(r)) { stopReason = 'cost_limit'; queue.length = 0; }
            }
          }
          await drainUserSteer(roundsRun);
        }
      }
      // 调度到此为止:之后的 Historian 摘要不消费插话 → 关掉入口,客户端回退起新 run 排在本 run 后面。
      await speechQueue;
      if (speechFailure) throw speechFailure;
      p.closeSteer?.();
    } catch (err) {
      abortInFlight(); // 团队 run 自己出错 / 被中止:子 run 不能变成没人管的孤儿
      // Completed deliverables already queued before cancellation must reach disk before the terminal event.
      await speechQueue;
      throw err;
    }

    await publish(runId, 'group_ended', {
      rounds: roundsRun, reason: stopReason, steps,
      participants: participants.map((a) => ({ slug: a.slug, name: a.name })),
    });

    // Historian supplies an optional attachment. Never ask for mandatory input or fail the team for a summary failure.
    let summarized = false;
    if (!signal.aborted && !p.agentConfig.groupNoSummary && stopReason !== 'quota' && stopReason !== 'cost_limit') {
      try {
        const hostMessageId = uuidv4();
        const cfg = loadSpecialAgentsConfig().historian;
        const summaryModel = await resolveBackgroundModelId(cfg.modelId).catch(() => '') || modelId;
        const result = await completeHistorianTask({
          sessionId, userId, modelId: summaryModel, task: 'team-summary',
          instructions: [cfg.prompt, HOST_PROMPT].filter(Boolean).join('\n\n'),
          transcript: transcript.map((t) => `[${t.name}]\n${t.text}`).join('\n\n'),
          maxTokens: 1200, signal,
        });
        await account(p, result, summaryModel, result.model, HOST_SLUG, meter);
        if (result.content) {
          await state.finalizeAssistantMessage({
            messageId: hostMessageId, sessionId, modelId: summaryModel, timestamp: nextTimestamp(),
            content: TEAM_SUMMARY_PREFIX + result.content, reasoning: '', toolCalls: [], toolResults: [],
          });
          await publish(runId, 'group_summary', { messageId: hostMessageId, text: result.content, historianSessionId: result.historianSessionId });
          summarized = true;
        }
      } catch (err: any) {
        if (signal.aborted) throw new AbortLikeError();
        console.warn('[agent-core] optional Historian team summary unavailable:', err?.message || err);
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

/** 显式 groupMaxConcurrent(内部调用方:讨论 / Historian 辅助传 1 = 顺序交替)钳 1..成员数;没传 = TEAM_MAX_CONCURRENT(不超过成员数)。 */
function concurrencyCap(v: any, members: number): number {
  const n = Math.floor(Number(v));
  const base = Number.isFinite(n) && n >= 1 ? n : TEAM_MAX_CONCURRENT;
  return Math.max(1, Math.min(base, members));
}

const THINK_LEVELS: readonly string[] = THINKING_LEVELS;
const APPROVAL_MODES = ['readonly', 'auto-edit', 'full-auto'];

/** 会话级成员调档(agentConfig.teamMemberConfigs:slug → { model, thinkingLevel }):
 *  只覆盖显式给了值的那一项,其余照成员定义。model 走子 run 的 model_id、thinkingLevel 走子 run 的 agentConfig,
 *  两者都不回写 Agent 定义 —— 本会话调档,别人的私聊不受影响。非法档位 / 未知 slug 一律忽略。 */
export function tuneMembers(members: NormalAgentDef[], raw: any): NormalAgentDef[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return members;
  return members.map((a) => {
    const t = raw[a.slug];
    if (!t || typeof t !== 'object') return a;
    const model = typeof t.model === 'string' ? t.model.trim() : '';
    const thinkingLevel = THINK_LEVELS.includes(t.thinkingLevel) ? t.thinkingLevel : '';
    if (!model && !thinkingLevel) return a;
    return { ...a, model: model || a.model, thinkingLevel: (thinkingLevel || a.thinkingLevel) as NormalAgentDef['thinkingLevel'] };
  });
}

/** 临时 Agent 定义来自客户端(本会话用,不落盘):校验必填 + 钳制各字段,复刻 agentRegistry.saveAgent 的口径。 */
export function sanitizeTempAgents(raw: any): NormalAgentDef[] {
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

/**
 * 成员系统提示里的团队段(拼在成员自己的人格之后;agentLoop 在 agentConfig.teamMember 在场时注入)。全员共识、逐字不变 → 前缀缓存友好。
 * 规则按并行模型写:自己的线程里干活、只有最终消息进团队聊天、等人就 @ 并不写 DONE、完事写 DONE、同目录并行编辑的纪律。
 */
export function teamMemberSection(agentName: string, roster: string, teamDoc?: string): string {
  return (
    '## Team Mode\n' +
    "You are a member of a team working on the user's request. Members present:\n" +
    roster +
    '\n\n' +
    `You are "${agentName}". How the team works:\n` +
    '- Every member works in their own thread, in parallel. Your final answer is posted to the team chat automatically — that is your remark. Use team_say only for something the team needs BEFORE you finish: a blocking question, a heads-up during long work, or a handoff. After a team_say, end your turn with just DONE unless you have something genuinely new to add; never restate a remark you already posted. Tool calls and private drafts stay in your thread.\n' +
    '- Address a member with @<name>; quote their words with a markdown blockquote (starting with >). In team_say, set requestReply=true only for a question or new work that needs the mentioned member to act. Ordinary progress and completion acknowledgements do not reactivate teammates. A request in your final answer without DONE also activates the mentioned member. Do not ask teammates to confirm an already completed task.\n' +
    '- You are activated whenever the team chat has new remarks for you: a teammate @-mentioned you, the user spoke, or a new cycle started because someone still has work to do.\n' +
    '- If you are waiting on a teammate, @-mention them with exactly what you need and end WITHOUT DONE — you will be activated again when they report back or when the next cycle starts.\n' +
    '- When your part is complete and nobody needs anything more from you, end your final message with DONE on its own line as the last line. You then stay silent unless a member @-mentions you or the user speaks again. The team is finished once every member has ended with DONE; there is no round limit and no vote.\n' +
    '- Teammates may be editing the same workspace at the same time: say which files you own, stay inside them, and never rewrite files a teammate owns.\n' +
    '- Be concise and well-grounded; keep your professional perspective and persona — do not blindly agree.' +
    (teamDoc ? '\n\n' + teamDoc : '')
  );
}

export function formatDelta(delta: TranscriptEntry[], selfName: string): string {
  if (!delta.length) return `You are activated now (${selfName}): continue your part and post your report to the team chat as your final message.`;
  const lines = delta
    .map((t) => (t.slug === CONTEXT_SLUG ? t.text : t.slug === USER_SLUG ? `[User] ${t.text}` : `@${t.name}:\n${t.text}`))
    .join('\n\n');
  return `New remarks in the team chat:\n\n${lines}\n\n———\nYou are activated now (${selfName}). Do your part, then post your report to the team chat as your final message (you may @ a member, or quote their remark with >). If you already posted everything with team_say, end with just DONE — never say the same thing twice.`;
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
  'You are this conversation’s Historian, also serving as the team moderator. Your summary is an optional attachment below the chat, not another participant speech. Based on the full discussion record, give the user a clear, objective summary:\n' +
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
