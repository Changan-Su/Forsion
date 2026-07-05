/**
 * 接缝②:CloudBrainServices —— 云端共享大脑(LLM / 用户 / 记忆 / 资产 / 搜索 / 存储 / 模型)。
 *
 * 两个实现:
 *   - microserver:forsionSeams 进程内直连 server/src/services/*(零行为变化)
 *   - standalone:httpBrain 调云端 /api/brain/*(持 forsion_token)
 *
 * core 只通过本接口访问大脑,不再硬 import 任何 Forsion service。
 */
import type {
  AgentModel,
  AgentUser,
  ChatMessage,
  ResolvedModel,
  SkillRecord,
  CustomToolRecord,
  ListFilter,
  ThinkingLevel,
  Tool,
  ToolCall,
  AppendMemoryResult,
} from '../core/types.js';

// ── LLM 子接口(签名对齐 server/src/services/llmService 的三个导出)─────────────
export interface BuildPayloadOpts {
  model: AgentModel;
  apiModelId: string;
  messages: ChatMessage[];
  projectSource?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  attachments?: any[];
  thinkingLevel?: ThinkingLevel;
  stream?: boolean;
  /** 缓存路由键(传 sessionId):OpenAI 官方 API 的 prompt_cache_key,同会话请求粘到同一推理机提升前缀缓存命中。 */
  cacheKey?: string;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  /** cached_tokens/cache_write_tokens:prompt 缓存命中/写入量(provider 上报,brain 归一化;未上报为 0/缺省)。 */
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; cache_write_tokens?: number };
  finishReason?: string;
}

export interface StreamOpts {
  apiKey: string;
  baseUrl: string;
  payload: any;
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCallDelta?: (info: {
    id: string;
    name: string;
    argsLen: number;
    args: string;
    argsDelta: string;
  }) => void;
  signal?: AbortSignal;
  /** 模型 provider:anthropic/claude 时 server 侧走原生 /v1/messages;httpBrain 路径由 brain-api 自行解析,可省略。 */
  provider?: string;
}

export interface LlmBrain {
  resolveModelAndKey(modelId: string): Promise<ResolvedModel>;
  buildProviderPayload(opts: BuildPayloadOpts): Promise<any>;
  streamProviderCompletion(opts: StreamOpts): Promise<StreamResult>;
}

// ── 其余子接口 ──────────────────────────────────────────────────────────────
export interface UsersBrain {
  getUserById(id: string): Promise<AgentUser | null>;
}

export interface MemoryBrain {
  getMemory(userId: string): Promise<{ content: string; updatedAt: any }>;
  appendMemoryEntry(
    userId: string,
    text: string,
    opts?: { dedup?: boolean; cap?: number },
  ): Promise<AppendMemoryResult>;
  /** 整体覆盖用户长期记忆(读-改-写:Historian 据现有记忆做增量或修订)。可选——旧 brain 未实现时调用方降级为 append。 */
  setMemory?(userId: string, content: string): Promise<{ content: string; updatedAt: any }>;
  appendLogEntry(
    userId: string,
    text: string,
    opts?: { date?: string; time?: string },
  ): Promise<{ date: string; time: string }>;
  getLog(userId: string, date?: string): Promise<{ date: string; content: string; updatedAt: any }>;
}

export interface AssetsBrain {
  getSkill(id: string): Promise<SkillRecord | null>;
  listCustomTools(filter?: ListFilter): Promise<CustomToolRecord[]>;
  listForcedCustomTools(appId?: string): Promise<CustomToolRecord[]>;
  /** 技能目录(桌面/TUI 的技能面板用)。可选:旧版云端未实现时调用方降级空列表。 */
  listSkills?(filter?: ListFilter): Promise<SkillRecord[]>;
  /**
   * 上传/更新「请求者自己的」技能到云端(本地技能上云;owner 隔离,private,绝不进市场)。
   * 可选:旧版云端 404 → httpBrain 抛「云端版本过旧」;进程内实现需显式 userId。
   */
  upsertUserSkill?(
    userId: string,
    skill: { id?: string; name: string; description?: string; content: string; category?: string; icon?: string },
  ): Promise<{ id: string }>;
  /** 删除自己的云端技能(他人/全局 → false)。可选,同上。 */
  deleteUserSkill?(userId: string, id: string): Promise<boolean>;
}

export interface SearchBrain {
  /** 返回 { provider, text, results } 或字符串(见 ai-studio webSearchService.runSearch)。 */
  runSearch(query: string, maxResults: number): Promise<any>;
}

/** 模型目录(admin 列表用)。 */
export interface ModelsBrain {
  listGlobalModels(...args: any[]): Promise<any[]>;
  /**
   * 本地直连 provider 列表(BYO-key,桌面/TUI 模型选择器用;绝不含 apiKey,baseUrl 仅供 UI 展示)。
   * 可选:仅 standalone 的 multiBrain 实现;forsionSeams/httpBrain 不实现 → 调用方跳过。
   */
  listDirectProviders?(): Array<{ providerId: string; baseUrl?: string; modelIds?: string[]; imageModelIds?: string[]; ttsModelIds?: string[] }>;
  /**
   * 按应用过滤的模型列表(遵守 Forsion admin「应用模型配置」project_model_configs)。
   * 可选:旧版云端/brain 未实现 → 调用方回退 listGlobalModels。
   * 语义:project 无配置行 → 等价全局列表(优雅降级);有配置行 → 严格遵守。
   * 错误处理与 listGlobalModels 同款:httpBrain 对网络/旧契约降级 { models: [], defaultModelId: null }
   * (TUI 依赖不抛;空列表真相由调用方探针补全),进程内实现可抛(调用方捕获)。
   */
  listModelsForProject?(projectId: string): Promise<{ models: any[]; defaultModelId: string | null }>;
}

/**
 * 工作区存储:microserver 走 Penzor 云空间(cloudStorageService),standalone 走本地 FS。
 * 方法形态对齐 fileWorkspace 现用的 cloudStorageService 子集(返回结构沿用,故 any)。
 */
export interface StorageBrain {
  listDirectory(parentId: string | null, userId: string, appId: string, filters?: any): Promise<any[]>;
  createDirectory(userId: string, appId: string, parentId: string, name: string): Promise<any>;
  getFileContent(fileId: string, userId: string): Promise<{ content: Buffer; mimeType: string }>;
  updateFileContent(fileId: string, userId: string, content: Buffer | string): Promise<void>;
  uploadFile(
    userId: string,
    appId: string,
    parentId: string,
    name: string,
    content: Buffer | string,
    mimeType: string,
    // 对应 cloudStorageService.uploadFile 第 7 参 autoRename(默认 true:重名自动改名)。
    // 调用方(fileWorkspace)恒传 false（先 listDirectory 查重命中走 updateFileContent，
    // 故 uploadFile 只用于全新文件）。勿误名为 isDeleted —— 接到 is_deleted 会把上传文件标删、悄悄丢快照。
    autoRename?: boolean,
  ): Promise<any>;
  deleteItem(...args: any[]): Promise<any>;
}

/**
 * Tangu 每-agent 云文件镜像(Phase 2):跨设备同步(agentFileSync 读写)+ 云端运行水合共用。
 * 一行 = 一个 agent 的一个文件(config.toml/SOUL.md/MEMORY.md/LOG/<date>.md/Library/*),哨兵
 * slug '__user__'(USER.md) / '__meta__'(.meta.json)。文本内联,二进制 base64。可选:旧云端 404 → 调用方降级。
 */
export interface AgentFileMeta { relPath: string; mtimeMs: number; size: number; isBinary: boolean; deleted: boolean }
export interface AgentFileContent { content?: string; contentBase64?: string; isBinary: boolean; mtimeMs: number; deleted: boolean }
export interface AgentFilePutBody { content?: string; contentBase64?: string; isBinary: boolean; size: number; mtimeMs: number; deviceId?: string }
export interface AgentFilesBrain {
  getManifest(userId: string): Promise<Array<{ slug: string; files: AgentFileMeta[] }>>;
  getFile(userId: string, slug: string, relPath: string): Promise<AgentFileContent | null>;
  putFile(userId: string, slug: string, relPath: string, body: AgentFilePutBody): Promise<{ mtimeMs: number }>;
  deleteFile(userId: string, slug: string, relPath: string, mtimeMs: number, deviceId?: string): Promise<void>;
}

/**
 * 云端运行水合(Phase 2,B):云端 worker 的 `~/.tangu/agents/` 是空的,getAgent(本地 FS)拿不到人格 →
 * 经此从云端 tangu_agent_files 读 config.toml+SOUL.md 组装 def(人格/模型/库顺序),agentLoop 兜底用之。
 * 可选:旧云端/纯本地未注入 → agentLoop 回落今天行为(无 per-agent 人格)。
 */
export interface AgentsBrain {
  getAgent(userId: string, slug: string): Promise<import('../agents/agentRegistry.js').NormalAgentDef | null>;
}

/** 文生图(generate_image 用)。managed:调云端 /v1/images;direct:调 provider 自有 /images/generations。 */
export interface ImageGenRequest {
  model: string; // 图像模型 id(managed=Forsion model id;direct=apiModelId 或 <providerId>/<model>)
  prompt: string;
  size?: string; // 规范尺寸 '1:1'|'2:3'|'3:2'|'16:9'|'9:16' 或 'WxH';缺省 '1:1'
  n?: number;
  transparentBackground?: boolean;
  signal?: AbortSignal;
}
export interface ImageGenResult {
  images: Array<{ b64: string; mime: string }>;
}
export interface ImagesBrain {
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** 语音合成(朗读按钮/自动朗读用)。direct:调 provider 自有 OpenAI 兼容 /audio/speech。 */
export interface SpeechRequest {
  model: string; // TTS 模型 id(direct=apiModelId 或 <providerId>/<model>)
  text: string;
  voice?: string; // provider 特定音色 id
  speed?: number; // 0.5–2,缺省 1
  format?: 'mp3' | 'wav' | 'pcm'; // 缺省 mp3(朗读用);微信语音气泡需 wav(转 SILK)
  signal?: AbortSignal;
}
export interface SpeechResult {
  audio: Uint8Array;
  mime: string;
}
export interface TtsBrain {
  synthesize(req: SpeechRequest): Promise<SpeechResult>;
}

export interface CloudBrainServices {
  llm: LlmBrain;
  users: UsersBrain;
  memory: MemoryBrain;
  assets: AssetsBrain;
  search: SearchBrain;
  models: ModelsBrain;
  storage: StorageBrain;
  /** 文生图;可选:仅 standalone(httpBrain/multiBrain)实现,云端 worker/microserver 未注入 → 工具优雅降级。 */
  images?: ImagesBrain;
  /** 语音合成;可选:仅 standalone multiBrain 实现(BYO-key 直连),云端未注入 → /agent/tts 返回 501。 */
  tts?: TtsBrain;
  /** 每-agent 云文件(Phase 2);可选:旧云端/纯本地未注入 → 同步/水合调用方跳过。 */
  agentFiles?: AgentFilesBrain;
  /** 每-agent 人格(Phase 2 云端运行水合);可选:未注入 → agentLoop 回落本地 getAgent。 */
  agents?: AgentsBrain;
  /** 收件箱广播拉取(桌面 standalone 定期拉服务端公告);可选:旧云端/微服务进程/纯本地未注入 → inboxPull 调度器不启动。 */
  inbox?: InboxBrain;
}

/** 服务端收件箱广播(对端 GET /api/brain/inbox/broadcasts;created_at 为服务端微秒原文,原样回传做游标)。 */
export interface InboxBrain {
  listBroadcasts(since?: string): Promise<Array<{ id: string; title: string; body: string | null; created_at: string }>>;
}
