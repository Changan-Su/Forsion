/**
 * 开放工具注册表(G3):工具以 ToolProvider 自注册,取代 registry.ts 的封闭 TOOLS 字面量;
 * 工具可声明 isEnabledFor(profile, ctx) 做运行时能力门禁(参考 hermes §4.2 + openhanako §3.2),
 * 杜绝 loop 里写 `if (app === 'xx')` 的分支蔓延。
 *
 * 内置 provider 由 registry.ts(门面)按固定顺序注册;app 自带工具经
 * AppProfile.toolLoadout.providers 注入(resolve 时排在内置之后,不受 builtins 白名单约束)。
 */
import type { ToolImpl, ToolContext } from './toolTypes.js';
import type { AppProfile } from '../seams/appProfile.js';
import { presetOf } from '../core/presetTable.js';
import { isHostSandboxRestricted, isHostSandboxToolAllowed, resolveHostSandboxPolicy } from '../sandbox/hostSandboxPolicy.js';

export interface ToolDef extends ToolImpl {
  name: string;
  /** 运行时门禁:缺省=总可用。resolve 时统一过滤(在 mode/toolLoadout 过滤之后)。 */
  isEnabledFor?(profile: AppProfile, ctx: ToolContext): boolean;
  /** 按需装载(P0-2,借 pi deferred-tools):true=定义默认不进 defs,系统提示只留目录一行;
   *  经 load_tools 解锁(或历史里用过/系统 run)后追加在 defs 末尾。执行侧不受影响。 */
  deferred?: boolean;
  /** 同组连坐解锁(如 start/wait_discussion):解锁组内任一即整组解锁。 */
  deferGroup?: string;
  /** 目录行文案(英文一句话,带典型触发意图;缺省取 description 首行截断)。 */
  deferHint?: string;
}

/** 一组工具的提供者:内置工具按域拆若干 provider,app 自带工具经 AppProfile.toolLoadout.providers 注入。 */
export interface ToolProvider {
  id: string;
  tools(): ToolDef[];
  /** 'plugin' = 插件注册(plugins/bootstrap、plugins/registry 打标)。chat 正向面只认核心 provider:
   *  插件同名 web_search/write_file 也进不了 chat 面(creview 09-07 E6);work/coding 面为空,不受影响。 */
  origin?: 'plugin';
}

// 各 preset 的情境 deferred 集合住 core/presetTable.ts(单源);这里 re-export 保持既有 import 路径。
export { CODING_PRESET_DEFERRED } from '../core/presetTable.js';

/** 工具在本 ctx 下是否按 deferred 处理:静态标记 ∪ 本 preset 的情境集合(PRESET_TABLE.toolFace.deferred)。
 *  目录(listDeferredTools)、defs 过滤(getToolDefinitions)、解锁(load_tools)三处必须
 *  共用本判定——2026-08-09 前 load_tools 只认静态 deferred:true,coding 预设的情境 deferred
 *  工具在目录里被广而告之却解锁不了("Unknown/not loadable"),Codex 评审抓到的存量 bug。 */
export function isDeferredIn(ctx: ToolContext, name: string, deferred?: boolean): boolean {
  // 子代理(delegate)现在**有** load_tools 这条通道了(subAgent.ts 给它自己的 unlockedTools/
  // unlockTools + 目录段),deferred 工具不再是「看不见且取不回」。这条窄口因此不再是能力闸,
  // 只剩一个作用:省掉那一轮 load_tools。read_document 值得省 —— delegate 自己的描述就写着
  // batch file analysis,PDF/Office 正是那里的典型输入;read_file 读二进制文档只有乱码,且
  // (hostExec.ts 有意如此)不给任何指向 read_document 的提示,子代理拿到的是**静默的垃圾**
  // 而不是可恢复的报错,发现不了就不会去 load。
  // ponytail: 上限=一个工具名。别在这儿续名单 —— 其余按需工具走 load_tools 那条通道即可。
  if (name === 'read_document' && (ctx.subAgentDepth || 0) >= 1) return false;
  return !!deferred || presetOf(ctx.preset).toolFace.deferred.has(name);
}

/** 旧工具名静默别名(不进 defs/快照):只兜升级瞬间仍引用旧名的存量会话上下文。
 *  住这里(而非 registry.ts)的理由与 SUB_AGENT_DENY_TOOLS 同:共享策略层要先归一再判闸,
 *  放在门面层会让 toolRegistry → registry 成环。 */
export const TOOL_NAME_ALIASES: Record<string, string> = { muse_watch: 'manage_automation' };

/** 工具名归一:旧别名 → 正典名;非别名原样返回。
 *  必须 Object.hasOwn:模型硬调一个叫 `constructor` / `toString` / `__proto__` 的工具名时,
 *  普通对象的 `[name]` 会沿原型链取到函数/对象,下游 `name.startsWith` 直接 TypeError 掀翻整轮(Codex 09-15)。 */
export function canonicalToolName(name: string): string {
  return Object.hasOwn(TOOL_NAME_ALIASES, name) ? TOOL_NAME_ALIASES[name] : name;
}

/** 一个工具的全部拼写:正典名 + 指向它的旧别名。审批规则匹配用 —— 用户既可能按新名写规则
 *  (`deny: ["manage_automation"]`),也可能沿用旧名(`deny: ["muse_watch"]` / `muse_*`),两种都得挡得住。 */
export function toolNameSpellings(name: string): string[] {
  const canonical = canonicalToolName(name);
  return [canonical, ...Object.keys(TOOL_NAME_ALIASES).filter((k) => TOOL_NAME_ALIASES[k] === canonical)];
}

/**
 * 子代理(delegate;ctx.subAgentDepth ≥ 1)的管理面**缺省硬闸**。它们改的是 agent 定义 / 技能 /
 * 自动化规则 / 日程 / harness,即「下一次 run 长什么样」,越权后果跨 run 存续;而子代理的任务正文
 * 本身就是模型生成的文本(delegate 的 task/instructions),不该默认成为改配置的入口。
 *
 * **缺省仍是拒**;唯一的开口是「委派时由父代理逐次授予」:depth 0 的主 agent 在 delegate 的
 * `grantTools` 里点名某个管理工具,该名字经 SubAgentParams.grantTools → ctx.subAgentGrants 下来,
 * 本闸对它放行(见下方 isSubAgentDenied)。
 *
 * ⚠️ 不变量:**被授权的子代理永远不会比父代理更强**。两条一起保证:
 *   ① delegate 执行时按 resolveTools(父 profile, 父 ctx) 核验 —— 父自己此刻解析不出来的名字授不了;
 *   ② 授予只抬起**这一道**闸。宿主沙箱策略(hostSandboxPolicy)、toolsMode/toolsList、planMode、
 *      preset 正向面、工具自身 isEnabledFor、以及审批闸门(gateToolCall)一概照旧 ——
 *      被授权 ≠ 免审批,host 模式该弹的窗一个不少。
 *
 * 单源住这里(而不是 subAgent.ts):resolveTools(共享可见性层)与 executeTool(共享执行层)
 * 都要用它,放在 services 层会成环(toolRegistry → subAgent → registry → toolRegistry)。
 * `muse_watch` 这条旧别名留在集合里属 belt-and-braces:isSubAgentDenied 现在**先归一再判**,
 * 理论上它已是死条目 —— 但名单被当作纯名字集合直接 `.has()` 的调用点(测试、未来的新调用点)
 * 仍靠它兜住旧拼写,删掉只省不了什么,风险却是静默放行。
 *
 * ⚠️ 本硬闸**优先于** Muse / 自动化 run 的 deferBypass:父 run 是系统驱动的不等于它派出去的
 * 子代理也该有改配置的权限(此前 deferBypass 会把整族管理工具直接放进子代理首轮工具面)。
 */
export const SUB_AGENT_DENY_TOOLS: ReadonlySet<string> = new Set<string>([
  'manage_agent', 'manage_skill', 'manage_automation', 'manage_schedule', 'manage_harness',
  'muse_watch',
]);

/** 父代理可在 delegate.grantTools 里授予的管理工具(正典名,不含别名):delegate 的 enum 与入参校验单源。 */
export const SUB_AGENT_GRANTABLE_TOOLS: readonly string[] = [
  'manage_agent', 'manage_skill', 'manage_automation', 'manage_schedule', 'manage_harness',
];

/** 写入目标取自 **ALS 当前身份**(currentDisplayAgentSlug() || currentAgentSlug())而非入参的工具:
 *  同一份参数换个身份执行就写到**别人**的文件夹去。manage_harness → agents/<slug>/HARNESS.md;
 *  manage_skill(scope='agent')→ agents/<slug>/skills;manage_agent → 「不许改自己」那道自我判定。
 *
 *  用处:延后执行(pendingApprovals)时执行身份是**重建**的,与当时的 ALS 未必一致 ——
 *  子代理发起、用户事后批准的那一笔会落到父代理身上(2026-09-15 抓到的目标漂移)。
 *  参数里带显式目标的工具(manage_automation / manage_schedule / write_file …)不在此列,重放无歧义。 */
export const AGENT_SCOPED_TOOLS: ReadonlySet<string> = new Set<string>([
  'manage_harness', 'manage_skill', 'manage_agent',
]);

/** 本 ctx 下该工具是否命中子代理硬闸(深度 0 的主 loop 不受影响)。
 *  **先归一后判**:调用点传原始名(subAgent 审批前那道按 call.function.name 判)也拦得住旧别名;
 *  授予同样按正典名比对 —— 授了 manage_automation,子代理写 muse_watch 也一样放行。 */
export function isSubAgentDenied(ctx: Pick<ToolContext, 'subAgentDepth' | 'subAgentGrants'>, name: string): boolean {
  if ((ctx.subAgentDepth || 0) < 1) return false;
  const canonical = canonicalToolName(name);
  return SUB_AGENT_DENY_TOOLS.has(canonical) && !ctx.subAgentGrants?.has(canonical);
}

// ── 全局(内置)provider 注册表。注册顺序即工具喂给 LLM 的顺序——不可随意调换。──
const providers: ToolProvider[] = [];
const providerIndex = new Map<string, number>();

/**
 * 计划模式白名单:只读探查 + 规划辅助。写文件/跑命令/沙箱执行/记忆写入一律不可见;
 * custom/MCP 工具(外部副作用不可知)由 agentLoop 在 planMode 下整体跳过。
 * delegate 可用:子代理继承 planMode(subAgent 透传 ctx),同样只读。
 */
const PLAN_MODE_TOOLS = new Set([
  'get_datetime', 'calculator', 'web_search', 'web_fetch',
  'browser_search', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
  'search_files', 'glob_files', 'list_files', 'read_file', 'list_dir', 'view_image', 'view_video',
  'read_log', 'use_skill', 'todo_write', 'todo_read',
  'read_session', 'search_sessions', // 只读回看过去会话;规划「继续上次讨论」类任务离不开

  'list_processes', 'read_process_output',
  'delegate', 'ask_user', 'exit_plan_mode',
  'self_brainstorm', // 纯推理无副作用(分身无工具),计划阶段的方案压力测试正是其主场
  'load_tools', // 纯解锁无副作用;planMode 下 deferred 白名单工具(calculator 等)须经它可达

  'add_muse_todo', // Muse 唯一写权限,只读 planMode 下仍可用(可见性另由 ctx.muse 收口)
  'read_activity', // 只读用户活动日志;Muse 周期跑 planMode 故必须白名单(可见性另由 ctx.muse/activityAccess 收口)
]);

/** 名单不可及的基建工具:砍掉 exit_plan_mode 会让 planMode 死锁,ask_user 断交互,
 *  load_tools 会让 deferred 工具永久不可达。 */
const LOADOUT_EXEMPT = new Set(['exit_plan_mode', 'ask_user', 'load_tools']);

/** 注册一个 provider。同 id 幂等覆盖(保持原位置,热加载安全)。 */
export function registerToolProvider(p: ToolProvider): void {
  const i = providerIndex.get(p.id);
  if (i !== undefined) {
    providers[i] = p;
  } else {
    providerIndex.set(p.id, providers.length);
    providers.push(p);
  }
}

export function listToolProviders(): ToolProvider[] {
  return [...providers];
}

/**
 * 解析本次调用可见的工具集(Map 保持插入顺序)。过滤顺序(语义与原 visibleTools 一致):
 *   ① mode 域:host 模式隐藏 sandbox 工具(由 hostExec 的真实 FS 工具同名覆盖语义接管),
 *      非 host 隐藏 host 工具;
 *   ② profile.toolLoadout.builtins 白名单('all' 跳过;仅约束内置 provider);
 *   ③ 工具自身 isEnabledFor(profile, ctx)。
 * 同名后注册者覆盖(host 模式下 hostExec 的 read_file/write_file 覆盖云工作区版本——
 * 后者已被 ① 滤掉,故 host 工具按注册序追加在末尾,对齐原「HOST_TOOLS 末尾叠加」行为)。
 */
export function resolveTools(profile: AppProfile, ctx: ToolContext): Map<string, ToolDef> {
  const host = ctx.execMode === 'host';
  const sandboxCtx = { ...ctx, hostSandbox: ctx.hostSandbox ?? (ctx.execMode === 'sandbox' ? undefined : resolveHostSandboxPolicy()) };
  const sandboxRestricted = isHostSandboxRestricted(sandboxCtx);
  let builtins = profile.toolLoadout.builtins;
  // 部署级白名单(TANGU_TOOL_BUILTINS 等)含 deferred 工具却漏列 load_tools → 自动补上:
  // 否则目录还在、唯一解锁入口没了,deferred 工具永久不可达(还可能被同名 custom 工具顶替)。
  if (builtins !== 'all' && !builtins.includes('load_tools')) {
    const wl = new Set(builtins);
    const hasDeferred = providers.some((p) => p.tools().some((t) => isDeferredIn(ctx, t.name, t.deferred) && wl.has(t.name)));
    if (hasDeferred) builtins = [...builtins, 'load_tools'];
  }
  const out = new Map<string, ToolDef>();
  const add = (t: ToolDef, isBuiltin: boolean, fromPlugin = false): void => {
    // 子代理硬闸放在**最前**:defs / 目录 / load_tools 的可解锁集 / executeTool 的按名解析
    // 全经本函数,一处拒=四处都没有。放在 deferBypass 之前(Muse/自动化的子代理也一样拒)。
    if (isSubAgentDenied(ctx, t.name)) return;
    if (sandboxRestricted && (!isBuiltin || fromPlugin || !isHostSandboxToolAllowed(t.name, sandboxCtx))) return;
    const m = t.mode || 'both';
    if (host && m === 'sandbox') return;
    if (!host && m === 'host') return;
    // 计划模式:只读集中过滤。Muse 例外:remember 只写它自己记忆域(agents/muse/MEMORY.md)的自我校准
    // 洞察,不触达用户资产——「对用户的唯一写」仍是 add_muse_todo;普通 plan mode 行为零变化。
    if (ctx.planMode && !PLAN_MODE_TOOLS.has(t.name) && !((ctx as any).muse && t.name === 'remember')) return;
    // preset 硬闸(PRESET_TABLE.toolFace;chat 用):planMode 之后、isEnabledFor 之前——工具根本不进 out map,
    // defs / 目录 / load_tools 三处同时看不见。work/coding 的集合为空 → 零行为变化(旧快照逐字节不动)。
    // ① host 族按 t.mode 整族拒,不靠名单:host 侧同名的 read_file/write_file 打的是用户真实磁盘(D45);
    // ② 正向面:不在常驻 ∪ 按需集合里的一律拒(默认拒,明天新加的工具不会自动漏进 chat);且只认核心 provider——
    //    插件 provider(origin:'plugin')与 app 工具(isBuiltin=false)同名顶替也进不来;
    // ③ host execMode 下再拒按 cwd 爬真实磁盘的只读 both 工具(D11 纵深防御)。
    const face = presetOf(ctx.preset).toolFace;
    if (face.rejectHostMode && m === 'host') return;
    if (face.face.size && (!isBuiltin || fromPlugin || !face.face.has(t.name))) return;
    if (host && face.hostDiskHidden.has(t.name)) return;
    if (isBuiltin && builtins !== 'all' && !builtins.includes(t.name)) return;
    // 每-agent 内置工具黑白名单(config.toml tools_mode/tools_list):只约束**无门禁**的内置工具——
    // 门禁工具(isEnabledFor)可见性归引擎逻辑且不在 UI 目录里(allow 模式不误伤 Muse/inbox 系);
    // 基建工具豁免;MCP/app 工具(isBuiltin=false)不受约束。范围与 listLoadoutTools() 严格一致。
    if (isBuiltin && !t.isEnabledFor && !LOADOUT_EXEMPT.has(t.name)
      && (ctx.toolsMode === 'allow' || ctx.toolsMode === 'deny')) {
      const listed = !!ctx.toolsList?.includes(t.name);
      if (ctx.toolsMode === 'deny' ? listed : !listed) return;
    }
    if (t.isEnabledFor && !t.isEnabledFor(profile, ctx)) return;
    out.set(t.name, t);
  };
  for (const p of providers) for (const t of p.tools()) add(t, true, p.origin === 'plugin');
  for (const p of profile.toolLoadout.providers ?? []) for (const t of p.tools()) add(t, false);
  return out;
}

/** 工具目录(agent 编辑 UI「工具黑白名单」的可勾选项)=名单能约束的范围:无门禁、非豁免的内置工具。
 *  同名双版本(host/sandbox)按名字去重。description 取首行截断,供 UI 悬浮提示。 */
export function listLoadoutTools(): { name: string; description: string }[] {
  const seen = new Map<string, string>();
  for (const p of providers) {
    for (const t of p.tools()) {
      if (t.isEnabledFor || LOADOUT_EXEMPT.has(t.name)) continue;
      const d = t.definition?.function?.description || '';
      seen.set(t.name, d.split('\n')[0].slice(0, 160));
    }
  }
  return [...seen.entries()].map(([name, description]) => ({ name, description }));
}

/**
 * 工具自声明的审批档（capabilities.approval）。approvals.toolNeedsApproval 据此把插件工具并入
 * 「跑命令」档——核心不硬编码插件工具名，插件在 capabilities 里声明 `approval:'command'` 即可。
 * 与 resolveTools 同序遍历全局 provider，同名后注册者覆盖（取最后一个匹配）。
 * 只在 readonly/auto-edit 档需要判定时被调用（full-auto 直接放行，零开销）。
 */
export function declaredApproval(name: string): 'command' | undefined {
  let found: 'command' | undefined;
  for (const p of providers) {
    for (const t of p.tools()) {
      if (t.name === name && t.capabilities?.approval) found = t.capabilities.approval;
    }
  }
  return found;
}

/** 工具自声明的自动化可用性(capabilities.automationSafe)。与 declaredApproval 同款遍历语义。 */
export function declaredAutomationSafe(name: string): boolean {
  let found = false;
  for (const p of providers) {
    for (const t of p.tools()) {
      if (t.name === name && t.capabilities?.automationSafe !== undefined) found = !!t.capabilities.automationSafe;
    }
  }
  return found;
}
