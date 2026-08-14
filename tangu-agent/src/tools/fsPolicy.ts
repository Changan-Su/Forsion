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
import { realpathSync } from 'node:fs';
import type { ToolContext } from './toolTypes.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../seams/runContext.js';

/** agent 自己目录里的身份/自进化文件:generic 写工具(write_file/edit_file/apply_patch…)一律硬拒——
 *  人格(SOUL/config)归用户在设置里改;工作笔记必须走 manage_harness 的快照/封顶/脱敏管线,
 *  否则文件工具就是一条绕过人格主权与 journal 的后门(Codex 评审 #1)。Library/MEMORY/LOG 照旧可写。 */
const SELF_PROTECTED_AGENT_FILES = new Set(['SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md']);

/** 本次 run 的可写根:当前工作目录 + 当前 agent 的专属文件夹 + 用户显式添加的额外工作文件夹。 */
export function writableRoots(ctx: ToolContext): string[] {
  const roots = [path.resolve(ctx.cwd || process.cwd())];
  // agent 的 ~/.tangu/agents/<slug>/ 是它自己的私有目录(Library/ 在此):系统提示承诺它能主动
  // 往 Library 存取资料,故须可写,否则每次写都触发「越界写」审批 → agent 放弃使用 Library。
  try {
    roots.push(path.join(agentsDir(), currentAgentSlug() || DEFAULT_AGENT_SLUG));
  } catch { /* ignore */ }
  // 用户在「工作范围」里显式加的目录:等同工作区,不再逐次弹越界写审批。
  // 仍受 isProtected 约束(.git 内部、~/.ssh 等一律硬拒),加进来也提不了权。
  for (const r of ctx.extraRoots || []) {
    if (typeof r === 'string' && r.trim()) roots.push(path.resolve(r.trim()));
  }
  return roots;
}

const HOME = os.homedir();
// 家目录下的凭据/密钥目录:任何模式都禁写(即使恰好在工作区内)。
const PROTECTED_HOME_DIRS = ['.ssh', '.aws', '.gnupg', path.join('.config', 'gcloud')];

/** child 是否在 parent 之内(含相等)。 */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 真实路径解析:目标可能尚不存在 → realpath 最深已存在祖先,再拼回剩余段。
 *  防软链绕过(Codex 复核 #1):lexical 检查看到的是 Library/x,写入却跟随 symlink 落在 SOUL.md。
 *  目标与可写根都过这一道,macOS /tmp→/private/tmp 之类的系统软链两侧同规归一。 */
function realResolve(abs: string): string {
  let cur = path.resolve(abs);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...[...tail].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(abs); // 连根都解析不了:按字面
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
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

/** 判定一次 host 写入路径。abs 应为已解析的绝对路径;内部再做 realpath 归一(防软链)。 */
export function checkWritePath(ctx: ToolContext, abs: string): WritePathVerdict {
  const resolved = realResolve(abs);
  if (isProtected(resolved)) {
    return { ok: false, hardDeny: true, reason: `受保护路径,禁止写入:${resolved}` };
  }
  // 自己(记忆域与展示身份两个 slug 都算)的身份/自进化文件 → 硬拒。
  // agent 目录同样 realResolve:CLI 形态 ~/.tangu 是指向 ~/.forsion/tangu 的软链,字面比对会漏。
  try {
    for (const slug of new Set([currentAgentSlug(), currentDisplayAgentSlug()])) {
      if (!slug) continue;
      const dir = realResolve(path.join(agentsDir(), slug));
      if (isInside(resolved, dir) && SELF_PROTECTED_AGENT_FILES.has(path.relative(dir, resolved))) {
        return {
          ok: false,
          hardDeny: true,
          reason: `${path.relative(dir, resolved)} 是 agent 身份/自进化文件:人格由用户在设置中修改;工作笔记请用 manage_harness 工具`,
        };
      }
    }
  } catch { /* run 上下文缺席(测试等)→ 不加此判 */ }
  if (writableRoots(ctx).some((r) => isInside(resolved, realResolve(r)))) {
    return { ok: true, hardDeny: false, reason: '' };
  }
  return { ok: false, hardDeny: false, reason: `工作区(${writableRoots(ctx)[0]})之外的写入` };
}

/** 审批闸用:目标是否为「越界写」(工作区外但非硬拒保护路径)→ 需升级审批。 */
export function isOutsideWorkspace(ctx: ToolContext, abs: string): boolean {
  const v = checkWritePath(ctx, path.resolve(abs));
  return !v.ok && !v.hardDeny;
}
