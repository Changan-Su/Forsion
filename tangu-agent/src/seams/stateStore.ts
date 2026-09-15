/**
 * 状态存储接缝（StateStore）—— worker 执行路径触达的全部「运行态/会话态」读写。
 *
 * 背景:thin worker 不持 Postgres,run/session/event 状态经 HTTP 向 server 索取/上报。把 core 里散落的
 * 直连 SQL(runStore / eventBus / agentLoop 内联 / todo / interaction / runs.ts)收敛到本接缝,两份实现:
 *   - SqlStateStore(默认):今天的 SQL 原样,经 deps().host.query。microserver / standalone / TUI / 网关 /
 *     server 状态端点 都用它 → **行为零变化**。
 *   - HttpStateStore(thin worker):每方法 = 调 server /api/agent-state/*(带 per-run token);append-only 的
 *     事件/步骤/非终态状态走单 run NDJSON 流式通道。
 *
 * 设计:本接缝**只做状态 op**,不含 app 逻辑(消息塑形、窗口计算留在 agentLoop)。事件的内存 emit/订阅
 * (SSE 实时扇出)仍在 eventBus(纯服务端);SqlStateStore.appendEvent 透传到 eventBus 的本地机制。
 */
import type { AgentRun } from '../services/runStore.js';
import type { AgentEvent } from '../services/eventBus.js';
import type { SessionHit, SessionSearchInput, SessionTranscript, SessionTranscriptInput } from '../services/sessionSearch.js';

export interface StepInput {
  id: string;
  runId: string;
  stepNo: number;
  llmRequest?: any;
  llmResponse?: any;
  toolCalls?: any;
  toolResults?: any;
  stateDelta?: any;
}

export interface StepRow {
  stepNo: number;
  llmResponse: any;
  toolCalls: any;
  toolResults: any;
  createdAt: string | null;
}

/** B3(跨 run 回放交错重建):一条 assistant 消息背后、其 run 的某一轮步骤。
 *  只取重建所需三列 —— tool_results 不取(结果一律从 chat_messages 行拿,免得 hydrate 把大结果读两遍)。 */
export interface MessageStepRow {
  /** agent_runs.assistant_message_id —— 与 chat_messages.id 对齐。 */
  messageId: string;
  stepNo: number;
  llmResponse: any;
  toolCalls: any;
}

export interface ActiveRunRow {
  id: string;
  status: string;
  assistant_message_id: string | null;
}

/** hydrate 用的原始消息行（塑形/截断/图片 parts 在 agentLoop 做）。 */
export interface RawMessageRow {
  id: string;
  role: string;
  content: string | null;
  tool_calls: any;
  tool_results?: any;
  attachments: any;
  /** 消息时间戳(ms)；压缩检查点 hydrate 用。本地 sqlStateStore 填充；httpStateStore 可能缺（则压缩检查点在 worker 退化为 no-op，fail-safe）。 */
  timestamp?: number;
}

export interface FinalizeMessageInput {
  messageId: string;
  sessionId: string;
  modelId: string;
  content: string;
  reasoning: string;
  toolCalls: any[];
  toolResults: any[];
  /** agent 在对话区展示给用户的文件(DisplayFileItem[];path 或 dataUrl)。缺省/空=不写。 */
  displayFiles?: any[];
  /** 产出这条消息的 agent slug —— 客户端按它还原头像/昵称(否则重载只能回退到「会话默认 agent」)。 */
  agentSlug?: string;
}

export interface StateStore {
  // ── runs ──
  createRun(run: {
    id: string;
    sessionId: string;
    userId: string;
    appId: string;
    modelId: string;
    assistantMessageId: string;
    input: any;
  }): Promise<void>;
  getRun(id: string): Promise<AgentRun | null>;
  getRunForUser(id: string, userId: string): Promise<AgentRun | null>;
  updateRunStatus(
    id: string,
    status: string,
    extra?: { result?: any; error?: string; currentStep?: number; tokensTotal?: number },
  ): Promise<void>;
  listActiveRunsBySession(sessionId: string, userId: string): Promise<ActiveRunRow[]>;
  /** 进程重启自愈（仅持库进程调;worker 关掉）。 */
  listPendingRunsForRecovery(): Promise<Array<{ id: string; session_id: string }>>;
  failStaleRuns(olderThanMinutes?: number): Promise<number>;

  // ── steps ──
  appendStep(step: StepInput): Promise<void>;
  listSteps(runId: string): Promise<StepRow[]>;
  /** 可选(B3):按 assistant 消息 id 批量取其 run 的分步记录,供 hydrate 重建在线时的
   *  assistant→tool→assistant 交错。**未实现即优雅降级**:thin worker 没有对应的
   *  /api/agent-state 端点,回放退回扁平形态(= 2026-09 之前的行为),只是少一截缓存前缀。 */
  listStepsForMessages?(sessionId: string, messageIds: string[]): Promise<MessageStepRow[]>;

  // ── events ──
  /** 分配 seq + 持久化 + 实时 emit(SqlStateStore);worker 写 NDJSON 通道。返回 seq。 */
  appendEvent(runId: string, type: string, payload: any): Promise<number>;
  /** 等待该 run 已发布事件全部落库/上报(finalize/done 前调用,防空尾)。 */
  drain(runId: string): Promise<void>;
  /** SSE 回放(seq>fromSeq)。仅服务端用;worker 不调。 */
  listEventsFrom(runId: string, fromSeq: number): Promise<AgentEvent[]>;

  // ── messages（会话历史）──
  countSessionMessages(sessionId: string): Promise<number>;
  listSessionMessagesWindow(sessionId: string, limit: number, offset: number): Promise<RawMessageRow[]>;
  insertUserMessage(m: {
    id: string;
    sessionId: string;
    content: string;
    modelId: string;
    attachments: any[] | null;
  }): Promise<void>;
  finalizeAssistantMessage(m: FinalizeMessageInput): Promise<void>;

  // ── sessions ──
  /** 返回 session 的 owner userId(不存在=null);供 runs.ts 起 run 前校验。 */
  getSessionOwner(sessionId: string): Promise<string | null>;
  autoCreateSession(s: { id: string; userId: string; appId: string; title: string; modelId: string }): Promise<void>;
  /** chat_sessions.todos 原始值(JSON 字符串或对象;调用方解析）。 */
  loadTodos(sessionId: string): Promise<any>;
  writeTodos(sessionId: string, todosJson: string): Promise<void>;
  /** chat_sessions.agent_config 原始值。 */
  getAgentConfig(sessionId: string): Promise<any>;
  setAgentConfig(sessionId: string, agentConfigJson: string): Promise<void>;

  // ── session recall(工具 search_sessions / read_session 与记忆召回的历史段)──
  // 2026-09-13 前这两条直连 core/db.js → thin worker(云端 Web / 移动端)整体抛错。SQL 本体在
  // services/sessionSearchSql.ts;HttpStateStore 经网关 /api/agent-state/sessions/* 代查(归属仍按 token userId)。
  /** 检索/列出会话(语义正典见 services/sessionSearch.ts 头注)。 */
  searchSessions(input: SessionSearchInput): Promise<SessionHit[]>;
  /** 另一会话的会话头 + 一页原始消息(最新在前;塑形在 read_session 工具)。 */
  readSessionTranscript(input: SessionTranscriptInput): Promise<SessionTranscript>;
}
