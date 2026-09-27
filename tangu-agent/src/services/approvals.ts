/**
 * 进程内工具审批登记表（host-exec 模式 / TUI 专用）。
 *
 * 事件总线是单向的（run publish → 订阅者）。审批需要「订阅者把决定送回正在等待的 run」。
 * 因为 TUI 在**同一进程**里跑 loop（无 HTTP，同 cli），用一张进程内登记表即可：
 *   loop 调 requestApproval → 发 `approval_request` 事件 + 登记 resolver，await Promise；
 *   TUI 收到事件、用户按键 → resolveApproval(approvalId, decision)，Promise 兑现，loop 继续。
 *
 * **安全边界**：gateToolCall 在 execMode!=='host' 时只有 mcp__ 工具过闸，其余立即放行（无 await、无事件）；
 * 会话档现读(modeSessionId)只在 hostExec 引擎形态由 agentLoop 给出 —— 云端形态(microserver / worker)一律用 run 快照。
 *
 * 远程 host-exec（跨进程）需要的是 HTTP「租赁」端点（见架构 v2.0 §3.3 Lease），不在此文件范围。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publish } from './eventBus.js';
import { isOutsideWorkspace, writableRoots, protectedLocalWrite, protectedRemoteWrite } from '../tools/fsPolicy.js';
import { credentialPaths, matchProtected, pathWithin, canonicalFuturePath } from '../sandbox/hostSandboxProtection.js';
import { clampApprovalMode, effectiveRemote, remoteApprovalCap, type CapMode, type RemoteInfo } from './remoteOrigin.js';
import { writeTargetsOf } from '../tools/writeTargets.js';
import type { ToolCall } from '../core/types.js';
import { runHooks } from '../hooks/index.js';
import { currentAgentSlug } from '../seams/runContext.js';
import { canonicalToolName, declaredApproval, toolNameSpellings } from '../tools/toolRegistry.js';
import { USER_BROWSER_ACTIONS, userBrowserBound } from '../tools/builtin/browserTools.js';
import { getRawSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';
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

// 审批 id 就是兑现凭据:随机不可猜(旧版 时间戳+全局序号 可预测)。前缀 apv_ 保留,客户端只原样回传不解析。
function nextApprovalId(): string {
  return `apv_${randomUUID()}`;
}

/**
 * 破坏性工具在某审批档下是否需要批准。
 *   readonly  : 写文件 + 跑命令都要批
 *   auto-edit : 写文件放行，跑命令要批（codex「auto edit」语义）
 *   full-auto : 全放行
 *   custom    : 按 config.json approval 段的 base 档(逐条规则的命中判定在 gateToolCall)
 * 只读工具（read_file/list_dir/web_search/...）永不在此返回 true。
 */
/** 远程污点 run 里按「跑命令」档审批的持久化后续执行入口(§6.6):它们建的规则 / 日程条目日后以**完全通行**
 *  无人值守地跑(automation.ts 强制 full-auto),不拦 = 远端在 auto-edit 上限下借一条自动化把自己升成 full-auto。 */
const REMOTE_COMMAND_TOOLS = new Set(['manage_automation', 'manage_schedule']);

export function toolNeedsApproval(name: string, mode: ApprovalMode | undefined, opts?: { userBrowser?: boolean; remote?: boolean }): boolean {
  if (mode === 'custom') mode = customRules().base;
  if (!mode || mode === 'full-auto') return false;
  const writesFiles = name === 'write_file' || name === 'edit_file' || name === 'multi_edit' || name === 'apply_patch';
  // 跑命令档(auto-edit 也要批):run_bash / kill_process / MCP 任意能力 / 后台起进程 / 给进程喂 stdin。
  // run_background + write_process_input = 启动任意 shell 进程并向其喂输入,危险性同 run_bash,纳入此档。
  // browser_task = 自主 agent 以用户身份操作已登录网站(点按/提交),危险性同档。
  const runsCommands =
    name === 'run_bash' || name === 'kill_process' || name === 'run_background' ||
    name === 'write_process_input' || name === 'browser_task' || name.startsWith('mcp__') ||
    // 接管了用户自己的 Chrome(browserTools.userBrowserEndpoint)时,点按 / 输入 / 页内执行 JS 就是以用户身份
    // 操作已登录网站,与 browser_task 同档;没接管时它们只动 Tangu 自己的后台浏览器,照旧免批。由调用方判定后传入。
    (opts?.userBrowser === true && USER_BROWSER_ACTIONS.has(name)) ||
    // 插件工具经 capabilities.approval:'command' 自声明并入本档(核心不硬编码插件工具名;如 computer-use 的 act_ui)。
    declaredApproval(name) === 'command' ||
    (opts?.remote === true && REMOTE_COMMAND_TOOLS.has(name));
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
  // 接管用户 Chrome 时 browser_console 要批:用户批的是整段页内 JS,不许在 200 字处截断藏住后半段(Codex 09-24 #5)
  if (name === 'browser_console') return args.expression != null ? `browser_console — run JS in the page:\n${String(args.expression)}` : 'browser_console (read console/errors)';
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

/**
 * TUI 按键 / 通道 / HTTP 审批端点调用：兑现某审批。返回 false 表示该 id 已不在等待（重复/过期）。
 * ⚠️ HTTP 路由**必须**传 runId(同 uiAck.ts):路由只能证明 URL 里的 runId 属于调用者,证明不了这条审批属于那条 run
 * —— 桌面引擎所有 run 都属于 'local',不比对 = 拿任意 run 的 URL 兑现任意 run 的审批。
 * 进程内调用方(TUI / 通道)拿的是自己订阅的那条 run 事件流里的 id,可不传。
 */
export function resolveApproval(approvalId: string, decision: ApprovalDecision, runId?: string): boolean {
  const p = pending.get(approvalId);
  // runId 不匹配 → 一律当作「不在等待」,不泄露它是否存在。
  if (!p || (runId !== undefined && p.runId !== runId)) return false;
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

/** Contract C4: a read-only shortcut must not reach credential files. Any path-like argument (resolved against cwd)
 * that is a credential file, lies inside a credential directory, or — for recursive readers — contains one, disqualifies.
 * Recursive roots are compared in both the literal and the realpath form: rg and `grep -r` follow a symlink given as a root
 * (`rg SECRET link` with link -> ~/.forsion reads auth.json), so a lexical check alone lets that through (review B#1).
 * Symlinks *inside* the tree are only followed with rg -L/--follow or grep -R — those flags are not on the safe list. */
/** Split at the first `--`: before it, dash-words are options; after it, *everything* is an operand
 * (`rg SECRET -- -n` reads a file literally named `-n` — Codex 09-27). */
function splitOptions(args: string[]): { options: string[]; operands: string[] } {
  const i = args.indexOf('--');
  const before = i < 0 ? args : args.slice(0, i);
  const after = i < 0 ? [] : args.slice(i + 1);
  return { options: before.filter((a) => a.startsWith('-') && a !== '-'), operands: [...before.filter((a) => !a.startsWith('-') || a === '-'), ...after] };
}

function touchesCredentials(program: string, args: string[], cwd: string): boolean {
  const creds = credentialPaths();
  const { options, operands } = splitOptions(args);
  const recursive = program === 'rg' || ((program === 'grep') && options.some((a) => a === '-r' || a === '-R'));
  // grep/rg: first operand is the pattern; no path operands = search cwd (rg always, grep only when recursive).
  const paths = program === 'rg' || program === 'grep' ? operands.slice(1) : operands;
  const roots = recursive && !paths.length ? [cwd] : paths;
  return roots.some((a) => {
    const abs = path.resolve(cwd, a);
    if (matchProtected(abs, creds)) return true;
    if (!recursive) return false;
    const real = canonicalFuturePath(abs);
    return creds.some((c) => pathWithin(c, abs) || pathWithin(c, real));
  });
}

/** Options a known-safe rg/grep may carry. Deliberately absent: rg `-L`/`--follow` and grep `-R` (they dereference symlinks
 * inside the tree, which a root check cannot see), `--pre` and every option with side effects, and **every option that takes
 * a value**: rg's `-r` (--replace) and `-E` (--encoding) would swallow a following `--` as their argument, so
 * `rg -r -- --pre=sh x f` runs `sh` while the `--` split above thinks option parsing ended (Codex 09-27 re-review).
 * Same letters mean different things per program (grep `-L` = files-without-match, `-r` = recursive, `-E` = extended
 * regex — all argument-free) — hence per-program sets. */
const SAFE_SEARCH_FLAGS = ['-n', '-i', '-l', '-c', '-v', '-w', '-F', '--files', '--hidden', '--no-ignore', '--no-config', '--line-number', '--ignore-case', '--fixed-strings', '--files-with-matches', '--count'];
const SAFE_RG_FLAGS = new Set(SAFE_SEARCH_FLAGS);
const SAFE_GREP_FLAGS = new Set([...SAFE_SEARCH_FLAGS, '-r', '-E', '-L']);

/** Only simple unquoted word tokens are classified. Shell parsing remains the shell's job. */
export function isKnownSafeBash(command: string, cwd: string = process.cwd()): boolean {
  const cmd = String(command || '').trim();
  // Deny substitutions, expansions, quotes, shell operators, escapes and control characters.
  if (!cmd || /[^A-Za-z0-9_./:@%+=, \-]/.test(cmd)) return false;
  const [program, ...args] = cmd.split(/ +/);
  if ((SAFE_BASH_PROGRAMS.has(program) || program === 'rg' || program === 'grep') && touchesCredentials(program, args, cwd)) return false;
  if (SAFE_BASH_PROGRAMS.has(program)) return true;
  if (program === 'date') return args.every((a) => a === '-u' || a === '--utc' || a.startsWith('+'));
  if (program === 'hostname') return args.length === 0;
  // rg can execute --pre helpers and read config containing --pre; remove that implicit input.
  // Even without --pre, arbitrary flags can gain new behavior, so only a bounded option set.
  if (program === 'rg' || program === 'grep') {
    const flags = program === 'rg' ? SAFE_RG_FLAGS : SAFE_GREP_FLAGS;
    if (program === 'rg' && process.env.RIPGREP_CONFIG_PATH) return false;
    return splitOptions(args).options.every((a) => flags.has(a));
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

const APPROVAL_MODES = new Set(['readonly', 'auto-edit', 'full-auto', 'custom']);
/** 会话此刻存着的审批档(输入区切档 = PUT 进 agent_config)。没存 → undefined;**读失败照抛**(调用方自己决定兜底方向)。 */
export async function storedApprovalMode(sessionId: string): Promise<ApprovalMode | undefined> {
  const raw = await deps().state.getAgentConfig(sessionId);
  const mode = (typeof raw === 'string' ? JSON.parse(raw) : raw)?.approvalMode;
  return APPROVAL_MODES.has(mode) ? mode : undefined;
}


/** 越界写诊断:同 run 同目录只记一次(反馈包带后端日志;09-21 那份只剩工具名,答不了「它到底写哪儿了」)。 */
const loggedEscalations = new Set<string>();
function logEscalation(runId: string, call: ToolCall, ctx: { cwd?: string; extraRoots?: string[]; remote?: RemoteInfo }): void {
  const cwd = ctx.cwd || process.cwd();
  for (const t of writeTargetsOf(call)) {
    const dir = path.dirname(path.resolve(cwd, t));
    const key = `${runId}|${dir}`;
    if (loggedEscalations.has(key)) continue;
    if (loggedEscalations.size > 500) loggedEscalations.clear(); // ponytail: 只防无界增长,清空后最多重复记一行
    loggedEscalations.add(key);
    console.warn(`[tangu] 越界写需审批 run=${runId.slice(0, 8)} dir=${dir} roots=${JSON.stringify(writableRoots({ cwd, extraRoots: ctx.extraRoots, remote: ctx.remote } as any))}`);
  }
}

/** 写目标是否越界(工作区外,但非硬拒保护路径)→ 需升级审批。借 Codex writable-roots escalation。 */
export function writeEscalationNeeded(call: ToolCall, ctx: { cwd?: string; extraRoots?: string[]; remote?: RemoteInfo }): boolean {
  const targets = writeTargetsOf(call);
  if (!targets.length) return false;
  const cwd = ctx.cwd || process.cwd();
  // extraRoots 必须一起带上,否则用户在「工作范围」里加的目录仍会被判越界写、逐次弹审批。
  // remote 也要带:远程污点 run 的 cwd 若是家目录一类(C8),fsPolicy.writableRoots 不认它 —— 不带就等于没这道兜底。
  const fakeCtx = { cwd, extraRoots: ctx.extraRoots, remote: ctx.remote } as any;
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
  /** custom-ask=用户规则要求问 · escalate=工作区外写入升级 · mode=该档位本就需要审批 ·
   *  protected=写凭据 / ~/.forsion(-dev) 本机配置(契约 C4 / C6:完全通行也问、总允许不作数)。老客户端不认 protected → 按无理由渲染。 */
  kind: 'custom-ask' | 'escalate' | 'mode' | 'protected';
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
  // 工具名按**全部拼写**比:gateToolCall 入口已把调用归一成正典名,但用户的存量规则可能还写着旧名
  // (`deny: ["muse_watch"]` / `muse_*`)—— 只拿正典名去比,升级那一刻这些规则就静默失效(Codex 09-15)。
  // 精确规则本身也先归一(规则写 muse_watch = 规则写 manage_automation);通配规则按前缀对每个拼写各试一次。
  const spellings = toolNameSpellings(call.function.name);
  const wildcard = toolPat.endsWith('*');
  const patCanon = wildcard ? toolPat : canonicalToolName(toolPat);
  const toolOk = spellings.some((n) => (wildcard ? n.startsWith(patCanon.slice(0, -1)) : n === patCanon));
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
 *   - 入口先把工具名归一成正典名(旧别名不得绕过用户规则),此后全程按归一后的 call 判定
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
    /** 审批档跟这个会话**此刻**存的设置走(run 中途在输入区切档当场生效;团队成员 = 团队会话);没存才用 approvalMode 快照。
     *  只给「档位本就来自会话设置」的 run(见 agentLoop.approvalModeSessionId),通道 / Muse / 自动化各自定档,不给。 */
    modeSessionId?: string;
    /** 无人值守 run(Muse ask/agent 档):需要人决定时不 await 订阅者,改走 pendingApprovals(排队 / 代批)。 */
    approvalDeferral?: 'queue' | 'agent'; userId?: string; agentSlug?: string;
    /** 本次调用**此刻真正的执行身份**(具名子代理的展示 slug),与 agentSlug(run 的归属 agent)不同时才给。
     *  两个用处:① PermissionRequest hook 的 agent_slug 用它(hook 按执行身份裁决);
     *  ② pendingApprovals:ALS 作用域的工具不能排队等事后重放,否则会写到 agentSlug 那个 agent 头上。 */
    execAgentSlug?: string;
    /** 远程污点(契约 C1/C3):有效档钳到 config.json remote.maxApprovalMode;保护路径写入硬拒;「总允许」不作数。
     *  run 起跑后才被远端 steer 染上的按 runId 现取(effectiveRemote)。 */
    remote?: RemoteInfo;
    /** 无人值守且无异步审批通道的 run(自动化:强制完全通行、没有订阅者):本该问人的保护路径写入直接拒,不挂死等。 */
    unattended?: boolean;
  },
  signal?: AbortSignal,
  /** 内部用:这一趟是审批卡上**改过参数**的重闸(见函数末尾)。外部调用方不传。 */
  editedOnCard = false,
): Promise<ApprovalDecision> {
  // 工具名**先归一**(旧别名 muse_watch → manage_automation):下面每一道判定都直接读
  // call.function.name —— custom 规则匹配(customVerdictDetailed/ruleMatches)、approvalPreview、
  // PermissionRequest hook 的 tool_name、approval_request 事件、以及「总允许」的键。只归一一个局部变量
  // 的话,模型写旧别名就能整片绕过用户写的 deny/ask 规则(executeTool 照样按正典名执行真工具),
  // 而 manage_automation 这类工具的**唯一**审批控制正是 custom 规则。归一后弹窗显示的也是真正会跑的那个名字。
  const canonical = canonicalToolName(call.function.name);
  if (canonical !== call.function.name) call = { ...call, function: { ...call.function, name: canonical } };
  const name = call.function.name;
  // host 模式全部过闸;非 host 仅 MCP 工具过闸(本地形态的 sandbox 会话也可能挂 MCP)。
  if (ctx.execMode !== 'host' && !name.startsWith('mcp__')) return { action: 'approve' };
  const remote = effectiveRemote({ remote: ctx.remote, runId });
  const cap: CapMode | undefined = remote ? remoteApprovalCap() : undefined;

  // 契约 C4 · 保护路径写入(凭据 + ~/.forsion(-dev) 配置):远程污点 → 硬拒(不进审批 —— 按 D1 会被推到远端批,
  // 与「只在本机」矛盾;不依赖宿主沙箱);本机 → 每次都问人(完全通行 / 总允许 / custom allow / hook allow 都不放行);
  // 自动化这类无人值守又没有异步审批通道的 → 拒(问了也没人答,只会挂死)。
  let protectedAsk = '';
  if (ctx.execMode === 'host') {
    const cwd = ctx.cwd || process.cwd();
    for (const t of writeTargetsOf(call)) {
      const abs = path.isAbsolute(t) ? t : path.resolve(cwd, t);
      if (remote && protectedRemoteWrite(abs)) {
        return { action: 'reject', rejectReason: `Remote sessions cannot write protected configuration, credential or startup files (${abs}). Ask the user to make this change on the host computer.` };
      }
      if (!protectedAsk && protectedLocalWrite(abs)) protectedAsk = abs;
    }
    if (protectedAsk && ctx.unattended && !ctx.approvalDeferral) {
      return { action: 'reject', rejectReason: `Unattended runs cannot write protected configuration or credential files (${protectedAsk}).` };
    }
  }

  // custom 档先裁决:用户写下的规则**压过**下面的 known-safe 捷径(把 `run_bash:ls` 放进 ask
  // 就该真弹审批,否则规则形同虚设);未命中则降解成 base 档,后续逻辑与三档完全一致。
  // 档位现读:团队 run 一跑几小时、成员子 run 各自冻着启动那刻的档 —— 只认快照,用户切到「完全通行」整场纹丝不动(09-21 反馈)。
  // 读失败 fail-closed:回落快照可能正好放开用户刚收紧的档 → 按只读问,用户写的 deny / ask 规则照样生效、allow 不放行
  // (只读档管不到 manage_automation 这类只靠 custom 规则把关的工具,光落 readonly 等于绕过 deny —— Codex 09-21 二轮)。
  let mode = ctx.approvalMode;
  let readFailed = false;
  if (ctx.modeSessionId) {
    try { mode = (await storedApprovalMode(ctx.modeSessionId)) || mode; } catch { readFailed = true; }
  }
  // C3:远程污点 run 的**有效**档 = min(档, 上限) —— 钳在现读会话存档之后(本机建成完全通行的会话被手机继续,照样钳);
  // 没设档(undefined 在下面等于免审批)按上限。custom 在下面按规则层钳。
  if (cap && mode !== 'custom') mode = clampApprovalMode(mode, cap) as CapMode;
  let forceAsk = false;
  let askRule = '';
  if (mode === 'custom' || readFailed) {
    const rules = customRules();
    const v = customVerdictDetailed(call, readFailed ? { ...rules, allow: [] } : rules);
    // 拒绝时把规则串一并带出:否则用户写坏一条 deny 规则,只看到 agent 莫名失败,无从调起。
    // 模型面文本一律英文(项目约定:提示/工具结果英文,UI/日志中文)
    if (v?.verdict === 'deny') return { action: 'reject', rejectReason: `Denied by approval rule: ${v.rule}` };
    // allow 规则的放行面对远程污点 run 不超过上限档:上限档本身要问的,allow 也不代答(C3)。保护路径写入另说,总要问。
    if (v?.verdict === 'allow' && !protectedAsk && !(cap && remote && (await capWouldAsk(call, cap, ctx, remote)))) return { action: 'approve' };
    forceAsk = v?.verdict === 'ask';
    askRule = forceAsk ? v!.rule : '';
    const base: CapMode = readFailed ? 'readonly' : rules.base;
    mode = cap ? (clampApprovalMode(base, cap) as CapMode) : base;
  }

  // known-safe 只读 bash:免审批(碰凭据文件的不算 known-safe,见 isKnownSafeBash)。
  if (!forceAsk && name === 'run_bash' && isKnownSafeBash(bashCommandOf(call), ctx.cwd)) return { action: 'approve' };

  // 越界写升级:工作区外写一律要批(full-auto 例外:用户已全信任)。远程污点 run 不认额外可写根(同 fsPolicy.writableRoots)。
  const escCtx = remote ? { ...ctx, extraRoots: undefined, remote } : ctx;
  const escalate = ctx.execMode === 'host' && mode !== 'full-auto' && writeEscalationNeeded(call, escCtx);
  if (escalate) logEscalation(runId, call, escCtx);

  if (!escalate && !forceAsk && !protectedAsk) {
    // 接管态的点按类工具只能作用在绑定过的用户标签上 → 「有活绑定」即要批(与执行侧同一真源,不另探端口);
    // 无人值守 run 本就不接管,也就不因此排队审批
    const userBrowser = mode !== 'full-auto' && USER_BROWSER_ACTIONS.has(name) && !ctx.approvalDeferral && await userBrowserBound();
    if (!toolNeedsApproval(name, mode, { userBrowser, remote: !!remote })) return { action: 'approve' };
    // 改参重闸不走「总允许」捷径:同会话另一张卡刚点了总允许,也不能让这次改过的参数跳过下面的 hook(Codex 09-27 复审)。
    // 远程污点 run 也不走:本机在这个会话里点过的「总允许 run_bash」会让远程 run 越过上限档(C3)。
    if (!editedOnCard && !remote && isAlwaysAllowed(ctx.sessionId, name)) return { action: 'approve' };
  }

  // —— PermissionRequest hook：在弹审批 UI 前问 hook（host-only）。deny → 拒绝；allow → 跳过用户审批直接放行。——
  const permV = await runHooks('PermissionRequest', {
    tool_name: name,
    tool_input: parseCallArgs(call),
    // 具名子代理的调用在父 run 的 ALS 里送审、却在子代理的 ALS 里执行(subAgent.ts runWithAgentSlug):
    // hook 必须看到**执行身份**,否则「只允许父代理」的 hook 会放行一个其实由 subby 执行的 manage_harness(Codex 09-15)。
    session_id: ctx.sessionId, run_id: runId, cwd: ctx.cwd, agent_slug: ctx.execAgentSlug ?? currentAgentSlug(),
  }, {
    profile: ctx.profile,
    execMode: ctx.execMode === 'host' ? 'host' : 'sandbox',
    cwd: ctx.cwd, sessionId: ctx.sessionId, runId, signal,
  });
  // 诚实性:这是 hook 挡的,不是用户拒的 —— 不写清楚,模型和用户都会以为「用户拒绝了该操作」
  if (permV.block) return { action: 'reject', rejectReason: 'Denied by a PermissionRequest hook.' };
  // hook 的 allow 对远程污点 run 同样不越过上限档(C3):上限档本身要问的,hook 也不代答;block 照常生效。
  if (permV.allow && !protectedAsk && !(cap && remote && (await capWouldAsk(call, cap, escCtx, remote)))) return { action: 'approve' };
  // 改参重闸:「这个档位下这个工具要不要问」刚在审批卡上被答过(批准者就是在那张卡上改的参数),不问第二遍 ——
  // 否则桌面 / TUI 改完 bash 命令还得再批一次。越界写与 custom ask 规则看的是**参数**,照新参数重问(上面的 deny 规则与 hook 也已按新参数判过)。
  if (editedOnCard && !escalate && !forceAsk && !protectedAsk) return { action: 'approve' };

  const preview = protectedAsk
    ? '⚠ 受保护的配置 / 凭据 · Protected config or credentials · ' + approvalPreview(call)
    : escalate ? '⚠ 工作区外写入 · ' + approvalPreview(call) : approvalPreview(call);
  // 「为什么问你」(B3):保护路径 > 用户自己写的规则 > 越界升级 > 档位本身。
  // 保护路径排最前:它是「总允许在这里不作数、完全通行也要问」的那个理由,卡片据此说清(契约 C6,桌面映射 zh/en 文案)。
  const reason: ApprovalReason = protectedAsk
    ? { kind: 'protected', mode }
    : forceAsk
      ? { kind: 'custom-ask', rule: askRule, mode }
      : escalate
        ? { kind: 'escalate', mode }
        : { kind: 'mode', mode };
  // 无人值守且没有异步审批通道(自动化 / Muse 完全通行档,被远端 steer 染色后才会走到这里):没人答,await 就是永久挂起 → 直接拒。
  if (ctx.unattended && !ctx.approvalDeferral) {
    return { action: 'reject', rejectReason: 'This unattended run cannot ask for approval, so the action was not performed.' };
  }
  // 无人值守 run:没有订阅者能应答 approval_request,await 就是永久卡死 → 排队 / 代批(动态 import 防模块环)。
  if (ctx.approvalDeferral) {
    const { deferApproval } = await import('./pendingApprovals.js');
    return deferApproval(runId, call, preview, reason, ctx);
  }
  const d = await requestApproval(runId, call, preview, signal, reason);
  if (d.action === 'reject') return d;
  let out: ApprovalDecision = { action: 'approve' };
  if (d.argsOverride) {
    // 批准时改了参数 → 真正要执行的是新参数,批准只覆盖卡上显示过的那份:按新参数把整道闸重过一遍
    // (custom 规则 / known-safe / 越界升级 / PermissionRequest hook 都认新参数)。从前改写后直接执行,
    // 改成工作区外路径或 deny 规则挡的命令都不再过闸。再次弹卡时批准者可能又改一次 → 取最后一次的参数。
    const edited: ToolCall = { ...call, function: { ...call.function, arguments: JSON.stringify(d.argsOverride) } };
    const again = await gateToolCall(runId, edited, ctx, signal, true);
    if (again.action === 'reject') return again;
    out = { action: 'approve', argsOverride: again.argsOverride ?? d.argsOverride };
  }
  // 「总允许」在重闸**之后**才记:先记的话,重闸那一趟被 isAlwaysAllowed 提前放行,改后的参数就绕过了 PermissionRequest hook(Codex 09-27)。
  // 越界写、custom 的 ask 规则都不进「总允许」:前者每次都确认,后者是用户写死的「永远问我」。
  // 远程污点 run 的「总允许」按单次批准算:记下来就等于远端改了本机会话的审批面(本机 run 随后也吃它)。
  if (d.action === 'approve_always' && !escalate && !forceAsk && !protectedAsk && !remote) allowAlways(ctx.sessionId, name);
  return out;
}

/** 这次调用若按上限档 cap 判,需不需要问人(custom 的 allow 规则对远程污点 run 不许越过它)。 */
async function capWouldAsk(
  call: ToolCall,
  cap: CapMode,
  ctx: { execMode?: string; cwd?: string; extraRoots?: string[]; approvalDeferral?: 'queue' | 'agent' },
  remote: RemoteInfo,
): Promise<boolean> {
  if (cap === 'full-auto') return false;
  const name = call.function.name;
  if (name === 'run_bash' && isKnownSafeBash(bashCommandOf(call), ctx.cwd)) return false;
  if (ctx.execMode === 'host' && writeEscalationNeeded(call, { cwd: ctx.cwd, remote })) return true; // 远程不认额外可写根,也不认 C8 禁用的 cwd
  const userBrowser = USER_BROWSER_ACTIONS.has(name) && !ctx.approvalDeferral && await userBrowserBound();
  return toolNeedsApproval(name, cap, { userBrowser, remote: true });
}
