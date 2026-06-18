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
import { todoProvider } from './builtin/todo.js';
import { hostProcessProvider } from './builtin/hostProcess.js';
import { delegateProvider } from './builtin/delegate.js';
import { interactionProvider } from './builtin/interaction.js';
import { manageAgentProvider } from './builtin/manageAgent.js';
import { museTodoProvider } from './builtin/museTodo.js';
import type { ToolContext, ToolResult, ToolImpl } from './toolTypes.js';

// 类型 re-export:保持既有 `from './registry.js'` 的 import 路径不变。
export type { ToolContext, ToolResult, ToolImpl } from './toolTypes.js';

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
registerToolProvider(todoProvider);
registerToolProvider(hostProcessProvider);
registerToolProvider(delegateProvider);
registerToolProvider(interactionProvider);
registerToolProvider(manageAgentProvider); // host-only:本地 Normal Agent 自创建(append 末尾,保前缀缓存)
registerToolProvider(museTodoProvider); // Muse 唯一写权限;仅 ctx.muse 可见(普通 run 不暴露,快照不变)

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
    try {
      const result = await impl.execute(args, ctx);
      return { toolCallId: call.id, name, result: String(result), isError: false };
    } catch (e: any) {
      return { toolCallId: call.id, name, result: `Error: ${e?.message || e}`, isError: true };
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
