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
  'add_muse_todo', // Muse 唯一写权限,只读 planMode 下仍可用(可见性另由 ctx.muse 收口)
]);

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
  const builtins = profile.toolLoadout.builtins;
  const out = new Map<string, ToolDef>();
  const add = (t: ToolDef, isBuiltin: boolean): void => {
    const m = t.mode || 'both';
    if (host && m === 'sandbox') return;
    if (!host && m === 'host') return;
    // 计划模式:只读集中过滤。Muse 例外:remember 只写它自己记忆域(agents/muse/MEMORY.md)的自我校准
    // 洞察,不触达用户资产——「对用户的唯一写」仍是 add_muse_todo;普通 plan mode 行为零变化。
    if (ctx.planMode && !PLAN_MODE_TOOLS.has(t.name) && !((ctx as any).muse && t.name === 'remember')) return;
    if (isBuiltin && builtins !== 'all' && !builtins.includes(t.name)) return;
    if (t.isEnabledFor && !t.isEnabledFor(profile, ctx)) return;
    out.set(t.name, t);
  };
  for (const p of providers) for (const t of p.tools()) add(t, true);
  for (const p of profile.toolLoadout.providers ?? []) for (const t of p.tools()) add(t, false);
  return out;
}
