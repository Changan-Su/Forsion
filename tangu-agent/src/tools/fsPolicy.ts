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
const SELF_PROTECTED_AGENT_FILES = new Set(['HUMAN.md', 'SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md', '.cloudsync-accounts.json', '.memory-state.json', '.memory-tombstones.json', '.memory-dream.json', '.memory-raw.md', '.memory.lock']
  .map((f) => foldPathSegment(f)));

/**
 * 硬拒判定用的「同名」折叠(只用于**拒**,绝不用于放行判定):macOS APFS / Windows NTFS 默认不分大小写,
 * 而且不分的不只是 ASCII 大小写 —— APFS 按 Unicode 完整大小写折叠比较:`conﬁg.toml`(U+FB01 连字)、`agentſ/`(U+017F 长 s)、
 * `HARNEß.md`(ß=ss)都落在同一个文件上(09-25 实测:ﬁ 写法把别人的 config.toml 改成了 full-auto,文件名照旧是 config.toml)。
 * 只做 toLowerCase 挡不住这些。折叠口径取保守的一边:NFKC(兼容分解:ﬁ→fi、ſ→s、全角→半角)→ toUpperCase(ß→SS)
 * → toLowerCase。win32 另剥 Win32 路径规整会吃掉的尾部点 / 空格(`config.toml.` = config.toml),以及 `:流名`
 * (`config.toml::$DATA` 就是 config.toml 的主数据流)。已存在的前缀另由 realResolve 走 realpath.native 取盘上真名
 * (8.3 短名 `CONFIG~1.TOM` 这类折叠管不到的也归它)。大小写敏感盘上至多多拒几个同名异写的文件,不放宽任何东西。
 * platform 参数只为在非 Windows 机器上单测 win32 分支。
 */
export function foldPathSegment(seg: string, platform: NodeJS.Platform = process.platform): string {
  let s = seg.normalize('NFKC').toUpperCase().toLowerCase();
  if (platform === 'win32') {
    const colon = s.indexOf(':');
    if (colon >= 0) s = s.slice(0, colon); // 备用数据流 name:stream[:type]
    s = s.replace(/[. ]+$/, ''); // Win32 规整去掉尾部的点与空格
  }
  return s;
}

/** 整条绝对路径逐段折叠(根 / 盘符只转小写,不剥冒号)。两侧都折叠后再做包含 / 相对判定。 */
export function foldPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const { root } = P.parse(p);
  const segs = p.slice(root.length).split(P.sep).filter(Boolean).map((seg) => foldPathSegment(seg, platform));
  return root.toLowerCase() + segs.join(P.sep);
}

/** 折叠后的包含判定 —— 只给硬拒用(见 foldPathSegment)。 */
const insideFolded = (child: string, parent: string): boolean => isInside(foldPath(child), foldPath(parent));

/** 任一 Agent 的配置文件:`agents/<任意 slug>/config.toml`,以及旧式扁平 `agents/<slug>.md`
 *  (getAgent / listAgents 会把它的 frontmatter —— 含 approvalMode —— 原样迁成 config.toml,等价于写配置)。
 *  resolved 与 agentsDir 都已 realResolve;调用方传入。两侧折叠后比(见 foldPathSegment)。 */
function isAnyAgentConfig(resolved: string, agentsRoot: string): boolean {
  const rel = path.relative(foldPath(agentsRoot), foldPath(resolved));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const segs = rel.split(path.sep);
  return (segs.length === 2 && segs[1] === 'config.toml') || (segs.length === 1 && segs[0].endsWith('.md'));
}

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
 *  目标与可写根都过这一道,macOS /tmp→/private/tmp 之类的系统软链两侧同规归一。
 *  用 realpathSync.native(系统 realpath / GetFinalPathNameByHandle):已存在的段取**盘上真名** ——
 *  JS 版 realpathSync 原样保留调用方写的名字,`conﬁg.toml` / `agentſ` / `CONFIG~1.TOM` 在不分大小写的盘上打开的是
 *  config.toml / agents,字面却对不上任何规则(09-25 P1)。不存在的尾段交给 foldPathSegment。 */
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
  // `.gitignore` 等是独立段名,不会误命中。按折叠后的段名比:`.GIT` / `.git.`(win32)同样命中。
  if (foldPath(abs).split(path.sep).includes('.git')) return true;
  return PROTECTED_HOME_DIRS.some((d) => insideFolded(abs, path.join(HOME, d)));
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
    foldPath(resolved).split(path.sep).some((part) => part === '.agents' || part === '.codex') ||
    protectedHostPaths().some((protectedPath) => insideFolded(resolved, protectedPath) || insideFolded(path.resolve(abs), protectedPath))
  )) return { ok: false, hardDeny: true, reason: `Host sandbox protects runtime configuration or metadata: ${resolved}` };
  if (isProtected(resolved)) {
    return { ok: false, hardDeny: true, reason: `Protected path (git metadata or a credentials directory); writing here is not allowed: ${resolved}` };
  }
  // 自己(记忆域与展示身份两个 slug 都算)的身份/自进化文件 → 硬拒。
  // agent 目录同样 realResolve:CLI 形态 ~/.tangu 是指向 ~/.forsion/tangu 的软链,字面比对会漏。
  try {
    for (const slug of new Set([currentAgentSlug(), currentDisplayAgentSlug()])) {
      if (!slug) continue;
      const dir = realResolve(path.join(agentsDir(), slug));
      const fr = foldPath(resolved);
      const fd = foldPath(dir);
      if (isInside(fr, fd) && SELF_PROTECTED_AGENT_FILES.has(path.relative(fd, fr))) {
        return {
          ok: false,
          hardDeny: true,
          reason: path.relative(fd, fr) === 'human.md' ? 'Update HUMAN.md through manage_human so the user receives version history and an undo card.' : `${path.relative(dir, resolved)} is one of your identity / self-evolution files and cannot be written with file tools: your persona is changed by the user in Settings; record working methods with the manage_harness tool.`,
        };
      }
    }
  } catch { /* run 上下文缺席(测试等)→ 不加此判 */ }
  if (path.basename(resolved).toLowerCase() === 'human.md' && (
    pathWithin(resolved, realResolve(agentsDir())) || (ctx.cwd && ['HUMAN.md', '.tangu/HUMAN.md', '.forsion/HUMAN.md'].some(rel => realResolve(path.join(ctx.cwd!, rel)) === resolved))
  )) {
    return { ok: false, hardDeny: true, reason: 'Update HUMAN.md through manage_human so the user receives version history and an undo card.' };
  }
  // **任一** Agent 的 config.toml(审批档 / 内置工具名单 / 模型都在里面)→ 硬拒,不只上面「自己的」。
  // 只拒自己的话,会话目录或额外工作文件夹盖住 agents/(比如会话开在 ~)时,auto-edit 下 write_file 就能无审批地把
  // 别的 Agent 的 approval_mode 改成 full-auto,绕过 manage_agent 不开放审批档的约束(Codex 09-25 P1)。
  // 与 run 上下文无关,放在 try 外单独判。manage_agent / 设置页走 saveAgent 直接落盘,不经此判。
  try {
    if (isAnyAgentConfig(resolved, realResolve(agentsDir()))) {
      return {
        ok: false,
        hardDeny: true,
        reason: `Agent configuration files (config.toml, including the approval tier) cannot be written with file tools: ${resolved}. Use the manage_agent tool; approval tiers are changed by the user in Settings.`,
      };
    }
  } catch { /* agentsDir 解析失败 → 不加此判 */ }
  if (writableRoots(ctx).some((r) => isInside(resolved, realResolve(r)))) {
    return { ok: true, hardDeny: false, reason: '' };
  }
  return { ok: false, hardDeny: false, reason: `Write outside the workspace (${writableRoots(ctx)[0]})` };
}

/** 审批闸用:目标是否为「越界写」(工作区外但非硬拒保护路径)→ 需升级审批。 */
export function isOutsideWorkspace(ctx: ToolContext, abs: string): boolean {
  const v = checkWritePath(ctx, path.resolve(abs));
  return !v.ok && !v.hardDeny;
}
