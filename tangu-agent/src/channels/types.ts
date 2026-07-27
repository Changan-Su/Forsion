/**
 * 多通道(Channel)公共类型。通道 = 一个外部 IM 接入(微信 iLink / Telegram Bot / QQ 官方机器人),
 * 统一由 channels/service.ts 的通道无关管线驱动;每种通道只实现 ChannelDriver(传输层)。
 */

export type ChannelKind = 'wechat' | 'telegram' | 'qq';
export const CHANNEL_KINDS: ChannelKind[] = ['wechat', 'telegram', 'qq'];

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto';

/** 入站图片附件(与桌面发图同形:{name,mimeType,data(base64)},走多模态路径)。 */
export interface InboundImage { name: string; mimeType: string; data: string }
/** 入站文件(交管线落盘到会话工作区)。 */
export interface InboundFile { name: string; mimeType: string; buffer: Buffer }

/** 通道入站消息(驱动 → 管线)。返回值 = 要回给用户的首条文本(驱动负责发出)。 */
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
  /** 启动底层连接(长轮询/WS)。入站消息回调 onMessage(由 hub 接到管线)。幂等。 */
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
  approvalMode: ApprovalMode;
  /** 收件箱转发:senders='all' 或 [agent slug|'system'|'server']。与 Channel Session 相互独立。 */
  inboxForward: { enabled: boolean; senders: 'all' | string[] };
  /** Telegram 凭据。 */
  botToken?: string;
  /** QQ 开放平台凭据。 */
  appId?: string;
  appSecret?: string;
}
