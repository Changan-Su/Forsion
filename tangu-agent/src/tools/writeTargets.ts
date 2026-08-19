/**
 * 写类工具的目标路径抽取(单一真源):审批越界判定与代码检查点快照共用同一份口径,
 * 否则两边各写一个补丁解析器 = 迟早对不上(有一边漏了 Move to: 就出漏网的写入)。
 */
import type { ToolCall } from '../core/types.js';

/** 写类工具名(args.path 直给 / apply_patch 从补丁文本抽)。 */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch']);

// 补丁路径抽取(不必整体解析补丁):匹配 File: / Move to: 行。
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** host 写工具的目标路径(write/edit/multi_edit 取 args.path;apply_patch 从补丁文本抽,含 Move to 的新路径)。 */
export function writeTargetsOf(call: ToolCall): string[] {
  const name = call.function.name;
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return [];
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'multi_edit') {
    return args.path ? [String(args.path)] : [];
  }
  if (name === 'apply_patch') {
    const patch = String(args.patch ?? args.input ?? '');
    const out: string[] = [];
    PATCH_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATCH_PATH_RE.exec(patch))) out.push((m[1] || m[2] || '').trim());
    return out;
  }
  return [];
}
