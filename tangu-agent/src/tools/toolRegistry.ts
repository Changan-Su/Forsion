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
  'search_files', 'glob_files', 'list_files', 'read_file', 'list_dir', 'view_image',
  'read_log', 'use_skill', 'todo_write', 'todo_read',
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
  let builtins = profile.toolLoadout.builtins;
  // 部署级白名单(TANGU_TOOL_BUILTINS 等)含 deferred 工具却漏列 load_tools → 自动补上:
  // 否则目录还在、唯一解锁入口没了,deferred 工具永久不可达(还可能被同名 custom 工具顶替)。
  if (builtins !== 'all' && !builtins.includes('load_tools')) {
    const wl = new Set(builtins);
    const hasDeferred = providers.some((p) => p.tools().some((t) => t.deferred && wl.has(t.name)));
    if (hasDeferred) builtins = [...builtins, 'load_tools'];
  }
  const out = new Map<string, ToolDef>();
  const add = (t: ToolDef, isBuiltin: boolean): void => {
    const m = t.mode || 'both';
    if (host && m === 'sandbox') return;
    if (!host && m === 'host') return;
    // 计划模式:只读集中过滤。Muse 例外:remember 只写它自己记忆域(agents/muse/MEMORY.md)的自我校准
    // 洞察,不触达用户资产——「对用户的唯一写」仍是 add_muse_todo;普通 plan mode 行为零变化。
    if (ctx.planMode && !PLAN_MODE_TOOLS.has(t.name) && !((ctx as any).muse && t.name === 'remember')) return;
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
  for (const p of providers) for (const t of p.tools()) add(t, true);
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
