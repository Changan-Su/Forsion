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
}

export interface SendResult { ok: boolean; error?: string }

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
  /** 设置卡与侧栏文件夹的显示名。 */
  name: ChannelText;
  /** 凭据下方的一句提示(去哪儿拿凭据)。 */
  hint?: ChannelText;
  /** 设置卡要填的凭据,键复用通道设置的 appId / appSecret / botToken;secret 的不回显。全部填齐才算有凭据。 */
  fields: Array<{ key: 'appId' | 'appSecret' | 'botToken'; label: ChannelText; secret?: boolean }>;
}
