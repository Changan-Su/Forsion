/**
 * HttpStateStore —— StateStore 的 HTTP 实现(thin worker 专用)。
 *
 * worker 不持 DB:run/session/event 状态全经 server `/api/agent-state/*`。鉴权用 **per-dispatch token**
 * (网关派发时铸,按 userId scope);worker 不持 JWT_SECRET。token 按 runId/sessionId 登记(createRun 时
 * 绑定;handler 期回退到请求 ALS token),由 currentToken() 供 httpBrain 取当前 run 的 token。
 *
 * 设计要点:
 *   - 同步方法(gate 正确性:createRun/getRun/hydrate/finalize/终态 status/session 读写)= 直接请求响应。
 *   - append-only(事件/步骤/非终态 status)= 入 per-run 批量缓冲,按阈值/定时 flush(NDJSON 批),
 *     drain() = flush 余量 + 等 server ack(防 done 空尾)。校验 P4/P5。
 *   - **token 不靠 ALS 长连**:批量缓冲在创建时捕获 token 存入条目,定时 flush 用存的 token(校验 P3)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentRunId } from '../../seams/runContext.js';
import { LlmError } from '../../core/types.js';
import type { AgentRun } from '../runStore.js';
import type {
  ActiveRunRow,
  FinalizeMessageInput,
  RawMessageRow,
  StateStore,
  StepInput,
  StepRow,
} from '../../seams/stateStore.js';

// ── per-dispatch token 登记表(runId/sessionId → token) + 请求期回退 ALS ──
interface TokenEntry { token: string; }
const byRun = new Map<string, TokenEntry>();
const bySession = new Map<string, TokenEntry>();
const requestToken = new AsyncLocalStorage<string>();

/** 网关派发的请求期:把 Authorization token 注入本请求异步子树(handler 期 state 调用回退取它)。 */
export function enterRequestToken(token: string): void { requestToken.enterWith(token); }
/** createRun 时把 token 绑到 runId + sessionId(异步 loop 期据此取)。 */
export function bindRunToken(runId: string, sessionId: string, token: string): void {
  const e: TokenEntry = { token };
  byRun.set(runId, e);
  if (sessionId) bySession.set(sessionId, e);
}
/** token 续期:更新该 run 的 token(maps 共享 entry,sessionId 同步生效)。 */
export function refreshRunToken(runId: string, token: string): void {
  const e = byRun.get(runId);
  if (e) e.token = token;
}
export function dropRunToken(runId: string, sessionId?: string): void {
  byRun.delete(runId);
  if (sessionId) bySession.delete(sessionId);
}
function tokenForRun(runId?: string): string | undefined {
  return (runId ? byRun.get(runId)?.token : undefined) || requestToken.getStore();
}
function tokenForSession(sessionId?: string): string | undefined {
  return (sessionId ? bySession.get(sessionId)?.token : undefined) || requestToken.getStore();
}
/** 当前 run(ALS runId)的 token —— 供 worker 的 httpBrain.token 取。 */
export function currentToken(): string | undefined { return tokenForRun(currentRunId()); }

export interface HttpStateStoreConfig {
  cloudUrl: string; // 形如 https://server(无尾斜杠)
  /** fleet 通道密钥(与网关/server 共享):证明本进程是 fleet worker,随每个 state-API 请求发 X-Fleet-Auth。 */
  fleetSecret?: string;
}

type Frame =
  | { kind: 'event'; type: string; payload: any }
  | { kind: 'step'; step: StepInput }
  | { kind: 'status'; status: string };

interface RunBuffer {
  token: string; // 创建时捕获(不靠 flush 期 ALS)
  frames: Frame[];
  chain: Promise<void>; // per-run flush 串行链(保 server 端定序)
  timer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_THRESHOLD = 64; // 帧数阈值
const FLUSH_INTERVAL_MS = 120;
const TERMINAL = new Set(['done', 'failed', 'aborted']);
// flush 有界重试:此前单次 POST 失败即吞掉 → 丢帧;尤其 'done' 终态帧丢失会让客户端 SSE 永远等不到
// 结束、看着像「卡死」(实际 run 已完成)。重试几次仍失败才放弃记日志(避免无限阻塞 flush 链)。
const FLUSH_MAX_RETRY = 3;
const FLUSH_RETRY_BASE_MS = 200; // 线性退避:200/400ms
// state-API 请求超时:此前 reqJson 裸 fetch 无超时,server/网络挂死则该调用无限 await(连带 run 卡住、
// session 串行队列后续 run 全堵)。默认 30s,env 可调。
const STATE_TIMEOUT_MS = Number(process.env.TANGU_STATE_HTTP_TIMEOUT_MS) || 30_000;

/** 解码 JWT 的 exp(秒)→ 毫秒;失败 null。仅读不验(token 由网关签发,worker 信任之)。 */
function decodeExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch { return null; }
}

export function createHttpStateStore(cfg: HttpStateStoreConfig): StateStore {
  const base = cfg.cloudUrl.replace(/\/+$/, '') + '/api/agent-state';
  const buffers = new Map<string, RunBuffer>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const headers = (token: string | undefined): Record<string, string> => {
    const h: Record<string, string> = {
      Authorization: `Bearer ${token ?? ''}`,
      'Content-Type': 'application/json',
    };
    if (cfg.fleetSecret) h['X-Fleet-Auth'] = cfg.fleetSecret; // fleet 通道凭证:证明是 fleet worker
    return h;
  };

  async function reqJson<T>(method: string, path: string, token: string | undefined, body?: any): Promise<T> {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: headers(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    });
    if (r.status === 404) return null as unknown as T;
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `agent-state ${method} ${path} ${r.status}`);
    }
    const txt = await r.text();
    return (txt ? JSON.parse(txt) : null) as T;
  }

  // ── 批量通道 ──
  function bufFor(runId: string): RunBuffer {
    let b = buffers.get(runId);
    if (!b) {
      b = { token: tokenForRun(runId) ?? '', frames: [], chain: Promise.resolve(), timer: null };
      buffers.set(runId, b);
    }
    // token 可能在 createRun 后才绑定/续期 → 每次取最新
    const t = tokenForRun(runId);
    if (t) b.token = t;
    return b;
  }
  function scheduleFlush(runId: string): void {
    const b = buffers.get(runId);
    if (!b) return;
    if (b.frames.length >= FLUSH_THRESHOLD) { void flush(runId); return; }
    if (!b.timer) {
      b.timer = setTimeout(() => { void flush(runId); }, FLUSH_INTERVAL_MS);
      if (typeof b.timer.unref === 'function') b.timer.unref();
    }
  }
  function flush(runId: string): Promise<void> {
    const b = buffers.get(runId);
    if (!b) return Promise.resolve();
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    if (!b.frames.length) return b.chain;
    const frames = b.frames;
    b.frames = [];
    const token = b.token;
    b.chain = b.chain.then(async () => {
      // 投递语义 = at-least-once:若 server 已提交但响应丢失(超时),重试会重发 → 该批帧可能在 SSE
      // 回放里重复(append-only 无幂等键)。这是少见的"重复 token/状态"显示态,远好于此前的丢帧
      // (丢 'done' → 客户端永远等不到结束=卡死)。如需精确一次,后续在 server 侧按 (runId, frameSeq) 去重。
      for (let attempt = 0; attempt < FLUSH_MAX_RETRY; attempt++) {
        try {
          await reqJson('POST', `/runs/${encodeURIComponent(runId)}/stream`, token, { frames });
          return;
        } catch (err: any) {
          if (attempt === FLUSH_MAX_RETRY - 1) {
            console.error(`[tangu-worker] flush events failed run=${runId} (放弃,共 ${FLUSH_MAX_RETRY} 次):`, err?.message || err);
            return;
          }
          await new Promise((res) => setTimeout(res, FLUSH_RETRY_BASE_MS * (attempt + 1)));
        }
      }
    });
    return b.chain;
  }
  function enqueue(runId: string, frame: Frame): void {
    const b = bufFor(runId);
    b.frames.push(frame);
    scheduleFlush(runId);
  }

  // ── per-dispatch token 续期(长 run 跨 TTL):在 ~80% TTL 处向 server 换新 token ──
  function clearRefresh(runId: string): void {
    const t = refreshTimers.get(runId);
    if (t) { clearTimeout(t); refreshTimers.delete(runId); }
  }
  function scheduleRefresh(runId: string, sessionId: string): void {
    clearRefresh(runId);
    const token = bufFor(runId).token || tokenForRun(runId);
    if (!token) return;
    const expMs = decodeExpMs(token);
    if (!expMs) return;
    const delay = Math.max(5_000, (expMs - Date.now()) * 0.8);
    const timer = setTimeout(async () => {
      try {
        const cur = tokenForRun(runId);
        const r = await reqJson<{ token: string }>('POST', '/token/refresh', cur);
        if (r?.token) {
          refreshRunToken(runId, r.token);
          scheduleRefresh(runId, sessionId); // 链式续期
        }
      } catch (err: any) {
        console.warn(`[tangu-worker] token refresh failed run=${runId}:`, err?.message || err);
      }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    refreshTimers.set(runId, timer);
  }

  return {
    // ── runs ──
    async createRun(run) {
      const token = tokenForSession(run.sessionId);
      if (token) bindRunToken(run.id, run.sessionId, token);
      await reqJson('POST', '/runs', token, {
        id: run.id, sessionId: run.sessionId, appId: run.appId, modelId: run.modelId,
        assistantMessageId: run.assistantMessageId, input: run.input,
      });
      scheduleRefresh(run.id, run.sessionId); // 长 run 跨 TTL 自动续期
    },
    async getRun(id): Promise<AgentRun | null> {
      return await reqJson<AgentRun | null>('GET', `/runs/${encodeURIComponent(id)}`, tokenForRun(id));
    },
    async getRunForUser(id, _userId): Promise<AgentRun | null> {
      // server 已按 token userId scope;userId 参数冗余。
      return await reqJson<AgentRun | null>('GET', `/runs/${encodeURIComponent(id)}`, tokenForRun(id));
    },
    async updateRunStatus(id, status, extra) {
      if (TERMINAL.has(status)) {
        await flush(id); // 终态前确保 append-only 帧已上报有序
        await reqJson('POST', `/runs/${encodeURIComponent(id)}/status`, tokenForRun(id), { status, ...extra });
        clearRefresh(id);
        buffers.delete(id);
        dropRunToken(id);
      } else {
        enqueue(id, { kind: 'status', status }); // running 等非终态:批量 fire-and-forget
      }
    },
    async listActiveRunsBySession(sessionId, _userId): Promise<ActiveRunRow[]> {
      return (await reqJson<ActiveRunRow[]>('GET', `/sessions/${encodeURIComponent(sessionId)}/active-runs`, tokenForSession(sessionId))) || [];
    },
    async listPendingRunsForRecovery() { throw new Error('listPendingRunsForRecovery 不在 thin worker 可用(recovery 由 server 侧负责)'); },
    async failStaleRuns() { throw new Error('failStaleRuns 不在 thin worker 可用'); },

    // ── steps ──
    async appendStep(step: StepInput) { enqueue(step.runId, { kind: 'step', step }); },
    async listSteps(runId): Promise<StepRow[]> {
      return (await reqJson<StepRow[]>('GET', `/runs/${encodeURIComponent(runId)}/steps`, tokenForRun(runId))) || [];
    },

    // ── events ──
    async appendEvent(runId, type, payload): Promise<number> {
      enqueue(runId, { kind: 'event', type, payload });
      return 0; // 真实 seq 由 server 分配;worker 侧返回值无人依赖
    },
    async drain(runId): Promise<void> { await flush(runId); },
    async listEventsFrom() { throw new Error('listEventsFrom 不在 thin worker 可用(SSE 由 server 服务)'); },

    // ── messages ──
    async countSessionMessages(sessionId): Promise<number> {
      const r = await reqJson<{ count: number }>('GET', `/sessions/${encodeURIComponent(sessionId)}/message-count`, tokenForSession(sessionId));
      return Number(r?.count || 0);
    },
    async listSessionMessagesWindow(sessionId, limit, offset): Promise<RawMessageRow[]> {
      return (await reqJson<RawMessageRow[]>('GET', `/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`, tokenForSession(sessionId))) || [];
    },
    async insertUserMessage(m) {
      await reqJson('POST', `/sessions/${encodeURIComponent(m.sessionId)}/user-message`, tokenForSession(m.sessionId), {
        id: m.id, content: m.content, modelId: m.modelId, attachments: m.attachments,
      });
    },
    async finalizeAssistantMessage(m: FinalizeMessageInput) {
      await reqJson('POST', `/sessions/${encodeURIComponent(m.sessionId)}/assistant-message`, tokenForSession(m.sessionId), {
        messageId: m.messageId, modelId: m.modelId, content: m.content, reasoning: m.reasoning,
        toolCalls: m.toolCalls, toolResults: m.toolResults, displayFiles: m.displayFiles, agentSlug: m.agentSlug,
      });
    },

    // ── sessions ──
    async getSessionOwner(sessionId): Promise<string | null> {
      const r = await reqJson<{ owner: string | null }>('GET', `/sessions/${encodeURIComponent(sessionId)}/owner`, tokenForSession(sessionId));
      return r?.owner ?? null;
    },
    async autoCreateSession(s) {
      await reqJson('POST', '/sessions', tokenForSession(s.id), { id: s.id, appId: s.appId, title: s.title, modelId: s.modelId });
    },
    async loadTodos(sessionId) {
      const r = await reqJson<{ todos: any }>('GET', `/sessions/${encodeURIComponent(sessionId)}/todos`, tokenForSession(sessionId));
      return r?.todos;
    },
    async writeTodos(sessionId, todosJson) {
      await reqJson('POST', `/sessions/${encodeURIComponent(sessionId)}/todos`, tokenForSession(sessionId), { todos: todosJson });
    },
    async getAgentConfig(sessionId) {
      const r = await reqJson<{ agentConfig: any }>('GET', `/sessions/${encodeURIComponent(sessionId)}/agent-config`, tokenForSession(sessionId));
      return r?.agentConfig;
    },
    async setAgentConfig(sessionId, agentConfigJson) {
      await reqJson('POST', `/sessions/${encodeURIComponent(sessionId)}/agent-config`, tokenForSession(sessionId), { agentConfig: agentConfigJson });
    },
  };
}
