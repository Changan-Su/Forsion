/**
 * 给外部引擎这一轮用的短命 MCP 桥:只开放宿主核准过的那组工具,每次调用先过 Forsion 的审批闸。
 *
 * 两类调用方:
 *  - 插件发起的任务(pluginToolNames / 只读白名单):照旧,不画卡、不限时。
 *  - 跑在外部引擎上的 Agent 的普通对话(底层第 3 步「交接」):`cards` + `budgetMs`。
 *
 * 为什么要限时(11-15 实测,方案目录 instrument/acp-bridge-timeout-probe.cjs):DSH 调一次外部工具最多等 60 秒,
 * 到点告诉模型 `Request timed out`、另发一条 notifications/cancelled 并断开连接 —— 但这座桥是无状态的(每个 HTTP
 * 请求一个 Server),取消通知落在另一个请求上,**正在跑的那次照样跑完**(实测 70 秒的调用在第 88 秒执行完)。
 * 审批卡挂着时更糟:用户 60 秒后点「允许」,工具才执行,模型却早以为失败了,重试一次就做两遍。
 * 所以每次调用在 budgetMs 内必回:没等到审批 / 没跑完就先回一个编号,模型再用 WAIT_TOOL 取结果
 * (每次取同样限时)。一轮结束(close)时撤掉还挂着的审批、中止还在跑的工具。
 *
 * DSH 对同名同参的连续调用在第 3、5、8 次提醒模型「换个办法或收尾」(dsh-repeat-tool-reminder),
 * 所以取结果的参数里带一个递增的 attempt,每次回话直接给出下一次的确切参数。
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveTools } from '../tools/toolRegistry.js';
import { executeTool, toolSourceOf } from '../tools/registry.js';
import { gateToolCall, type ApprovalDecision } from '../services/approvals.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { deps } from '../seams/runtime.js';
import { enterRunContext, setRunCwd } from '../seams/runContext.js';
import { isHtmlCardTool, LEGACY_HTML_CARD_TOOL } from '../tools/builtin/sketch.js';

/** 取结果的那个工具(只在带 budgetMs 的桥上有)。 */
export const WAIT_TOOL = 'forsion_wait';
/** DSH 等一次外部工具的上限是 60 秒(dsh-mcp-client 的 toolCallTimeoutMs,ACP 入口改不了);留出网络和排队的余量。 */
export const BRIDGE_CALL_BUDGET_MS = 45_000;
/** 交给模型的文本上限:超长的工具输出照 runLoop 落盘那样太重,这里截断并说明。 */
const MAX_TEXT_CHARS = 60_000;

export interface RunToolServerOptions {
  /** MCP 服务名。引擎把工具叫作 `mcp__<name>__<工具>`(DSH 的 publicToolName),界面据此认出哪些调用是桥里的。 */
  name?: string;
  /** 跑这一轮的 Agent(记忆域 / 展示身份)。HTTP 回调不在 run 的异步链上,不带的话 remember 之类会落到缺省 Agent。 */
  memorySlug?: string;
  agentSlug?: string;
  /** 卡片由 Forsion 自己画:桥里执行的工具按 Tangu 的原名发 tool_call / tool_result,并收进 calls / results 落库。
   *  contentOffset = 这一刻回答正文的长度(卡片在正文里的位置,重开对话时据此排回去)。 */
  cards?: { publish: (type: string, payload: any) => void; contentOffset: () => number };
  /** 每次调用最多占用多久(毫秒);超了先回编号。不给 = 一直等(插件任务,照旧)。 */
  budgetMs?: number;
}

type Outcome = { text: string; isError: boolean };
interface Ticket { id: string; tool: string; phase: 'approval' | 'running'; job: Promise<Outcome>; settled?: Outcome; attempt: number }

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, ms); t.unref?.();
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** 对外发、落库都按线上的名字(HTML 卡叫 sketch,同 runLoop 的 wireToolName)。 */
const wireName = (name: string): string => (isHtmlCardTool(name) ? LEGACY_HTML_CARD_TOOL : name);

export async function createRunToolServer(ctx: ToolContext & { runId: string }, names: string[], opts: RunToolServerOptions = {}) {
  const token = randomBytes(32).toString('hex');
  const serverName = opts.name || 'forsion_task';
  // 这座桥自己的中止:跟着 run 的信号走,close 时也中止 —— 撤掉挂着的审批、停下还在跑的工具。
  const life = new AbortController();
  const onRunAbort = () => life.abort();
  if (ctx.signal?.aborted) life.abort(); else ctx.signal?.addEventListener('abort', onRunAbort, { once: true });
  const live = () => !life.signal.aborted;
  const toolCtx: ToolContext & { runId: string } = { ...ctx, signal: life.signal };
  const allowed = () => new Map([...resolveTools(deps().profile, toolCtx)].filter(([n]) => names.includes(n)));
  const open = new Set<Server>();
  const tickets = new Map<string, Ticket>();
  let ticketSeq = 0;
  const calls: any[] = [];
  const results: any[] = [];
  const budget = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : undefined;

  const enter = () => {
    enterRunContext(ctx.userId, ctx.runId, opts.memorySlug, opts.agentSlug);
    if (ctx.cwd) setRunCwd(ctx.cwd);
  };

  /** 审批 + 执行一次。卡片事件在这里发,结果在这里收(不管模型等没等到)。 */
  const runCall = (name: string, args: Record<string, unknown>, onPhase: (p: Ticket['phase']) => void): Promise<Outcome> => {
    const id = randomUUID();
    const call = { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args || {}) } };
    const startedAt = Date.now();
    const source = (() => { try { return toolSourceOf(name, toolCtx); } catch { return 'plugin' as const; } })();
    if (opts.cards) {
      calls.push({ ...call, function: { ...call.function, name: wireName(name) }, ui_content_offset: opts.cards.contentOffset() });
      opts.cards.publish('tool_call', { id, name: wireName(name), arguments: call.function.arguments, startedAt, source });
    }
    const finish = (text: string, isError: boolean, extra: { metadata?: any; artifactPath?: string } = {}): Outcome => {
      const capped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Output truncated: ${text.length} characters in total.]` : text;
      if (opts.cards) {
        const elapsedMs = Date.now() - startedAt;
        results.push({ tool_call_id: id, name: wireName(name), content: capped, isError, startedAt, elapsedMs, outputChars: capped.length, ...(extra.artifactPath ? { artifactPath: extra.artifactPath } : {}) });
        opts.cards.publish('tool_result', { id, name: wireName(name), result: capped, isError, startedAt, elapsedMs, outputChars: capped.length, source, ...extra });
      }
      return { text: capped, isError };
    };
    return (async (): Promise<Outcome> => {
      enter();
      try {
        const decision: ApprovalDecision = await gateToolCall(ctx.runId, call, {
          sessionId: ctx.sessionId, userId: ctx.userId, execMode: 'host', cwd: ctx.cwd, approvalMode: ctx.approvalMode,
          modeSessionId: ctx.approvalModeSessionId ?? ctx.sessionId, profile: ctx.profile, agentSlug: opts.agentSlug, projectPath: ctx.projectPath,
        }, life.signal);
        if (decision.action === 'reject') return finish(decision.rejectReason || 'The user denied this tool call.', true);
        life.signal.throwIfAborted();
        if (!allowed().has(name)) return finish('Tool is no longer available.', true);
        onPhase('running');
        const approved = decision.argsOverride ? { ...call, function: { ...call.function, arguments: JSON.stringify(decision.argsOverride) } } : call;
        const result = await executeTool(approved, { ...toolCtx, toolCallId: id });
        return finish(String(result.result), !!result.isError, { metadata: result.metadata, artifactPath: result.artifactPath });
      } catch (e: any) {
        const stopped = life.signal.aborted;
        return finish(stopped ? 'Stopped: this turn ended before the tool call finished.' : `Error: ${e?.message || e}`, true);
      }
    })();
  };

  /** 限时等一个结果;没等到就把它挂成编号(或更新编号),回一段告诉模型怎么取的话。 */
  const awaitOrTicket = async (job: Promise<Outcome>, ticket: Ticket | null, make: () => Ticket): Promise<{ text: string; isError: boolean }> => {
    if (!budget) return job;
    const done = await Promise.race([job.then((o) => ({ o })), sleep(budget, life.signal).then(() => null)]);
    if (done) { if (ticket) tickets.delete(ticket.id); return done.o; }
    if (!live()) return { text: 'Stopped: this turn ended before the tool call finished.', isError: true };
    const t = ticket ?? make();
    t.attempt += 1;
    const waiting = t.phase === 'approval' ? 'is waiting for the user to approve it in Forsion' : 'is still running';
    return {
      isError: false,
      text: `Pending: ${t.tool} ${waiting} (ticket ${t.id}). It was not lost and must not be called again. `
        + `Call ${WAIT_TOOL} with {"ticket":"${t.id}","attempt":${t.attempt}} to wait for its result. `
        + 'Do not end your turn while a ticket is pending.',
    };
  };

  const http = createServer(async (req, res) => {
    const got = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${token}`);
    if (!live() || req.method !== 'POST' || req.url !== '/mcp' || got.length !== expected.length || !timingSafeEqual(got, expected)) { res.writeHead(403).end(); return; }
    const server = new Server({ name: 'forsion-task', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    open.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      enter();
      const tools = [...allowed().values()].map(t => ({ name: t.name, description: t.definition.function.description, inputSchema: t.definition.function.parameters }));
      if (budget) tools.push({
        name: WAIT_TOOL,
        description: 'Wait for the result of a Forsion tool call that answered with a pending ticket (it is waiting for the user\'s approval or still running). '
          + `Waits up to about ${Math.round(budget / 1000)} seconds. If it is still pending, the answer gives the exact arguments for the next call.`,
        inputSchema: { type: 'object', properties: { ticket: { type: 'string', description: 'The ticket from the pending answer, e.g. "T1".' }, attempt: { type: 'number', description: 'The attempt number given in the pending answer.' } }, required: ['ticket'] } as any,
      });
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (!live()) throw new Error('Tool is unavailable');
      const name = request.params.name;
      const args = (request.params.arguments || {}) as Record<string, unknown>;
      if (budget && name === WAIT_TOOL) {
        const t = tickets.get(String(args.ticket ?? ''));
        if (!t) return { isError: true, content: [{ type: 'text', text: `Unknown or already collected ticket: ${String(args.ticket ?? '')}.` }] };
        const out = await awaitOrTicket(t.job, t, () => t);
        return { isError: out.isError, content: [{ type: 'text', text: out.text }] };
      }
      if (!allowed().has(name)) throw new Error('Tool is unavailable');
      let phase: Ticket['phase'] = 'approval';
      let ticketRef: Ticket | null = null;
      const job = runCall(name, args, (p) => { phase = p; if (ticketRef) ticketRef.phase = p; });
      const out = await awaitOrTicket(job, null, () => {
        const t: Ticket = { id: `T${++ticketSeq}`, tool: name, phase, job, attempt: 0 };
        void job.then((o) => { t.settled = o; });
        tickets.set(t.id, t); ticketRef = t; return t;
      });
      return { isError: out.isError, content: [{ type: 'text', text: out.text }] };
    });
    try {
      let raw = ''; for await (const b of req) { raw += b; if (raw.length > 1024 * 1024) throw new Error('Request too large'); }
      await server.connect(transport); await transport.handleRequest(req, res, JSON.parse(raw));
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
    finally { await server.close(); open.delete(server); }
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const port = (http.address() as { port: number }).port;
  return {
    server: { type: 'http' as const, name: serverName, url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    /** 引擎那边这座桥的工具名前缀(`mcp__<服务名>__`):引擎自己的工具卡据此认出桥里的调用、不再画第二张。 */
    toolPrefix: `mcp__${serverName}__`,
    /** 桥里执行过的调用(runLoop 的落库形状:tool_calls 带 ui_content_offset,tool_results 按 tool_call_id 配)。 */
    calls: () => [...calls],
    results: () => [...results],
    /** 还没取走结果的编号数(收尾时说明用)。 */
    pendingTickets: () => [...tickets.values()].filter((t) => !t.settled).length,
    async close() {
      life.abort();
      ctx.signal?.removeEventListener('abort', onRunAbort);
      // 挂着的审批随 life 撤回、在跑的工具随 life 中止;等它们把终态卡片发完再关(最多 3 秒,别吊住收尾)。
      await Promise.race([Promise.allSettled([...tickets.values()].map((t) => t.job)), new Promise((r) => { const x = setTimeout(r, 3000); x.unref?.(); })]);
      await Promise.allSettled([...open].map(s => s.close())); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r()));
    },
  };
}
