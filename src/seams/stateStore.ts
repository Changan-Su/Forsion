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
}
