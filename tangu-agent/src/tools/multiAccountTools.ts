/**
 * 多账号模式(core/accountScope.ts)的工具白名单:缺省拒绝,只放这一段审过的。不在名单里的工具既不进给模型的清单,
 * 执行时也再拒一次(toolRegistry.resolveTools 最前一道 + registry.executeTool 开头一道;自定义工具与 MCP 在多账号模式下一律不给)。
 * 第一版的口径:对话必需、记忆、Agent 管理、技能、文件读写 / 列目录。会起子进程的(run_bash、run_background、search_files / glob_files 的
 * 搜索进程、git、view_video、read_document 的转换、view_image 的缩图…)一律不进;用进程那一份云端凭据替人办事的(账号、发布、商店、
 * 收件箱、生图、网页搜索 / 抓取)也不进。文件工具另受账号文件夹的读写根约束(services/accessDomain.ts 的账号域)。
 * 加一个名字之前:读过它的实现,确认它只经按人分流的库 / 路径 / 缓存拿数据、不起子进程、不用进程级云端凭据。
 */
import { isMultiAccount } from '../core/accountScope.js';

export const MULTI_ACCOUNT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // 对话本身
  'get_datetime', 'ask_user', 'exit_plan_mode', 'todo_write', 'todo_read', 'load_tools',
  // 记忆 / 日志(写在这个账号的 agents/<slug>/ 里)
  'remember', 'log_event', 'read_log',
  // Agent 管理 / 技能(这个账号的 agents/、skills/)
  'manage_agent', 'use_skill', 'manage_skill',
  // 文件读写 / 列目录(host 版;读写根钳在账号文件夹)
  'read_file', 'write_file', 'edit_file', 'multi_edit', 'list_dir',
]);

/** 多账号模式下这件工具能不能出现 / 执行。单人模式恒 true。 */
export function multiAccountToolAllowed(name: string, mode?: 'host' | 'sandbox' | 'both'): boolean {
  if (!isMultiAccount()) return true;
  // sandbox 版的同名工具(云工作区 read_file / write_file 等)走进程那一份云端存储凭据:不给。
  if (mode === 'sandbox') return false;
  return MULTI_ACCOUNT_TOOL_ALLOWLIST.has(name);
}
