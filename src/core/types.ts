/**
 * Tangu Core 纯类型(C 类:随包带走,无任何 Forsion 耦合)。
 *
 * 这些类型曾散落在 server/src/types 与各 service 里;集中到此作为「核心运行时」与
 * 「接缝实现」共享的唯一真相源。两侧(microserver 的 forsionSeams、standalone 的
 * httpBrain)都从这里 import,靠 TS 结构化类型与各自的 Forsion/HTTP 实现对接。
 */

// ── 对话消息 / 工具(OpenAI function 格式)──────────────────────────────────
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | any[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

// ── LLM 解析/思考等级/错误 ──────────────────────────────────────────────────
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** 模型(对 core 不透明:只读 id/name/provider,其余字段透传给 buildProviderPayload)。 */
export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  [k: string]: any;
}

/** 用户(对 core 只需 id/username)。 */
export interface AgentUser {
  id: string;
  username: string;
  [k: string]: any;
}

export interface ResolvedModel {
  model: AgentModel;
  apiKey: string;
  baseUrl: string;
  apiModelId: string;
}

/** 带 HTTP 语义的 LLM 错误。core 自有此类——不跨边界 instanceof(接缝实现 throw 它,路由按 .status 处理)。 */
export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

// ── 配额/记忆结果 ───────────────────────────────────────────────────────────
/** 配额检查/扣减结果(core 只看 .ok,其余字段透传)。 */
export interface QuotaResult {
  ok: boolean;
  [k: string]: any;
}

export interface AppendMemoryResult {
  appended: boolean;
  reason?: 'empty' | 'duplicate' | 'full';
  length: number;
}

// ── 资产:技能 / 自定义工具(与 Forsion aiStudioAssetsService 同构)──────────
export interface SkillRecord {
  id: string;
  app_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  version: string | null;
  author: string | null;
  tools: any;
  content: string | null;
  visibility: string;
  is_builtin: boolean;
  is_user_visible: boolean;
  is_market_listed: boolean;
  is_default_enabled: boolean;
  sort_order: number;
  is_cross_app: boolean;
  required_apps: any;
  created_at: string;
  updated_at: string;
}

export interface CustomToolRecord {
  id: string;
  app_id: string;
  name: string;
  description: string | null;
  executor: 'http' | 'javascript';
  parameters: any;
  url_template: string | null;
  method: string | null;
  headers: any;
  code: string | null;
  is_builtin: boolean;
  is_user_visible: boolean;
  is_market_listed: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ListFilter {
  appId?: string;
  market?: boolean;
  visibleOnly?: boolean;
}
