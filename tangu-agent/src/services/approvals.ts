/**
 * 进程内工具审批登记表（host-exec 模式 / TUI 专用）。
 *
 * 事件总线是单向的（run publish → 订阅者）。审批需要「订阅者把决定送回正在等待的 run」。
 * 因为 TUI 在**同一进程**里跑 loop（无 HTTP，同 cli），用一张进程内登记表即可：
 *   loop 调 requestApproval → 发 `approval_request` 事件 + 登记 resolver，await Promise；
 *   TUI 收到事件、用户按键 → resolveApproval(approvalId, decision)，Promise 兑现，loop 继续。
 *
 * **安全边界**：gateToolCall 在 execMode!=='host' 时立即放行（无 await、无事件），
 * 故 microserver / standalone-server / worker 行为零变化——审批只在 host-exec（TUI）激活。
 *
 * 远程 host-exec（跨进程）需要的是 HTTP「租赁」端点（见架构 v2.0 §3.3 Lease），不在此文件范围。
 */
import path from 'node:path';
import { publish } from './eventBus.js';
import { isOutsideWorkspace } from '../tools/fsPolicy.js';
import { writeTargetsOf } from '../tools/writeTargets.js';
import type { ToolCall } from '../core/types.js';
import { runHooks } from '../hooks/index.js';
import { currentAgentSlug } from '../seams/runContext.js';
import { declaredApproval } from '../tools/toolRegistry.js';
import { getRawSection } from '../core/config.js';
import type { AppProfile } from '../seams/appProfile.js';

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | 'custom';
export type ApprovalAction = 'approve' | 'approve_always' | 'reject';
export interface ApprovalDecision {
  action: ApprovalAction;
  /** 用户在审批时修改了参数（如改 bash 命令）：用这份覆盖原 call 的 arguments 执行。 */
  argsOverride?: Record<string, any>;
  /** 拒绝原因（仅规则自动拒绝时有）：让模型与用户都看得见是**哪条规则**挡的，否则无从调起。 */
  rejectReason?: string;
}

interface Pending {
  runId: string;
  resolve: (d: ApprovalDecision) => void;
}

const pending = new Map<string, Pending>(); // approvalId -> resolver
const alwaysAllow = new Map<string, Set<string>>(); // sessionId -> 本会话「总允许」的工具名

let approvalSeq = 0;
function nextApprovalId(): string {
  return `apv_${Date.now().toString(36)}_${++approvalSeq}`;
}

/**
 * 破坏性工具在某审批档下是否需要批准。
 *   readonly  : 写文件 + 跑命令都要批
 *   auto-edit : 写文件放行，跑命令要批（codex「auto edit」语义）
 *   full-auto : 全放行
 *   custom    : 按 config.json approval 段的 base 档(逐条规则的命中判定在 gateToolCall)
 * 只读工具（read_file/list_dir/web_search/...）永不在此返回 true。
 */
export function toolNeedsApproval(name: string, mode: ApprovalMode | undefined): boolean {
  if (mode === 'custom') mode = customRules().base;
  if (!mode || mode === 'full-auto') return false;
  const writesFiles = name === 'write_file' || name === 'edit_file' || name === 'multi_edit' || name === 'apply_patch';
  // 跑命令档(auto-edit 也要批):run_bash / kill_process / MCP 任意能力 / 后台起进程 / 给进程喂 stdin。
  // run_background + write_process_input = 启动任意 shell 进程并向其喂输入,危险性同 run_bash,纳入此档。
  // browser_task = 自主 agent 以用户身份操作已登录网站(点按/提交),危险性同档。
  const runsCommands =
    name === 'run_bash' || name === 'kill_process' || name === 'run_background' ||
    name === 'write_process_input' || name === 'browser_task' || name.startsWith('mcp__') ||
    // 插件工具经 capabilities.approval:'command' 自声明并入本档(核心不硬编码插件工具名;如 computer-use 的 act_ui)。
    declaredApproval(name) === 'command';
  if (mode === 'readonly') return writesFiles || runsCommands;
  if (mode === 'auto-edit') return runsCommands;
  return false;
}

/** 给审批弹窗用的人类可读预览（从 tool 参数里抽要害）。 */
export function approvalPreview(call: ToolCall): string {
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    /* ignore */
  }
  const name = call.function.name;
  if (name === 'run_bash') return `$ ${String(args.command ?? '').trim()}`;
  if (name === 'write_file') return `write ${args.path} (${String(args.content ?? '').length} chars)`;
  if (name === 'edit_file') return `edit ${args.path}`;
  if (name === 'multi_edit') return `multi_edit ${args.path} (${Array.isArray(args.edits) ? args.edits.length : '?'} edits)`;
  if (name === 'run_background') return `bg$ ${String(args.command ?? '').trim()}`;
  if (name === 'write_process_input') {
    const inp = String(args.input ?? '');
    return `→ proc ${args.process_id}: ${inp.length > 80 ? inp.slice(0, 80) + '…' : inp || '(poll)'}`;
  }
  if (name === 'apply_patch') {
    const n = (String(args.patch ?? args.input ?? '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm) || []).length;
    return `apply_patch (${n} file change(s))`;
  }
  if (name === 'kill_process') return `kill process ${args.process_id ?? ''}`;
  if (name === 'browser_task') {
    const t = String(args.task ?? '').trim();
    const domains = Array.isArray(args.allowed_domains) && args.allowed_domains.length ? ` [${args.allowed_domains.join(', ')}]` : '';
    return `browser_task${domains}: ${t.length > 160 ? `${t.slice(0, 160)}…` : t}`;
  }
  return `${name} ${JSON.stringify(args).slice(0, 200)}`;
}

// 同 run 审批串行化(Codex 评审 07-30 #2):TUI 的审批 UI 是单槽,通道端收到首个决定即退订——
// 并行子代理同时弹审批会互相顶掉,后到的一直挂到超时。同 run 的请求排队逐个发布。
const approvalQueues = new Map<string, Promise<unknown>>(); // runId -> 队尾

/** 登记一次审批请求:同 run 内排队逐个发布(发事件 + await 决定)。中止信号触发时按拒绝兑现。 */
export function requestApproval(
  runId: string,
  call: ToolCall,
  preview: string,
  signal?: AbortSignal,
  reason?: ApprovalReason,
): Promise<ApprovalDecision> {
  const tail = approvalQueues.get(runId) || Promise.resolve();
  const mine = tail.then(() => requestApprovalNow(runId, call, preview, signal, reason));
  const entry = mine.then(() => undefined, () => undefined);
  approvalQueues.set(runId, entry);
  void entry.then(() => { if (approvalQueues.get(runId) === entry) approvalQueues.delete(runId); });
  return mine;
}

function requestApprovalNow(
  runId: string,
  call: ToolCall,
  preview: string,
  signal?: AbortSignal,
  reason?: ApprovalReason,
): Promise<ApprovalDecision> {
  if (signal?.aborted) return Promise.resolve({ action: 'reject' });
  const approvalId = nextApprovalId();
  return new Promise<ApprovalDecision>((resolve) => {
    const onAbort = (): void => {
      pending.delete(approvalId);
      resolve({ action: 'reject' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending.set(approvalId, {
      runId,
      resolve: (d) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(d);
      },
    });
    void publish(runId, 'approval_request', {
      approvalId,
      name: call.function.name,
      arguments: call.function.arguments,
      preview,
      ...(reason ? { reason } : {}), // 旧客户端忽略未知字段;preview 一个字都没动(它是越界警示的唯一载体)
    });
  });
}

/** TUI 按键 / HTTP 审批端点调用：兑现某审批。返回 false 表示该 id 已不在等待（重复/过期）。 */
export function resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  pending.delete(approvalId);
  p.resolve(decision);
  // 广播审批结果:SSE 回放/多端订阅者据此知道该审批已被消化(TUI 忽略未知事件类型,零影响)。
  void publish(p.runId, 'approval_result', { approvalId, action: decision.action });
  return true;
}

export function isAlwaysAllowed(sessionId: string, toolName: string): boolean {
  return alwaysAllow.get(sessionId)?.has(toolName) ?? false;
}
export function allowAlways(sessionId: string, toolName: string): void {
  let s = alwaysAllow.get(sessionId);
  if (!s) {
    s = new Set();
    alwaysAllow.set(sessionId, s);
  }
  s.add(toolName);
}
// A convenience classifier, not a security boundary. Unknown syntax/options require approval.
const SAFE_BASH_PROGRAMS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'stat', 'which', 'whoami',
  'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'uname',
]);
const SAFE_GIT_FLAGS = new Set([
  '--short', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2',
  '--stat', '--numstat', '--shortstat', '--name-only', '--name-status',
  '--cached', '--staged', '--check', '--no-patch', '--oneline', '--all',
  '--no-color', '--no-ext-diff', '--no-textconv', '--abbrev-ref', '--show-toplevel',
  '--show-prefix', '--show-cdup', '--is-inside-work-tree', '--verify',
]);

/** Only simple unquoted word tokens are classified. Shell parsing remains the shell's job. */
export function isKnownSafeBash(command: string): boolean {
  const cmd = String(command || '').trim();
  // Deny substitutions, expansions, quotes, shell operators, escapes and control characters.
  if (!cmd || /[^A-Za-z0-9_./:@%+=, \-]/.test(cmd)) return false;
  const [program, ...args] = cmd.split(/ +/);
  if (SAFE_BASH_PROGRAMS.has(program)) return true;
  if (program === 'date') return args.every((a) => a === '-u' || a === '--utc' || a.startsWith('+'));
  if (program === 'hostname') return args.length === 0;
  // rg can execute --pre helpers and read config containing --pre; remove that implicit input.
  // Even without --pre, arbitrary flags can gain new behavior, so only a bounded option set.
  if (program === 'rg' || program === 'grep') {
    const flags = new Set(['-n', '-i', '-l', '-L', '-c', '-r', '-R', '-v', '-w', '-F', '-E', '--files', '--hidden', '--no-ignore', '--no-config', '--line-number', '--ignore-case', '--fixed-strings', '--files-with-matches', '--count']);
    if (program === 'rg' && process.env.RIPGREP_CONFIG_PATH) return false;
    return args.every((a) => !a.startsWith('-') || a === '--' || flags.has(a));
  }
  if (program !== 'git') return false;
  const [sub, ...rest] = args;
  // branch and remote have mutating forms; only exact listing invocations qualify.
  if (sub === 'branch') return rest.every((a) => ['-a', '-r', '--all', '--remotes', '--list'].includes(a));
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v');
  // diff/show can invoke configured external diff/textconv commands. Keep these behind approval
  // unless callers explicitly disable both extension mechanisms.
  if (['diff', 'show'].includes(sub) && !(rest.includes('--no-ext-diff') && rest.includes('--no-textconv'))) return false;
  if (!['status', 'diff', 'show', 'log', 'rev-parse', 'describe'].includes(sub)) return false;
  return rest.every((a) => !a.startsWith('-') || a === '--' || SAFE_GIT_FLAGS.has(a) || /^--max-count=[0-9]+$/.test(a));
}

// 路径抽取已迁 tools/writeTargets.ts(检查点快照共用同一口径,见该文件头注)。

/** 写目标是否越界(工作区外,但非硬拒保护路径)→ 需升级审批。借 Codex writable-roots escalation。 */
export function writeEscalationNeeded(call: ToolCall, ctx: { cwd?: string; extraRoots?: string[] }): boolean {
  const targets = writeTargetsOf(call);
  if (!targets.length) return false;
  const cwd = ctx.cwd || process.cwd();
  // extraRoots 必须一起带上,否则用户在「工作范围」里加的目录仍会被判越界写、逐次弹审批。
  const fakeCtx = { cwd, extraRoots: ctx.extraRoots } as any;
  return targets.some((t) => isOutsideWorkspace(fakeCtx, path.isAbsolute(t) ? t : path.resolve(cwd, t)));
}

function bashCommandOf(call: ToolCall): string {
  try {
    return String((call.function.arguments ? JSON.parse(call.function.arguments) : {}).command || '');
  } catch {
    return '';
  }
}

/** 安全解析工具参数（供 PermissionRequest hook payload）。坏 JSON → 空对象。 */
function parseCallArgs(call: ToolCall): any {
  try {
    return call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return {};
  }
}

// ── custom 档：规则来自 ~/.tangu/config.json 的 approval 段（与三档并列的第四档）。────────────
//   { "approval": { "base": "auto-edit", "allow": [...], "ask": [...], "deny": [...] } }
//   规则串 = 工具名（`*` 结尾为前缀通配），可再跟 `:参数前缀`（跑命令比 command，写文件比 path）：
//     "web_fetch"    "mcp__*"    "run_bash:npm test"    "write_file:/etc/"
//   优先级 deny > ask > allow > base 档；一条都没命中就退回 base 档的原三档语义。
/**
 * 「这次为什么要问你」——审批卡的解释来源(B3)。
 * 判定分支在 gateToolCall 里已经算过一遍,不带出来客户端只能猜(而它猜不到引擎侧生效的 base 档)。
 */
export interface ApprovalReason {
  /** custom-ask=用户规则要求问 · escalate=工作区外写入升级 · mode=该档位本就需要审批 */
  kind: 'custom-ask' | 'escalate' | 'mode';
  /** 命中的规则串(仅 custom-ask) */
  rule?: string;
  /** 引擎侧**生效**的档位(custom 未命中时是降解后的 base;客户端算不出来) */
  mode?: Exclude<ApprovalMode, 'custom'>;
}

export interface CustomApprovalRules {
  base: Exclude<ApprovalMode, 'custom'>;
  allow: string[];
  ask: string[];
  deny: string[];
}

const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** 读 approval 段。ponytail: 每次现读(config.json 就几 KB)——改完规则立刻生效，不必重启引擎。 */
export function customRules(): CustomApprovalRules {
  const raw = (getRawSection('approval') as any) || {};
  const base = raw.base;
  return {
    base: base === 'readonly' || base === 'full-auto' ? base : 'auto-edit',
    allow: strList(raw.allow),
    ask: strList(raw.ask),
    deny: strList(raw.deny),
  };
}

/** 规则串里 `:` 后半段要比对的「参数主体」：跑命令取 command，写工具取目标路径。 */
function ruleSubject(call: ToolCall): string {
  const name = call.function.name;
  if (name === 'run_bash' || name === 'run_background') return bashCommandOf(call);
  return writeTargetsOf(call)[0] || '';
}

function ruleMatches(rule: string, call: ToolCall): boolean {
  const i = rule.indexOf(':');
  const toolPat = (i >= 0 ? rule.slice(0, i) : rule).trim();
  const argPrefix = i >= 0 ? rule.slice(i + 1).trim() : '';
  const name = call.function.name;
  const toolOk = toolPat.endsWith('*') ? name.startsWith(toolPat.slice(0, -1)) : name === toolPat;
  if (!toolOk) return false;
  return !argPrefix || ruleSubject(call).trim().startsWith(argPrefix);
}

/**
 * custom 档判定（详版）：连**命中的那条规则**一起返回。
 * 界面要回答「为什么问你/为什么被拒」，只给一个档位是答不了的；用户写坏一条 deny 规则时，
 * 没有规则串就只能看到 agent 莫名失败，无从调起。
 */
export function customVerdictDetailed(
  call: ToolCall,
  rules: CustomApprovalRules,
): { verdict: 'allow' | 'ask' | 'deny'; rule: string } | undefined {
  const hit = (list: string[]): string | undefined => list.find((r) => ruleMatches(r, call));
  const d = hit(rules.deny); if (d) return { verdict: 'deny', rule: d };
  const a = hit(rules.ask); if (a) return { verdict: 'ask', rule: a };
  const w = hit(rules.allow); if (w) return { verdict: 'allow', rule: w };
  return undefined;
}

/** custom 档判定：命中即返回该档，全不命中返回 undefined（交回 base 档处理）。 */
export function customVerdict(call: ToolCall, rules: CustomApprovalRules): 'allow' | 'ask' | 'deny' | undefined {
  return customVerdictDetailed(call, rules)?.verdict;
}

/**
 * loop 工具执行前的审批闸门。返回归一化决定（approve / reject）。
 *   - execMode!=='host' 且非 mcp__ → 立即 approve（**server/worker 零影响**）
 *   - custom 档命中规则 → deny 直接拒 / allow 直接放 / ask 强制批；未命中按其 base 档
 *   - run_bash 且 known-safe(只读单命令) → 立即 approve（纯 UX,即便 readonly）
 *   - 越界写(工作区外,非保护路径)→ 强制升级审批（auto-edit 也要批;full-auto 放行;不吃「总允许」）
 *   - 否则按档:不需审批 / 已「总允许」→ approve;否则 await 用户决定
 */
export async function gateToolCall(
  runId: string,
  call: ToolCall,
  ctx: {
    sessionId: string; execMode?: string; approvalMode?: ApprovalMode; cwd?: string; extraRoots?: string[]; profile?: AppProfile;
    /** 无人值守 run(Muse ask/agent 档):需要人决定时不 await 订阅者,改走 pendingApprovals(排队 / 代批)。 */
    approvalDeferral?: 'queue' | 'agent'; userId?: string; agentSlug?: string;
  },
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const name = call.function.name;
  // host 模式全部过闸;非 host 仅 MCP 工具过闸(本地形态的 sandbox 会话也可能挂 MCP)。
  if (ctx.execMode !== 'host' && !name.startsWith('mcp__')) return { action: 'approve' };

  // custom 档先裁决:用户写下的规则**压过**下面的 known-safe 捷径(把 `run_bash:ls` 放进 ask
  // 就该真弹审批,否则规则形同虚设);未命中则降解成 base 档,后续逻辑与三档完全一致。
  let mode = ctx.approvalMode;
  let forceAsk = false;
  let askRule = '';
  if (mode === 'custom') {
    const rules = customRules();
    const v = customVerdictDetailed(call, rules);
    // 拒绝时把规则串一并带出:否则用户写坏一条 deny 规则,只看到 agent 莫名失败,无从调起。
    // 模型面文本一律英文(项目约定:提示/工具结果英文,UI/日志中文)
    if (v?.verdict === 'deny') return { action: 'reject', rejectReason: `Denied by approval rule: ${v.rule}` };
    if (v?.verdict === 'allow') return { action: 'approve' };
    forceAsk = v?.verdict === 'ask';
    askRule = forceAsk ? v!.rule : '';
    mode = rules.base;
  }

  // known-safe 只读 bash:免审批。
  if (!forceAsk && name === 'run_bash' && isKnownSafeBash(bashCommandOf(call))) return { action: 'approve' };

  // 越界写升级:工作区外写一律要批(full-auto 例外:用户已全信任)。
  const escalate = ctx.execMode === 'host' && mode !== 'full-auto' && writeEscalationNeeded(call, ctx);

  if (!escalate && !forceAsk) {
    if (!toolNeedsApproval(name, mode)) return { action: 'approve' };
    if (isAlwaysAllowed(ctx.sessionId, name)) return { action: 'approve' };
  }

  // —— PermissionRequest hook：在弹审批 UI 前问 hook（host-only）。deny → 拒绝；allow → 跳过用户审批直接放行。——
  const permV = await runHooks('PermissionRequest', {
    tool_name: name,
    tool_input: parseCallArgs(call),
    session_id: ctx.sessionId, run_id: runId, cwd: ctx.cwd, agent_slug: currentAgentSlug(),
  }, {
    profile: ctx.profile,
    execMode: ctx.execMode === 'host' ? 'host' : 'sandbox',
    cwd: ctx.cwd, sessionId: ctx.sessionId, runId, signal,
  });
  // 诚实性:这是 hook 挡的,不是用户拒的 —— 不写清楚,模型和用户都会以为「用户拒绝了该操作」
  if (permV.block) return { action: 'reject', rejectReason: 'Denied by a PermissionRequest hook.' };
  if (permV.allow) return { action: 'approve' };

  const preview = escalate ? '⚠ 工作区外写入 · ' + approvalPreview(call) : approvalPreview(call);
  // 「为什么问你」(B3):优先级与判定同序 —— 用户自己写的规则 > 越界升级 > 档位本身。
  const reason: ApprovalReason = forceAsk
    ? { kind: 'custom-ask', rule: askRule, mode }
    : escalate
      ? { kind: 'escalate', mode }
      : { kind: 'mode', mode };
  // 无人值守 run:没有订阅者能应答 approval_request,await 就是永久卡死 → 排队 / 代批(动态 import 防模块环)。
  if (ctx.approvalDeferral) {
    const { deferApproval } = await import('./pendingApprovals.js');
    return deferApproval(runId, call, preview, reason, ctx);
  }
  const d = await requestApproval(runId, call, preview, signal, reason);

  if (d.action === 'approve_always') {
    // 越界写、custom 的 ask 规则都不进「总允许」:前者每次都确认,后者是用户写死的「永远问我」。
    if (!escalate && !forceAsk) allowAlways(ctx.sessionId, name);
    return { action: 'approve', argsOverride: d.argsOverride };
  }
  return d;
}
