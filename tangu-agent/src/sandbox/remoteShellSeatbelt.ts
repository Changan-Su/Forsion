/**
 * P1 · G5 方案 A:宿主沙箱关时,macOS 上远程污点 run 的每一条 shell 都套 `sandbox-exec` 写拒绝 profile
 * (`(allow default)` + 一组 `deny file-write*`),名单 = remoteShellWriteDenySpec()(与 protectedRemoteWrite 同源)。
 * 评估与实测:docs/remote-bash-protected-paths.md。
 *
 * profile 的几条硬约束(macOS 26.3 现场探针):
 *   · Seatbelt 后写的规则赢:Library 的 allow 写在「整片禁写的根」之后、在凭据 / 启动项这些必须赢的 deny 之前;
 *   · 路径一律写成**大小写不敏感的正则字符串**:已存在的路径 Seatbelt 按真实大小写比,但新建时按调用方给的写法比 ——
 *     `.TANGU/` 在默认 APFS 上就是 `.tangu/`,字面 subpath 拦不住;
 *   · 用 `(regex "…")` 字符串形式而不是 `#"…"`:后者装不下双引号。字符串按 Scheme 规则转义 `\` 与 `"`;
 *     控制字符一律拒绝渲染(抛错 → 调用方失败即关,不跑命令);
 *   · 祖先目录另拒 file-write-unlink:否则 `mv <祖先> x; 改 x/…; mv x <祖先>` 绕过按路径的 deny。
 */
import path from 'node:path';
import { remoteShellWriteDenySpec, protectedAncestors, type RemoteShellWriteDenySpec } from './hostSandboxProtection.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../seams/runContext.js';

/** 远程 shell 写保护不可用 / 渲染失败:命令一律不跑(失败即关)。run_bash 据此把它当工具错误回给模型。 */
export class RemoteShellProtectionError extends Error {
  /** local = 不带远程污点、因 writeProtectShell 才套的那一类(引擎自己的 git、免审批的 git 读命令)—— 文案不能说「来自远程会话」。 */
  constructor(readonly detail: string, local = false) {
    super(local
      ? `On this Mac, git commands that run without approval only run inside a write-protection sandbox (sandbox-exec) that keeps programs configured in the repository away from Forsion settings, credentials and startup files. The sandbox could not be set up (${detail}), so the command was not run.`
      : `This command comes from a remote session, and on this Mac such commands only run inside a write-protection sandbox (sandbox-exec) that keeps them away from Forsion settings, credentials and startup files. The sandbox could not be set up (${detail}), so the command was not run. Run it on this computer directly, or turn on the host sandbox in Settings.`);
    this.name = 'RemoteShellProtectionError';
  }
}

/** 字面串 → 正则片段:ASCII 字母写成 [aA],正则元字符反斜杠转义,其余(含非 ASCII)原样。控制字符抛错。 */
export function ciRegexLiteral(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/[\u0000-\u001f\u007f]/.test(ch)) throw new RemoteShellProtectionError('a protected path contains a control character');
    if (/^[A-Za-z]$/.test(ch)) out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    else if (/^[.^$*+?()[\]{}|\\]$/.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}
/** Scheme 字符串字面量(SBPL):只有 `\` 与 `"` 需要转义;控制字符已在 ciRegexLiteral 拒掉,这里再兜一次。 */
function sbplString(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new RemoteShellProtectionError('a sandbox rule contains a control character');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
const rx = (pattern: string): string => `(regex ${sbplString(pattern)})`;
/** 路径去掉尾部分隔符(根目录除外),再转正则。 */
const pathRx = (p: string): string => ciRegexLiteral(p.length > 1 ? p.replace(/\/+$/, '') : p);
const alt = (names: string[]): string => names.map(ciRegexLiteral).join('|');

/** 由名单渲染 profile。Exposed for tests。 */
export function renderRemoteShellProfile(spec: RemoteShellWriteDenySpec): string {
  const deny = (pattern: string): string => `(deny file-write* ${rx(pattern)})`;
  const lib = `/(${alt(['agents', 'teams', 'engines'])})/[^/]+/${ciRegexLiteral('library')}`;
  const control = `[.](${alt(spec.controlSegments.map((s) => s.replace(/^\./, '')))})`;
  const lines = [
    '(version 1)', '(allow default)',
    // ① Library allow 能盖过的 deny:工作区控制目录段(项目里的 .tangu/.forsion)+ Forsion / 引擎家目录 / 桌面 userData 整片
    deny(`/${control}(/|$)`),
    ...spec.domainRoots.map((r) => deny(`^${pathRx(r)}(/|$)`)),
    // ② Agent / 团队 / 引擎的 Library(私聊 / 团队 / 引擎会话的工作目录)
    ...spec.libraryBases.map((b) => `(allow file-write* ${rx(`^${pathRx(b)}${lib}(/|$)`)})`),
    // ③ Library 里也必须赢的 deny
    ...spec.libraryBases.map((b) => deny(`^${pathRx(b)}${lib}/(.*/)?${control}(/|$)`)),
    ...spec.protectedTrees.map((p) => deny(`^${pathRx(p)}(/|$)`)),
    ...spec.homes.map((h) => deny(`^${pathRx(h)}/[.][^/]+$`)),
    deny(`/[.](${alt(spec.metadataSegments.map((s) => s.replace(/^\./, '')))})(/|$)`),
    deny(`/(${alt(spec.startupNames)})(/|$)`),
    // ④ 祖先目录不许删 / 改名(按路径的 deny 挡不住「整个祖先挪走再挪回」)
    ...protectedAncestors([...spec.domainRoots, ...spec.protectedTrees, ...spec.homes.map((h) => path.join(h, '_'))])
      .map((a) => `(deny file-write-unlink ${rx(`^${pathRx(a)}$`)})`),
  ];
  return [...new Set(lines)].join('\n');
}

/** local(不带远程污点、因 writeProtectShell 才套的:引擎自己的 git、免审批的 git 读命令)的 profile 缓存窗口。
 *  git 现场一次 3 条、项目详情面板一次 7 条,各自现算名单在真家目录上每次要几到几十 ms(机器负载高时),远超 sandbox-exec 本身;
 *  名单里随配置变的项(微信状态目录、急停锁文件)一秒的滞后无所谓。远程污点命令照旧每条现算。 */
const LOCAL_PROFILE_TTL_MS = 1000;
let localProfile: { at: number; key: string; profile: string } | undefined;
/** 名单构建里唯一随调用方变的输入是 ALS 里的 Agent slug(protectedHostPaths 的各 Agent 身份文件);今天它们都落在整片拒写的
 *  引擎 home 里、被精简掉,渲染结果与 slug 无关(实测),但缓存仍按它分键,免得将来名单改了悄悄串到别的 Agent 头上。 */
const localProfileKey = (): string => `${currentAgentSlug() ?? ''}\0${currentDisplayAgentSlug() ?? ''}`;
/** 现算名单并渲染(远程污点命令每条一次:名单里有随配置变的项,如微信状态目录、急停锁文件;local 见上)。 */
export function remoteShellProfile(local = false): string {
  const key = local ? localProfileKey() : '';
  if (local && localProfile && localProfile.key === key && Date.now() - localProfile.at < LOCAL_PROFILE_TTL_MS) return localProfile.profile;
  try {
    const profile = renderRemoteShellProfile(remoteShellWriteDenySpec());
    if (local) localProfile = { at: Date.now(), key, profile };
    return profile;
  } catch (e) {
    const detail = e instanceof RemoteShellProtectionError ? e.detail : `the protected path list could not be built: ${String((e as Error)?.message || e)}`;
    throw e instanceof RemoteShellProtectionError && !local ? e : new RemoteShellProtectionError(detail, local);
  }
}

/** 远程写保护下 shell 输出的补充说明(只在被包住的命令上加)。 */
export function remoteShellNotes(stderr: string): string {
  const notes: string[] = [];
  if (/sandbox_apply|sandbox-exec:/.test(stderr)) {
    notes.push('Note: commands from this remote session run inside a macOS sandbox, and a sandbox cannot be started inside another one. A program that sets up its own sandbox fails here: pass its option to turn that off (for example `swift build --disable-sandbox`, `swift package --disable-sandbox …`), or run it on this computer directly.');
  }
  if (/Operation not permitted/.test(stderr)) {
    notes.push('Note: this remote session cannot change Forsion settings, credentials, agent configuration, shell startup files or other protected locations on this computer, so writes there fail with "Operation not permitted" by design. Do not retry them another way; tell the user it has to be done on this computer.');
  }
  return notes.join('\n');
}
