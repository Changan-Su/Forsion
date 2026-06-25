/**
 * host 模式文件系统写策略(借 Codex writable-roots / protected-metadata 思路,但只做策略层,
 * 不做 OS 原生沙箱)。仅 execMode==='host' 的真实 FS 写工具调用——云端有自己的工作区沙箱,不经此。
 *
 * 两类判定:
 *   - hardDeny:受保护路径(.git 内部、家目录凭据/密钥目录),**任何审批档都禁写**,防 agent 失控。
 *   - 工作区外(非保护):交审批闸升级为「越界写需批准」(见 services/approvals.ts writeEscalationNeeded)。
 */
import path from 'node:path';
import os from 'node:os';
import type { ToolContext } from './toolTypes.js';

/** 本次 run 的可写根:当前工作目录(v1;后续可经 profile 扩展为多根/自定义)。 */
export function writableRoots(ctx: ToolContext): string[] {
  return [path.resolve(ctx.cwd || process.cwd())];
}

const HOME = os.homedir();
// 家目录下的凭据/密钥目录:任何模式都禁写(即使恰好在工作区内)。
const PROTECTED_HOME_DIRS = ['.ssh', '.aws', '.gnupg', path.join('.config', 'gcloud')];

/** child 是否在 parent 之内(含相等)。 */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 受保护位置:.git 元数据目录内部 + 家目录凭据/密钥目录。 */
function isProtected(abs: string): boolean {
  // 路径里出现 `.git` 段即视为 .git 内部(对齐 Codex forbidden_agent_metadata_write);
  // `.gitignore` 等是独立段名,不会误命中。
  if (abs.split(path.sep).includes('.git')) return true;
  return PROTECTED_HOME_DIRS.some((d) => isInside(abs, path.join(HOME, d)));
}

export interface WritePathVerdict {
  ok: boolean;
  /** true=受保护路径,任何审批档硬拒;false 且 ok=false=工作区外,交审批闸升级。 */
  hardDeny: boolean;
  reason: string;
}

/** 判定一次 host 写入路径。abs 应为已解析的绝对路径。 */
export function checkWritePath(ctx: ToolContext, abs: string): WritePathVerdict {
  const resolved = path.resolve(abs);
  if (isProtected(resolved)) {
    return { ok: false, hardDeny: true, reason: `受保护路径,禁止写入:${resolved}` };
  }
  if (writableRoots(ctx).some((r) => isInside(resolved, r))) {
    return { ok: true, hardDeny: false, reason: '' };
  }
  return { ok: false, hardDeny: false, reason: `工作区(${writableRoots(ctx)[0]})之外的写入` };
}

/** 审批闸用:目标是否为「越界写」(工作区外但非硬拒保护路径)→ 需升级审批。 */
export function isOutsideWorkspace(ctx: ToolContext, abs: string): boolean {
  const v = checkWritePath(ctx, path.resolve(abs));
  return !v.ok && !v.hardDeny;
}
