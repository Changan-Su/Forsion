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
import { publish } from './eventBus.js';
import { isOutsideWorkspace, writableRoots } from '../tools/fsPolicy.js';
import { writeTargetsOf } from '../tools/writeTargets.js';
import type { ToolCall } from '../core/types.js';
import { runHooks } from '../hooks/index.js';
import { currentAgentSlug } from '../seams/runContext.js';
import { canonicalToolName, declaredApproval, toolNameSpellings } from '../tools/toolRegistry.js';
import { USER_BROWSER_ACTIONS, userBrowserBound } from '../tools/builtin/browserTools.js';
import { getRawSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';
import type { AppProfile } from '../seams/appProfile.js';
import { canonicalFuturePath } from '../sandbox/hostSandboxProtection.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { MUSE_AGENT_SLUG, AGENT_MAX_ITERATIONS_MIN, buildAgentDef, getAgent, isValidSlug, slugify, type NormalAgentDef } from '../agents/agentRegistry.js';
// 控制面预览按**落盘前的校验结果**渲染(见 savedText)。两个校验都是纯同步函数;museTriggers 只在函数体里用 agentRegistry 的导出,
// 与本文件 ↔ agentRegistry 的既有互引同理,求值顺序无关。
import { validateEntryInput } from './agentSchedule.js';
import { validateTriggerInput } from './museTriggers.js';

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | 'custom';

const KNOWN_APPROVAL_MODES: readonly string[] = ['readonly', 'auto-edit', 'full-auto', 'custom'];
const warnedUnknownModes = new Set<string>();
/**
 * 审批档归一(H5 fail-closed):空 / 缺席 → undefined(调用方按原口径兜底:host=auto-edit、云端=full-auto);
 * 四个 id 原样;**其它任何非空值** → readonly 并告警。旧口径是 `||` 透传,落到 toolNeedsApproval 末尾的
 * `return false` —— 一个拼错 / 新客户端才认识的档位 = 全部放行。同一个值只告警一次(每次工具调用都会过这里)。
 */
export function normalizeApprovalMode(raw: unknown, source = 'approvalMode'): ApprovalMode | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'string' && KNOWN_APPROVAL_MODES.includes(raw)) return raw as ApprovalMode;
  warnUnknownMode(raw, source);
  return 'readonly';
}
function warnUnknownMode(raw: unknown, source: string): void {
  const key = `${source}|${String(raw)}`;
  if (warnedUnknownModes.has(key)) return;
  if (warnedUnknownModes.size > 200) warnedUnknownModes.clear(); // ponytail: 只防无界增长
  warnedUnknownModes.add(key);
  console.warn(`[tangu] 未知审批档 ${JSON.stringify(raw)}(来源 ${source}),按 readonly 处理`);
}
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
 *   不认识的非空档:按 readonly(H5,见 normalizeApprovalMode);空 / 缺席 = 不审批(云端口径)
 * 只读工具（read_file/list_dir/web_search/...）永不在此返回 true。
 * 控制面(manage_agent 建改 / 无人值守自动化与日程)按参数判定,不在此处 —— 见 controlPlaneCall。
 */
export function toolNeedsApproval(name: string, rawMode: ApprovalMode | undefined, opts?: { userBrowser?: boolean }): boolean {
  let mode = normalizeApprovalMode(rawMode, 'toolNeedsApproval');
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
    declaredApproval(name) === 'command';
  if (mode === 'auto-edit') return runsCommands;
  // readonly(归一后已不可能再有别的值;即便有,也按最严的一档兜 —— 旧代码这里 return false = 未知档全放行)
  return writesFiles || runsCommands;
}

/**
 * 控制面(H1):agent 发起的「建出之后无人值守、以完全放行跑的工作」。前两档(readonly / auto-edit)
 * 每次都问、**不进「总允许」**;full-auto 放行;custom 规则照旧先裁决(deny / allow / ask)。
 * 这三个都是核心工具,按参数判定写在核心里(插件声明式 capabilities.approval 管不了「同一工具的某些动作」)。
 *   - manage_agent  : create / update(改的是别的 agent 下次怎么跑,含模型 / 工具 / 思考档);list / delete 免批
 *   - manage_schedule: set 且 auto=true(到期经 automation 管道以 full-auto 起跑);auto=false 纯规划免批。
 *                     例外:Muse 自己的后台周期给**自己**排的 auto 条目 —— 它们回灌进 Muse 的周期、按 Muse 当前档跑
 *                     (automation.ts 跳过 muse),不是提权;不豁免的话 ask/agent 档的 Muse 每个自排跟进都要排队等人批。
 *   - manage_automation: set 且规则启用,并且含 agent_run / tool_call 步骤、或旧式 agent 简写(单步 agent_run);
 *                     更新时省略 actions = 保留旧动作链(upsertTrigger),看不到旧链 → 按控制面问(fail-closed)。
 *                     list / remove / 纯停用(enabled:false 且不同时写入 agent_run / tool_call / 旧式 agent)、
 *                     纯 notify / db 动作链、唤醒 Muse 的旧式规则免批。
 *   非 host 会话(本机引擎的 sandbox 会话)里控制面**不论档位**都问:sandbox 的 full-auto 是缺省值、只授权沙箱内的事,
 *   不是对「到点在 host 上以完全放行跑」的授权(见 gateToolCall)。
 * 解析口径逐一对齐各工具自己的校验(validateEntryInput 的 auto、validateTriggerInput 的 enabled / agent_slug)。
 */
export function controlPlaneCall(
  name: string,
  args: unknown,
  opts: { agentSlug?: string; museCycle?: boolean } = {},
): boolean {
  const a: Record<string, any> = args && typeof args === 'object' ? (args as Record<string, any>) : {};
  const action = String(a.action ?? '');
  if (name === 'manage_agent') return action === 'create' || action === 'update';
  if (name === 'manage_schedule') {
    if (action !== 'set' || !(a.auto === true || a.auto === 'true')) return false;
    const target = String(a.agent || opts.agentSlug || DEFAULT_AGENT_SLUG).trim(); // 与 manageSchedule.execute 同口径
    return !(opts.museCycle && target === MUSE_AGENT_SLUG);
  }
  if (name === 'manage_automation') {
    if (action !== 'set') return false;
    const agent = String(a.agent_slug ?? a.agent ?? '').trim(); // manageAutomation:agent_slug ?? agent;muse 归一为唤醒 Muse
    // 本次调用**写进去**的控制内容:非 Muse 的旧式 agent 简写,或含 agent_run / tool_call 的动作链(形状不对按最严)。
    const writesControl = (agent !== '' && agent !== MUSE_AGENT_SLUG) ||
      (a.actions != null && (!Array.isArray(a.actions) || a.actions.some((s: any) => {
        const t = String(s?.type || '');
        return t === 'agent_run' || t === 'tool_call';
      })));
    // 停用(validateTriggerInput:缺席=启用)只在**不写入**控制内容时免批:停用的同时改写 agent_run 链 / 旧式 agent 的 prompt,
    // 用户之后在面板里一键重新启用,跑的就是模型写的那条链(面板不显示改动)。省略 actions 的纯停用照旧免批。
    if (a.enabled !== undefined && !a.enabled) return writesControl;
    if (writesControl) return true;
    // 启用且省略 actions 的更新 = 保留旧动作链(upsertTrigger),分类器看不到旧链 → 按控制面问(fail-closed);null = 显式清空。
    return a.actions === undefined && !!String(a.id ?? '').trim();
  }
  return false;
}

/** controlPlaneCall 可能为真的工具(闸门据此决定要不要为非 host 调用解析参数)。 */
const CONTROL_PLANE_TOOLS = new Set(['manage_agent', 'manage_schedule', 'manage_automation']);

/*
 * 审批预览的排版(Codex 09-25 二轮 #2)。控制面审批卡的待批内容**一个字都不省**:无人值守要跑的提示词、tool_call 的参数、
 * Agent 的指令 / 人格 / 工具名单 —— 桌面 / TUI 审批卡、通道卡与 Muse 代批判官都只看得到 preview(Codex 09-25 P1)。
 * **换行不折**:旧口径把所有空白折成一个空格,`echo ok # safe\nrm -rf ~/Documents` 显示成一行,后一条命令看着像在注释里。
 * 所以:
 *   - 内容字段(命令 / 提示词 / 指令 / 人格 / 正文 / stdin / 浏览器任务)换行与缩进原样;结构化预览(manage_*)里多行的值排成块,
 *     每行带固定前缀 PREVIEW_GUTTER —— 内容行冒充不了结构行(「· tools → […]」),截断标记落在块外、不带前缀;
 *     tool_call 步骤 / 兜底分支(mcp__ 等)的参数里,顶层含换行的字符串值同样抽出来排成块(`args.<键>:`),其余照旧 JSON;
 *     **要执行的值**(这些参数、write_process_input 的 stdin)首尾的换行不吞:写成块前的 `[starts with "…" · ends with "…"]`,
 *     只剩一行时整值写 JSON 字面量(见 execBlock;对交互进程一个空行就是一次回车);
 *   - 标识类字段(slug / 名字 / id / 模型 / 日期 / 工具名)保持单行,换行写成可见的 `\n`,不静默折掉;
 *   - 整段预览最后过一遍 previewText:C0(留 \t \n)/ C1 / 零宽 / 方向控制 / 行段分隔符换成可见转义(见 SPOOF_CHARS);
 *     **长空白串**(不论行首行中,宽于 MAX_BLANK_COLS 列)换成可见的 `[N spaces]` —— pre-wrap 的卡片里,一长串空白挂在
 *     行尾(CSS 对 pre-wrap 行尾空白无条件 hang),其后的文字**与卡片宽度无关地**软换行到第 0 列、不带前缀,冒充结构行
 *     (Codex 09-25 三轮 #5;280/400/640px 实测都落在第 0 列)。缩进与对齐在阈值内原样。
 *   - 前缀只挡得住「硬换行」:卡片比内容行窄时,普通长行照样软换行到第 0 列。所以引擎补的事实(改哪个 agent、审批档)
 *     放第一行、在任何模型内容之前(controlPreview),不靠排在末尾的位置说话 —— 收件箱按 2000 字截断时也截不掉它。
 * 客户端原样显示(桌面 .approval-preview 是 pre-wrap;TUI 的 Ink Text 认 \n;通道按行切条)。界面要折叠自己折,不能在这里省。
 */
/** 块内容行的前缀(结构化预览里多行的值)。 */
export const PREVIEW_GUTTER = '  │ ';
// 能在展示面上伪装内容的字符:C0 控制符(不含 \t \n;\r 单独出现时也算 —— 终端里它把光标拉回行首、覆盖前文)、DEL、
// C1(8 位 CSI 0x9B 真终端会解释,TUI 就跑在终端里)、软连字符、阿拉伯字母标记、蒙古文元音分隔符、零宽空格、
// LRM / RLM、行 / 段分隔符(浏览器里会断行)、方向嵌入 / 覆盖 / 隔离、word joiner 与不可见运算符、BOM。
// 换成**可见**转义而不是空格:空格能把伪装后的串变得像无害的,可见的 \u202E 会让人多看一眼。
// ZWNJ / ZWJ(U+200C / U+200D)不在内:波斯文、印地文与 emoji 序列正常要用它们,单独出现也改不了显示顺序。
const SPOOF_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00AD\u061C\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;
/** 一段横向空白(行首行中都算)宽过这么多列(tab 按 8 列)就换成可见标记。24 = 六级 4 空格缩进 / 三个 tab 仍原样;
 *  桌面卡片 / 终端都宽过它,挂在行尾的空白推不走后面的文字(见上方排版说明)。 */
const MAX_BLANK_COLS = 24;
/** String.replace 的回调:run 是一段极大的横向空白,at 是它在 all 里的位置。 */
const blankRun = (run: string, at: number, all: string): string => {
  // 块前缀(行首的 PREVIEW_GUTTER)末尾那个空格和内容的行首缩进连成一串:它不算内容,原样留着
  const lead = at >= 3 && all.startsWith(PREVIEW_GUTTER, at - 3) && (at === 3 || all[at - 4] === '\n') ? run[0] : '';
  const content = run.slice(lead.length);
  let cols = 0;
  for (const c of content) cols += c === '\t' ? 8 : 1;
  if (cols <= MAX_BLANK_COLS) return run;
  const kind = /^ +$/.test(content) ? 'spaces' : /^\t+$/.test(content) ? 'tabs' : 'whitespace chars';
  // 两侧各留一个空格与邻字隔开;行首 / 行尾不补
  const before = lead || (at === 0 || all[at - 1] === '\n' ? '' : ' ');
  const end = at + run.length;
  const after = end === all.length || all[end] === '\n' ? '' : ' ';
  return `${before}[${content.length} ${kind}]${after}`;
};
/** 审批预览的展示净化:保留换行、缩进与制表符,其余能伪装显示的字符换成可见转义(\x1B、\u202E);CRLF 归一为 \n、去掉末尾空白;
 *  宽过 MAX_BLANK_COLS 列的空白串换成 `[N spaces]`(见上方排版说明)。
 *  approvalPreview 的返回值已经过这一道;收件箱 / 其它要**多行**展示预览的地方复用它(单行的 LOG / 标题照旧用 displayText)。 */
export function previewText(s: unknown): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(SPOOF_CHARS, (c) => {
      const n = c.charCodeAt(0);
      return n < 0x100 ? `\\x${n.toString(16).toUpperCase().padStart(2, '0')}` : `\\u${n.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    // 不用 .replace(/\s+$/, ''):一长串空白后面跟着别的字(`"yes<空白>"` 的引号、`[ends with "<空白>"]`)时它是平方级
    // (9 万个空格 ≈ 3.6s,同步卡在审批闸里,入队时 storedPreview 还再来一遍 —— 三轮 C #2)。trimEnd 线性,剥的字符集相同
    // (WhiteSpace + LineTerminator,与 \s 同一张表)。
    .trimEnd()
    // 净化之后剩下的横向空白:空格、\t、NBSP、U+1680、U+2000–U+200A、U+202F、U+205F、U+3000(\v \f \r 已转义)
    .replace(/[^\S\n]+/g, blankRun);
}
/** 标识类字段:单行,换行写成可见的 `\n`(不折、不丢)。其余控制符由 previewText 统一转义。 */
const full = (v: unknown): string => String(v ?? '').trim().replace(/\r?\n/g, '\\n');
/** 内容字段:换行与缩进原样。单行 → 原样(去首尾空白);多行 → 以换行开头、每行带 PREVIEW_GUTTER、以换行结尾的块
 *  (只去掉开头的空行与末尾空白,首行缩进也保留)。拼接用 labeled / joinParts,块后面的结构从新的一行起。 */
const body = (v: unknown): string => {
  const s = String(v ?? '').replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (!s.includes('\n')) return s.trim();
  return `\n${s.split('\n').map((l) => (l ? PREVIEW_GUTTER + l : PREVIEW_GUTTER.trimEnd())).join('\n')}\n`;
};
/** 可执行的值(write_process_input 的 stdin、tool_call 步骤 / mcp__ 等兜底分支的参数)排成块:**每个换行都看得见**
 *  (Codex 09-25 三轮 B #2)。body() 是给提示词这类正文用的,去掉开头的空行与末尾空白 —— 对要执行的值那就是吞掉回车:
 *  发按键的 `"\nyes\n"` 显示成 `args.input: yes`,实际先回车、再 yes、再回车。所以:
 *    - 剥出开头的空白行(start 之前)与末尾空白(end 之后,含换行 / \r / 空格);都在**原串**上算,\r\n 与单独的 \r 原样进 JSON;
 *    - 中间是多行 → 照旧排块(两端没有空白时与 body 逐字相同);两端有东西时,块**前**加一行不带前缀的结构行
 *      `[starts with "…" · ends with "…"]`(JSON 字面量,每个 \n 都写出来;内容行都带前缀,冒充不了)。
 *      「ends with」也写在块前,不写在块后:引擎补的事实放在模型内容之前(见上方排版说明),长脚本被收件箱 / LOG / 通道
 *      截断时截不掉它。不整值退成 JSON:脚本几乎都以换行结尾,整段 JSON 会把三轮 #6 的多行命令打回一行;
 *    - 中间只剩一行(含全空白)→ undefined:调用方整值写 JSON 字面量(withArgs 留在参数 JSON 里)。
 *  不用 /\s+$/ 剥末尾:对 10 万字的参数是平方级(5 万个空格 + 1 个字 ≈ 1s);开头按行走一遍,线性。 */
const execBlock = (s: string): string | undefined => {
  let start = 0;
  for (let nl = s.indexOf('\n'); nl !== -1 && !s.slice(start, nl).trim(); nl = s.indexOf('\n', start)) start = nl + 1;
  const end = start + s.slice(start).trimEnd().length;
  const core = s.slice(start, end);
  if (!core.includes('\n')) return undefined;
  const lines = core.replace(/\r\n/g, '\n').split('\n').map((l) => (l ? PREVIEW_GUTTER + l : PREVIEW_GUTTER.trimEnd()));
  const edges = [
    start ? `starts with ${JSON.stringify(s.slice(0, start))}` : '',
    end < s.length ? `ends with ${JSON.stringify(s.slice(end))}` : '',
  ].filter(Boolean).join(' · ');
  return `\n${edges ? `[${edges}]\n` : ''}${lines.join('\n')}\n`;
};
/** `label: 值`;值是块时冒号后直接换行。 */
const labeled = (label: string, b: string): string => (b.startsWith('\n') ? `${label}:${b}` : `${label}: ${b}`);
/** 按分隔符拼接;前一段以块结尾(已换行)时分隔符去掉行首空格,不把结构接在内容行后面。 */
const joinParts = (parts: string[], sep = ' · '): string =>
  parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}${acc.endsWith('\n') ? sep.trimStart() : sep}${p}`), '');
/** 参数原样 JSON(不折空白:字符串里的换行按 \n 转义,一个字符不丢;方向控制符由 previewText 转义)。 */
const asJson = (v: unknown): string => {
  try { return JSON.stringify(v ?? {}) ?? String(v); } catch { return String(v); }
};
/** `head {参数 JSON}`;参数对象里**顶层**的多行字符串值(命令、脚本、正文)抽出来排成 `args.<键>:` 块,其余键照旧 JSON
 *  (Codex 09-25 三轮 #6:无人值守 tool_call run_bash 的 `echo ok # safe\nrm -rf ~` 在单行 JSON 里只剩一个可见的 \n 区分)。
 *  块走 execBlock:首尾的换行 / 空白行写成块前的 `[starts with … · ends with …]`,不吞(三轮 B #2)。
 *  去掉首尾空白后只剩一行的值(`"\nyes\n"`、`"yes\n\n"`)与全空白的值留在 JSON 里 —— 每个 \n 都转义可见。
 *  只看顶层:嵌套对象里的字符串照旧 JSON 转义,一个字符不丢。 */
const withArgs = (head: string, v: unknown): string => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${head} ${asJson(v)}`;
  const rest: Record<string, unknown> = {};
  const blocks: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const block = typeof val === 'string' ? execBlock(val) : undefined;
    if (block) blocks.push(labeled(`args.${full(k)}`, block));
    else rest[k] = val;
  }
  if (!blocks.length) return `${head} ${asJson(v)}`;
  return joinParts([Object.keys(rest).length ? `${head} ${asJson(rest)}` : head, ...blocks]);
};
/**
 * 卡上写的必须是**实际落盘**的那一份(09-25 评审 #4):写全之后卡片展示的是原始参数,而各工具落盘前会截断 ——
 * agent_run / 旧式 prompt 500、日程 prompt 4000 / description 500、notify 正文 4000、Agent 指令 / 人格 100k。
 * 模型在 500 字之后补一句「更正:什么都别删」,卡上看得见、存下来的却没有。所以控制面三件先过各自的校验
 * (validateTriggerInput / validateEntryInput / buildAgentDef,都是纯同步函数)再渲染;截掉了就明说。
 * 校验不过 = 工具会报错、什么都不存 → 退回原始参数渲染(不把校验的中文错误语塞进英文卡片)。
 */
const savedText = (saved: string, raw: unknown): string => {
  const shown = body(saved);
  if (String(raw ?? '').trim() === saved.trim()) return shown;
  // 块:标记单独一行、不带前缀 —— 内容写不出「看着没截断」的样子
  const mark = `[truncated: only the first ${saved.length} characters are saved]`;
  return shown.endsWith('\n') ? `${shown}${mark}` : `${shown} ${mark}`;
};

/** manage_agent 的参数 → buildAgentDef 会存下的那份(与 manageAgent.execute 的映射同口径;existing=null 只取字段校验 / 截断)。
 *  轮数低于下限的由工具自己拒(且会触发 clamp 的告警),不传进来。缺 name / system_prompt → buildAgentDef 抛 → undefined。 */
function savedAgentFields(args: any): NormalAgentDef | undefined {
  const iter = Number(args.max_iterations);
  try {
    return buildAgentDef('preview', null, {
      name: String(args.name ?? ''),
      description: args.description != null ? String(args.description) : undefined,
      model: args.model != null ? String(args.model) : undefined,
      tools: Array.isArray(args.tools) ? args.tools.map((t: unknown) => String(t)) : undefined,
      thinkingLevel: args.thinking_level,
      maxIterations: Number.isFinite(iter) && iter >= AGENT_MAX_ITERATIONS_MIN ? iter : undefined,
      systemPrompt: String(args.system_prompt ?? ''),
      soul: args.soul != null ? String(args.soul) : undefined,
    });
  } catch {
    return undefined;
  }
}

/** 给审批弹窗用的人类可读预览（从 tool 参数里抽要害）。多行内容原样保留(见 previewText 上方的排版说明),
 *  返回前整段过 previewText。
 *  opts.keptActions:manage_automation 更新且省略 actions 时,闸门读到的旧动作链(undefined = 没读 / 读不到;
 *  null 或 [] = 旧规则没有动作链)。 */
export function approvalPreview(call: ToolCall, opts: { keptActions?: unknown[] | null } = {}): string {
  return previewText(rawPreview(call, opts));
}

/** approvalPreview 的未净化版本:末尾可能是块(以换行结尾),controlPreview 据此在后面接补充信息。 */
function rawPreview(call: ToolCall, opts: { keptActions?: unknown[] | null } = {}): string {
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
    // 与 run_bash 同档,写全不截(Codex 09-25 三轮 #3:旧口径截到 80 字,`echo ok` + 80 个空格 + `\nrm -rf ~` 卡上只剩 echo ok)。
    // 取值与工具同口径:input 不是字符串 = 空 = 只轮询。
    const inp: string = typeof args.input === 'string' ? args.input : '';
    const head = `→ proc ${full(args.process_id)}`;
    if (!inp) return `${head}: (poll)`;
    // 单独的 Ctrl-C:工具不写 stdin,改发 SIGINT,也不补换行(processRegistry.writeStdin 的 CTRL_C 分支)。
    // 只写在头部、不带冒号:内容一律在 `: ` 之后,单行输入写不出这个样子(process_id 伪造不了:对不上进程,工具直接报错)。
    if (inp === '\x03') return `${head} (Ctrl-C → SIGINT)`;
    // 卡上写的是**实际写进 stdin 的字节**(Codex 09-25 三轮 C #1):工具默认在 input 后再补一个 \n
    // (hostProcess.ts `append_newline !== false` → writeStdin 写 `data + '\n'`)。只写 input 就少一个回车 ——
    // `"\nyes\n"` 卡上两个 \n,实际三个,多出来的那个能确认下一个 [Y/n]。所以 sent = 真正写出去的那串:
    //   - 默认补换行、单行、两端无空白 → 原样(`yes` = 敲 yes 再回车,最常见的一种)。长得像引擎自己写的形态的除外:
    //     一行字 `(poll)` 原样写就是「只轮询、什么都不写」的卡,实际敲字再回车;以 `"` 开头的读起来是 JSON 字面量 —— 都按字节写;
    //   - 其余一律按 sent 渲染,与 tool_call / mcp__ 参数同一套(execBlock,三轮 B #2):中间是多行 → 块,块里的行就是字节,
    //     首尾写成块前的 `[starts with … · ends with …]`(默认模式下至少有 ends with "\n");否则整串 JSON 字面量,每个 \n 都在;
    //   - append_newline:false → 头部标 `(no trailing newline)`,且单行也写成 JSON 字面量:与默认模式的 `yes` 一眼分得开。
    //     标记同样在冒号之前,内容冒充不了。取值与工具同口径:只有布尔 false 才不补(字符串 "false" 照样补)。
    const append = args.append_newline !== false;
    if (append && !inp.includes('\n') && inp === inp.trim() && inp !== '(poll)' && !inp.startsWith('"')) return `${head}: ${inp}`;
    const sent = append ? `${inp}\n` : inp;
    return labeled(append ? head : `${head} (no trailing newline)`, execBlock(sent) ?? JSON.stringify(sent));
  }
  if (name === 'apply_patch') {
    const n = (String(args.patch ?? args.input ?? '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm) || []).length;
    return `apply_patch (${n} file change(s))`;
  }
  if (name === 'kill_process') return `kill process ${args.process_id ?? ''}`;
  if (name === 'update_session_settings') {
    const parts = [args.model ? `model → ${args.model}` : '', args.thinking_level ? `thinking → ${args.thinking_level}` : ''].filter(Boolean);
    return `session settings: ${parts.join(' · ') || '(nothing)'}${args.reason ? ` — ${String(args.reason).slice(0, 200)}` : ''}`;
  }
  // 接管用户 Chrome 时 browser_console 要批:用户批的是整段页内 JS,不许在 200 字处截断藏住后半段(Codex 09-24 #5)
  if (name === 'browser_console') return args.expression != null ? `browser_console — run JS in the page:\n${String(args.expression)}` : 'browser_console (read console/errors)';
  if (name === 'browser_task') {
    // 以用户身份操作已登录网站,与 run_bash 同档:任务全文写出,不在 160 字处截断(Codex 09-25 三轮 #3)
    const domains = Array.isArray(args.allowed_domains) && args.allowed_domains.length ? ` [${args.allowed_domains.map(full).join(', ')}]` : '';
    return labeled(`browser_task${domains}`, body(args.task));
  }
  // 控制面三件:审批卡(旧客户端不认 reason.kind='control')和 Muse 代批判官都只看得到 preview ——
  // 截断的 JSON 答不了「它要建什么、谁到时候无人值守去跑、跑什么」。
  if (name === 'manage_agent') {
    const act = String(args.action ?? '');
    if (act !== 'create' && act !== 'update') return `manage_agent ${act}${args.slug ? ` ${full(args.slug)}` : ''}`;
    // 只列模型本次传了的字段(省略的由 manageAgent 保留原值);值取落盘那份。description 进 Agent 系统提示的 Identity 段,同样要写出来。
    const sv = savedAgentFields(args);
    const iter = Number(args.max_iterations);
    const parts = [
      args.description != null ? labeled('description', sv ? savedText(sv.description, args.description) : body(args.description)) : '',
      args.model != null ? `model → ${sv ? full(sv.model) || '(session model)' : full(args.model)}` : '',
      args.thinking_level != null ? `thinking → ${sv ? sv.thinkingLevel || '(not set)' : full(args.thinking_level)}` : '',
      Array.isArray(args.tools) ? `tools → [${(sv ? sv.tools : args.tools).map(full).join(', ')}]` : '',
      args.max_iterations != null
        ? `max_iterations → ${sv && Number.isFinite(iter) && iter >= AGENT_MAX_ITERATIONS_MIN ? sv.maxIterations : full(args.max_iterations)}`
        : '',
      args.system_prompt != null ? labeled('instructions', sv ? savedText(sv.systemPrompt, args.system_prompt) : body(args.system_prompt)) : '',
      args.soul != null ? labeled('persona', sv ? savedText(sv.soul ?? '', args.soul) : body(args.soul)) : '',
    ].filter(Boolean);
    return joinParts([`manage_agent ${act} ${args.slug ? full(args.slug) : '(slug from name)'} "${sv ? full(sv.name) : full(args.name)}"`, ...parts]);
  }
  if (name === 'manage_schedule') {
    const act = String(args.action ?? '');
    const who = args.agent ? ` for agent "${full(args.agent)}"` : '';
    if (act !== 'set') return `manage_schedule ${act}${who}${args.id ? ` ${full(args.id)}` : ''}`;
    const auto = args.auto === true || args.auto === 'true';
    // description 到点拼进无人值守 kickoff 的「Context:」(automation.scheduleMessage),与 prompt 同样是要跑的指令(评审 #2)。
    const v = validateEntryInput(args);
    const prompt = v.ok ? savedText(v.value.prompt, args.prompt) : body(args.prompt);
    const desc = v.ok ? (v.value.description ? savedText(v.value.description, args.description) : '') : body(args.description);
    return joinParts([
      `manage_schedule set ${args.id ? full(args.id) : '(new)'}${who}: "${v.ok ? full(v.value.name) : full(args.name)}" @ ${full(args.date || '?')}` +
        `${args.repeat ? ` every ${full(args.repeat)}` : ''}`,
      auto ? labeled('runs unattended when due', prompt) : 'planning only',
      desc ? labeled('context', desc) : '',
    ].filter(Boolean));
  }
  if (name === 'manage_automation') {
    const act = String(args.action ?? '');
    if (act !== 'set') return `manage_automation ${act}${args.id ? ` ${full(args.id)}` : ''}`;
    const when = [args.cond_type, args.datetime || args.interval || args.time || args.match || args.path || args.event]
      .filter(Boolean).map(full).join(' ');
    // 本次写入的动作链 / 旧式 prompt 取校验后的那份(见 savedText)。cond 换成 manual 只为绕开这里给不了的 cwd / vault
    // (file_chars_gte / db_changed 要),动作与 prompt 的校验与 cond 无关;与工具同样 allowToolCall=false。
    // cond 真不合法时工具照样报错、什么都不存 —— 卡上多写了几个字,不放宽任何东西。
    const v = validateTriggerInput({ ...args, agent_slug: args.agent_slug ?? args.agent, cond_type: 'manual' });
    const agent = v.ok ? (v.value.agentSlug ?? '') : String(args.agent_slug ?? args.agent ?? '').trim();
    const newActions: unknown = v.ok ? v.value.actions : args.actions;
    const legacyPrompt = v.ok ? savedText(v.value.prompt ?? '', args.prompt) : body(args.prompt);
    // 原始参数里同一步的原文(按下标对齐,校验不改顺序):截断标记要拿它比。kept 链是已落盘的值,没有原文 → 不标。
    const rawSteps: any[] = v.ok && Array.isArray(args.actions) ? args.actions : [];
    // 每步写全:agent_run 的整段提示词、tool_call 的整份参数、notify 正文、多维表写入的目标与单元格。
    const renderSteps = (list: any[], raw: any[] = []): string => joinParts(list.map((s: any, i: number) => {
      const t = String(s?.type || '?');
      const text = (key: 'prompt' | 'body'): string => (raw[i] ? savedText(String(s?.[key] ?? ''), raw[i]?.[key]) : body(s?.[key]));
      if (t === 'agent_run') return labeled(`agent_run "${full(s.agentSlug || s.agent_slug)}" unattended`, text('prompt'));
      if (t === 'tool_call') return withArgs(`tool_call ${full(s.tool)}`, s.args);
      if (t === 'notify') return s.body ? labeled(`notify "${full(s.title)}"`, text('body')) : `notify "${full(s.title)}"`;
      const { type: _t, path: p, ...rest } = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return `${t}${p ? ` ${full(p)}` : ''}${Object.keys(rest).length ? ` ${asJson(rest)}` : ''}`;
    }), ' → ');
    // 更新且省略 actions = 保留旧链(upsertTrigger);旧式 agent / prompt 则按本次参数整量覆写。
    // 闸门读得到旧链时经 opts.keptActions 传进来,让用户看见批的这条规则到点**实际**跑什么(评审 #7)。
    const keeps = args.actions === undefined && !!args.id;
    const kept = keeps && Array.isArray(opts.keptActions) && opts.keptActions.length ? opts.keptActions : undefined;
    const steps = Array.isArray(newActions)
      ? renderSteps(newActions, rawSteps)
      : kept
        ? `keeps existing actions: ${renderSteps(kept)}`
        : agent && agent !== MUSE_AGENT_SLUG
          ? labeled(`agent_run "${full(agent)}" unattended`, legacyPrompt)
          : keeps && opts.keptActions === undefined ? '(actions unchanged)' : 'wake Muse';
    const off = args.enabled !== undefined && !args.enabled ? ' (disabled)' : '';
    return joinParts([`manage_automation set ${args.id ? full(args.id) : '(new)'}${off}: "${full(args.desc)}"`, `when ${when || '?'}`, steps]);
  }
  // 兜底(mcp__ 任意能力、插件声明 command 档的工具):整份参数,不在 200 字处截断(Codex 09-25 三轮 #3);多行字符串排成块(#6)
  return withArgs(name, args);
}

/**
 * 拒绝的模型面文案(英文),按原因区分 —— ApprovalDecision.rejectReason 是唯一载体:
 *   - 规则 / hook / 无人值守排队:各自在产生处写 rejectReason(`Denied by approval rule: …` 等);
 *   - 中止(用户停了 run、审批还挂着):ABORTED_REJECT_REASON;
 *   - 用户在审批卡 / 通道里点了拒绝:决定体不带 rejectReason → 消费方回落 USER_REJECT_REASON。
 * 旧文案是写死的中文「用户拒绝了该操作。」,且三种原因共用,模型分不清是被拒、被停还是被规则挡。
 */
export const USER_REJECT_REASON =
  'The user rejected this tool call, so it was NOT run. Do not retry the same call; ask the user how to proceed or continue with other work.';
export const ABORTED_REJECT_REASON =
  'The run was stopped while this tool call was waiting for approval, so it was NOT run.';

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
  // 中止 ≠ 用户拒绝:按拒绝兑现,但原因写清(主 loop 随后抛 AbortLikeError 不会读到;子代理等其它消费方会)
  if (signal?.aborted) return Promise.resolve({ action: 'reject', rejectReason: ABORTED_REJECT_REASON });
  const approvalId = nextApprovalId();
  return new Promise<ApprovalDecision>((resolve) => {
    const onAbort = (): void => {
      pending.delete(approvalId);
      resolve({ action: 'reject', rejectReason: ABORTED_REJECT_REASON });
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

/** 会话此刻存着的审批档(输入区切档 = PUT 进 agent_config)。没存 → undefined;**读失败照抛**(调用方自己决定兜底方向)。
 *  存了个不认识的非空值 → readonly(H5):从前当「没存」,回落到可能更宽的启动快照。 */
export async function storedApprovalMode(sessionId: string): Promise<ApprovalMode | undefined> {
  const raw = await deps().state.getAgentConfig(sessionId);
  const mode = (typeof raw === 'string' ? JSON.parse(raw) : raw)?.approvalMode;
  return normalizeApprovalMode(mode, `session ${sessionId}`);
}


/** 越界写诊断:同 run 同目录只记一次(反馈包带后端日志;09-21 那份只剩工具名,答不了「它到底写哪儿了」)。 */
const loggedEscalations = new Set<string>();
function logEscalation(runId: string, call: ToolCall, ctx: { cwd?: string; extraRoots?: string[] }): void {
  const cwd = ctx.cwd || process.cwd();
  for (const t of writeTargetsOf(call)) {
    const dir = path.dirname(path.resolve(cwd, t));
    const key = `${runId}|${dir}`;
    if (loggedEscalations.has(key)) continue;
    if (loggedEscalations.size > 500) loggedEscalations.clear(); // ponytail: 只防无界增长,清空后最多重复记一行
    loggedEscalations.add(key);
    console.warn(`[tangu] 越界写需审批 run=${runId.slice(0, 8)} dir=${dir} roots=${JSON.stringify(writableRoots({ cwd, extraRoots: ctx.extraRoots } as any))}`);
  }
}

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
  /** custom-ask=用户规则要求问 · escalate=工作区外写入升级 · mode=该档位本就需要审批
   *  · control=控制面:建出之后无人值守、以完全放行跑的工作(建自动化 / auto 日程 / 建改 Agent),不可「总允许」。
   *  旧客户端不认识新 kind 只是不显示原因(桌面 appStore 白名单清洗成 undefined)。 */
  kind: 'custom-ask' | 'escalate' | 'mode' | 'control';
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
  // H5:缺席 / 空 = 缺省 auto-edit(照旧);三档原样;其它任何值(拼错的 "read-only"、大小写变体、把 custom 当 base)
  // → readonly 并告警。旧口径是一律落 auto-edit —— 用户想写只读、手滑写成 "Readonly",就被静默放宽成自动改文件。
  let base = normalizeApprovalMode(raw.base, 'config.json approval.base');
  if (base === 'custom') { warnUnknownMode(raw.base, 'config.json approval.base'); base = 'readonly'; }
  return {
    base: base ?? 'auto-edit',
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

/** child 是否在 parent 之内(含相等);两侧都应是 canonicalFuturePath 归一过的绝对路径。 */
function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * H3:custom 的 allow 规则能否豁免「越界写」升级。只有规则带**绝对路径前缀**、且本次**全部**写目标
 * (相对路径按 cwd 解析)经真实路径归一后都落在该前缀之内才算 —— 裸 `write_file` 这种 allow 从前在越界升级之前
 * 就返回了,等于静默放行工作区外任意位置的写入。归一用 canonicalFuturePath(与 fsPolicy.realResolve 同一算法:
 * realpath 最深已存在祖先再拼回),前缀与目标两侧同规归一:`../` 逃逸、前缀内的软链指向外面、macOS /tmp→/private/tmp 都挡得住。
 * 规则匹配本身(ruleMatches)仍是字面前缀、只看首个目标 —— deny / ask 语义不动,这里只收紧 allow 的豁免面。
 */
export function allowRuleCoversWrites(rule: string, call: ToolCall, cwd?: string): boolean {
  const i = rule.indexOf(':');
  const prefix = i >= 0 ? rule.slice(i + 1).trim() : '';
  if (!prefix || !path.isAbsolute(prefix)) return false;
  const targets = writeTargetsOf(call);
  if (!targets.length) return false;
  const root = canonicalFuturePath(prefix);
  const base = cwd || process.cwd();
  return targets.every((t) => isInsideDir(canonicalFuturePath(path.resolve(base, t)), root));
}

/** 本次 run 的 profile 是否本机引擎形态(ctx.profile 缺省回退部署基线;未配置 = 否)。 */
function profileHasHostExec(p?: AppProfile): boolean {
  try { return !!(p ?? deps().profile).capabilities.hostExec; } catch { return false; }
}

/**
 * 控制面审批卡的预览:在 approvalPreview 之上补**只有闸门读得到**的事实(评审 #7),用户据此才批得明白 ——
 *   - manage_automation 更新且省略 actions:旧动作链会保留,写出它到点实际跑什么(从前只有「(actions unchanged)」);
 *   - manage_agent create / update:是否覆盖已有 agent,以及生效的审批档 —— Agent 自带档由 manageAgent 保留;
 *     没有自带档(新建,或先 delete 再 create)= 跟会话档。先免批 delete 再 create,卡上写的是「new agent」,不再像无害的新建。
 * 读失败只是少这点补充,判定不受影响。
 */
async function controlPreview(call: ToolCall): Promise<string> {
  const args = parseCallArgs(call) || {};
  const name = call.function.name;
  try {
    const id = String(args.id ?? '').trim();
    if (name === 'manage_automation' && args.actions === undefined && id) {
      const { loadTriggers } = await import('./museTriggers.js');
      const cur = (await loadTriggers()).find((t) => t.id === id);
      return approvalPreview(call, { keptActions: cur ? (cur.actions ?? null) : undefined });
    }
    if (name === 'manage_agent') {
      // slug 归一与 manageAgent.execute 同口径(非法 slug → slugify(name)),否则预览说的和实际写的不是同一个 agent
      const requested = args.slug ? String(args.slug) : '';
      const slug = requested && isValidSlug(requested) ? requested : slugify(String(args.name ?? ''));
      const existing = slug ? await getAgent(slug) : null;
      const create = String(args.action) === 'create';
      const what = existing
        ? create ? `overwrites existing agent "${slug}"` : `edits agent "${slug}"`
        : create ? `new agent "${slug}"` : `agent "${slug}" does not exist`;
      const tier = existing?.approvalMode
        ? `approval tier stays ${existing.approvalMode}`
        : 'no approval tier of its own (follows the session)';
      // 引擎补的事实放**第一行**、在任何模型内容之前(Codex 09-25 三轮 #5):排在末尾时,人格 / 指令里一长串空白能让一行
      // 伪造的「· approval tier stays readonly」软换行到第 0 列、冒充结构行;收件箱按 2000 字截断时末尾的事实也会被截掉。
      // 第一行全是引擎写的:slug 已按 isValidSlug / slugify 归一,审批档来自磁盘。
      return previewText(`${what} · ${tier}\n${rawPreview(call)}`);
    }
  } catch { /* 补充信息读不到就不补 */ }
  return approvalPreview(call);
}

/**
 * loop 工具执行前的审批闸门。返回归一化决定（approve / reject）。
 *   - execMode!=='host' 且非 mcp__ → 立即 approve（**server/worker 零影响**）—— 唯一例外:本机引擎(hostExec)的
 *     sandbox 会话发起控制面调用,不论档位都问(sandbox 的 full-auto 只是缺省值,不是对 host 无人值守工作的授权)
 *   - 入口先把工具名归一成正典名(旧别名不得绕过用户规则),此后全程按归一后的 call 判定
 *   - 档位归一:不认识的非空档按 readonly(H5)
 *   - custom 档命中规则 → deny 直接拒 / ask 强制批 / allow 直接放 —— 但 allow 不豁免越界写升级,
 *     除非规则带绝对路径前缀且全部写目标都在其内(H3);未命中按其 base 档
 *   - run_bash 且 known-safe(只读单命令) → 立即 approve（纯 UX,即便 readonly）
 *   - 越界写(工作区外,非保护路径)→ 强制升级审批（auto-edit 也要批;full-auto 放行;不吃「总允许」）
 *   - 控制面(controlPlaneCall:建无人值守工作 / 建改 Agent)→ readonly / auto-edit 必问,不吃「总允许」(H1);
 *     无人值守 run 的代批档('agent')对控制面不代批,一律排队给用户;预览补上旧动作链 / 覆盖与审批档(评审 #7)
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
  },
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  // 工具名**先归一**(旧别名 muse_watch → manage_automation):下面每一道判定都直接读
  // call.function.name —— custom 规则匹配(customVerdictDetailed/ruleMatches)、approvalPreview、
  // PermissionRequest hook 的 tool_name、approval_request 事件、以及「总允许」的键。只归一一个局部变量
  // 的话,模型写旧别名就能整片绕过用户写的 deny/ask 规则(executeTool 照样按正典名执行真工具),
  // 而 manage_automation 这类工具的**唯一**审批控制正是 custom 规则。归一后弹窗显示的也是真正会跑的那个名字。
  const canonical = canonicalToolName(call.function.name);
  if (canonical !== call.function.name) call = { ...call, function: { ...call.function, name: canonical } };
  const name = call.function.name;
  const isControl = CONTROL_PLANE_TOOLS.has(name) &&
    controlPlaneCall(name, parseCallArgs(call), { agentSlug: ctx.agentSlug, museCycle: !!ctx.approvalDeferral });
  // host 模式全部过闸;非 host 仅 MCP 工具过闸(本地形态的 sandbox 会话也可能挂 MCP)。
  // 例外(评审 H1 #1):manage_automation / manage_schedule 是 mode:'both'、只按 profile 的 hostExec 门禁 ——
  // 本机的 sandbox 会话(桌面「未选工作区」、TUI / API 直接传 execMode:'sandbox')也看得见,而它们建出的规则 / auto 日程
  // 到点以 execMode:'host' + full-auto 起跑。从前这里直接放行 = 沙箱会话一句话建出 host 上的无人值守全开工作,
  // 连审批卡都不弹。sandbox 的档(缺省 full-auto,或 agent 定义带的档)只管沙箱内,不是这件事的授权 → 控制面一律问。
  // 云端(profile 无 hostExec)这几个工具本就不可见,且照旧零影响:不进闸、不发事件。
  const nonHost = ctx.execMode !== 'host';
  const nonHostControl = nonHost && isControl && profileHasHostExec(ctx.profile);
  if (nonHost && !name.startsWith('mcp__') && !nonHostControl) return { action: 'approve' };

  // custom 档先裁决:用户写下的规则**压过**下面的 known-safe 捷径(把 `run_bash:ls` 放进 ask
  // 就该真弹审批,否则规则形同虚设);未命中则降解成 base 档,后续逻辑与三档完全一致。
  // 档位现读:团队 run 一跑几小时、成员子 run 各自冻着启动那刻的档 —— 只认快照,用户切到「完全通行」整场纹丝不动(09-21 反馈)。
  // 读失败 fail-closed:回落快照可能正好放开用户刚收紧的档 → 按只读问,用户写的 deny / ask 规则照样生效、allow 不放行
  // (只读档管不到 manage_automation 这类只靠 custom 规则把关的工具,光落 readonly 等于绕过 deny —— Codex 09-21 二轮)。
  let mode = normalizeApprovalMode(ctx.approvalMode, 'run snapshot');
  let readFailed = false;
  if (ctx.modeSessionId) {
    try { mode = (await storedApprovalMode(ctx.modeSessionId)) || mode; } catch { readFailed = true; }
  }
  let forceAsk = false;
  let askRule = '';
  let allowRule = '';
  if (mode === 'custom' || readFailed) {
    const rules = customRules();
    const v = customVerdictDetailed(call, readFailed ? { ...rules, allow: [] } : rules);
    // 拒绝时把规则串一并带出:否则用户写坏一条 deny 规则,只看到 agent 莫名失败,无从调起。
    // 模型面文本一律英文(项目约定:提示/工具结果英文,UI/日志中文)
    if (v?.verdict === 'deny') return { action: 'reject', rejectReason: `Denied by approval rule: ${v.rule}` };
    if (v?.verdict === 'allow') allowRule = v.rule; // 先不放:越界升级算完再定(H3)
    forceAsk = v?.verdict === 'ask';
    askRule = forceAsk ? v!.rule : '';
    mode = readFailed ? 'readonly' : rules.base;
  }

  // 越界写升级:工作区外写一律要批(full-auto 例外:用户已全信任)。**先于** allow 放行计算(H3):
  // 从前 allow 在这之前就返回,裸 `write_file` allow = 工作区外任意写静默放行。
  const escalate = ctx.execMode === 'host' && mode !== 'full-auto' && writeEscalationNeeded(call, ctx);
  if (allowRule && (!escalate || allowRuleCoversWrites(allowRule, call, ctx.cwd))) return { action: 'approve' };

  // known-safe 只读 bash:免审批。
  if (!forceAsk && name === 'run_bash' && isKnownSafeBash(bashCommandOf(call))) return { action: 'approve' };

  if (escalate) logEscalation(runId, call, ctx);

  // 控制面(H1):host 会话 mode 为空 = 不审批的云端口径,与 toolNeedsApproval 一致;custom 已降解成 base。
  // 非 host 会话不看档位(见入口处的例外)。
  const control = nonHost ? nonHostControl : isControl && !!mode && mode !== 'full-auto';

  if (!escalate && !forceAsk && !control) {
    // 接管态的点按类工具只能作用在绑定过的用户标签上 → 「有活绑定」即要批(与执行侧同一真源,不另探端口);
    // 无人值守 run 本就不接管,也就不因此排队审批
    const userBrowser = mode !== 'full-auto' && USER_BROWSER_ACTIONS.has(name) && !ctx.approvalDeferral && await userBrowserBound();
    if (!toolNeedsApproval(name, mode, { userBrowser })) return { action: 'approve' };
    if (isAlwaysAllowed(ctx.sessionId, name)) return { action: 'approve' };
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
  if (permV.allow) return { action: 'approve' };

  // preview 同时是审批卡正文与 Muse 代批判官的输入(模型面)→ 英文;越界的本地化标签由客户端按 reason.kind 渲染。
  const base = control ? await controlPreview(call) : approvalPreview(call);
  const preview = escalate ? `⚠ Write outside the workspace · ${base}` : base;
  // 「为什么问你」(B3):优先级与判定同序 —— 用户自己写的规则 > 越界升级 > 控制面 > 档位本身
  // (越界只有写工具、控制面只有 manage_*,两者互斥)。
  const reason: ApprovalReason = forceAsk
    ? { kind: 'custom-ask', rule: askRule, mode }
    : escalate
      ? { kind: 'escalate', mode }
      : control
        ? { kind: 'control', mode }
        : { kind: 'mode', mode };
  // 无人值守 run:没有订阅者能应答 approval_request,await 就是永久卡死 → 排队 / 代批(动态 import 防模块环)。
  if (ctx.approvalDeferral) {
    const { deferApproval } = await import('./pendingApprovals.js');
    // 控制面不交给代批判官(评审 #2):判官的放行口径是「可逆 / 在工作区内」,答不了「要不要让某个 agent 到点无人值守全开跑」,
    // 而 H1 的约定是这类调用必须由用户本人点头 → 'agent' 档也按 'queue' 排队进收件箱。
    return deferApproval(runId, call, preview, reason, control ? { ...ctx, approvalDeferral: 'queue' } : ctx);
  }
  const d = await requestApproval(runId, call, preview, signal, reason);

  if (d.action === 'approve_always') {
    // 越界写、custom 的 ask 规则、控制面都不进「总允许」:越界每次都确认;ask 是用户写死的「永远问我」;
    // 控制面按工具裸名缓存 = 批一次「建个提醒」就放行本会话之后所有「建无人值守 agent 任务」(H1)。
    // 旧客户端不认 kind='control' 仍会显示「总允许」按钮 —— 按一次性批准处理,不缓存。
    if (!escalate && !forceAsk && !control) allowAlways(ctx.sessionId, name);
    return { action: 'approve', argsOverride: d.argsOverride };
  }
  return d;
}
