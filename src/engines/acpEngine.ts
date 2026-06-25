/**
 * 把一个外部 agent 当作 ACP（Agent Client Protocol）子进程驱动一整个 turn，并把它的事件翻译成 Tangu 的
 * AgentEvent（token/reasoning/tool_call/tool_result/usage）回灌 eventBus。Tangu 这里是 ACP **客户端**，
 * 不实现任何 loop/工具——loop/工具/上下文全在外部 agent 自己那边。
 *
 * 流程（见 SDK examples/client.js）：spawn → Writable/Readable.toWeb → ndJsonStream → ClientSideConnection
 *   → initialize → newSession → prompt（阻塞到 turn 结束，期间经 sessionUpdate 回调流式吐内容）。
 * 审批：ACP 的 session/request_permission（Client 回调）→ 复用 Tangu requestApproval（同审批弹窗/HTTP 端点）。
 *
 * 纯翻译逻辑抽成 createAcpClient(无进程)，单测直接喂伪造通知即可，见 acpEngine.test.ts。
 */
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type PermissionOption,
  type PermissionOptionKind,
} from '@agentclientprotocol/sdk';
import type { ToolCall } from '../core/types.js';
import type { ApprovalDecision } from '../services/approvals.js';
import type { EngineDef } from './config.js';
import type { EngineRunCtx, EngineResult, EngineCapabilities } from './manager.js';

/** createAcpClient 需要的最小上下文（EngineRunCtx 结构上即满足）。 */
export interface AcpClientCtx {
  signal: AbortSignal;
  publish: (type: string, payload: any) => void;
  requestApproval: (preview: string, toolCall: ToolCall) => Promise<ApprovalDecision>;
}

/** 从 ACP tool_call_update 的 content[] 抽人类可读文本（用于 tool_result）。 */
function toolUpdateText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === 'content' && c.content?.type === 'text') parts.push(c.content.text);
    else if (c?.type === 'diff') parts.push(`(diff ${c.path ?? ''})`);
  }
  return parts.join('\n');
}

/** ACP newSession.models（SessionModelState）→ Tangu 形状（modelId→id）。纯函数，供探测 + 单测。 */
export function mapAcpModels(ms: any): { models: EngineCapabilities['models']; currentModelId?: string } {
  const models = (ms?.availableModels || []).map((m: any) => ({
    id: m.modelId,
    name: m.name || m.modelId,
    description: m.description ?? undefined,
  }));
  return { models, currentModelId: ms?.currentModelId };
}

/** ACP available_commands_update.availableCommands → Tangu 形状（取 input.hint）。纯函数，供探测 + 单测。 */
export function mapAcpCommands(availableCommands: any): EngineCapabilities['commands'] {
  return (availableCommands || []).map((c: any) => ({
    name: c.name,
    description: c.description || '',
    hint: c.input?.hint,
  }));
}

/** Tangu 审批决定 → 选哪个 ACP 权限选项（按 kind 精确匹配，缺则回退同类首个）。 */
export function pickPermissionOption(options: PermissionOption[], action: ApprovalDecision['action']): string | null {
  if (!options.length) return null;
  const want: PermissionOptionKind =
    action === 'approve' ? 'allow_once' : action === 'approve_always' ? 'allow_always' : 'reject_once';
  const exact = options.find((o) => o.kind === want);
  if (exact) return exact.optionId;
  const prefix = action === 'reject' ? 'reject' : 'allow';
  const same = options.find((o) => o.kind.startsWith(prefix));
  return (same ?? options[0]).optionId;
}

/** 纯翻译器：返回实现了 ACP Client 的对象 + 取累积结果。无进程、无 SDK 连接，可单测。 */
export function createAcpClient(
  engineName: string,
  ctx: AcpClientCtx,
): { client: Client; result(): EngineResult } {
  let content = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  const toolResults: any[] = [];
  const toolNames = new Map<string, string>(); // toolCallId -> name（给 tool_result 补名）

  const client: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const u: any = params.update;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const t = u.content?.type === 'text' ? u.content.text : '';
          if (t) {
            content += t;
            ctx.publish('token', { delta: t });
          }
          break;
        }
        case 'agent_thought_chunk': {
          const t = u.content?.type === 'text' ? u.content.text : '';
          if (t) {
            reasoning += t;
            ctx.publish('reasoning', { delta: t });
          }
          break;
        }
        case 'tool_call': {
          const name = u.title || u.kind || 'tool';
          toolNames.set(u.toolCallId, name);
          const args = u.rawInput ? JSON.stringify(u.rawInput) : '{}';
          toolCalls.push({ id: u.toolCallId, type: 'function', function: { name, arguments: args } });
          ctx.publish('tool_call', { id: u.toolCallId, name, arguments: args, startedAt: Date.now() });
          break;
        }
        case 'tool_call_update': {
          if (u.status === 'completed' || u.status === 'failed') {
            const name = toolNames.get(u.toolCallId) || '';
            const result = toolUpdateText(u.content);
            const isError = u.status === 'failed';
            toolResults.push({ id: u.toolCallId, name, result, isError });
            ctx.publish('tool_result', { id: u.toolCallId, name, result, isError });
          }
          break;
        }
        case 'usage_update': {
          // 附带计：外部 run 跑用户自己的账号，仅展示，不进 Tangu 计费。
          const us = u.usage ?? u;
          ctx.publish('usage', {
            prompt: us.inputTokens ?? us.promptTokens ?? 0,
            completion: us.outputTokens ?? us.completionTokens ?? 0,
            total: us.totalTokens ?? 0,
          });
          break;
        }
        default:
          break; // plan / available_commands_update / mode 等：spike 忽略
      }
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      if (ctx.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const tc: any = params.toolCall;
      const title = tc?.title || tc?.kind || 'tool';
      const raw = tc?.rawInput;
      const preview = `[${engineName}] ${title}${raw ? ' · ' + JSON.stringify(raw).slice(0, 160) : ''}`;
      const synth: ToolCall = {
        id: tc?.toolCallId || 'acp',
        type: 'function',
        function: { name: title, arguments: raw ? JSON.stringify(raw) : '{}' },
      };
      const decision = await ctx.requestApproval(preview, synth);
      if (decision.action === 'reject') {
        const rej = pickPermissionOption(params.options, 'reject');
        return rej ? { outcome: { outcome: 'selected', optionId: rej } } : { outcome: { outcome: 'cancelled' } };
      }
      const optionId = pickPermissionOption(params.options, decision.action);
      return optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } };
    },
  };

  return {
    client,
    result: () => ({ content, reasoning, toolCalls, toolResults }),
  };
}

export async function runAcpEngine(def: EngineDef, ctx: EngineRunCtx): Promise<EngineResult> {
  const cwd = ctx.cwd || process.cwd();
  // host 能力下运行：继承父 env（等价于用户自己在终端跑 claude），叠加 def.env。适配器据此读 ANTHROPIC_API_KEY/~/.claude。
  // detached:true → 子进程自成进程组(pgid=child.pid);kill 时杀「整组」，连带 npx 衍生的真子进程(claude-code-acp)，
  // 否则只杀外层 npx、孙进程残留成孤儿。范本 ../tools/hostExec.ts。
  const child = spawn(def.command, def.args ?? [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...(def.env ?? {}) },
  });
  child.on('error', (e) => ctx.publish('status', { detail: `engine spawn error: ${e.message}` }));
  // 适配器把日志写 stderr；只做诊断，不进协议流。
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.warn(`[engine:${def.id}] ${s}`);
  });

  // 进程组 kill + SIGTERM→2s→SIGKILL 升级:先给 ACP 子进程优雅退出(flush)的机会，仍不退就强杀整组。
  // 负 pid = 杀整组；非 POSIX/拿不到 pid 时退回杀 child 本身(Windows 无 setsid/负 pid)。
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const killTree = (sig: NodeJS.Signals): void => {
    const pid = child.pid;
    try {
      if (pid && process.platform !== 'win32') process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  const killNow = (): void => {
    killTree('SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
  };
  child.once('exit', () => { if (killTimer) { clearTimeout(killTimer); killTimer = null; } });

  let sessionId = '';
  const onAbort = (): void => {
    try {
      if (sessionId) void conn.cancel({ sessionId });
    } catch {
      /* ignore */
    }
    killNow();
  };

  // 不活动看门狗:外部引擎 turn 若 ENGINE_IDLE_MS 内无任何事件回灌(子进程卡死/不回包)则中止整个 turn。
  // 阈值比直连流(120s)宽:外部 agent(Claude Code/Codex)可能长时间静默思考。审批期间停表(等用户不能误杀)。
  const ENGINE_IDLE_MS = Number(process.env.TANGU_ENGINE_IDLE_TIMEOUT_MS) || 300_000;
  let engineIdle: ReturnType<typeof setTimeout> | null = null;
  const armEngineIdle = (): void => {
    if (ctx.signal.aborted) return;
    if (engineIdle) clearTimeout(engineIdle);
    engineIdle = setTimeout(() => { try { onAbort(); } catch { /* ignore */ } }, ENGINE_IDLE_MS);
  };
  // 包一层 ctx:每次事件回灌续命；审批期间停表(审批不经 publish，等用户点批准不能被 idle 误杀)。
  const wrappedCtx: AcpClientCtx = {
    signal: ctx.signal,
    publish: (type, payload) => { armEngineIdle(); ctx.publish(type, payload); },
    requestApproval: async (preview, toolCall) => {
      if (engineIdle) { clearTimeout(engineIdle); engineIdle = null; }
      try { return await ctx.requestApproval(preview, toolCall); }
      finally { armEngineIdle(); }
    },
  };

  const { client, result } = createAcpClient(def.name, wrappedCtx);

  // Node web streams 与 SDK 期望的 DOM lib WritableStream/ReadableStream 类型不互认 → 转 unknown 过桥。
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const conn = new ClientSideConnection(() => client, stream);

  ctx.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // fs/terminal 不声明 → 外部 agent 用自带工具直接在 cwd 上做文件/命令操作（host 模式与 Tangu 一致）。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const s = await conn.newSession({ cwd, mcpServers: [] });
    sessionId = s.sessionId;
    // 应用用户为该引擎选的模型(若与当前不同);失败不阻断,用引擎默认继续。
    if (ctx.engineModelId && ctx.engineModelId !== (s as any).models?.currentModelId) {
      try {
        await conn.unstable_setSessionModel({ sessionId, modelId: ctx.engineModelId });
      } catch (e: any) {
        console.warn(`[engine] setSessionModel(${ctx.engineModelId}) failed: ${e?.message || e}`);
      }
    }
    armEngineIdle(); // turn 开始起表
    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: ctx.message }] });
    return { ...result(), stopReason: res.stopReason };
  } finally {
    if (engineIdle) clearTimeout(engineIdle);
    ctx.signal.removeEventListener('abort', onAbort);
    killNow();
  }
}

/**
 * 懒探测引擎能力:spawn → initialize → newSession(取 models) → 短窗口收一次 available_commands_update → dispose。
 * 不累积正文/不接审批(与 createAcpClient 区分);仅用于 UI 填模型/命令选择器。
 */
export async function probeAcpEngine(def: EngineDef): Promise<EngineCapabilities> {
  const child = spawn(def.command, def.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(def.env ?? {}) },
  });
  child.on('error', () => {});
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.warn(`[engine:${def.id}] (probe) ${s}`);
  });

  let commands: EngineCapabilities['commands'] = [];
  let resolveCommands: () => void = () => {};
  const commandsReceived = new Promise<void>((r) => {
    resolveCommands = r;
  });

  const client: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const u: any = params.update;
      if (u.sessionUpdate === 'available_commands_update') {
        commands = mapAcpCommands(u.availableCommands);
        resolveCommands();
      }
    },
    async requestPermission(): Promise<RequestPermissionResponse> {
      return { outcome: { outcome: 'cancelled' } }; // 探测不执行任何操作
    },
  };

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const conn = new ClientSideConnection(() => client, stream);

  try {
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const s = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
    const { models, currentModelId } = mapAcpModels((s as any).models);
    // 命令在 newSession 后异步到达;收到即返回,否则 1.5s 超时。
    await Promise.race([commandsReceived, new Promise<void>((r) => setTimeout(r, 1500))]);
    return { models, currentModelId, commands };
  } finally {
    child.kill();
  }
}
