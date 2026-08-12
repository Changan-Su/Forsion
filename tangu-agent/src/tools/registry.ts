/**
 * 工具系统门面(G3 拆分后)。工具实现按域拆在 builtin/* 各 provider,经 toolRegistry 自注册;
 * 本文件只负责:① 固定顺序注册内置 provider ② 保持 getToolDefinitions/executeTool 既有签名
 * (agentLoop / tui 的 import 点零改动)。大输出落盘见 outputPersist.ts。
 */
import type { Tool, ToolCall } from '../core/types.js';
import { deps } from '../seams/runtime.js';
import { executeCustomTool } from './customTools.js';
import { registerToolProvider, resolveTools, isDeferredIn, type ToolDef } from './toolRegistry.js';
import { datetimeProvider, calculatorProvider } from './builtin/coreUtils.js';
import { memoryLogProvider } from './builtin/memoryLog.js';
import { webSearchProvider } from './builtin/webSearch.js';
import { workspaceFilesProvider } from './builtin/workspaceFiles.js';
import { skillsProvider } from './builtin/skills.js';
import { sandboxPythonProvider } from './builtin/sandboxPython.js';
import { hostExecProvider } from './hostExec.js';
import { fileSearchProvider } from './builtin/fileSearch.js';
import { webFetchProvider } from './builtin/webFetch.js';
import { browserToolsProvider } from './builtin/browserTools.js';
import { todoProvider } from './builtin/todo.js';
import { hostProcessProvider } from './builtin/hostProcess.js';
import { delegateProvider } from './builtin/delegate.js';
import { brainstormProvider } from './builtin/brainstorm.js';
import { interactionProvider } from './builtin/interaction.js';
import { manageAgentProvider } from './builtin/manageAgent.js';
import { manageSkillProvider } from './builtin/manageSkill.js';
import { museTodoProvider } from './builtin/museTodo.js';
import { channelToolsProvider } from './builtin/channelTools.js';
import { applyPatchProvider } from './builtin/applyPatch.js';
import { discussProvider } from './builtin/discuss.js';
import { displayFileProvider } from './builtin/displayTools.js';
import { deskPresentProvider } from './builtin/deskPresent.js';
import { imageGenProvider } from './builtin/imageTools.js';
import { inboxSendProvider } from './builtin/inboxSend.js';
import { browserUseProvider } from './builtin/browserUse.js';
import { amadeusProvider } from './builtin/amadeus.js';
import { readActivityProvider } from './builtin/readActivity.js';
import { readSessionProvider } from './builtin/readSession.js';
import { searchSessionsProvider } from './builtin/searchSessions.js';
import { manageAutomationProvider } from './builtin/manageAutomation.js';
import { manageScheduleProvider } from './builtin/manageSchedule.js';
import { loadToolsProvider } from './builtin/loadTools.js';
import { appendActivityLine } from '../services/userActivity.js';
import type { ToolContext, ToolResult, ToolImpl, ToolCapabilities } from './toolTypes.js';

// 类型 re-export:保持既有 `from './registry.js'` 的 import 路径不变。
export type { ToolContext, ToolResult, ToolImpl } from './toolTypes.js';

const DEFAULT_TOOL_CAPABILITIES: Record<string, ToolCapabilities> = {
  get_datetime: { sideEffect: 'none', parallel: true, defaultTimeoutMs: 5_000 },
  calculator: { sideEffect: 'none', parallel: true, defaultTimeoutMs: 5_000 },
  web_search: { sideEffect: 'network', parallel: true, defaultTimeoutMs: 30_000 },
  web_fetch: { sideEffect: 'network', parallel: true, defaultTimeoutMs: 25_000 },
  browser_search: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 60_000 },
  browser_navigate: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 60_000 },
  browser_snapshot: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_click: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_type: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_scroll: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_back: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_press: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_console: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_screenshot: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 30_000 },
  browser_task: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 300_000 },
  search_files: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 30_000 },
  glob_files: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 20_000 },
  list_files: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 },
  read_file: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 20_000 },
  list_dir: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 },
  view_image: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 20_000 },
  read_log: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 },
  list_processes: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 10_000 },
  read_process_output: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 10_000 },
  todo_read: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 10_000 },
  // 子代理可并发(借 Codex spawn 并行模式:一轮多 delegate 同时跑,批宽由 MAX_PARALLEL_TOOL_CALLS 管)。
  // 子代理内部的工具串行执行且审批闸门照走,父层并发不叠加写冲突面;写作用域不重叠由委派方(模型)划分。
  delegate: { sideEffect: 'unknown', parallel: true, defaultTimeoutMs: 600_000 },
  // 纯推理无副作用,但 N 席×2 轮很贵且自身已内部并行 → 不再与其它工具并跑;超时同 delegate。
  self_brainstorm: { sideEffect: 'none', parallel: false, defaultTimeoutMs: 600_000 },
};

const SERIAL_TOOL_CAPABILITIES: ToolCapabilities = {
  sideEffect: 'unknown',
  parallel: false,
};

function mergeCapabilities(name: string, impl?: ToolImpl): ToolCapabilities {
  const defaults = DEFAULT_TOOL_CAPABILITIES[name] || SERIAL_TOOL_CAPABILITIES;
  return { ...defaults, ...(impl?.capabilities || {}) };
}

export function getToolCapabilities(name: string, ctx: ToolContext): ToolCapabilities {
  const impl = resolveTools(currentProfile(ctx), ctx).get(name);
  if (impl) return mergeCapabilities(name, impl);
  // custom/MCP 工具副作用不可知，默认不并发。
  return { ...SERIAL_TOOL_CAPABILITIES };
}

function withTimeoutSignal(ctx: ToolContext, timeoutMs?: number): { scopedCtx: ToolContext; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { scopedCtx: ctx, cleanup: () => {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = (): void => ac.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    scopedCtx: { ...ctx, signal: ac.signal },
    cleanup: () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    },
  };
}

// ── 内置 provider 注册。顺序 = 原 TOOLS 字面量字段顺序(get_datetime → remember/log_event/read_log
//    → calculator → web_search → list_files/read_file/write_file → use_skill → pip_install/run_python),
//    喂给 LLM 的 defs 顺序保持字节级一致;hostExecProvider 最后(host 模式真实 FS 工具追加在末尾,
//    对齐原「HOST_TOOLS 末尾叠加」行为)。──
registerToolProvider(datetimeProvider);
registerToolProvider(memoryLogProvider);
registerToolProvider(calculatorProvider);
registerToolProvider(webSearchProvider);
registerToolProvider(workspaceFilesProvider);
registerToolProvider(skillsProvider);
registerToolProvider(sandboxPythonProvider);
registerToolProvider(hostExecProvider);
// ── 2026-06 扩充的核心开发工具:一律注册在 hostExecProvider 之后 ——
//    这样无论 sandbox 还是 host 模式,新工具都**追加在既有 defs 末尾**(严格 append-only,
//    旧会话的 prompt 前缀缓存只在部署边界失效一次)。后续新增 provider 继续往这里追加。──
registerToolProvider(fileSearchProvider);
registerToolProvider(webFetchProvider);
registerToolProvider(browserToolsProvider);
registerToolProvider(todoProvider);
registerToolProvider(hostProcessProvider);
registerToolProvider(delegateProvider);
registerToolProvider(interactionProvider);
registerToolProvider(manageAgentProvider); // host-only:本地 Normal Agent 自创建(append 末尾,保前缀缓存)
registerToolProvider(museTodoProvider); // Muse 唯一写权限;仅 ctx.muse 可见(普通 run 不暴露,快照不变)
registerToolProvider(channelToolsProvider); // host-only:通道会话里发文件/图片(append 末尾,保前缀缓存)
registerToolProvider(applyPatchProvider); // both:结构化补丁编辑(云端+host 共用,append 末尾,保前缀缓存)
registerToolProvider(discussProvider); // host-only:start_discussion/wait_discussion(分身进后台群聊讨论;append 末尾,保前缀缓存)
registerToolProvider(displayFileProvider); // both:display_file 在桌面对话区展示文件给用户(append 末尾,保前缀缓存)
registerToolProvider(manageSkillProvider); // host-only:把「这类活怎么干」沉淀成本地技能(append 末尾,保前缀缓存)
registerToolProvider(imageGenProvider); // both:generate_image 文生图→落盘+对话区展示(append 末尾,保前缀缓存)
registerToolProvider(inboxSendProvider); // 本地限定:inbox_send 发消息进用户收件箱、可定时(append 末尾,保前缀缓存)
registerToolProvider(browserUseProvider); // host-only:browser_task 委派整包网页任务给 browser-use 自主 agent(真实 Chrome;append 末尾,保前缀缓存)
registerToolProvider(amadeusProvider); // both:Amadeus 笔记库 + Calendar —— host 直连磁盘 vault,非 host 经 brain.amadeus 云 vault API(append 末尾,保前缀缓存)
registerToolProvider(readActivityProvider); // 默认仅 Muse(ctx.muse/activityAccess 收口,普通 run 不暴露,快照不变):读用户活动日志
registerToolProvider(manageAutomationProvider); // 本地限定:自动化规则 触发×动作链(原 muse_watch,改名属 schema 大改同批打穿缓存)
registerToolProvider(manageScheduleProvider); // 本地限定:每-agent 日程 SCHEDULE.db(append 末尾,保前缀缓存)
registerToolProvider(loadToolsProvider); // both:load_tools 解锁 deferred 工具定义(P0-2;仅有未解锁项且调用方支持时可见)
registerToolProvider(deskPresentProvider); // host-only:desk_present 在桌面聊天旁的 Agent Desk 演出面板展示文件(实验;append 末尾,保前缀缓存)
registerToolProvider(readSessionProvider); // both:read_session 按 id 读另一个会话的记录(工作区拖会话进聊天的 [[session:id]] 引用靠它落地;append 末尾,保前缀缓存)
registerToolProvider(brainstormProvider); // host-only:self_brainstorm 从当前上下文分裂多视角分身自我批判(append 末尾,保前缀缓存)
registerToolProvider(searchSessionsProvider); // both:search_sessions 列出/检索过去会话,找到 id 交给 read_session(append 末尾,保前缀缓存)
// 插件(表情包/分段等)现为文件夹插件(plugins/),经 activateAllPlugins→ctx.registerPlugin 注册其工具,不在此处。

/** ctx 自带 profile(loop 按 run.app_id 解析)优先;缺省回退本进程装配的 profile。 */
function currentProfile(ctx: ToolContext) {
  return ctx.profile ?? deps().profile;
}

/** agent 代改文件 → 用户活动日志(引擎侧唯一埋点,单点覆盖全部写类工具;host 成功才记)。 */
const AGENT_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch']);
function logAgentEdit(name: string, args: Record<string, any>, ctx: ToolContext, result: string): void {
  if (ctx.execMode !== 'host' || !AGENT_EDIT_TOOLS.has(name)) return;
  if (result.startsWith('Error')) return;
  const f = String(args.path || args.file_path || '').trim();
  appendActivityLine('agent.edit', { tool: name, agent: ctx.agentSlug, f: f || undefined, o: ctx.automationOrigin || undefined });
}

// CODING_PRESET_DEFERRED / isDeferredIn 已迁 toolRegistry.ts(load_tools 也要用同一判定,留在
// 本文件会成环:registry → loadTools → registry)。

/** 返回喂给 LLM 的工具定义（OpenAI function 格式）：按模式/profile 过滤的内置 + 本 run 的自定义工具 + MCP 工具（按名去重，内置 > 自定义 > MCP）。 */
export function getToolDefinitions(ctx: ToolContext): Tool[] {
  const hasSkills = !!(ctx.enabledSkillIds && ctx.enabledSkillIds.length);
  const tools = resolveTools(currentProfile(ctx), ctx);
  // deferred 按需装载(P0-2,借 pi deferred-tools):defer 标记的工具默认不进 defs(系统提示只留
  // 目录一行),load_tools 解锁后**追加在内置 defs 末尾**——immediate 前缀字节不动,缓存只在解锁
  // 那一刻断一次。系统驱动的 run(Muse/自动化)全量可见不吃这套;无 unlockTools 回调的调用方
  // (delegate 子代理/群聊)看不到 load_tools,deferred 保持隐藏(拿到的就是精简集)。
  const deferBypass = !!ctx.muse || !!ctx.automationOrigin;
  const unlocked = ctx.unlockedTools;
  let lockedCount = 0;
  if (!deferBypass) {
    for (const t of tools.values()) if (isDeferredIn(ctx, t.name, t.deferred) && !unlocked?.has(t.name)) lockedCount++;
  }
  const defs: Tool[] = [];
  const unlockedDeferred: Tool[] = [];
  for (const [name, t] of tools) {
    if (name === 'use_skill' && !hasSkills) continue; // 无启用技能时不暴露 use_skill
    if (name === 'load_tools' && (lockedCount === 0 || !ctx.unlockTools)) continue; // 无可解锁项/不支持解锁时不暴露
    if (isDeferredIn(ctx, name, t.deferred) && !deferBypass) {
      if (unlocked?.has(name)) unlockedDeferred.push(t.definition);
      continue;
    }
    defs.push(t.definition);
  }
  defs.push(...unlockedDeferred);
  const taken = new Set<string>(tools.keys());
  if (ctx.customTools && ctx.customTools.size) {
    for (const t of ctx.customTools.values()) {
      if (taken.has(t.name)) continue; // 内置同名优先
      taken.add(t.name);
      defs.push(t.definition);
    }
  }
  // MCP 工具(ctx 运行时注入,manager 已按 (server, tool) 排序 → defs 字节级稳定)
  if (ctx.mcpTools && ctx.mcpTools.size) {
    for (const t of ctx.mcpTools.values()) {
      if (taken.has(t.name)) continue; // mcp__ 前缀理论上不冲突,保险跳过
      taken.add(t.name);
      defs.push(t.definition);
    }
  }
  return defs;
}

/** deferred 工具目录(agentLoop 拼「Additional Tools」系统提示段):resolve 过滤后仍存在的全量
 *  deferred 工具——**不随解锁状态变**(稳定文本,护前缀缓存)。 */
export function listDeferredTools(ctx: ToolContext): { name: string; hint: string; group?: string }[] {
  const out: { name: string; hint: string; group?: string }[] = [];
  for (const [name, t] of resolveTools(currentProfile(ctx), ctx)) {
    if (!isDeferredIn(ctx, name, t.deferred)) continue;
    const hint = t.deferHint || String(t.definition?.function?.description || '').split('\n')[0].slice(0, 120);
    out.push({ name, hint, ...(t.deferGroup ? { group: t.deferGroup } : {}) });
  }
  return out;
}

/** 旧工具名静默别名(不进 defs/快照):只兜升级瞬间仍引用旧名的存量会话上下文。 */
const TOOL_NAME_ALIASES: Record<string, string> = { muse_watch: 'manage_automation' };

/** 执行一个工具调用。先查（按模式/profile 过滤的）内置，再查本 run 的自定义工具；未知工具返回 isError。 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const name = TOOL_NAME_ALIASES[call.function.name] || call.function.name;
  let args: Record<string, any> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    args = {};
  }

  const impl: ToolDef | undefined = resolveTools(currentProfile(ctx), ctx).get(name);
  if (impl) {
    const caps = mergeCapabilities(name, impl);
    const { scopedCtx, cleanup } = withTimeoutSignal(ctx, caps.defaultTimeoutMs);
    try {
      const result = await impl.execute(args, scopedCtx);
      logAgentEdit(name, args, ctx, String(result));
      return { toolCallId: call.id, name, result: String(result), isError: false };
    } catch (e: any) {
      if (scopedCtx.signal?.aborted && !ctx.signal?.aborted) {
        return { toolCallId: call.id, name, result: `Error: tool timed out after ${caps.defaultTimeoutMs}ms. If you retry, narrow the operation (smaller file / shorter command) or split it into steps.`, isError: true };
      }
      return { toolCallId: call.id, name, result: `Error: ${e?.message || e}`, isError: true };
    } finally {
      cleanup();
    }
  }

  const custom = ctx.customTools?.get(name);
  if (custom) {
    try {
      const result = await executeCustomTool(custom, args, ctx);
      const isError = typeof result === 'string' && result.startsWith('Error:');
      return { toolCallId: call.id, name, result: String(result), isError };
    } catch (e: any) {
      return { toolCallId: call.id, name, result: `Error: ${e?.message || e}`, isError: true };
    }
  }

  // 第三级 fallback:MCP 工具(经 deps().mcp 调远端;仅 standalone/TUI 装配了 mcp)。
  const mcpTool = ctx.mcpTools?.get(name);
  if (mcpTool && deps().mcp) {
    const r = await deps().mcp!.callTool(mcpTool, args, ctx.signal);
    return { toolCallId: call.id, name, result: r.text, isError: r.isError };
  }

  // 错误消息即提示词:说明「为什么不可用 + 下一步做什么」,不留死胡同(借 pi/Codex 的恢复导向文案)。
  if (ctx.planMode && resolveTools(currentProfile(ctx), { ...ctx, planMode: false }).has(name)) {
    return {
      toolCallId: call.id, name,
      result: `Tool "${name}" is blocked by plan mode (read-only). Finish researching with read-only tools and submit your plan via exit_plan_mode; it becomes available after the user approves.`,
      isError: true,
    };
  }
  // 目录提示只在本 ctx 真有可解锁目录时给(delegate 无 unlockTools、Muse/自动化全量豁免,这些场景
  // 没有 load_tools,瞎指会把「出路」变成第二次失败——Codex 评审 #4);plan 模式下 custom/MCP 工具
  // 根本不进 ctx、无法逐名识别 → 补一句模式级说明兜底(Codex 评审 #3)。
  const canLoad = !!ctx.unlockTools && !ctx.muse && !ctx.automationOrigin &&
    [...resolveTools(currentProfile(ctx), ctx).values()].some((t) => isDeferredIn(ctx, t.name, t.deferred) && !ctx.unlockedTools?.has(t.name));
  const planNote = ctx.planMode ? ' Note: plan mode is active — custom/external tools are disabled until the plan is approved.' : '';
  return {
    toolCallId: call.id, name,
    result: `Tool "${name}" is not available in this session.${planNote} Use only tools from your tool list${canLoad ? ', or load a listed one from the "Additional Tools" catalog with load_tools' : ''}; do not retry this name.`,
    isError: true,
  };
}
