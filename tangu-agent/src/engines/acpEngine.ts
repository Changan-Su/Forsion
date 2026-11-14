/**
 * 把一个外部 agent 当作 ACP（Agent Client Protocol）子进程驱动一整个 turn，并把它的事件翻译成 Tangu 的
 * AgentEvent（token/reasoning/tool_call/tool_result/usage）回灌 eventBus。Tangu 这里是 ACP **客户端**，
 * 不实现任何 loop/工具——loop/工具/上下文全在外部 agent 自己那边。
 *
 * 流程（见 SDK examples/client.js）：spawn → Writable/Readable.toWeb → ndJsonStream → ClientSideConnection
 *   → initialize → newSession（或续接上一轮的会话）→ prompt（阻塞到 turn 结束，期间经 sessionUpdate 回调流式吐内容）。
 * 续接:一 run 一进程,所以「第二句记得第一句」靠引擎自己存的会话 —— 引擎报 `loadSession` 就走 session/load(回放的旧
 *   消息丢掉不上屏),只报 `sessionCapabilities.resume` 的(DSH)走 session/resume(不回放)。
 * 模型:引擎给 `models` 的走 session/set_model;把模型和思考档放在 `configOptions` 里的(DSH)走 session/set_config_option。
 * 审批：ACP 的 session/request_permission（Client 回调）→ 复用 Tangu requestApproval（同审批弹窗/HTTP 端点）。
 *
 * 纯翻译逻辑抽成 createAcpClient(无进程)，单测直接喂伪造通知即可，见 acpEngine.test.ts。
 */
import { spawn, type ChildProcess } from 'node:child_process';
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
import { envWithFullPath, type EngineDef } from './config.js';
import type { EngineRunCtx, EngineResult, EngineCapabilities } from './manager.js';
import { toolSubprocessEnv } from '../sandbox/credentialEnv.js';
import { killProcessTree } from '../utils/boundedProcess.js';

/** createAcpClient 需要的最小上下文（EngineRunCtx 结构上即满足）。 */
export interface AcpClientCtx {
  replaying?: () => boolean;
  signal: AbortSignal;
  publish: (type: string, payload: any) => void;
  requestApproval: (preview: string, toolCall: ToolCall) => Promise<ApprovalDecision>;
}

/** 引擎握手上限:spawn + initialize + newSession 若在此窗口内没完成(子进程卡死/Windows 上 .cmd shim spawn
 *  失败永不吐 stdout)就放弃,避免切换引擎时 UI 无限转圈。冷启 `npx -y` 首次下载较慢 → 给足 30s,可经 env 调。 */
const HANDSHAKE_TIMEOUT_MS = Number(process.env.TANGU_ENGINE_HANDSHAKE_TIMEOUT_MS) || 30_000;

/** 跨平台起引擎子进程。Windows 上 npx/claude/codex 等是 .cmd 批处理 shim,spawn 不带 shell 无法执行
 *  (Node CVE-2024-27980 后更是硬拒 .cmd)→ win32 必须 shell:true 交 cmd.exe 解析,这正是「切换外部 CLI 在
 *  Windows 卡死」的根因。args:内置引擎为常量;自定义引擎取自用户本机 engines.json(host-only,等价用户自己
 *  在终端敲命令),非远程注入面。windowsHide 避免弹控制台窗口。POSIX 上 shell=false、detached 组杀行为照旧。
 *  env:PATH 先补全(envWithFullPath)——GUI 启动的 Electron 只有 launchd 精简 PATH,`openclaw`/`pi` 这类全局 bin
 *  在终端跑得起、装成 App 就 ENOENT;检测端 binOnPath 早就扫这些目录了,spawn 端不补就是「检测说有、跑起来没有」。 */
export function spawnEngine(def: EngineDef, opts?: { cwd?: string; detached?: boolean }) {
  return spawn(def.command, def.args ?? [], {
    cwd: opts?.cwd,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], // 元组字面量 → 非空 stdin/stdout 流类型
    // 剥引擎凭据(C2):外部 CLI 跑模型驱动的命令,拿到 forsion_token / 本机令牌就能绕过本引擎直调云端与本机端点。
    // 在**合成之后**再剥:引擎清单的 def.env 也不许把这些键加回来。
    env: toolSubprocessEnv({ ...envWithFullPath(process.env), ...(def.env ?? {}) }),
    shell: process.platform === 'win32',
    windowsHide: true,
    // DETACHED_PROCESS cancels windowsHide and loses grandchild stdout on Windows.
    detached: process.platform !== 'win32' && (opts?.detached ?? false),
  });
}

/** 起不来的子进程要立刻让握手失败,别让用户干等 30s。两种形态都得盯:
 *  ① spawn 报错(命令不存在 / Windows 无 shell);
 *  ② **进程起来了,但握手前自己退了** —— 2026-09-19 线上实报:Windows 安装包里的内置 Node 缺 npm
 *     (electron-builder 的 extraResources 过滤器无条件丢掉 `from` 根下那层 `node_modules`),
 *     `npx.cmd` 找不到 npm-prefix.js 直接 MODULE_NOT_FOUND 退出 → 没有 'error' 事件 → 只能等超时,
 *     日志里三坨栈 + 一句 `timed out after 30000ms`,读不出病因。
 *  顺手留 stderr 末尾几行进错误信息,让「起不来」自带现场。
 *  ⚠️报错要等 stderr 排空:'exit' 只保证进程没了,**不保证 stdio 读完**('close' 才保证)——
 *  在 'exit' 上直接 reject 会拿到空 tail(最后一段 MODULE_NOT_FOUND 还在管道里)。但 detached 的
 *  npx 会把 stderr 传给孙进程,'close' 可能迟迟不来,所以两边都听:'close' 先到就立刻报,
 *  否则 'exit' 后给 EXIT_FLUSH_MS 的排空宽限再报。
 *  disarm():子进程的死活不再关我们事时撤表(run 收尾主动 kill、探测完 kill)—— 那不是失败。 */
const STDERR_TAIL = 4;
const EXIT_FLUSH_MS = 200;
export function watchEngineStartup(child: ChildProcess, engineId: string, tag = ''): { failed: Promise<never>; disarm: () => void } {
  const tail: string[] = [];
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (!s) return;
    console.warn(`[engine:${engineId}]${tag} ${s}`);
    tail.push(s);
    if (tail.length > STDERR_TAIL) tail.shift();
  });
  let armed = true;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const failed = new Promise<never>((_, reject) => {
    const die = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!armed) return;
      armed = false;
      const why = tail.length ? `:${tail.join(' / ')}` : '';
      reject(new Error(`engine ${engineId} 握手前就退出了(code=${code ?? signal})${why}`));
    };
    child.on('error', (e) => {
      if (!armed) return;
      armed = false;
      reject(new Error(`engine spawn failed: ${e.message}(请确认已安装 Node/npx)`));
    });
    child.on('exit', (code, signal) => {
      if (!armed || flushTimer) return;
      flushTimer = setTimeout(() => die(code, signal), EXIT_FLUSH_MS);
      flushTimer.unref?.(); // 宽限期不该吊住进程退出
    });
    child.on('close', (code, signal) => die(code, signal));
  });
  return {
    failed,
    disarm: () => { armed = false; if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } },
  };
}

/** 给 promise 加超时闸(到点 reject);用于外部引擎握手兜底,防子进程不回包时无限 await。 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`engine ${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
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

/** configOptions 里读出来的模型与思考档。`*ConfigId` 是改它时要回传的 configId(DSH 是 'model' / 'reasoning_effort')。 */
export interface AcpConfigSelection {
  modelConfigId?: string;
  models: EngineCapabilities['models'];
  currentModelId?: string;
  thoughtConfigId?: string;
  thoughtLevels: NonNullable<EngineCapabilities['thoughtLevels']>;
  currentThoughtLevel?: string;
}

/**
 * ACP `configOptions`(session/new、session/resume、session/set_config_option 的回包里都有)→ 模型清单 + 思考档。
 * 按 category 认('model' / 'thought_level'),没写 category 的老实现按 id 兜底。选项可以是平的,也可以按组嵌一层
 * (DSH 按供应商分组);value 是不透明的串(DSH 的模型值是一段 JSON 文本),原样当 id,绝不解析。纯函数,供探测 + 单测。
 */
export function mapAcpConfigOptions(configOptions: unknown): AcpConfigSelection {
  const out: AcpConfigSelection = { models: [], thoughtLevels: [] };
  if (!Array.isArray(configOptions)) return out;
  const flat = (options: unknown): Array<{ id: string; name: string; description?: string }> => {
    const items: Array<{ id: string; name: string; description?: string }> = [];
    for (const o of Array.isArray(options) ? (options as any[]) : []) {
      if (Array.isArray(o?.options)) {
        // 一组:组名补进没有自带说明的选项,下拉里看得出是哪家的
        for (const item of flat(o.options)) items.push({ ...item, description: item.description ?? (typeof o.name === 'string' && o.name ? o.name : undefined) });
      } else if (typeof o?.value === 'string' && o.value) {
        items.push({ id: o.value, name: typeof o.name === 'string' && o.name ? o.name : o.value, description: typeof o.description === 'string' && o.description ? o.description : undefined });
      }
    }
    return items;
  };
  const pick = (category: string, fallbackId: string): any =>
    (configOptions as any[]).find((o) => o?.type === 'select' && o?.category === category)
    ?? (configOptions as any[]).find((o) => o?.type === 'select' && o?.category == null && o?.id === fallbackId);
  const model = pick('model', 'model');
  if (model && typeof model.id === 'string') {
    out.modelConfigId = model.id;
    out.models = flat(model.options);
    if (typeof model.currentValue === 'string') out.currentModelId = model.currentValue;
  }
  const thought = pick('thought_level', 'reasoning_effort');
  if (thought && typeof thought.id === 'string') {
    out.thoughtConfigId = thought.id;
    out.thoughtLevels = flat(thought.options);
    if (typeof thought.currentValue === 'string') out.currentThoughtLevel = thought.currentValue;
  }
  return out;
}

/** JSON-RPC 错误(SDK 原样抛出 { code, message, data })或普通 Error → 一行可读的话。DSH 把真话放在 data.details 里,
 *  message 只有「Internal error」。 */
export function acpErrorText(e: any): string {
  const message = typeof e?.message === 'string' && e.message ? e.message : String(e);
  const details = typeof e?.data?.details === 'string' ? e.data.details : typeof e?.data === 'string' ? e.data : '';
  return details && !message.includes(details) ? `${message}: ${details}` : message;
}

/**
 * 续接失败是哪一种(只在 session/load、session/resume 被引擎拒绝时问):
 *   - 'gone'  那个会话在引擎那边没有了(删了、换了目录、重装)。措辞取自实测:DSH 回 -32602「session is not resumable」;
 *             ACP 规范的「资源不存在」是 -32002,只在报错说的是会话(不是文件 / 目录)时才算。
 *   - 'busy'  会话还在,但被另一个进程占着(用户自己开着 DSH 界面并点开了这一场)。实测 DSH 回 -32603,
 *             data.details「… is already owned by an active write handle」。
 *   - 'other' 其余(超时、进程死了、参数不对……)。
 * 认不出的一律 'other':宁可照实失败,也不把「不知道」当成「没有了」而悄悄丢掉上文。
 */
export function classifyResumeFailure(e: any): 'gone' | 'busy' | 'other' {
  const text = acpErrorText(e);
  if (/already owned|active write handle|already active|in use by another/i.test(text)) return 'busy';
  // 「没有了」只认说的是**会话**的:-32002 在规范里是泛指的「资源不存在」,工作目录 / 文件不在也可能回它(报错文字
  // 或 data.uri 指着一个路径),那种情况会话本身还好好的 —— 判成 gone 会在 run 上留下「别再找它」的记号,把一场完好的会话丢掉。
  if (/not resumable|session not found|no such session|unknown session/i.test(text)) return 'gone';
  const uri = typeof e?.data?.uri === 'string' ? e.data.uri : '';
  const aboutFiles = /\b(file|director(y|ies)|folder|path|workspace|cwd)\b/i.test(text) || /^(file:|\/|[A-Za-z]:[\\/])/.test(uri);
  if (aboutFiles) return 'other';
  if (e?.code === -32002) return 'gone'; // 续接请求里能「不存在」的资源,除了文件 / 目录就是那个会话
  if (/session/i.test(text) && /does not exist|no longer exists|was deleted/i.test(text)) return 'gone';
  return 'other';
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
  let tokensTotal: number | undefined;
  const toolCalls: ToolCall[] = [];
  const toolResults: any[] = [];
  const toolNames = new Map<string, string>(); // toolCallId -> name（给 tool_result 补名）
  // toolCallId -> 最新的 rawInput / 标题(审批请求只带 id 时拿来补,见 requestPermission)。**必须跟着 tool_call_update 更新**:
  // 引擎可以先发一条参数不全(或还是别的参数)的 tool_call,再用 update 改成真正要跑的;卡上要是还显示头一条,
  // 用户看到的是一条命令、批准的是另一条。
  const toolInputs = new Map<string, unknown>();
  const toolTitles = new Map<string, string>();

  const client: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      if (ctx.replaying?.()) return;
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
          if (u.rawInput != null) toolInputs.set(u.toolCallId, u.rawInput);
          if (typeof u.title === 'string' && u.title) toolTitles.set(u.toolCallId, u.title);
          const args = u.rawInput ? JSON.stringify(u.rawInput) : '{}';
          toolCalls.push({ id: u.toolCallId, type: 'function', function: { name, arguments: args } });
          // source(遥测契约 §7):外部引擎自己的工具名不归 Tangu,按 plugin 记 —— Extend 不外发 plugin 的工具名
          ctx.publish('tool_call', { id: u.toolCallId, name, arguments: args, startedAt: Date.now(), source: 'plugin' });
          break;
        }
        case 'tool_call_update': {
          // 规范:update 里出现的字段整个替换原值。只更新审批用的这两份;已经发给界面的 tool_call 事件和结果里的工具名不动。
          if (u.rawInput != null) toolInputs.set(u.toolCallId, u.rawInput);
          if (typeof u.title === 'string' && u.title) toolTitles.set(u.toolCallId, u.title);
          if (u.status === 'completed' || u.status === 'failed') {
            const name = toolNames.get(u.toolCallId) || '';
            const result = toolUpdateText(u.content);
            const isError = u.status === 'failed';
            toolResults.push({ id: u.toolCallId, name, result, isError });
            ctx.publish('tool_result', { id: u.toolCallId, name, result, isError, source: 'plugin' });
          }
          break;
        }
        case 'usage_update': {
          // 附带计：外部 run 跑用户自己的账号，仅展示，不进 Tangu 计费。
          const us = u.usage ?? u;
          if (Number.isFinite(us.totalTokens)) tokensTotal = us.totalTokens;
          else if (Number.isFinite(us.inputTokens) && Number.isFinite(us.outputTokens)) tokensTotal = us.inputTokens + us.outputTokens;
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
      // 规范里这里的 toolCall 是一条「更新」,可以只带 toolCallId(DSH 就是):标题和参数在它前面那条 tool_call 里。
      // 不补的话审批卡上只有一个「tool」和空参数,用户不知道自己在批什么。
      const seenName = tc?.toolCallId ? (toolTitles.get(tc.toolCallId) || toolNames.get(tc.toolCallId)) : undefined;
      const title = tc?.title || seenName || tc?.kind || 'tool';
      const raw = tc?.rawInput ?? (tc?.toolCallId ? toolInputs.get(tc.toolCallId) : undefined);
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
    result: () => ({ content, reasoning, toolCalls, toolResults, tokensTotal }),
  };
}

/** 引擎会话 id → 上一轮那个进程「真的退了」的 promise。一 run 一进程:下一轮要在新进程里续接同一个会话,而上一轮的进程
 *  被杀之后要过一会儿才放开会话(DSH 的会话写入权按进程持有;SIGTERM 后它先收尾)。紧跟着发的下一句(排队的消息)
 *  赶在它退之前去续接,会被当成「另一个进程占着」拒掉 —— 所以续接前先等它。 */
const exitingSessions = new Map<string, Promise<void>>();
const EXIT_WAIT_MS = 3000; // 收尾是 SIGTERM → 2s → SIGKILL,给够这一段

function trackExit(sessionId: string, child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, EXIT_WAIT_MS);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  }).finally(() => { if (exitingSessions.get(sessionId) === gone) exitingSessions.delete(sessionId); });
  exitingSessions.set(sessionId, gone);
}

export async function runAcpEngine(def: EngineDef, ctx: EngineRunCtx): Promise<EngineResult> {
  const cwd = ctx.cwd || process.cwd();
  // host 能力下运行：继承父 env（等价于用户自己在终端跑 claude），叠加 def.env。适配器据此读 ANTHROPIC_API_KEY/~/.claude。
  // detached:true → 子进程自成进程组(pgid=child.pid);kill 时杀「整组」，连带 npx 衍生的真子进程(claude-code-acp)，
  // 否则只杀外层 npx、孙进程残留成孤儿。范本 ../tools/hostExec.ts。
  const child = spawnEngine(def, { cwd, detached: true });
  // 起不来必须让握手立刻失败(spawn 报错 / 握手前自退),否则 initialize 会一路 await 到 30s 超时。
  // 适配器的 stderr 只做诊断,不进协议流;watchEngineStartup 顺带留末尾几行进错误信息。
  const startup = watchEngineStartup(child, def.id);
  const spawnFailed = startup.failed;
  child.on('error', (e) => ctx.publish('status', { detail: `engine spawn error: ${e.message}` }));

  // 进程组 kill + SIGTERM→2s→SIGKILL 升级:先给 ACP 子进程优雅退出(flush)的机会，仍不退就强杀整组。
  // POSIX 负 pid 杀整组;Windows 用 taskkill /T /F,停止 npx 启动的实际引擎。
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const killTree = (sig: NodeJS.Signals): void => {
    void killProcessTree(child, 5000, sig);
  };
  const killNow = (): void => {
    killTree('SIGTERM');
    if (process.platform !== 'win32' && !killTimer) killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
  };
  child.once('exit', () => { if (killTimer) { clearTimeout(killTimer); killTimer = null; } });

  let sessionId = '';
  let resumable = false;
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
  let replaying = false;
  const wrappedCtx: AcpClientCtx = {
    replaying: () => replaying,
    signal: ctx.signal,
    publish: (type, payload) => { armEngineIdle(); ctx.publish(type, payload); },
    requestApproval: async (preview, toolCall) => {
      // Read-only ACP modes remain host-enforced at permission boundaries.
      // The scoped MCP bridge gates its own tools independently.
      if (ctx.readOnly) {
        // The host MCP server enforces its exact tool list and native approval separately.
        return {action:toolCall.function.name.startsWith('mcp__forsion_task__')?'approve':'reject'};
      }
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

  // 握手闸:任一步超时 或 spawn 失败即 reject,绝不在死子进程上无限等 initialize(idle 看门狗要到 prompt 前才起表)。
  const guard = <T>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([withTimeout(p, HANDSHAKE_TIMEOUT_MS, label), spawnFailed]) as Promise<T>;
  try {
    const initialized = await guard(conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // fs/terminal 不声明 → 外部 agent 用自带工具直接在 cwd 上做文件/命令操作（host 模式与 Tangu 一致）。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }), 'initialize');
    const mcpServers = ctx.mcpServers || [];
    if (mcpServers.some(s => 'type' in s && s.type === 'http') && !initialized.agentCapabilities?.mcpCapabilities?.http) throw new Error('This external engine does not support HTTP MCP tool bridges');
    const claudeReadOnly=ctx.readOnly && initialized.agentInfo?.name==='@zed-industries/claude-code-acp';
    const codexReadOnly=ctx.readOnly && initialized.agentInfo?.name==='@agentclientprotocol/codex-acp';
    if(ctx.readOnly&&!claudeReadOnly&&!codexReadOnly)throw new Error('Read-only execution is not verified for this ACP adapter');
    const meta=claudeReadOnly?{disableBuiltInTools:true,claudeCode:{options:{strictMcpConfig:true,settingSources:[]}}}:undefined;
    // 续接:报 loadSession 的引擎(Claude Code / Codex)照旧走 session/load,回放的旧消息丢掉;只报 resume 的(DSH)走
    // session/resume,它不回放。两样都不报 = 这个引擎每轮都是新会话。
    const canLoad = !!initialized.agentCapabilities?.loadSession;
    const canResume = !!(initialized.agentCapabilities as any)?.sessionCapabilities?.resume;
    let s: any;
    if (ctx.resumeSessionId) {
      await exitingSessions.get(ctx.resumeSessionId); // 上一轮的进程还在收尾 → 等它退了再续接(见 exitingSessions)
      ctx.signal.throwIfAborted();
      try {
        if (canLoad) {
          replaying = true;
          try { s = await guard(conn.loadSession({ cwd, mcpServers, _meta:meta, sessionId: ctx.resumeSessionId }), 'loadSession'); }
          finally { replaying = false; }
        } else if (canResume) {
          s = await guard(conn.unstable_resumeSession({ cwd, mcpServers, _meta:meta, sessionId: ctx.resumeSessionId }), 'resumeSession');
        } else {
          throw Object.assign(new Error('This external engine cannot resume an existing session'), { resumeUnsupported: true });
        }
        sessionId = ctx.resumeSessionId;
      } catch (e: any) {
        if (ctx.signal.aborted) throw e;
        // 续接失败一律照实失败:不悄悄换一个新会话丢掉上文,也不回落到别的引擎。「没有了」单独标出来(externalSessionGone),
        // 调用方据此决定下一次要不要新开(见 agentLoop.externalEngineLoop)。
        const kind = e?.resumeUnsupported ? 'gone' : classifyResumeFailure(e);
        if (kind === 'gone') throw Object.assign(new Error(`${def.name} no longer has the earlier session of this conversation (${acpErrorText(e)}).`), { externalSessionGone: true });
        if (kind === 'busy') throw new Error(`${def.name} has this conversation open in another window or process, so it cannot be continued here. Close it there, then send again. (${acpErrorText(e)})`);
        if (e instanceof Error) throw e;
        throw new Error(`${def.name} could not continue the earlier session: ${acpErrorText(e)}`);
      }
    } else {
      s = await guard(conn.newSession({ cwd, mcpServers, _meta:meta }), 'newSession'); sessionId = s.sessionId;
    }
    resumable = canLoad || canResume;
    // 会话一建立就告诉调用方(在 prompt 之前):这一轮中途被停掉 / 崩了,下一轮也接得上。记不下来不拦这一轮。
    try { await ctx.onSession?.({ id: sessionId, resumable, resumed: !!ctx.resumeSessionId, via: canLoad ? 'load' : canResume ? 'resume' : undefined }); }
    catch (e: any) { console.warn(`[engine] onSession failed: ${e?.message || e}`); }
    if (ctx.readOnly) {
      const mode = s.modes?.availableModes?.find((m: any) => (claudeReadOnly ? m.id==='plan' : m.id==='read-only'));
      if (!mode) throw new Error('This external engine does not advertise a read-only or plan mode');
      await guard(conn.setSessionMode({ sessionId, modeId: mode.id }), 'setSessionMode');
    }
    // 应用用户为该引擎选的模型(若与当前不同);失败不阻断,用引擎当前的继续。
    // 引擎给 `models` 的走 session/set_model;没有 `models`、模型在 configOptions 里的(DSH)走 session/set_config_option。
    // 续接的会话记着上次选的模型,所以每轮都对一下「当前值」而不是只在新建时设。
    // (DSH 实测:换模型会把思考档重置成那个模型的缺省值。这里不碰思考档。)
    if (ctx.engineModelId) {
      const sel = mapAcpConfigOptions((s as any)?.configOptions);
      try {
        if (!(s as any)?.models && sel.modelConfigId) {
          if (ctx.engineModelId !== sel.currentModelId) {
            // 存着的选择不在这次的清单里(引擎那边换了目录 / 下架)→ 不发,照引擎当前的跑
            if (!sel.models.some((m) => m.id === ctx.engineModelId)) console.warn(`[engine] model ${ctx.engineModelId} is not offered by ${def.id} any more; keeping ${sel.currentModelId ?? 'the engine default'}`);
            else await guard(conn.setSessionConfigOption({ sessionId, configId: sel.modelConfigId, value: ctx.engineModelId }), 'setSessionConfigOption');
          }
        } else if (ctx.engineModelId !== (s as any)?.models?.currentModelId) {
          await conn.unstable_setSessionModel({ sessionId, modelId: ctx.engineModelId });
        }
      } catch (e: any) {
        console.warn(`[engine] set model(${ctx.engineModelId}) failed: ${acpErrorText(e)}`);
      }
    }
    armEngineIdle(); // turn 开始起表
    // prompt 不设握手超时(一轮可以跑很久),但**子进程半路死掉要立刻知道** —— 否则只能等 5 分钟的
    // idle 看门狗,而 ACP 连接未必会因 stdio EOF 自己 reject(这正是本轮那个 bug 的形态)。
    const res = await Promise.race([
      conn.prompt({ sessionId, prompt: [{ type: 'text', text: ctx.message }] }),
      spawnFailed,
    ]);
    return { ...result(), stopReason: res.stopReason, externalSessionId: resumable ? sessionId : undefined };
  } finally {
    startup.disarm(); // 到此子进程的死活不再是「起不来」:下面 killNow() 是我们自己杀的
    if (engineIdle) clearTimeout(engineIdle);
    ctx.signal.removeEventListener('abort', onAbort);
    killNow();
    if (resumable && sessionId) trackExit(sessionId, child); // 不在这里等(不拖慢这一轮收尾),下一轮续接前等
  }
}

/**
 * 懒探测引擎能力:spawn → initialize → newSession(取 models / configOptions) → 短窗口收一次 available_commands_update → dispose。
 * 不累积正文/不接审批(与 createAcpClient 区分);仅用于 UI 填模型/命令选择器。
 * opts.reuseSessionId / reuseCwd:只对「会 resume、不会 load」的引擎生效,见函数内注释;回包里的 probeSessionId 由调用方存起来下次传回。
 */
export async function probeAcpEngine(def: EngineDef, opts?: { reuseSessionId?: string; reuseCwd?: string }): Promise<EngineCapabilities & { probeSessionId?: string }> {
  const child = spawnEngine(def);
  // 原本空 error 处理器吞掉了 Windows 上的 spawn 失败 → initialize 永久 await → /capabilities 永不返回 → UI 卡死。
  const startup = watchEngineStartup(child, def.id, ' (probe)');
  const spawnFailed = startup.failed;

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

  const guard = <T>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([withTimeout(p, HANDSHAKE_TIMEOUT_MS, label), spawnFailed]) as Promise<T>;
  try {
    const initialized = await guard(conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }), 'initialize');
    const canLoad = !!initialized.agentCapabilities?.loadSession;
    const sessionCaps = (initialized.agentCapabilities as any)?.sessionCapabilities;
    const canResume = !!sessionCaps?.resume;
    // 探测要建一个会话才拿得到模型清单。只会 resume 的引擎(DSH)连没发过话的空会话也存下来(实测:关掉、杀进程后仍在
    // session/list 里),每探一次留一个,用户自己的 DSH 历史里就会攒一堆空会话 → 这类引擎复用同一个探测会话,
    // 工作目录也固定(续接要核对工作目录)。上次那个没了 / 被占着就新建一个,由调用方记下新的。
    const reuse = canResume && !canLoad;
    const cwd = reuse && opts?.reuseCwd ? opts.reuseCwd : process.cwd();
    let s: any;
    let probeSessionId: string | undefined;
    if (reuse && opts?.reuseSessionId) {
      try {
        s = await guard(conn.unstable_resumeSession({ cwd, mcpServers: [], sessionId: opts.reuseSessionId }), 'resumeSession');
        probeSessionId = opts.reuseSessionId;
      } catch { s = undefined; }
    }
    if (!s) {
      s = await guard(conn.newSession({ cwd, mcpServers: [] }), 'newSession');
      if (reuse) probeSessionId = s.sessionId;
    }
    const viaModels = mapAcpModels((s as any).models);
    const sel = mapAcpConfigOptions((s as any).configOptions);
    // 模型清单:引擎给 `models` 就用它;没有、而 configOptions 里有模型选项(DSH)就用后者。
    const fromConfig = !viaModels.models.length && sel.models.length > 0;
    // 命令在 newSession 后异步到达;收到即返回,否则 1.5s 超时。
    await Promise.race([commandsReceived, new Promise<void>((r) => setTimeout(r, 1500))]);
    // 关掉探测会话再杀进程:让引擎把它落稳,下次才续得上同一个(SDK 0.14 没有 close 的封装,走扩展方法发原名)。
    if (reuse && sessionCaps?.close && probeSessionId) {
      await withTimeout(conn.extMethod('session/close', { sessionId: probeSessionId }), 3000, 'closeSession').catch(() => {});
    }
    return {
      models: fromConfig ? sel.models : viaModels.models,
      currentModelId: fromConfig ? sel.currentModelId : viaModels.currentModelId,
      commands, loadSession: canLoad, resume: canResume, modes:(s as any).modes?.availableModes,
      ...(sel.thoughtLevels.length ? { thoughtLevels: sel.thoughtLevels, currentThoughtLevel: sel.currentThoughtLevel } : {}),
      ...(probeSessionId ? { probeSessionId } : {}),
    };
  } finally {
    startup.disarm(); // 下面这刀是我们自己捅的,不算「起不来」
    if (process.platform === 'win32') await killProcessTree(child);
    else child.kill();
  }
}
