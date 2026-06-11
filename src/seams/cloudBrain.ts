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
}

export interface SearchBrain {
  /** 返回 { provider, text, results } 或字符串(见 ai-studio webSearchService.runSearch)。 */
  runSearch(query: string, maxResults: number): Promise<any>;
}

/** 模型目录(admin 列表用)。 */
export interface ModelsBrain {
  listGlobalModels(...args: any[]): Promise<any[]>;
  /**
   * 本地直连 provider 列表(BYO-key,桌面/TUI 模型选择器用;绝不含 apiKey)。
   * 可选:仅 standalone 的 multiBrain 实现;forsionSeams/httpBrain 不实现 → 调用方跳过。
   */
  listDirectProviders?(): Array<{ providerId: string; modelIds?: string[] }>;
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
    isDeleted?: boolean,
  ): Promise<any>;
  deleteItem(...args: any[]): Promise<any>;
}

export interface CloudBrainServices {
  llm: LlmBrain;
  users: UsersBrain;
  memory: MemoryBrain;
  assets: AssetsBrain;
  search: SearchBrain;
  models: ModelsBrain;
  storage: StorageBrain;
}
