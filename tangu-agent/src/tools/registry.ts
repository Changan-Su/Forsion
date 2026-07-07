/**
 * 工具系统门面(G3 拆分后)。工具实现按域拆在 builtin/* 各 provider,经 toolRegistry 自注册;
 * 本文件只负责:① 固定顺序注册内置 provider ② 保持 getToolDefinitions/executeTool 既有签名
 * (agentLoop / tui 的 import 点零改动)。大输出落盘见 outputPersist.ts。
 */
import type { Tool, ToolCall } from '../core/types.js';
import { deps } from '../seams/runtime.js';
import { executeCustomTool } from './customTools.js';
import { registerToolProvider, resolveTools, type ToolDef } from './toolRegistry.js';
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
import { interactionProvider } from './builtin/interaction.js';
import { manageAgentProvider } from './builtin/manageAgent.js';
import { museTodoProvider } from './builtin/museTodo.js';
import { wechatToolsProvider } from './builtin/wechatTools.js';
import { applyPatchProvider } from './builtin/applyPatch.js';
import { discussProvider } from './builtin/discuss.js';
import { displayFileProvider } from './builtin/displayTools.js';
import { imageGenProvider } from './builtin/imageTools.js';
import { inboxSendProvider } from './builtin/inboxSend.js';
import { browserUseProvider } from './builtin/browserUse.js';
import { amadeusProvider } from './builtin/amadeus.js';
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
registerToolProvider(wechatToolsProvider); // host-only:微信远程会话里发文件/图片(append 末尾,保前缀缓存)
registerToolProvider(applyPatchProvider); // both:结构化补丁编辑(云端+host 共用,append 末尾,保前缀缓存)
registerToolProvider(discussProvider); // host-only:start_discussion/wait_discussion(分身进后台群聊讨论;append 末尾,保前缀缓存)
registerToolProvider(displayFileProvider); // both:display_file 在桌面对话区展示文件给用户(append 末尾,保前缀缓存)
registerToolProvider(imageGenProvider); // both:generate_image 文生图→落盘+对话区展示(append 末尾,保前缀缓存)
registerToolProvider(inboxSendProvider); // 本地限定:inbox_send 发消息进用户收件箱、可定时(append 末尾,保前缀缓存)
registerToolProvider(browserUseProvider); // host-only:browser_task 委派整包网页任务给 browser-use 自主 agent(真实 Chrome;append 末尾,保前缀缓存)
registerToolProvider(amadeusProvider); // both:Amadeus 笔记库 + Calendar —— host 直连磁盘 vault,非 host 经 brain.amadeus 云 vault API(append 末尾,保前缀缓存)
// 插件(表情包/分段等)现为文件夹插件(plugins/),经 activateAllPlugins→ctx.registerPlugin 注册其工具,不在此处。

/** ctx 自带 profile(loop 按 run.app_id 解析)优先;缺省回退本进程装配的 profile。 */
function currentProfile(ctx: ToolContext) {
  return ctx.profile ?? deps().profile;
}

/** 返回喂给 LLM 的工具定义（OpenAI function 格式）：按模式/profile 过滤的内置 + 本 run 的自定义工具 + MCP 工具（按名去重，内置 > 自定义 > MCP）。 */
export function getToolDefinitions(ctx: ToolContext): Tool[] {
  const hasSkills = !!(ctx.enabledSkillIds && ctx.enabledSkillIds.length);
  const tools = resolveTools(currentProfile(ctx), ctx);
  const defs: Tool[] = [];
  for (const [name, t] of tools) {
    if (name === 'use_skill' && !hasSkills) continue; // 无启用技能时不暴露 use_skill
    defs.push(t.definition);
  }
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

/** 执行一个工具调用。先查（按模式/profile 过滤的）内置，再查本 run 的自定义工具；未知工具返回 isError。 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const name = call.function.name;
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
      return { toolCallId: call.id, name, result: String(result), isError: false };
    } catch (e: any) {
      if (scopedCtx.signal?.aborted && !ctx.signal?.aborted) {
        return { toolCallId: call.id, name, result: `Error: tool timed out after ${caps.defaultTimeoutMs}ms`, isError: true };
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

  return { toolCallId: call.id, name, result: `Tool "${name}" is not available.`, isError: true };
}
