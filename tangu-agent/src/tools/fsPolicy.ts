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
import { agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../seams/runContext.js';
import { protectedHostPaths, credentialPaths, forsionConfigPaths, matchProtected, credentialReadTarget, remoteForbiddenRoot, withinForsionDomains, remoteHomeStartupTarget, remoteCwdForbidden, foldCase, canonicalFuturePath, pathWithin } from '../sandbox/hostSandboxProtection.js';
import { effectiveRemote } from '../services/remoteOrigin.js';

/** agent 自己目录里的身份/自进化文件:generic 写工具(write_file/edit_file/apply_patch…)一律硬拒——
 *  人格(SOUL/config)归用户在设置里改;工作笔记必须走 manage_harness 的快照/封顶/脱敏管线,
 *  否则文件工具就是一条绕过人格主权与 journal 的后门(Codex 评审 #1)。Library/MEMORY/LOG 照旧可写。 */
const SELF_PROTECTED_AGENT_FILES = new Set(['HUMAN.md', 'SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md', '.cloudsync-accounts.json', '.memory-state.json', '.memory-tombstones.json', '.memory-dream.json', '.memory-raw.md', '.memory.lock']);

/** 本次 run 的可写根:当前工作目录 + 当前 agent 的专属文件夹 + 用户显式添加的额外工作文件夹。 */
export function writableRoots(ctx: ToolContext): string[] {
  const cwdRoot = path.resolve(ctx.cwd || process.cwd());
  const remote = effectiveRemote(ctx);
  // 远程污点 run 的 cwd 若是家目录 / 根 / 受保护目录的祖先(契约 C8),它不算可写根 —— 路由已对这种 cwd 回 400,
  // 这里兜住绕过路由进来的(远端 steer 进本机 run、派生 run 抄来的 cwd、没带 cwd 回落到引擎进程目录):
  // 写入一律按「工作区外」走越界审批,不再因为「在 cwd 里」就免批。
  const roots = remote && remoteCwdForbidden(cwdRoot) ? [] : [cwdRoot];
  // agent 的 ~/.tangu/agents/<slug>/ 是它自己的私有目录(Library/ 在此):系统提示承诺它能主动
  // 往 Library 存取资料,故须可写,否则每次写都触发「越界写」审批 → agent 放弃使用 Library。
  // 两个 slug 都算:提示词按展示身份指路(agentLoop「Your Personal Folder」),共用默认记忆的 agent 记忆域却是 xyra ——
  // 只认记忆域 slug,它自己的 Library 就成了「工作区外」。
  try {
    for (const slug of new Set([currentAgentSlug() || DEFAULT_AGENT_SLUG, currentDisplayAgentSlug()])) {
      if (slug) roots.push(path.join(agentsDir(), slug));
    }
  } catch { /* ignore */ }
  // 用户在「工作范围」里显式加的目录:等同工作区,不再逐次弹越界写审批。
  // 仍受 isProtected 约束(.git 内部、~/.ssh 等一律硬拒),加进来也提不了权。
  // 远程污点 run 没有额外可写根(C1 剥 extraRoots;起跑后才被远端 steer 染上的本机 run 也从此不认)。
  if (remote) return roots;
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
  // 与 canonicalFuturePath 同一实现:悬空软链(目标还不存在)按链接目标解析 —— 写入会跟着它把目标建出来(Codex 09-27 跟进轮)。
  return canonicalFuturePath(abs);
}

/** 路径段按宿主文件系统的比较口径归一:macOS / Windows 默认大小写不敏感(`.GIT` 就是 `.git`,`.Agents` 就是 `.agents`,评审 B#4 /
 *  P0 第三轮 E4);Windows 还会吞掉段尾的点和空格(`.git.` / `.git ` 打开的就是 `.git`)。platform 参数只给测试(Linux CI 上验另两个平台)。 */
export function metadataSegment(part: string, platform: NodeJS.Platform = process.platform): string {
  const seg = platform === 'darwin' || platform === 'win32' ? part.toLowerCase() : part;
  return platform === 'win32' ? seg.replace(/[. ]+$/, '') : seg;
}
const metaSegment = (part: string): string => metadataSegment(part);
const hasSegment = (p: string, names: string[]): boolean => p.split(path.sep).some((part) => names.includes(metaSegment(part)));

/** 路径里有 `.agents` / `.codex` 段(别的 agent 工具的技能 / 配置目录)。 */
function isAgentMetadataPath(p: string): boolean {
  return hasSegment(p, ['.agents', '.codex']);
}

/** 受保护位置:.git 元数据目录内部 + 家目录凭据/密钥目录。 */
function isProtected(abs: string): boolean {
  // 路径里出现 `.git` 段即视为 .git 内部(对齐 Codex forbidden_agent_metadata_write);
  // `.gitignore` 等是独立段名,不会误命中。大小写按宿主文件系统折叠:mac 上写 `.GIT/hooks/pre-commit` 落的就是真 hook。
  if (hasSegment(abs, ['.git'])) return true;
  return PROTECTED_HOME_DIRS.some((d) => pathWithin(abs, path.join(HOME, d))); // 大小写折叠:mac 上 ~/.SSH 就是 ~/.ssh
}

export interface WritePathVerdict {
  ok: boolean;
  /** true=受保护路径,任何审批档硬拒;false 且 ok=false=工作区外,交审批闸升级。 */
  hardDeny: boolean;
  reason: string;
}

/**
 * 契约 C4 · 写:凭据 + ~/.forsion(-dev) 本机配置。远程污点 run 连同宿主沙箱那张表(引擎包、agent 身份文件、.agents/.codex)
 * 一律硬拒 —— **不依赖宿主沙箱**,也不进审批(按 D1 审批会被推到远端批,与「只在本机」矛盾);本机 run 见 protectedLocalWrite。
 * 返回命中的路径,没命中 null。只管结构化写工具;run_bash 在沙箱关闭时写这些路径仍拦不住(方案 §6.8 残余风险)。
 */
export function protectedRemoteWrite(abs: string): string | null {
  const resolved = realResolve(abs);
  if (isAgentMetadataPath(resolved)) return resolved;
  // 家目录启动项(C8,远程专属):~/.zshrc、~/.gitconfig、~/.config/**、~/Library/LaunchAgents/**、任何位置的 shell rc ——
  // 远端把它们写进去,下一次本机登录 / 开终端就以用户身份执行。
  const startup = remoteHomeStartupTarget(abs);
  if (startup) return startup;
  // Forsion 家目录 / 引擎 home / 桌面 userData 整片(Agent / 团队 / 引擎的 Library 除外),再加宿主沙箱那张表(引擎包、agent 身份文件)。
  const hit = remoteForbiddenRoot(abs) ?? matchProtected(abs, [...credentialPaths(), ...forsionConfigPaths(), ...protectedHostPaths()]);
  if (hit) return hit;
  // 项目里的 .tangu/(旧 .forsion/)工作区控制目录:项目技能 / 项目指令会被下一次本机 run 装载(§6.6 远端不许改项目指令 / 设置 / 技能)。
  // 家目录域内的已由上面判过(Library 例外里同样禁),这里只管家目录之外。
  if (!withinForsionDomains(abs) && resolved.split(path.sep).some((part) => ['.tangu', '.forsion'].includes(metaSegment(part.toLowerCase())))) return resolved;
  return null;
}

/** 契约 C4 · 本机 run 写凭据 / ~/.forsion(-dev) 配置:每次都要人批(完全通行也要,不吃「总允许」)。
 *  刻意不含宿主沙箱那张全表 —— 引擎包目录也在里头,本机完全通行地开发 tangu-agent 会被每次写都问一遍。 */
export function protectedLocalWrite(abs: string): string | null {
  return matchProtected(abs, [...credentialPaths(), ...forsionConfigPaths()]);
}

export interface ReadPathVerdict { ok: boolean; reason: string }
/** 契约 C4 · 读:凭据文件对**所有** run 的**结构化读工具**硬拒(read_file / read_document / view_image;search_files 在搜索侧排除;
 *  Library 文件端点 / 通道发文件同样过这道)。防的是「run 读出 forsion_token 再去批准别处的审批」(§6.4-1);按 realpath 判,软链进来同样拒。
 *  ⚠️ shell(run_bash / run_background)读同一个文件不在这里:known-safe 捷径碰到凭据就不再免批、改走审批 —— 审批是 D1 下的同意,
 *  不是硬拒;要彻底隔离得开宿主沙箱(方案 §6.8)。 */
export function checkReadPath(abs: string): ReadPathVerdict {
  const hit = credentialReadTarget(abs);
  return hit ? { ok: false, reason: `Access denied: ${abs} is a protected credential file and cannot be read by agents.` } : { ok: true, reason: '' };
}

/** 判定一次 host 写入路径。abs 应为已解析的绝对路径;内部再做 realpath 归一(防软链)。 */
export function checkWritePath(ctx: ToolContext, abs: string): WritePathVerdict {
  const resolved = realResolve(abs);
  if (effectiveRemote(ctx)) {
    const hit = protectedRemoteWrite(abs);
    if (hit) return { ok: false, hardDeny: true, reason: `Remote sessions cannot write protected configuration, credentials or startup files: ${resolved}` };
  }
  if (ctx.hostSandbox && ctx.hostSandbox.mode !== 'off' && (
    isAgentMetadataPath(resolved) ||
    protectedHostPaths().some((protectedPath) => pathWithin(resolved, protectedPath) || pathWithin(path.resolve(abs), protectedPath))
  )) return { ok: false, hardDeny: true, reason: `Host sandbox protects runtime configuration or metadata: ${resolved}` };
  if (isProtected(resolved)) {
    return { ok: false, hardDeny: true, reason: `受保护路径,禁止写入:${resolved}` };
  }
  // 自己(记忆域与展示身份两个 slug 都算)的身份/自进化文件 → 硬拒。
  // agent 目录同样 realResolve:CLI 形态 ~/.tangu 是指向 ~/.forsion/tangu 的软链,字面比对会漏。
  try {
    for (const slug of new Set([currentAgentSlug(), currentDisplayAgentSlug()])) {
      if (!slug) continue;
      const dir = realResolve(path.join(agentsDir(), slug));
      // 大小写折叠比(mac 上 Soul.md 就是 SOUL.md):SELF_PROTECTED_AGENT_FILES 按原名存,比的时候两边都折。
      const rel = pathWithin(resolved, dir) ? path.relative(foldCase ? dir.toLowerCase() : dir, foldCase ? resolved.toLowerCase() : resolved) : '';
      if (rel && [...SELF_PROTECTED_AGENT_FILES].some((f) => (foldCase ? f.toLowerCase() : f) === rel)) {
        return {
          ok: false,
          hardDeny: true,
          reason: rel.toLowerCase() === 'human.md' ? 'Update HUMAN.md through manage_human so the user receives version history and an undo card.' : `${path.relative(dir, resolved)} 是 agent 身份/自进化文件:人格由用户在设置中修改;工作笔记请用 manage_harness 工具`,
        };
      }
    }
  } catch { /* run 上下文缺席(测试等)→ 不加此判 */ }
  if (path.basename(resolved).toLowerCase() === 'human.md' && (
    pathWithin(resolved, realResolve(agentsDir())) || (ctx.cwd && ['HUMAN.md', '.tangu/HUMAN.md', '.forsion/HUMAN.md'].some(rel => realResolve(path.join(ctx.cwd!, rel)) === resolved))
  )) {
    return { ok: false, hardDeny: true, reason: 'Update HUMAN.md through manage_human so the user receives version history and an undo card.' };
  }
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
