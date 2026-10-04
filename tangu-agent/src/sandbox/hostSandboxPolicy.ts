/** Trusted instance policy. Request bodies/tool arguments cannot select or weaken it. */
import { configExists, loadRawConfig } from '../core/config.js';
import { normalizeHostSandbox, type HostSandboxConfig } from './hostSandbox.js';
import type { ToolContext } from '../tools/toolTypes.js';

export function resolveHostSandboxPolicy(): HostSandboxConfig {
  const config = loadRawConfig();
  if ((config === null && configExists()) || Array.isArray(config)) throw new Error('Invalid config.json: cannot determine local sandbox policy');
  return normalizeHostSandbox(config?.hostSandbox);
}

export function isHostSandboxRestricted(ctx?: Pick<ToolContext, 'hostSandbox' | 'execMode'>): boolean {
  if (ctx?.execMode && ctx.execMode !== 'host') return false;
  return (ctx?.hostSandbox ?? resolveHostSandboxPolicy()).mode !== 'off';
}

// Default deny: newly registered tools need an explicit review of their execution path.
// Only core providers may supply these names (enforced in toolRegistry.resolveTools).
const COVERED_TOOLS = new Set([
  'run_bash', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'list_dir',
  'view_image', 'read_document', 'run_background', 'list_processes',
  'read_process_output', 'write_process_input', 'kill_process',
  // Trusted, Agent-scoped application-state brokers; no arbitrary filesystem arguments.
  'remember', 'manage_human', 'manage_harness', 'log_event', 'read_log', 'search_sessions', 'read_session',
  // 只读固定路径 <共享域>/computer-history/(不收模型给的路径);Muse 周期跑 execMode:host,开了宿主沙箱不列就整个没了。
  'read_computer_history',
  'load_tools', 'ask_user', 'exit_plan_mode', 'todo_read', 'todo_write', 'get_datetime',
]);

export function isHostSandboxToolAllowed(name: string, ctx?: Pick<ToolContext, 'hostSandbox' | 'execMode'>): boolean {
  return !isHostSandboxRestricted(ctx) || COVERED_TOOLS.has(name);
}
