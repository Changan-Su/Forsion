/**
 * 通道无关管线:入站消息 → 绑定校验 → (stop/审批/询问/slash) → Tangu run → 回复交付(分段+语音)。
 * 从 wechatRemote 移植泛化;微信/Telegram/QQ 共用,通道差异全部收在 ChannelDriver(传输层)。
 *
 * 会话语义(2026-07 起):无「默认会话」概念——每次连接(扫码/connect)都新建一个会话;
 * 通道会话统一落在该通道专属工作区(project_path),桌面侧栏按文件夹分组展示。
 * 新会话创建时盖上通道默认 Agent / LLM / 画图 / 语音模型(见 createChannelSession)。
 *
 * slash 命令的解析 / 分发 / 文案在 commands.ts(目录驱动);用户可见文案在 messages.ts(zh/en 成对)。
 *
 * 每个 peer 的运行态(09-25 重做,同日评审二轮再改):
 *   - runsByPeer:该 peer 发起、未结束的**全部** run(在跑 + 排队)。旧版只记一个 runId,run 进行中再发一条
 *     消息就指向了排队的那个,「停止」只停掉排队的、真正在跑的继续跑(r_7 补答 1)。
 *   - 每个 run **一个**事件订阅(trackRun → onRunEvent),审批 / 询问 / 结果全在这里登记与投递。旧版回复等待者
 *     自己订阅、在第一张卡处退订,此后到的第二张卡(并行子代理用父 runId 发 ask_user;/new 后两个会话各跑一个
 *     run)没人接,直接丢了。等待者现在只是一个「回复出口」(ReplySink):挂着时 run 的里程碑经它回给触发它的那条
 *     入站消息,没挂时经驱动主动推送。
 *   - 卡片(审批 / 询问)每 peer 一条 FIFO:队首 = 正显示在聊天里的那张,「批准 / 拒绝」/ 答复只作用于它;答完 /
 *     作废后再显示下一张。旧版每 peer 一个槽,第二张直接覆盖第一张、第一张永远无人兑现。
 *   - 审批卡**显示出来**后 10 分钟无人应答 → 按拒绝兑现(rejectReason 与「用户拒绝」区分),并在通道里说一声。
 *   - 入站按 peer 串行**分派**(receive),分派完即放手:run 的回复不占住驱动的轮询循环(否则任务跑着的头 3 分钟里
 *     发「停止」要等到任务出第一条回复才被读到)。
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { withKeyLock } from '../core/keyLock.js';
import { deps } from '../seams/runtime.js';
import { createRun } from '../services/runStore.js';
import { abortRun, enqueueRun, sessionHasActiveRun } from '../services/agentLoop.js';
import { subscribe } from '../services/eventBus.js';
import { normalizeApprovalMode, resolveApproval, type ApprovalMode as EngineApprovalMode } from '../services/approvals.js';
import { resolveInquiry } from '../services/inquiries.js';
import { patchSessionAgentConfig, readSessionSettings, requestRunThinking, setSessionModelId } from '../services/sessionSettings.js';
import { chatModels, listModelCatalog } from '../services/modelCatalog.js';
import { readAgentsMeta, listAgents, getAgent, agentCapOf, DEFAULT_MAX_ITERATIONS } from '../agents/agentRegistry.js';
import { resolveReplySegment, splitMessage, segmentDelayMs } from '../services/replySegment.js';
import { resolveVoiceMessage, synthesizeVoiceWav, VOICE_MESSAGE_PLUGIN_ID } from '../services/voiceMessage.js';
import { setPluginEnabled, setScopeSettings } from '../plugins/settingsStore.js';
import { channelSettings, channelWorkspaceDir, saveChannelSettings } from './config.js';
import { ChannelCommandCenter, normalizeChannelText, parseChannelCommand, stopReply, type ChannelCommandRuntime, type ChannelUsage } from './commands.js';
import { CHANNEL_NAME, CHANNEL_REPLY_MAX, channelMsg, clipReply, resolveChannelLocale, type ChannelLocale } from './messages.js';
import type { ApprovalMode, ChannelDriver, ChannelInbound, ChannelKind, SendResult } from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const RUN_REPLY_TIMEOUT_MS = 180_000;

/** 通道审批无人应答的超时(之后按拒绝兑现)。hermes 5 分钟;通道消息常被手机通知延后,放宽到 10 分钟。 */
export const CHANNEL_APPROVAL_TIMEOUT_MS = 10 * 60_000;
const APPROVAL_TIMEOUT_MIN = Math.round(CHANNEL_APPROVAL_TIMEOUT_MS / 60_000);
// 给模型看的拒绝原因(英文):与「用户拒绝」区分开,模型才不会把沉默当成用户的意见。
export const APPROVAL_TIMEOUT_REASON = `No one answered this approval request in the chat channel within ${APPROVAL_TIMEOUT_MIN} minutes, so the action was not run.`;
export const APPROVAL_SUPERSEDED_REASON = 'The user sent a new message in the chat channel instead of answering this approval request, so the action was not run.';
// 只有通道**完全停止**(禁用 / 断开 / 凭据清空 / 引擎退出)或该账号被断开才走这条;换凭据只重启传输层,待批的卡片留着(见 hub.restartChannel)。
export const APPROVAL_CHANNEL_STOPPED_REASON = 'The chat channel was stopped or disconnected before anyone answered this approval request, so the action was not run.';
/**
 * 通道完全停止 / 账号断开时替用户兑现还挂着的询问(ask_user / 计划审阅):不兑现的话 run 永远卡在等答复上(询问不超时)。给模型看,英文。
 * 开头自带「[No answer]」:ask_user 会在前面拼上「用户回答:」,不自标的话模型读到的是「用户回答了:通道停了」。
 */
export const INQUIRY_CHANNEL_STOPPED_ANSWER = '[No answer] The chat channel was stopped or disconnected before the user answered this question. This is a system note, not the user\'s reply: do not assume an answer; continue without it or wait for the user to reach out again.';
/** 多条审批卡有条没发出去(驱动报失败):用户没看全,不在通道里批。给模型看,英文。 */
export const APPROVAL_DELIVERY_FAILED_REASON = 'Part of this approval request could not be delivered to the chat channel, so the user could not review it in full there and it was not run. If it is still needed, ask the user to continue in Tangu Desktop, where they can review and approve the full action.';
/** 审批内容长到通道里分条也显示不全:不在通道里批(批准后执行的是完整参数,卡上看不到的尾巴不能替用户放行)。 */
export function approvalTooLongReason(chars: number): string {
  return `This action was too long (${chars} characters) to show in full in the chat channel, so the user could not review it there and it was not run. If it is still needed, split it into shorter steps, or ask the user to continue in Tangu Desktop, where they can review and approve the full action.`;
}

const STOP_RE = /^(stop|停止|取消|中止)$/i;
const APPROVE_RE = /^(批准|同意|确认|可以|好的?|是的?|yes|y|ok|approve|👍)$/i;
const REJECT_RE = /^(拒绝|不同意|不行|否|不|no|n|reject)$/i;
/**
 * 审批卡里的 preview **不截断**(批准后执行的是完整参数,旧版截到 1200 字,长命令末尾的删除 / 外传在卡上根本看不到):
 * 超过单条能放的就分条发,每条带 (i/n);超过条数上限就不在通道里批(按拒绝兑现,让用户去桌面端看全文)。
 * 每条 preview 片段 ≤ PREVIEW_PART_MAX,加上抬头 / 回复提示 / 排队提示 / 序号仍 < CHANNEL_REPLY_MAX。
 */
export const PREVIEW_PART_MAX = 1400;
export const APPROVAL_CARD_MAX_PARTS = 5;
/** 超时通知 / 过长拒绝里只引开头,提醒是哪个操作(不需要全文)。 */
const PREVIEW_HEAD_MAX = 300;
const PLAN_MAX = 1100;
/**
 * 询问卡里问题正文的上限(超出截断并注明去桌面端看全文,同 PLAN_MAX 的口径)。选项与回复提示**从不截**:
 * 回复序号映射的就是它们(旧版整卡 clipReply 到 1800 字,长问题把选项和提示截没了,用户回「2」却映射到没见过的选项)。
 * 整卡放不下一条就按 (i/n) 分条发全。
 */
export const INQUIRY_QUESTION_MAX = PREVIEW_PART_MAX * 3;
/** 审批档从严到宽的名次(启动对齐只收紧、建 run 取更严时比大小用)。 */
const APPROVAL_RANK: Record<ApprovalMode, number> = { readonly: 0, 'auto-edit': 1, 'full-auto': 2 };
/** 通道三档阶梯:custom / 不认识的档一律按 readonly 算(通道设置只提供三档;custom 只可能是遗留 / 手改的绑定值)。 */
function approvalLadder(m: EngineApprovalMode | undefined): ApprovalMode {
  return m === 'auto-edit' || m === 'full-auto' ? m : 'readonly';
}

interface BindingRow {
  id: string;
  user_id: string;
  channel: string;
  account_id: string;
  peer_id: string | null;
  session_id: string;
  /** 库里是 VARCHAR,没有枚举约束:可能是旧版 / 手改的任意值,读的时候一律过 effectiveApprovalMode。 */
  remote_approval_mode: string | null;
}

interface PeerAddr { key: string; accountId: string; peerId: string }

/** 等用户在通道里回复的一张卡。每 peer 一条 FIFO(见 prompts),队首是正显示着的那张。 */
interface ApprovalPrompt extends PeerAddr {
  kind: 'approval';
  runId: string;
  approvalId: string;
  preview: string;
  /** 无人应答超时:这张卡**显示出来**时才起算(排队期间用户看不到它,不能替他计时)。 */
  timer?: ReturnType<typeof setTimeout>;
}

interface InquiryPrompt extends PeerAddr {
  kind: 'inquiry';
  runId: string;
  inquiryId: string;
  /** 登记时就渲染好的问题卡(plan 询问要用当时的计划正文)。 */
  text: string;
  /** 回复序号 n → answers[n-1](plan 询问是固定选项串的子集,wire 约定逐字不动)。 */
  answers: string[];
  /** exit_plan_mode 的计划审阅(通道自己答的才由通道代发「开始执行」,见 RunState.planAnsweredHere)。 */
  isPlan: boolean;
}

type Prompt = ApprovalPrompt | InquiryPrompt;

/**
 * run 的回复出口:挂着时 run 的下一个里程碑(卡片 / 结果)经它回给触发它的那条入站消息(首条 resolve,之后主动推送);
 * 没挂时由 output() 经驱动主动推送。每个 run 同一时刻至多一个。
 */
interface ReplySink {
  deliver(text: string): void;
  /** 摘下出口(停 typing、清计时器);还没回过话的,用 fallback 兑现 —— 不留悬挂的 promise。 */
  close(fallback?: string): void;
}

interface RunState {
  runId: string;
  addr: PeerAddr;
  agentSlug?: string;
  off: () => void;
  sink: ReplySink | null;
  /** exit_plan_mode 先发 plan 事件、再发 inquiry_request。 */
  planText: string;
  planAutoStart: boolean;
  /** 计划审阅由通道这边作答:只有这时批准「马上开始」后由通道代发执行消息(桌面答的由桌面自己发,两边都发就跑两遍)。 */
  planAnsweredHere: boolean;
  /** 被通道「停止」:aborted 终态不再单独回一句「任务已停止」(停止的回复已经说了),分段回复也即停。 */
  stopped: boolean;
  /** 已收到 done / error:之后只剩把回复发完,不再处理事件。 */
  ended: boolean;
}

/** 分派结果:直接回一句,或一个要等的 run 回复(不能直接返回 Promise —— async 函数会把它摊平成等待)。 */
type Dispatched = string | { wait: Promise<string> };

export interface ChannelServiceOpts {
  kind: ChannelKind;
  driver: ChannelDriver;
  /** 未绑定 peer 收到消息时的提示(缺省按语言从 messages.ts 取)。 */
  unboundHint?: string;
  /** 入站文件落盘目录名(微信沿用历史 wechat-inbox)。 */
  inboxDirName: string;
  /** 新会话默认标题。 */
  sessionTitle: string;
  /**
   * 承载本通道引擎的客户端面标识(desktop/2.9.9)。通常由 Desktop spawn 时经
   * TANGU_HOST_CLIENT 注入;显式值仅供其它宿主/测试注入。
   */
  hostClientTag?: string;
}

// 与 routes/runs.ts 的公开请求闸同形。这里读的是受信宿主 env,但仍收紧形状,
// 避免手动启动 standalone 时把脏值写进 client-stats;云端 brain-api 落 api_usage_logs 前还会再验一次。
const HOST_CLIENT_TAG_RE = /^(desktop|web|mobile|cli|tui)\/[A-Za-z0-9._-]{1,32}$/;
export function normalizeChannelHostClientTag(v: unknown): string | undefined {
  return typeof v === 'string' && HOST_CLIENT_TAG_RE.test(v) ? v : undefined;
}

export function parseJson(v: any): any {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * 绑定上记着的审批档(记录值,随通道设置同步,见 syncApprovalMode)。与引擎同一个归一(H5 fail-closed):
 * 四个 id 原样(含遗留的 custom);**其它任何非空值 → readonly**;空 / 缺席 = 历史缺省 auto-edit(同建表 DEFAULT)。
 * 旧版把三档以外的一律落 auto-edit —— 库里一个拼错的 / 旧客户端写的值就把写文件放成免批。
 */
export function effectiveApprovalMode(binding: Pick<BindingRow, 'remote_approval_mode'>): EngineApprovalMode {
  return normalizeApprovalMode(binding.remote_approval_mode, 'channel binding') ?? 'auto-edit';
}

/**
 * 通道 run **实际**用的审批档:通道设置与绑定里**更严**的那档(readonly < auto-edit < full-auto;custom / 不认识的按 readonly)。
 * 设置页收紧档位时先存设置、再异步同步绑定 —— 同步失败或还没轮到时,只看绑定就会按旧的宽档接单。取更严的一档,
 * 收紧即刻生效;放宽要等同步成功(绑定仍是记录值,不在这里改写)。通道 run 不现读会话存值(approvalModeSessionId),
 * 这里算出的就是整个 run 的档。
 */
export function channelRunApprovalMode(settingsMode: unknown, binding: Pick<BindingRow, 'remote_approval_mode'>): ApprovalMode {
  const s = approvalLadder(normalizeApprovalMode(settingsMode, 'channel settings') ?? 'auto-edit');
  const b = approvalLadder(effectiveApprovalMode(binding));
  return APPROVAL_RANK[s] <= APPROVAL_RANK[b] ? s : b;
}

/** 按行切 preview(尽量在换行处断,不拆代理对),每段 ≤ size。只切不删:各段拼回去就是原文。 */
export function splitPreview(text: string, size = PREVIEW_PART_MAX): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size; // 附近没有换行:硬切
    else cut += 1; // 换行留在前一段末尾
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut -= 1; // 不把代理对劈成两半
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

function previewHead(text: string): string {
  return text.length > PREVIEW_HEAD_MAX ? `${text.slice(0, PREVIEW_HEAD_MAX)}…` : text;
}

/** 询问的答复:纯序号且在范围内 → 对应选项原文;否则原样当自由文本。 */
export function inquiryAnswerFor(answers: string[], text: string): string {
  if (/^\d{1,2}$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= answers.length) return answers[n - 1];
  }
  return text;
}

export class ChannelService {
  readonly kind: ChannelKind;
  readonly driver: ChannelDriver;
  private readonly opts: ChannelServiceOpts;
  private readonly hostClientTag?: string;
  private readonly commands = new ChannelCommandCenter();
  /** 本通道跟踪中的 run(trackRun 登记,finishRun 摘掉)。 */
  private readonly runs = new Map<string, RunState>();
  /** peer → 该 peer 发起、尚未结束的 run(在跑 + 排队)。 */
  private readonly runsByPeer = new Map<string, Set<string>>();
  /** peer → 待用户回复的卡片 FIFO(队首正显示着;其余答完 / 作废一张再出一张)。 */
  private readonly prompts = new Map<string, Prompt[]>();
  /**
   * peer → 审批卡作废时刻(超时自动拒绝 / 桌面端代答 / run 在别处结束,且之后没有别的卡)。之后短时间内回
   * 「批准 / 拒绝」要答「已过期」,不能落成一条内容是「批准」的新任务。一次性:有新卡登记即清,无卡时被下一条非命令消息取用。
   */
  private readonly expiredApprovalAt = new Map<string, number>();
  // typing 指示:peer → 周期性重发「正在输入」的定时器(run 期间开启,出回复时关闭)。
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  // 挂着的回复出口的强制结束器:stop()/服务重载时把所有等待中的回复 settle 掉,避免泄漏。
  private readonly pendingSettlers = new Set<() => void>();
  /** peer → 入站串行分派链的队尾(receive)。 */
  private readonly inboundChains = new Map<string, Promise<void>>();
  /** releasePending 递增:排在分派链里、还没轮到的入站随之作废。 */
  private epoch = 0;

  constructor(opts: ChannelServiceOpts) {
    this.kind = opts.kind;
    this.driver = opts.driver;
    this.opts = opts;
    this.hostClientTag = normalizeChannelHostClientTag(opts.hostClientTag ?? process.env.TANGU_HOST_CLIENT);
  }

  settings() { return channelSettings(this.kind); }
  workspaceDir(): string { return channelWorkspaceDir(this.kind); }
  /** 本通道回复语言(设置手选 → TANGU_LOCALE → 系统 → 平台缺省)。每次现算:改设置即时生效。 */
  locale(): ChannelLocale { return resolveChannelLocale(this.kind, this.settings().locale); }
  private async ensureWorkspaceDir(): Promise<string> {
    const dir = this.workspaceDir();
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }
  private peerKey(accountId: string, peerId: string): string { return `${accountId}:${peerId}`; }

  /**
   * 通道**完全停止**(禁用 / 断开 / 引擎退出):结束所有挂起等待 + 定时器 + 订阅,并替用户兑现还挂着的卡片。
   * 换凭据 / 启用只重启传输层,不调这里(hub.restartChannel):service 实例常驻,run 订阅与卡片留着,答复与结果照样经新驱动走
   * —— 旧版重启也走这里,退订了全部 run,在等 ask_user 的 run 永远等下去、用户重启后的答复被当成新任务、在跑任务的结果也丢了。
   */
  releasePending(): void {
    this.epoch += 1;
    const all = [...this.prompts.values()].flat();
    this.prompts.clear();
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    for (const settle of [...this.pendingSettlers]) settle();
    this.pendingSettlers.clear();
    // 先退订再兑现(settleDropped):兑现会广播 approval_result / inquiry_result,不能再让订阅者去「显示下一张」/ 重挂出口。
    for (const st of this.runs.values()) st.off();
    this.runs.clear();
    this.runsByPeer.clear();
    this.expiredApprovalAt.clear();
    this.inboundChains.clear();
    this.settleDropped(all);
  }

  /**
   * 断开**某一个账号**(微信多账号里只移除一个;其余账号照常在跑):只释放这个账号名下的卡片与 run,语义同 releasePending。
   * 旧版单账号断开只作废绑定 + 移除 iLink 账号,它名下在等 ask_user 的 run 永远等、结果推给一个已不存在的账号。
   * epoch 是全通道的,不动:排在分派链里的这个账号的旧入站,轮到时绑定已作废,只会回「未绑定」。
   */
  releasePendingFor(accountId: string): void {
    const dropped: Prompt[] = [];
    for (const [key, q] of [...this.prompts]) {
      if (!q.some((p) => p.accountId === accountId)) continue;
      dropped.push(...q);
      this.prompts.delete(key);
    }
    for (const st of [...this.runs.values()]) {
      if (st.addr.accountId !== accountId) continue;
      st.off(); // 先退订再兑现(同 releasePending)
      st.sink?.close(); // 摘出口:停 typing、清计时器、摘 pendingSettlers;账号正在移除,不再往它说话
      this.runs.delete(st.runId);
      this.runsByPeer.delete(st.addr.key);
    }
    for (const key of [...this.expiredApprovalAt.keys()]) if (key.startsWith(`${accountId}:`)) this.expiredApprovalAt.delete(key);
    this.settleDropped(dropped);
  }

  /**
   * 替用户兑现被丢下的卡片:审批按拒绝、询问答「通道已停止 / 断开,没有答复」(原因都写清,给模型看的英文)。只清计时器不兑现的话,
   * 它们再无人应答(询问本就不超时),run 永远卡着。已在桌面端答掉的,resolve* 回 false,无副作用。
   * 调用前必须已退订相关 run:兑现会广播 approval_result / inquiry_result,不能再让订阅者去「显示下一张」/ 重挂出口。
   * (广播的落库在 eventBus 的 per-run 写链里,失败只记日志;引擎退出时这里的写入不会冒成未处理的 rejection。)
   */
  private settleDropped(prompts: Prompt[]): void {
    for (const p of prompts) {
      if (p.kind === 'approval') {
        if (p.timer) clearTimeout(p.timer);
        resolveApproval(p.approvalId, { action: 'reject', rejectReason: APPROVAL_CHANNEL_STOPPED_REASON });
      } else {
        resolveInquiry(p.inquiryId, INQUIRY_CHANNEL_STOPPED_ANSWER);
      }
    }
  }

  // ── 绑定/会话 ──

  /**
   * 连接账号:登记账号行 + 作废该用户本通道全部旧绑定 + 新建绑定与**全新会话**。
   * 「连接即新会话」——不复用旧会话;历史会话仍留在通道工作区文件夹里可切回(/resume)。
   * 调用方显式带的审批档(微信扫码的 approval_mode)与设置不一致时写回设置并同步到本通道全部绑定 ——
   * 与 hub.applySettings 同一口径(设置是唯一真源,设置值 = 各绑定上的值);只写设置不同步的话,本通道别的绑定
   * 要到下次改设置才对齐。
   */
  async bindAccount(input: { userId: string; accountId: string; peerId?: string | null; label?: string | null; approvalMode?: ApprovalMode }): Promise<{ sessionId: string }> {
    const st = this.settings();
    const approval = input.approvalMode || st.approvalMode;
    const modeChanged = !!input.approvalMode && input.approvalMode !== st.approvalMode;
    if (modeChanged) saveChannelSettings(this.kind, { approvalMode: approval });
    const sessionId = await this.createChannelSession(input.userId, undefined, undefined);
    await query(
      `INSERT INTO tangu_wechat_accounts (id, user_id, wx_user_id, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET status = 'active', wx_user_id = ?, channel = ?, updated_at = CURRENT_TIMESTAMP`,
      [input.accountId, input.userId, input.label || null, this.kind, input.label || null, this.kind],
    );
    // 单活跃绑定不变式:每 (用户, 通道) 同一时刻只有一个 is_active 绑定。
    await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE WHERE user_id = ? AND channel = ?`, [input.userId, this.kind]);
    await query(
      `INSERT INTO tangu_wechat_bindings (id, user_id, channel, account_id, peer_id, session_id, remote_approval_mode, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [uuidv4(), input.userId, this.kind, input.accountId, input.peerId || null, sessionId, approval],
    );
    if (modeChanged) await this.syncApprovalMode(approval);
    return { sessionId };
  }

  /**
   * 把通道设置里的审批档同步到本通道**全部**绑定。旧版只在建绑定时写一次 remote_approval_mode,而通道 run 强制用它
   * —— 设置页收紧了档,已连接的会话照旧按老档跑(r_1 §3.2 缺陷 3,也是安全问题)。
   * 不动 updated_at:findBinding / activeBinding 按它排序,改设置不该改变「哪个绑定最新」。
   *
   * narrowOnly(引擎启动时的对齐用):只把**比设置宽**的绑定收紧到设置档,不放宽。启动时没有任何用户动作,
   * 而设置值可能来自兜底链(微信:TANGU_WECHAT_REMOTE_APPROVAL_MODE → 旧 wechat.remoteApprovalMode → 'auto-edit'),
   * 老客户端按 readonly 建的绑定不能因此被悄悄放宽到 auto-edit / full-auto。放宽只走用户在设置页的显式改动(applySettings)。
   * 改了几个、还有几个比设置严,都打日志。
   */
  async syncApprovalMode(mode: ApprovalMode, opts: { narrowOnly?: boolean } = {}): Promise<void> {
    if (!opts.narrowOnly) {
      await query(`UPDATE tangu_wechat_bindings SET remote_approval_mode = ? WHERE channel = ?`, [mode, this.kind]);
      return;
    }
    const rows = await query<any[]>(`SELECT id, remote_approval_mode FROM tangu_wechat_bindings WHERE channel = ?`, [this.kind]);
    // custom / 不认识的绑定值按 readonly 排名(建 run 时也按 readonly 用,见 channelRunApprovalMode):只会被算作「更严」,不会被改宽。
    const rank = (r: any): number => APPROVAL_RANK[approvalLadder(effectiveApprovalMode(r))];
    const looser = rows.filter((r) => rank(r) > APPROVAL_RANK[mode]);
    const stricter = rows.filter((r) => rank(r) < APPROVAL_RANK[mode]).length;
    for (const r of looser) {
      await query(`UPDATE tangu_wechat_bindings SET remote_approval_mode = ? WHERE id = ?`, [mode, r.id]);
    }
    if (looser.length) {
      const from = [...new Set(looser.map((r) => String(r.remote_approval_mode ?? 'null')))].join('/');
      console.warn(`[${this.kind}-channel] 启动对齐:${looser.length} 个绑定的审批档从 ${from} 收紧到设置档 ${mode}`);
    }
    if (stricter) console.warn(`[${this.kind}-channel] 启动对齐:${stricter} 个绑定比设置档 ${mode} 更严,保持不动(在设置页改一次审批档即全部对齐)`);
  }

  /**
   * 断开:作废绑定 + 账号行。带 accountId(微信单账号断开;两个调用方 routes/channels 与 wechatRemote 都先经这里再移除 iLink 账号)
   * 时顺带释放该账号名下挂着的卡片与 run(releasePendingFor)—— 不带时由调用方走 hub.stopChannel 完全停止。
   */
  async disconnect(userId: string, accountId?: string): Promise<{ ok: boolean }> {
    if (accountId) {
      await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ? AND account_id = ?`, [userId, this.kind, accountId]);
      await query(`UPDATE tangu_wechat_accounts SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ? AND id = ?`, [userId, this.kind, accountId]);
      this.releasePendingFor(accountId);
    } else {
      await query(`UPDATE tangu_wechat_bindings SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ?`, [userId, this.kind]);
      await query(`UPDATE tangu_wechat_accounts SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ?`, [userId, this.kind]);
    }
    return { ok: true };
  }

  /** 当前活跃绑定(含 peer 是否已确认),供状态展示与收件箱转发寻址。 */
  async activeBinding(userId: string): Promise<BindingRow | null> {
    const rows = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings WHERE user_id = ? AND channel = ? AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
      [userId, this.kind],
    );
    return (rows[0] as BindingRow) || null;
  }

  private async findBinding(accountId: string, peerId: string): Promise<BindingRow | null> {
    const exact = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings
       WHERE channel = ? AND account_id = ? AND peer_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [this.kind, accountId, peerId],
    );
    if (exact[0]) return exact[0] as BindingRow;
    const fallback = await query<any[]>(
      `SELECT * FROM tangu_wechat_bindings
       WHERE channel = ? AND account_id = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [this.kind, accountId],
    );
    const b = fallback[0] as BindingRow | undefined;
    if (b && !b.peer_id) {
      // 未绑定联系人的 binding:收第一个发消息的 peer 作为其专属联系人(TOFU)。
      await query(`UPDATE tangu_wechat_bindings SET peer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [peerId, b.id]);
      b.peer_id = peerId;
      return b;
    }
    // binding 已绑定其它联系人 → 拒绝其他 peer(peer 隔离,避免任意人借同一 binding 执行 host)。
    return null;
  }

  /** 在通道工作区新建会话并盖上通道默认(Agent/LLM/画图模型/审批)。 */
  async createChannelSession(userId: string, modelId?: string, title?: string): Promise<string> {
    const st = this.settings();
    const ws = await this.ensureWorkspaceDir();
    const profile = deps().profile;
    const mid = modelId || st.modelId || profile.defaultModelId || '';
    const id = uuidv4();
    await deps().state.autoCreateSession({ id, userId, appId: profile.appId, title: title || this.opts.sessionTitle, modelId: mid });
    // project_path 让桌面侧栏把它归入通道工作区组;cwd 让 host 执行有真实工作目录。
    await query(`UPDATE chat_sessions SET project_path = ? WHERE id = ?`, [ws, id]);
    const cfg: any = {
      execMode: 'host',
      approvalMode: st.approvalMode,
      cwd: ws,
      agentSlug: st.agentSlug || readAgentsMeta().defaultSlug,
    };
    if (st.imageModelId) cfg.imageModelId = st.imageModelId;
    await deps().state.setAgentConfig(id, JSON.stringify(cfg));
    return id;
  }

  /** 列出该用户本通道工作区下的会话(标注哪个是正在连接的)。 */
  async listProjectSessions(userId: string): Promise<Array<{ id: string; title: string; updated_at: any; connected: boolean; agentSlug: string | null }>> {
    const rows = await query<any[]>(
      `SELECT id, title, updated_at, agent_config FROM chat_sessions WHERE user_id = ? AND project_path = ? ORDER BY updated_at DESC`,
      [userId, this.workspaceDir()],
    );
    const binding = await this.activeBinding(userId);
    const connected = binding?.session_id ?? null;
    return rows.map((r) => ({ id: r.id, title: r.title || this.opts.sessionTitle, updated_at: r.updated_at, connected: r.id === connected, agentSlug: (parseJson(r.agent_config) || {}).agentSlug || null }));
  }

  /** 设置某会话使用的 Normal Agent(按键合并 agentSlug,与桌面 PATCH 同锁)。 */
  async setSessionAgent(userId: string, sessionId: string, slug: string): Promise<{ ok: boolean }> {
    const rows = await query<any[]>(`SELECT id FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
    if (!rows[0]) throw new Error('Session not found');
    await patchSessionAgentConfig(sessionId, { agentSlug: slug });
    return { ok: true };
  }

  /** 把「正在连接的 session」切换到 sessionId(校验归属;兜底补齐 host+cwd)。 */
  async setConnectedSession(userId: string, sessionId: string): Promise<{ ok: boolean }> {
    const rows = await query<any[]>(`SELECT agent_config, project_path FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
    const s = rows[0];
    if (!s) throw new Error('Session not found');
    if (s.project_path !== this.workspaceDir()) throw new Error("Only sessions in this channel's workspace can be connected");
    const cfg = parseJson(s.agent_config) || {};
    if (cfg.execMode !== 'host' || !cfg.cwd) {
      await patchSessionAgentConfig(sessionId, { execMode: 'host', approvalMode: cfg.approvalMode || this.settings().approvalMode, cwd: cfg.cwd || s.project_path || this.workspaceDir() });
    }
    await query(`UPDATE tangu_wechat_bindings SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = ? AND is_active = TRUE`, [sessionId, userId, this.kind]);
    return { ok: true };
  }

  /**
   * 把一份媒体(图片/文件)发送到某会话当前连接的通道 peer。
   * 供 builtin 工具(channel_send_file / channel_send_image)与插件 SDK 调用 —— 错误串是给模型看的,英文。
   */
  async sendMediaForSession(userId: string, sessionId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult> {
    const rows = await query<any[]>(
      `SELECT account_id, peer_id FROM tangu_wechat_bindings
       WHERE session_id = ? AND user_id = ? AND channel = ? AND is_active = TRUE
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, userId, this.kind],
    );
    const b = rows[0];
    if (!b) return { ok: false, error: 'This session is not connected to a channel (no active binding). The user must connect the channel in Tangu Desktop settings and make this the connected session.' };
    if (!b.peer_id) return { ok: false, error: 'The channel has no contact yet. Ask the user to send a message in the chat first, then retry.' };
    if (!this.driver.sendMedia) return { ok: false, error: 'This channel does not support sending media.' };
    return this.driver.sendMedia(b.account_id, b.peer_id, buffer, opts, signal);
  }

  /** 给该用户当前活跃绑定的 peer 发一条文本(收件箱转发等主动推送用)。 */
  async sendToOwner(userId: string, text: string): Promise<SendResult> {
    const b = await this.activeBinding(userId);
    if (!b) return { ok: false, error: 'no active binding' };
    if (!b.peer_id) return { ok: false, error: 'peer not established yet' };
    return this.driver.send(b.account_id, b.peer_id, text);
  }

  // ── 入站管线 ──

  /**
   * 驱动入口(hub 接的是这个):立即返回 '',不占住驱动的轮询循环。
   * 同一 peer 的入站按到达顺序串行**分派**(校验绑定 / 停止 / 兑现卡片 / 命令 / 建 run 入队),分派完就放手 ——
   * run 的回复不在串行链上等,经 driver.send 推回。所以「停止」在任务跑着时也是即刻读到的,且一定排在它要停的那条
   * 任务的建 run 之后(不会先跑空、再让任务起来)。命令回复同样经 send 发出(驱动的发送本身按 peer / 账号串行,顺序不乱)。
   * 代价:驱动在分派之前就推进了游标(Telegram offset),分派中途崩溃这条不会重投 —— 此时 run 往往已落库,重投只会重复执行。
   */
  receive(msg: ChannelInbound): Promise<string> {
    const key = this.peerKey(msg.accountId, msg.peerId);
    const epoch = this.epoch;
    const step = (this.inboundChains.get(key) ?? Promise.resolve()).then(async () => {
      if (epoch !== this.epoch) return; // 通道已停止 / 重启:排队中的旧入站作废
      const r = await this.dispatchInbound(msg);
      if (typeof r === 'string') {
        if (r) this.push(msg.accountId, msg.peerId, r);
      } else {
        void r.wait.then((t) => { if (t) this.push(msg.accountId, msg.peerId, t); });
      }
    }).catch((e: any) => console.warn(`[${this.kind}-channel] 处理入站消息失败:`, e?.message || e));
    this.inboundChains.set(key, step);
    void step.then(() => { if (this.inboundChains.get(key) === step) this.inboundChains.delete(key); });
    return Promise.resolve('');
  }

  /** 处理一条入站并等到它的首条回复(测试与需要同步拿回复的调用方用;驱动走 receive)。 */
  async handleInbound(msg: ChannelInbound): Promise<string> {
    const r = await this.dispatchInbound(msg);
    return typeof r === 'string' ? r : r.wait;
  }

  /** 主动推一条文本给 peer(失败只记日志)。 */
  private push(accountId: string, peerId: string, text: string): void {
    void this.send(accountId, peerId, text);
  }

  /** 同 push,但回报是否送达(驱动报 ok:false 或抛错 = 没送达;已记日志)。发送在调用时同步发起,多条按调用顺序。 */
  private send(accountId: string, peerId: string, text: string): Promise<boolean> {
    return this.driver.send(accountId, peerId, text)
      .then((r) => {
        if (!r?.ok) console.warn(`[${this.kind}-channel] 推送失败:`, r?.error);
        return !!r?.ok;
      })
      .catch((e: any) => {
        console.warn(`[${this.kind}-channel] 推送失败:`, e?.message || e);
        return false;
      });
  }

  private async dispatchInbound(msg: ChannelInbound): Promise<Dispatched> {
    const text = normalizeChannelText(msg.text);
    const attachments = msg.attachments ?? [];
    const key = this.peerKey(msg.accountId, msg.peerId);
    const addr: PeerAddr = { key, accountId: msg.accountId, peerId: msg.peerId };
    const L = this.locale();
    // 先校验绑定:stop / 批准拒绝 / slash / 普通任务 都要求该 peer 已绑定(防未绑定 peer 绕过执行)。
    // 按账号串行:receive 只按 peer 串行,两个不同 peer 同时给一个还没认主的绑定发消息,不锁的话两边都读到 peer_id 为空、
    // 都认领成功(TOFU 竞态,peer 隔离失守)。旧版整条轮询串行,碰巧没这个窗口(QQ 本来就有)。
    const binding = await withKeyLock(`channel-binding:${this.kind}:${msg.accountId}`, () => this.findBinding(msg.accountId, msg.peerId));
    if (!binding) return this.opts.unboundHint ?? channelMsg(L, 'unbound', { channel: CHANNEL_NAME[this.kind][L] });

    // Channel Session 关闭时不驱动 agent 会话(收件箱转发独立于此,仍可能在推送)。
    if (!this.settings().sessions) return channelMsg(L, 'sessionsOff');

    const cmd = parseChannelCommand(text);
    // 停止:裸关键词与 /stop 同一条路(旧版 /stop 落进「未知命令」)。
    if (STOP_RE.test(text) || cmd?.name === '/stop') return stopReply(L, this.stopPeer(key));

    const isVerdict = !cmd && (APPROVE_RE.test(text) || REJECT_RE.test(text));
    const head = this.prompts.get(key)?.[0];
    // 通道内审批:队首是审批卡时,「批准/拒绝」直接兑现它(无需回桌面)。命令照常执行,不动卡片。
    // 下面几步必须同步连着做:先摘卡再兑现(resolveApproval 会广播 approval_result,订阅者见卡已摘掉,不会当成「别处代答」);
    // 回复出口要在 run 的下一个事件之前挂上(run 在兑现后的微任务里才继续,同步挂上即赶得上)。
    if (head?.kind === 'approval' && isVerdict) {
      this.takeHead(key);
      const ok = resolveApproval(head.approvalId, { action: APPROVE_RE.test(text) ? 'approve' : 'reject' });
      const wait = ok ? this.waitForRunReply(head.runId) : null; // 先挂出口:下一张卡若是同一 run 的,它就是这条「批准」的回复
      this.afterHeadGone(key, head, !ok);
      this.releaseIfWaitingOnUser(head.runId);
      return wait ? { wait } : channelMsg(L, 'expired');
    }
    // 询问(ask_user / exit_plan_mode):队首是问题卡时,下一条非命令消息就是答复 —— 序号 → 选项原文,否则自由文本。
    // 「好 / 不」这类词在这里也是答复(不归审批,也不被「已过期」标记截走)。
    if (head?.kind === 'inquiry' && !cmd) {
      if (!text) return channelMsg(L, 'inquiryNeedsText');
      this.takeHead(key);
      const st = this.runs.get(head.runId);
      if (st && head.isPlan) st.planAnsweredHere = true; // 须在兑现前:plan_approved 紧随其后
      const ok = resolveInquiry(head.inquiryId, inquiryAnswerFor(head.answers, text));
      if (!ok && st) st.planAnsweredHere = false;
      const wait = ok ? this.waitForRunReply(head.runId) : null;
      this.afterHeadGone(key, head, false);
      this.releaseIfWaitingOnUser(head.runId);
      return wait ? { wait } : channelMsg(L, 'expired');
    }

    // slash 命令(目录驱动,见 commands.ts)。未知的 /x 在那边回「未知命令」,绝不落到下面当普通消息。
    if (cmd) return this.commands.dispatch(this.commandRuntime(binding, key, L), key, cmd);

    // 刚作废的审批卡(超时 / 桌面端代答 / run 在别处结束)后迟到的「批准 / 拒绝」:答「已过期」,不当新任务。
    // 只在没有卡片待答时看(有卡时上面两支已接走);标记被这条消息取用即删。
    if (!head) {
      const expiredAt = this.expiredApprovalAt.get(key);
      if (expiredAt !== undefined) {
        this.expiredApprovalAt.delete(key);
        if (isVerdict && Date.now() - expiredAt < CHANNEL_APPROVAL_TIMEOUT_MS) return channelMsg(L, 'expired');
      }
    }

    // 刚列过模型:10 分钟内回个纯数字 = 选模型(有审批卡待答时数字不归它 —— 走下面当新消息,那张卡按放弃处理)。
    if (!head && /^\d{1,3}$/.test(text)) {
      const picked = await this.commands.tryPickNumber(this.commandRuntime(binding, key, L), key, text);
      if (picked !== null) return picked;
    }

    const rows = await query<any[]>(`SELECT model_id, agent_config, project_path FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [binding.session_id, binding.user_id]);
    const session = rows[0];
    if (!session) return channelMsg(L, 'sessionMissing');
    const modelId = session.model_id || this.settings().modelId || deps().profile.defaultModelId || '';
    if (!modelId) return channelMsg(L, 'noModel');

    // 正显示的审批卡没答就发来新任务 → 视为放弃这张卡:按「被新消息取代」拒绝(原因如实告诉模型),旧 run 的结果照样推回
    // (旧版拒绝后没人再订阅,旧 run 的收尾回复就丢了)。排在它后面的卡接着显示 —— 用户还没见过它们,不替他放弃。
    // 上面有 await:只在这条消息到达时看到的那张卡仍是队首时才放弃它(这期间它可能已超时 / 被桌面答掉,换上来的新卡用户还没看到)。
    const stale = this.prompts.get(key)?.[0];
    if (stale && stale === head && stale.kind === 'approval') {
      this.takeHead(key);
      const ok = resolveApproval(stale.approvalId, { action: 'reject', rejectReason: APPROVAL_SUPERSEDED_REASON });
      this.afterHeadGone(key, stale, false);
      const st = this.runs.get(stale.runId);
      if (ok && st) this.resumeIfIdle(st);
    }

    const runId = uuidv4();
    const assistantMessageId = uuidv4();
    const userMessageId = uuidv4();
    const currentCfg = parseJson(session.agent_config) || {};
    const st = this.settings();
    // 会话存的 agent_config 整份带进 run(思考档 / 轮数 / 计划模式 / 技能…都在里面;/think /loop 就是写它),
    // 只覆盖通道必须钉死的键。
    const agentConfig: any = {
      ...currentCfg,
      execMode: 'host',
      // 设置与绑定取更严的一档:设置页刚收紧、绑定同步失败 / 还没同步到,也不按旧的宽档接单。
      approvalMode: channelRunApprovalMode(st.approvalMode, binding),
      // host 执行需要真实 cwd:优先会话已存 cwd,其次 project_path,最后兜底通道工作区。
      cwd: currentCfg.cwd || session.project_path || this.workspaceDir(),
      // 会话已选 agent 则用之,否则通道默认 agent,再兜底用户全局默认 agent。
      agentSlug: currentCfg.agentSlug || st.agentSlug || readAgentsMeta().defaultSlug,
    };
    if (!agentConfig.imageModelId && st.imageModelId) agentConfig.imageModelId = st.imageModelId;
    // 入站文件 → 落盘到会话工作区 <channel>-inbox/,把相对路径写进消息(host 工具可直接读;给模型看的,英文)。
    const fileNotes: string[] = [];
    for (const f of msg.files ?? []) {
      try {
        const saved = await this.saveInboundFile(agentConfig.cwd, f);
        fileNotes.push(`[The user sent a file; it was saved to ${saved}]`);
      } catch (e: any) {
        fileNotes.push(`[The user sent the file ${f.name}, but saving it failed: ${e?.message || e}]`);
      }
    }
    // 纯图片消息给个占位文本:部分 provider(如 Anthropic)拒绝空文本块,聊天记录里也更可读。
    const message = [text, ...fileNotes].filter(Boolean).join('\n') || (attachments.length ? '[image]' : '');
    await createRun({
      id: runId,
      sessionId: binding.session_id,
      userId: binding.user_id,
      appId: deps().profile.appId,
      modelId,
      assistantMessageId,
      input: {
        message,
        userMessageId,
        attachments, // 通道入站图片 → 与网页发图同一条多模态路径
        agentConfig,
        // 通道消息没有渲染层 POST /agent/runs 可自报端信息;继承托管引擎的 Desktop 端/版本。
        // 下游仍由 input.source.channel 区分微信/Telegram/QQ。
        ...(this.hostClientTag ? { client: this.hostClientTag } : {}),
        source: { channel: this.kind, accountId: msg.accountId, openid: msg.peerId, messageId: msg.messageId },
      },
    });
    this.trackRun(runId, addr, agentConfig.agentSlug);
    enqueueRun(binding.session_id, runId);
    return { wait: this.waitForRunReply(runId) };
  }

  // ── run 跟踪 ──

  /** 停掉该 peer 的全部 run(在跑 + 排队),卡片全部作废。返回停了几个。 */
  private stopPeer(key: string): number {
    const ids = [...(this.runsByPeer.get(key) ?? [])];
    this.runsByPeer.delete(key);
    for (const id of ids) {
      const st = this.runs.get(id);
      if (st) st.stopped = true;
      abortRun(id); // 在跑的走 AbortController;排队的出队并补终态(agentLoop.abortRun 两种都认)
    }
    // 卡片都属于这个 peer 的 run(刚全停了):审批 / 询问的 resolver 随 abort 信号释放,这里只摘表、清计时器。
    for (const p of this.prompts.get(key) ?? []) if (p.kind === 'approval' && p.timer) clearTimeout(p.timer);
    this.prompts.delete(key);
    return ids.length;
  }

  /** 登记 run 归属 + 挂它唯一的事件订阅(必须在 enqueueRun 之前,事件才不会漏)。 */
  private trackRun(runId: string, addr: PeerAddr, agentSlug?: string): void {
    let set = this.runsByPeer.get(addr.key);
    if (!set) this.runsByPeer.set(addr.key, (set = new Set()));
    set.add(runId);
    const st: RunState = {
      runId, addr, agentSlug, off: () => {}, sink: null,
      planText: '', planAutoStart: false, planAnsweredHere: false, stopped: false, ended: false,
    };
    this.runs.set(runId, st);
    st.off = subscribe(runId, (ev) => {
      try {
        this.onRunEvent(st, ev);
      } catch (e: any) {
        console.warn(`[${this.kind}-channel] 处理 run 事件 ${ev?.type} 失败:`, e?.message || e);
      }
    });
  }

  private onRunEvent(st: RunState, ev: { type: string; payload?: any }): void {
    if (st.ended) return;
    const p = ev.payload || {};
    switch (ev.type) {
      case 'plan': st.planText = String(p.plan || ''); return;
      case 'plan_approved': st.planAutoStart = p.auto === true; return;
      case 'approval_request': {
        const approvalId = String(p.approvalId || '');
        if (!approvalId) return;
        const preview = String(p.preview || p.name || channelMsg(this.locale(), 'approvalPreviewFallback'));
        // 分条也放不下:不在通道里批。requestApproval 先登记 resolver 再广播,这里同步兑现是安全的。
        if (splitPreview(preview).length > APPROVAL_CARD_MAX_PARTS) {
          this.refuseTooLong(st, approvalId, preview);
          return;
        }
        this.enqueuePrompt({ kind: 'approval', ...st.addr, runId: st.runId, approvalId, preview });
        return;
      }
      case 'inquiry_request': {
        const inquiryId = String(p.inquiryId || '');
        if (!inquiryId) return;
        const { text, answers, isPlan } = this.renderInquiry(this.locale(), p, st.planText);
        this.enqueuePrompt({ kind: 'inquiry', ...st.addr, runId: st.runId, inquiryId, text, answers, isPlan });
        return;
      }
      // 兑现广播:通道自己兑现的,兑现前已摘掉卡片(这里找不到,忽略);还在表里 = 桌面端 / 别处代答了。
      case 'approval_result':
        this.settledElsewhere(st, (q) => q.kind === 'approval' && q.approvalId === p.approvalId);
        return;
      case 'inquiry_result':
        this.settledElsewhere(st, (q) => q.kind === 'inquiry' && q.inquiryId === p.inquiryId);
        return;
      case 'done':
      case 'error':
        this.onRunEnd(st, ev.type, p);
        return;
      default:
        return; // token / tool_* 等流式事件:什么都不做(别每个 token 读一次 config.json)
    }
  }

  /** run 结束:它名下的卡作废(正显示的那张换下一张),结果经出口 / 主动推送送达,发完再摘掉 run。 */
  private onRunEnd(st: RunState, type: 'done' | 'error', p: any): void {
    st.ended = true;
    const key = st.addr.key;
    const q = this.prompts.get(key) ?? [];
    const shown = q[0]?.runId === st.runId ? q[0] : undefined;
    const rest = q.filter((x) => x.runId !== st.runId);
    for (const x of q) if (x.runId === st.runId && x.kind === 'approval' && x.timer) clearTimeout(x.timer);
    if (rest.length) this.prompts.set(key, rest);
    else this.prompts.delete(key);

    const L = this.locale();
    if (type === 'done') {
      // 拟人分段(按 agent,回落全局):该 agent 开启时把回复拆成多条依次发出;否则单条。
      void this.deliverReply(String(p.content || channelMsg(L, 'done')), (t) => this.output(st, t), () => {
        // 只在计划是通道这边批的时候代发:桌面批的,桌面自己会在 run 结束后发执行消息(两边都发就跑两遍)。
        const kickoff = st.planAutoStart && st.planAnsweredHere && !st.stopped;
        this.finalizeRun(st);
        if (kickoff) this.kickoffPlan(st.addr);
      }, st);
    } else {
      if (p.aborted && st.stopped) this.output(st, ''); // 「停止」的回复已经说了,不再重复
      else this.output(st, p.aborted ? channelMsg(L, 'taskStopped') : channelMsg(L, 'taskFailed', { error: p.error || 'unknown error' }));
      this.finalizeRun(st);
    }
    // 结果先发,再换下一张卡(deliverReply 的首段是同步发出的)。
    if (shown) this.afterHeadGone(key, shown, true);
  }

  /** run 的回复发完:摘出口、摘 run、退订。 */
  private finalizeRun(st: RunState): void {
    st.sink?.close();
    this.finishRun(st);
  }

  private finishRun(st: RunState): void {
    const set = this.runsByPeer.get(st.addr.key);
    if (set) {
      set.delete(st.runId);
      if (!set.size) this.runsByPeer.delete(st.addr.key);
    }
    if (this.runs.get(st.runId) === st) this.runs.delete(st.runId);
    st.off();
  }

  /** 把 run 的一条回复送出:有出口走出口(首条回给触发它的入站消息),否则主动推送。空串 = 不说话。 */
  private output(st: RunState, text: string): void {
    if (st.sink) st.sink.deliver(text);
    else if (text) this.push(st.addr.accountId, st.addr.peerId, text);
  }

  // ── 卡片(审批 / 询问)队列 ──

  private enqueuePrompt(p: Prompt): void {
    this.expiredApprovalAt.delete(p.key); // 有新卡了:之前作废的那张不再是「批准 / 拒绝」的对象
    const q = this.prompts.get(p.key);
    if (q?.length) {
      // 排队:当前那张答完 / 作废后再显示。它的 run 此刻在等用户(只是卡还没轮到),摘掉出口 —— 否则 typing 一直转、
      // 3 分钟后还会推一句「仍在执行」。轮到它时经主动推送显示。
      q.push(p);
      this.runs.get(p.runId)?.sink?.close();
      return;
    }
    this.prompts.set(p.key, [p]);
    this.showPrompt(p);
  }

  /**
   * 审批内容分条也放不下(> APPROVAL_CARD_MAX_PARTS 条):按拒绝兑现(给模型的原因写清、建议拆小),告诉用户去桌面端看全文。
   * 不登记卡片;没有别的卡待答时记下作废时刻 —— 用户看完这句回「批准」要答「已过期」,不能落成一条内容是「批准」的新任务。
   */
  private refuseTooLong(st: RunState, approvalId: string, preview: string): void {
    const ok = resolveApproval(approvalId, { action: 'reject', rejectReason: approvalTooLongReason(preview.length) });
    if (!ok) return; // 已在别处答掉
    const L = this.locale();
    const key = st.addr.key;
    const pending = this.prompts.get(key)?.[0];
    let text = channelMsg(L, 'approvalTooLong', { chars: preview.length, head: previewHead(preview) });
    // 更早的卡还在等答复(并行工具调用:A 正显示、B 过长被拒):这句拒绝成了聊天里最后一条,用户回个「好的」就批了上面的 A。
    // 在**同一条**里点明「接下来的回复作用于上面那个」—— 分开推会跟经出口送出的拒绝抢顺序(见 showPrompt 多条那段)。
    if (pending) text += `\n\n${channelMsg(L, 'promptStillPending', { head: previewHead(pending.kind === 'approval' ? pending.preview : pending.text) })}`;
    this.output(st, clipReply(text));
    if (!pending) this.expiredApprovalAt.set(key, Date.now());
  }

  /**
   * 审批卡的各条消息:preview 全文照发(见 PREVIEW_PART_MAX 的注释),一条放得下就是原样一张卡;放不下则分条,
   * 首条带抬头、末条带回复提示与排队提示,每条前缀 (i/n)。抬头 / 提示取自同一条 approvalCard 文案,两种形态措辞一致。
   */
  private approvalCardParts(L: ChannelLocale, preview: string, queued: string): string[] {
    const chunks = splitPreview(preview);
    if (chunks.length === 1) return [clipReply(`${channelMsg(L, 'approvalCard', { preview, minutes: APPROVAL_TIMEOUT_MIN })}${queued}`)];
    const MARK = '\u0000';
    const [head, foot] = channelMsg(L, 'approvalCard', { preview: MARK, minutes: APPROVAL_TIMEOUT_MIN }).split(MARK);
    const n = chunks.length;
    // 末条点明共几条:(i/n) 之外再提醒一句,丢了中间一条(微信限流丢弃不报错)的用户别照样回「批准」。
    const check = `\n${channelMsg(L, 'approvalPartsCheck', { n })}`;
    return chunks.map((c, i) => {
      const tag = `(${i + 1}/${n})`;
      if (i === 0) return `${tag} ${head}${c}`;
      return i === n - 1 ? `${tag}\n${c}${foot}${check}${queued}` : `${tag}\n${c}`;
    });
  }

  /** 询问卡的各条消息:一条放得下原样发;放不下按 (i/n) 分条发全(选项与回复提示在末尾,绝不截掉),排队提示跟在末条。 */
  private inquiryCardParts(text: string, queued: string): string[] {
    if (text.length + queued.length <= CHANNEL_REPLY_MAX) return [`${text}${queued}`];
    const chunks = splitPreview(text);
    const n = chunks.length;
    return chunks.map((c, i) => {
      const tag = `(${i + 1}/${n})`;
      if (i === 0) return `${tag} ${c}`;
      return i === n - 1 ? `${tag}\n${c}${queued}` : `${tag}\n${c}`;
    });
  }

  /** 显示一张卡(它此刻是队首):审批卡起 10 分钟计时;经它 run 的出口回(出口随即摘下 —— run 在等用户),没有出口就主动推送。 */
  private showPrompt(p: Prompt): void {
    const L = this.locale();
    const more = (this.prompts.get(p.key)?.length ?? 1) - 1;
    const queued = more > 0 ? `\n\n${channelMsg(L, 'promptsQueued', { n: more })}` : '';
    const parts = p.kind === 'approval' ? this.approvalCardParts(L, p.preview, queued) : this.inquiryCardParts(p.text, queued);
    if (p.kind === 'approval') {
      p.timer = setTimeout(() => this.onApprovalTimeout(p), CHANNEL_APPROVAL_TIMEOUT_MS);
      p.timer.unref?.();
    }
    const sink = this.runs.get(p.runId)?.sink;
    if (parts.length === 1 && sink) {
      sink.deliver(parts[0]);
      sink.close();
      return;
    }
    // 多条:不能让首条走出口 —— 出口兑现的是入站那条的等待,它在后面的微任务里才发,同步推的第 2 条会抢到前面。
    // 摘下出口(以 '' 兑现:不说话),全部按序主动推送;三个驱动的发送都按调用顺序串行,顺序不乱。
    sink?.close();
    const sends = parts.map((t) => this.send(p.accountId, p.peerId, t));
    // 审批卡有一条没送达:用户没看全,不能让一句「批准」放行看不到的那段 —— 按拒绝兑现(见 onApprovalUndelivered)。
    if (p.kind === 'approval') void Promise.all(sends).then((oks) => { if (oks.includes(false)) this.onApprovalUndelivered(p); });
  }

  /**
   * 审批卡(经主动推送发出的)有条没送达:它若仍在显示、没人答,按「没发全」拒绝(给模型的原因写清),通知用户,换下一张卡。
   * 已被答掉 / 作废的(不在队首)不管 —— 送达失败的回报可能晚于用户的答复(微信限流要退避重试好几秒)。
   * 微信 iLink 限流重试后丢弃时不报失败(ilinkRuntime),那一路只剩 (i/n) 与末条的「没收全就拒绝」提醒。
   */
  private onApprovalUndelivered(p: ApprovalPrompt): void {
    if (this.prompts.get(p.key)?.[0] !== p) return;
    this.takeHead(p.key);
    const ok = resolveApproval(p.approvalId, { action: 'reject', rejectReason: APPROVAL_DELIVERY_FAILED_REASON });
    if (ok) this.push(p.accountId, p.peerId, channelMsg(this.locale(), 'approvalDeliveryFailed', { head: previewHead(p.preview) }));
    this.afterHeadGone(p.key, p, true);
    const st = this.runs.get(p.runId);
    if (ok && st) this.resumeIfIdle(st);
  }

  /** 摘下队首(清它的计时器)。调用方随后必须调 afterHeadGone。 */
  private takeHead(key: string): Prompt | undefined {
    const p = this.prompts.get(key)?.shift();
    if (p?.kind === 'approval' && p.timer) { clearTimeout(p.timer); p.timer = undefined; }
    return p;
  }

  /**
   * 队首那张没了之后:还有卡 → 显示下一张;没卡了且没的是一张审批卡、又不是在通道里答掉的(markExpired)→ 记下作废时刻,
   * 迟到的「批准 / 拒绝」答「已过期」。队列里还有卡时不记 —— 那时「批准」的对象是新显示的那张。
   */
  private afterHeadGone(key: string, gone: Prompt, markExpired: boolean): void {
    const q = this.prompts.get(key);
    if (q?.length) { this.showPrompt(q[0]); return; }
    this.prompts.delete(key);
    if (markExpired && gone.kind === 'approval') this.expiredApprovalAt.set(key, Date.now());
  }

  /** 卡片在桌面端 / 别处被答掉了:从队列摘掉;若正显示着,换下一张;run 若不再等任何显示中的卡,重挂出口接着推结果。 */
  private settledElsewhere(st: RunState, match: (p: Prompt) => boolean): void {
    const key = st.addr.key;
    const q = this.prompts.get(key);
    const i = q ? q.findIndex(match) : -1;
    if (!q || i < 0) return;
    const [p] = q.splice(i, 1);
    if (p.kind === 'approval' && p.timer) clearTimeout(p.timer);
    if (i === 0) this.afterHeadGone(key, p, true);
    this.resumeIfIdle(st);
  }

  /** 审批超时(它正显示着):按拒绝兑现(原因与用户拒绝区分),通知用户,换下一张卡,接着等 run 的结果推回来。 */
  private onApprovalTimeout(p: ApprovalPrompt): void {
    const q = this.prompts.get(p.key);
    if (!q || q[0] !== p) return;
    q.shift();
    p.timer = undefined;
    // 先摘再兑现:resolveApproval 会广播 approval_result,订阅者见卡已摘掉,不当「别处代答」。
    const ok = resolveApproval(p.approvalId, { action: 'reject', rejectReason: APPROVAL_TIMEOUT_REASON });
    if (ok) this.push(p.accountId, p.peerId, channelMsg(this.locale(), 'approvalTimedOut', { minutes: APPROVAL_TIMEOUT_MIN, preview: previewHead(p.preview) }));
    this.afterHeadGone(p.key, p, true);
    const st = this.runs.get(p.runId);
    if (ok && st) this.resumeIfIdle(st);
  }

  /**
   * run 刚从等卡中解脱(桌面代答 / 超时 / 被新消息取代):没有出口、它的下一张卡也没正显示着时,重挂一个出口
   * (typing + 结果主动推送)。须在兑现后**同步**调用,赶在 run 的下一个事件之前。
   */
  private resumeIfIdle(st: RunState): void {
    if (st.ended || st.sink || this.runs.get(st.runId) !== st) return;
    if (this.prompts.get(st.addr.key)?.some((p) => p.runId === st.runId)) return; // 它还有卡在显示 / 排队:仍在等用户
    void this.waitForRunReply(st.runId).then((t) => { if (t) this.push(st.addr.accountId, st.addr.peerId, t); });
  }

  /** run 还有卡排在队里(没轮到显示)= 仍在等用户:摘掉它的出口(同 enqueuePrompt 排队那支)。 */
  private releaseIfWaitingOnUser(runId: string): void {
    const st = this.runs.get(runId);
    if (st?.sink && this.prompts.get(st.addr.key)?.some((p) => p.runId === runId)) st.sink.close();
  }

  /** 命令运行时:把 service 的能力按 commands.ts 的接缝暴露(每条命令现造,绑定 / 会话都是这一刻的)。 */
  private commandRuntime(binding: BindingRow, key: string, locale: ChannelLocale): ChannelCommandRuntime {
    const userId = binding.user_id;
    const sessionId = binding.session_id;
    return {
      kind: this.kind,
      locale,
      approvalMode: channelRunApprovalMode(this.settings().approvalMode, binding), // 与建 run 同一口径:/approval /status 报的就是会生效的档
      channelDefaults: () => { const st = this.settings(); return { agentSlug: st.agentSlug, modelId: st.modelId }; },
      defaultAgentSlug: () => readAgentsMeta().defaultSlug,
      workspaceDir: () => this.workspaceDir(),
      readSession: () => readSessionSettings(sessionId, userId),
      patchConfig: (patch) => patchSessionAgentConfig(sessionId, patch),
      setModel: (modelId) => setSessionModelId(sessionId, userId, modelId),
      listModels: async () => chatModels((await listModelCatalog(deps().profile)).models), // 与通道 run 同一个 profile
      listAgents: () => listAgents(),
      getAgent: (slug) => getAgent(slug),
      agentLoopCap: (def) => agentCapOf(def),
      defaultLoopCap: DEFAULT_MAX_ITERATIONS,
      newSession: async (title) => {
        const sid = await this.createChannelSession(userId, undefined, title);
        await this.setConnectedSession(userId, sid);
      },
      listSessions: () => this.listProjectSessions(userId),
      connectSession: async (id) => { await this.setConnectedSession(userId, id); },
      compact: (focus, modelId, cfg) => this.compactSession(sessionId, modelId, focus, cfg),
      usage: () => this.sessionUsage(sessionId),
      sessionBusy: () => sessionHasActiveRun(sessionId),
      peerRunIds: () => [...(this.runsByPeer.get(key) ?? [])],
      stopPeer: () => this.stopPeer(key),
      pendingState: () => {
        const head = this.prompts.get(key)?.[0];
        return { approval: head?.kind === 'approval', inquiry: head?.kind === 'inquiry' };
      },
      requestRunThinking: (runId, level) => requestRunThinking(runId, level),
      saveDefaultModel: (modelId) => { saveChannelSettings(this.kind, { modelId }); },
      setVoice: async (on, slug) => {
        if (on) await setPluginEnabled(VOICE_MESSAGE_PLUGIN_ID, true); // 确保插件启用(通道-only 用户也能开)
        await setScopeSettings(VOICE_MESSAGE_PLUGIN_ID, { agentSlug: slug }, { apply: on });
      },
    };
  }

  /** 与桌面 POST /agent/sessions/:id/compact 同一套:旋钮 = 会话 compaction > 该会话 Agent 的 [compaction] > config.json。 */
  private async compactSession(sessionId: string, modelId: string, focus: string, cfg: Record<string, unknown>): Promise<{ ok: boolean; summarizedCount?: number; reason?: string }> {
    const { isDelegateActive } = await import('../services/delegateTranscript.js');
    if (isDelegateActive(sessionId)) return { ok: false, reason: 'a delegated task is still running' };
    // 动态 import:compaction 依赖面大(历史回放 / 后台用量),通道模块静态引它会把整串拖进每个引用 hub 的入口。
    const { compactSession } = await import('../services/compaction.js');
    const { resolveCompactionSettings, globalCompactionLayer } = await import('../services/compactionSettings.js');
    const slug = typeof cfg.agentSlug === 'string' ? cfg.agentSlug : '';
    const def = slug ? await getAgent(slug).catch(() => null) : null;
    return compactSession(sessionId, modelId, deps().profile.appId, undefined, {
      focus: focus || undefined,
      settings: resolveCompactionSettings((cfg as any).compaction, def?.compaction, globalCompactionLayer()),
    });
  }

  /** 本会话累计用量:tokens 与桌面 /usage 同口径(agent_runs.tokens_total 求和);费用按 usage 事件的 cost 在 JS 里累加(不写 SQL JSON 谓词)。 */
  private async sessionUsage(sessionId: string): Promise<ChannelUsage> {
    const rows = await query<any[]>(`SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_total), 0) AS total FROM agent_runs WHERE session_id = ?`, [sessionId]);
    let cost: number | null = null;
    let cached = 0;
    try {
      const ev = await query<any[]>(
        `SELECT e.payload FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id WHERE r.session_id = ? AND e.type = 'usage'`,
        [sessionId],
      );
      cost = 0;
      for (const row of ev) {
        const p = parseJson(row.payload) || {};
        cost += Number(p.cost) || 0;
        cached += Number(p.cached) || 0;
      }
    } catch { cost = null; }
    return { tokens: Number(rows[0]?.total) || 0, runs: Number(rows[0]?.runs) || 0, cost, cached };
  }

  /**
   * 把一个入站文件写到会话工作区的 <channel>-inbox/ 下,返回相对 cwd 的路径。
   * 文件名做基本清洗(去路径分隔等),重名时追加 -1/-2… 不覆盖旧文件。
   */
  private async saveInboundFile(cwd: string, f: { name: string; buffer: Buffer }): Promise<string> {
    const inbox = path.join(cwd, this.opts.inboxDirName);
    await fsp.mkdir(inbox, { recursive: true });
    const safe = path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || `${this.kind}-file`;
    const ext = path.extname(safe);
    const stem = path.basename(safe, ext);
    let target = path.join(inbox, safe);
    for (let i = 1; i <= 99; i++) {
      try { await fsp.access(target); } catch { break; } // 不存在 → 用它
      target = path.join(inbox, `${stem}-${i}${ext}`);
    }
    await fsp.writeFile(target, f.buffer);
    return path.relative(cwd, target);
  }

  /**
   * 给 run 挂一个回复出口,等它的「下一个里程碑」:卡片(审批 / 询问)显示出来、或 run 结束 —— 由 onRunEvent 经出口投递。
   *  - 首条回复 resolve 本 promise(调用方负责发出);超时(180s)先回「仍在执行」、停 typing,但出口保留,之后的回复主动推送。
   *  - 卡片显示后出口即摘下(run 在等用户);用户答复 / 超时 / 桌面代答后再挂一个新的。
   * run 已结束 / 不在跟踪 → 立即以 '' 兑现。同一 run 已有出口时先把旧的收掉(不留悬挂的 promise)。
   */
  private waitForRunReply(runId: string): Promise<string> {
    const st = this.runs.get(runId);
    if (!st || st.ended) return Promise.resolve('');
    const { key, accountId, peerId } = st.addr;
    return new Promise<string>((resolve) => {
      let settled = false;
      let closed = false;
      const settle = (text: string): void => { if (!settled) { settled = true; resolve(text); } };
      const timer = setTimeout(() => {
        this.stopTyping(accountId, peerId, key);
        settle(channelMsg(this.locale(), 'stillRunning'));
      }, RUN_REPLY_TIMEOUT_MS);
      const sink: ReplySink = {
        deliver: (text) => {
          if (!settled) settle(text);
          else if (text) this.push(accountId, peerId, text);
        },
        close: (fallback = '') => {
          settle(fallback);
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          this.stopTyping(accountId, peerId, key);
          this.pendingSettlers.delete(forceSettle);
          if (st.sink === sink) st.sink = null;
        },
      };
      // stop()/服务重载时强制结束挂起的等待。
      const forceSettle = (): void => sink.close(channelMsg(this.locale(), 'serviceStopped'));
      st.sink?.close();
      st.sink = sink;
      this.pendingSettlers.add(forceSettle);
      this.startTyping(accountId, peerId, key);
    });
  }

  /**
   * 询问卡(纯文本):问题 + 编号选项。plan 询问(exit_plan_mode)的选项串是与 parsePlanAnswer 的 wire 约定,
   * 序号必须映射回**原串**;「需要修改(在输入框写反馈)」那项在通道里不列 —— 直接回文字就是反馈,选它反而把
   * 那句占位话当反馈回给模型。
   */
  private renderInquiry(L: ChannelLocale, payload: any, planText: string): { text: string; answers: string[]; isPlan: boolean } {
    const options: string[] = Array.isArray(payload.options) ? payload.options.map((o: unknown) => String(o ?? '')).filter(Boolean) : [];
    if (payload.kind === 'plan' && options.length >= 4) {
      const answers = [options[0], options[1], options[3]]; // 批准并自动开始 / 批准(手动开始)/ 拒绝
      const labels = [channelMsg(L, 'planApproveStart'), channelMsg(L, 'planApproveManual'), channelMsg(L, 'planReject')];
      const plan = planText.trim();
      const planBlock = plan ? (plan.length > PLAN_MAX ? `${plan.slice(0, PLAN_MAX)}\n${channelMsg(L, 'planTruncated')}` : plan) : '';
      const text = [planBlock, planBlock ? '' : null, channelMsg(L, 'planReady'), ...labels.map((l, i) => `${i + 1}. ${l}`), '', channelMsg(L, 'planHint')]
        .filter((x) => x !== null).join('\n');
      return { text, answers, isPlan: true };
    }
    const q = String(payload.question || '').trim();
    const question = q.length > INQUIRY_QUESTION_MAX ? `${splitPreview(q, INQUIRY_QUESTION_MAX)[0]}\n${channelMsg(L, 'inquiryTruncated')}` : q;
    const lines = [`❓ ${question}`];
    if (options.length) lines.push('', ...options.map((o, i) => `${i + 1}. ${o}`));
    lines.push('', channelMsg(L, options.length ? 'inquiryHintOptions' : 'inquiryHintFree'));
    return { text: lines.join('\n'), answers: options, isPlan: false };
  }

  /**
   * 计划「批准,马上开始执行」:桌面是客户端在 run 结束后自动发起执行消息;通道没有客户端,这里代发一条。
   * 走 receive:与用户自己的消息同一条串行链,回复主动推送。
   */
  private kickoffPlan(addr: PeerAddr): void {
    void this.receive({ accountId: addr.accountId, peerId: addr.peerId, text: channelMsg(this.locale(), 'planKickoff') });
  }

  /**
   * 把一条 done 回复送达通道。分段消息插件开启时拆成多条:首段同步送出(经出口即回给入站消息),其余段
   * 等拟人延迟后送出;被「停止」即停发。末了调 done() 收尾(摘出口 + 摘 run)。
   */
  private async deliverReply(
    content: string,
    deliver: (text: string) => void,
    done: () => void,
    st: RunState,
  ): Promise<void> {
    const { accountId, peerId } = st.addr;
    try {
      const seg = resolveReplySegment(st.agentSlug);
      const delayBase = seg.delayBase;
      const segs = seg.enabled ? splitMessage(content) : [content];
      // 只在本 run 被「停止」时中断;被新消息排在后面不算——每条回复都要发全,否则「回复中又发一条消息」
      // 会把上一条回复截成只剩第一段(实测的吞消息 bug)。新回复会经驱动限速排队跟在后面。
      const stopped = (): boolean => st.stopped;
      deliver(segs[0] ?? content);
      for (let i = 1; i < segs.length; i++) {
        if (stopped()) break;
        await sleep(segmentDelayMs(segs[i], delayBase));
        if (stopped()) break;
        void this.driver.setTyping?.(accountId, peerId, true).catch(() => {});
        deliver(segs[i]);
      }
      // 语音模式:文字之外,再把整条回复合成音频、当文件发一份。通道可配 TTS 模型/音色覆盖(缺省沿用「语音朗读」)。
      const cfg = this.settings();
      const base = resolveVoiceMessage(st.agentSlug);
      const voice = { ...base, model: cfg.ttsModelId || base.model, voice: cfg.ttsVoice || base.voice };
      if (voice.enabled && voice.wechat && this.driver.sendMedia && !stopped()) {
        if (voice.model) await this.sendVoiceFile(accountId, peerId, content, voice);
        else console.warn(`[${this.kind}-channel] 语音已开启但未配置 TTS 模型(设置→模型→语音朗读或通道语音模型),只发了文字。`);
      }
    } catch (e) {
      console.warn(`[${this.kind}-channel] deliverReply failed:`, e);
    } finally {
      done();
    }
  }

  /** 把整条回复合成音频、当**文件**发到通道(voice.wav)。失败静默(文字已发过,不影响主回复)。 */
  private async sendVoiceFile(
    accountId: string,
    peerId: string,
    text: string,
    cfg: { model: string; voice?: string; speed?: number; enabled: boolean; wechat: boolean },
  ): Promise<void> {
    try {
      const audio = await synthesizeVoiceWav(text, cfg); // WAV 字节
      const res = await this.driver.sendMedia?.(accountId, peerId, Buffer.from(audio), { kind: 'file', fileName: 'voice.wav' });
      if (!res?.ok) console.warn(`[${this.kind}-channel] 语音文件发送失败:`, res?.error);
    } catch (e: any) {
      console.warn(`[${this.kind}-channel] 语音文件合成/发送失败:`, e?.message || e);
    }
  }

  // ── typing 指示(run 期间周期重发「正在输入」,出回复时停止)──
  private startTyping(accountId: string, peerId: string, key: string): void {
    if (!this.driver.setTyping) return;
    const existing = this.typingTimers.get(key);
    if (existing) clearInterval(existing); // 多轮审批往返会重入 → 先清旧定时器避免泄漏
    const tick = (): void => { void this.driver.setTyping?.(accountId, peerId, true).catch(() => {}); };
    tick();
    this.typingTimers.set(key, setInterval(tick, 5_000));
  }
  private stopTyping(accountId: string, peerId: string, key: string): void {
    const t = this.typingTimers.get(key);
    if (t) { clearInterval(t); this.typingTimers.delete(key); }
    void this.driver.setTyping?.(accountId, peerId, false).catch(() => {});
  }
}
