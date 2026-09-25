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
import { protectedHostPaths } from '../sandbox/hostSandboxProtection.js';

/** agent 自己目录里的身份/自进化文件:generic 写工具(write_file/edit_file/apply_patch…)一律硬拒——
 *  人格(SOUL/config)归用户在设置里改;工作笔记必须走 manage_harness 的快照/封顶/脱敏管线,
 *  否则文件工具就是一条绕过人格主权与 journal 的后门(Codex 评审 #1)。Library/MEMORY/LOG 照旧可写。 */
const SELF_PROTECTED_AGENT_FILES = new Set(['SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md', '.cloudsync-accounts.json', '.memory-state.json', '.memory-tombstones.json', '.memory-dream.json', '.memory-raw.md', '.memory.lock']
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
  const roots = [path.resolve(ctx.cwd || process.cwd())];
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
  let cur = path.resolve(abs);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...[...tail].reverse());
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

/** 判定一次 host 写入路径。abs 应为已解析的绝对路径;内部再做 realpath 归一(防软链)。 */
export function checkWritePath(ctx: ToolContext, abs: string): WritePathVerdict {
  const resolved = realResolve(abs);
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
          reason: `${path.relative(dir, resolved)} is one of your identity / self-evolution files and cannot be written with file tools: your persona is changed by the user in Settings; record working methods with the manage_harness tool.`,
        };
      }
    }
  } catch { /* run 上下文缺席(测试等)→ 不加此判 */ }
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
