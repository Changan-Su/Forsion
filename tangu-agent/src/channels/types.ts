/**
 * 多通道(Channel)公共类型。通道 = 一个外部 IM 接入(微信 iLink / Telegram Bot / QQ 官方机器人),
 * 统一由 channels/service.ts 的通道无关管线驱动;每种通道只实现 ChannelDriver(传输层)。
 */

export type BuiltinChannelKind = 'wechat' | 'telegram' | 'qq';
/** 内置三通道 + 插件经 ctx.registerChannel 贡献的(kind 由插件定,见 hub.registerChannel 的校验)。 */
export type ChannelKind = BuiltinChannelKind | (string & {});
/** 内置通道;全部通道(含插件的)用 channelHub.kinds()。 */
export const CHANNEL_KINDS: BuiltinChannelKind[] = ['wechat', 'telegram', 'qq'];

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto';

/** 入站图片附件(与桌面发图同形:{name,mimeType,data(base64)},走多模态路径)。 */
export interface InboundImage { name: string; mimeType: string; data: string }
/** 入站文件(交管线落盘到会话工作区)。 */
export interface InboundFile { name: string; mimeType: string; buffer: Buffer }

/** 通道入站消息(驱动 → 管线)。 */
export interface ChannelInbound {
  accountId: string;
  peerId: string;
  text: string;
  messageId?: string;
  attachments?: InboundImage[];
  files?: InboundFile[];
  /** 钉这个 peer 的会话用哪个 Agent(优先于会话存值与通道默认)。内置通道不带;写法不合法的忽略。 */
  agentSlug?: string;
}

export interface SendResult { ok: boolean; error?: string }

/** 结构化审批卡(driver.sendApproval):工具调用的完整内容,怎么画、谁能批由驱动决定。 */
export interface ChannelApprovalCard {
  approvalId: string;
  runId: string;
  toolName: string;
  /** 工具参数的 JSON 原串(批准后执行的就是它)。 */
  arguments: string;
  /** 摘要 + 完整改动,与文字卡同一份。 */
  preview: string;
  /** true = 只能在执行设备本机批准:respond('approve') 恒回 false,仍可 reject。 */
  localOnly: boolean;
}
export type ChannelApprovalAction = 'approve' | 'reject';
/** 卡片怎么结束的:approved / rejected = 别处答的(桌面等);cancelled = run 结束 / 被停 / 通道停止。 */
export type ChannelApprovalOutcome = 'approved' | 'rejected' | 'timeout' | 'cancelled' | 'undelivered';

/** 通道驱动(传输层):连接生命周期 + 收发。会话映射/审批/slash/交付全在通道无关管线里。 */
export interface ChannelDriver {
  readonly kind: ChannelKind;
  /**
   * 启动底层连接(长轮询/WS)。入站消息回调 onMessage(由 hub 接到管线)。幂等。
   * onMessage 返回的非空文本由驱动发出;hub 接的 ChannelService.receive 恒立即回 '',所有回复都经 send 推送。
   */
  start(onMessage: (msg: ChannelInbound) => Promise<string>): Promise<void>;
  stop(): void;
  /** 各账号连接状态(label 供 UI 展示,如 bot 用户名)。 */
  status(): Array<{ accountId: string; running: boolean; peers?: number; label?: string }>;
  send(accountId: string, peerId: string, text: string): Promise<SendResult>;
  sendMedia?(accountId: string, peerId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<SendResult>;
  setTyping?(accountId: string, peerId: string, on: boolean): Promise<void>;
  /**
   * 有它就不发文字审批卡:卡片交给驱动,respond 兑现(true = 生效;false = 卡已结束,或此刻批不了:还没送达 / 只能本机批 / 已锁定远程)。
   * 卡片沿用文字卡那条每 peer 一张的队列与 10 分钟超时;该 peer 的文字消息不再作用于它(「好」批不了,新消息也不作废它)。
   * 回 ok:false 或抛错 = 没送达,按拒绝兑现。
   */
  sendApproval?(accountId: string, peerId: string, card: ChannelApprovalCard, respond: (action: ChannelApprovalAction) => boolean): Promise<SendResult>;
  /** 交出去的卡结束了(respond 回 true 的那次除外),驱动据此收卡。有它时宿主不再发超时之类的文字提示。 */
  settleApproval?(accountId: string, peerId: string, approvalId: string, outcome: ChannelApprovalOutcome): void | Promise<void>;
}

/** 每通道设置(config.json channels 段;见 channels/config.ts)。 */
export interface ChannelSettings {
  enabled: boolean;
  /** Channel Session:入站聊天 → agent 会话。与收件箱转发相互独立。 */
  sessions: boolean;
  /** 新会话默认 Normal Agent(空 = 用户全局默认 agent)。 */
  agentSlug: string;
  /** 新会话默认 LLM(空 = profile 默认模型)。 */
  modelId: string;
  /** 画图模型(空 = 全局解析链)。 */
  imageModelId: string;
  /** 语音(TTS)模型/音色(空 = 沿用「语音朗读」全局设置)。 */
  ttsModelId: string;
  ttsVoice: string;
  /** 通道 run 的审批档。改设置即同步到该通道全部绑定(见 ChannelService.syncApprovalMode);通道里只能看不能改。 */
  approvalMode: ApprovalMode;
  /** 通道回复语言(缺省 = 自动:TANGU_LANG / 系统语言 / 平台缺省,见 messages.resolveChannelLocale)。 */
  locale?: 'zh' | 'en';
  /** 收件箱转发:senders='all' 或 [agent slug|'system'|'server']。与 Channel Session 相互独立。 */
  inboxForward: { enabled: boolean; senders: 'all' | string[] };
  /** Telegram 凭据。 */
  botToken?: string;
  /** QQ 开放平台凭据。 */
  appId?: string;
  appSecret?: string;
}

/** 插件通道在设置卡上的一句双语文案。 */
export interface ChannelText { zh: string; en: string }

/**
 * 插件贡献的通道(ctx.registerChannel)。复用内置通道的整条管线:连接即新会话、审批、slash 命令、收件箱转发、
 * 侧栏工作区、设置 → 通道里的卡片(宿主按 fields 画凭据输入)。
 */
export interface PluginChannelSpec {
  /** driver.kind 即通道 kind:小写字母开头、`[a-z0-9-]`、2–16 字符(绑定表 channel 列 VARCHAR(16)),不得与内置撞。 */
  driver: ChannelDriver & {
    /** 「连接」按钮:校验凭据(失败抛错,文案给用户看),返回绑定用的账号 id 与卡片上的显示名。 */
    verify(): Promise<{ accountId: string; label: string }>;
  };
  /**
   * 一个账号服务多个 peer:每个 peer 一条绑定 + 一个会话 + 一个工作目录,互不相通。缺省 false = 内置通道的单联系人语义
   * (第一个发消息的 peer 认领,其余拒绝)。准入归驱动:它交上来的 peer 都会开会话,跑在连接这个账号的用户身份下。
   * 这些 peer 不是通道主人,所以只有 /stop 算命令(其余 /x 当普通消息),收件箱不转发,桌面也不能切换连接的会话。
   */
  multiPeer?: boolean;
  /** 设置卡与侧栏文件夹的显示名。 */
  name: ChannelText;
  /** 凭据下方的一句提示(去哪儿拿凭据)。 */
  hint?: ChannelText;
  /** 设置卡要填的凭据,键复用通道设置的 appId / appSecret / botToken;secret 的不回显。全部填齐才算有凭据。 */
  fields: Array<{ key: 'appId' | 'appSecret' | 'botToken'; label: ChannelText; secret?: boolean }>;
}

/** 通道归哪个插件:宿主按发现目录记,不是插件自报(ctx.tangu.connectChannel 据此判「本包的通道」)。 */
export interface ChannelOwner { engine: string; bundle: string | null }
