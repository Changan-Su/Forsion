import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configFile, tanguHome, forsionSharedDir, agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../seams/runContext.js';

/** Resolve the nearest existing ancestor too, so a missing config under a home symlink is protected. */
export function canonicalFuturePath(input: string): string {
  let cursor = path.resolve(input);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(cursor), ...tail.reverse()); }
    catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(input);
      tail.push(path.basename(cursor)); cursor = parent;
    }
  }
}
/** Model-controlled execution must not change the next run's security config or runtime code. */
export function protectedHostPaths(): string[] {
  const original = [
    ...['.ssh', '.aws', '.gnupg', '.config/gcloud'].map((name) => path.join(os.homedir(), name)),
    fileURLToPath(new URL('../..', import.meta.url)), process.execPath, configFile(),
    `${configFile()}.lock`, // config.json 的跨进程写锁(core/config.ts):被模型进程占住 = 用户的设置(含收紧审批)都存不进去
    path.join(forsionSharedDir(), 'auth.json'), path.join(forsionSharedDir(), 'provider-auth.json'),
    ...['.env', 'plugins', 'mcp.json', 'engines.json', 'engine-prefs.json', 'providers.json', 'muse-state.json'].map((name) => path.join(tanguHome(), name)),
  ];
  for (const slug of new Set([currentAgentSlug() || DEFAULT_AGENT_SLUG, currentDisplayAgentSlug()].filter(Boolean))) {
    original.push(...['SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md', '.cloudsync-accounts.json', '.memory-state.json', '.memory-tombstones.json', '.memory-dream.json', '.memory-raw.md', '.memory.lock'].map((name) => path.join(agentsDir(), slug!, name)));
  }
  return [...new Set([...original.map((p) => path.resolve(p)), ...original.map(canonicalFuturePath)])];
}
export function protectedAncestors(paths: string[]): string[] {
  const ancestors = new Set<string>();
  for (const original of paths) {
    let parent = path.dirname(original);
    while (parent !== path.dirname(parent)) { ancestors.add(parent); parent = path.dirname(parent); }
  }
  return [...ancestors];
}

// ── 契约 C4:凭据 / 本机配置路径(设备能力 MCP 方案 §6.3、§6.4)。宿主沙箱开没开都生效(调用方在 fsPolicy / 审批闸)。──

/** 桌面与引擎共用的凭据文件名(都在 Forsion 共享域顶层:auth / 订阅登录 / 浏览器扩展配对 / 桌面桥 / 对外 MCP 发现文件 / 本地回退令牌)。 */
const CREDENTIAL_FILE_NAMES = ['auth.json', 'provider-auth.json', 'browser-extension.json', 'desktop-bridge.json', 'forsion-mcp.json', 'desktop-local-token'];
/** 引擎 home 里决定下一次 run 行为的配置(与 protectedHostPaths 同一张表,另加 Special Agent 配置)。 */
const TANGU_CONFIG_NAMES = ['.env', 'plugins', 'mcp.json', 'engines.json', 'engine-prefs.json', 'providers.json', 'muse-state.json', 'special-agents.json'];

/** 当前共享域 + 正式 / dev 两个家目录:同一台机器上两套并存,dev 引擎的 run 同样不许碰正式那套(反之亦然)。 */
function forsionDomains(): string[] {
  return [...new Set([forsionSharedDir(), path.join(os.homedir(), '.forsion'), path.join(os.homedir(), '.forsion-dev')])];
}
function tanguHomes(): string[] {
  return [...new Set([tanguHome(), ...forsionDomains().map((d) => path.join(d, 'tangu')), path.join(os.homedir(), '.tangu')])];
}
const withCanonical = (list: string[]): string[] => [...new Set([...list.map((p) => path.resolve(p)), ...list.map(canonicalFuturePath)])];

/** 凭据:所有 run 读硬拒(read_file / read_document / view_image / search_files / known-safe 的 cat 类捷径);写入本机要批、远程硬拒。 */
export function credentialPaths(): string[] {
  const out: string[] = [];
  for (const d of forsionDomains()) {
    out.push(...CREDENTIAL_FILE_NAMES.map((n) => path.join(d, n)), path.join(d, 'secrets'));
  }
  for (const h of tanguHomes()) out.push(path.join(h, 'worker-key'));
  // 桌面配置(userData/tangu-desktop-config.json,存着设备通道密钥):引擎不知道 Electron 的 userData,
  // 但宿主给的 FORSION_AMADEUS_CONFIG 就住在 userData 里(backendManager.amadeusConfigPath)。
  const amadeusCfg = process.env.FORSION_AMADEUS_CONFIG?.trim();
  if (amadeusCfg) out.push(path.join(path.dirname(amadeusCfg), 'tangu-desktop-config.json'));
  return withCanonical(out);
}

/** ~/.forsion(-dev) 下的本机配置:写入本机要批(完全通行也要)、远程硬拒。 */
export function forsionConfigPaths(): string[] {
  const out: string[] = [];
  for (const d of forsionDomains()) out.push(path.join(d, 'config.json'), path.join(d, 'config.json.lock'));
  for (const h of tanguHomes()) out.push(...TANGU_CONFIG_NAMES.map((n) => path.join(h, n)));
  return withCanonical(out);
}

const foldCase = process.platform === 'darwin' || process.platform === 'win32';
/** child 是否在 parent 之内(含相等);macOS / Windows 默认大小写不敏感,按折叠比(~/.forsion/Auth.json 就是 auth.json)。 */
export function pathWithin(child: string, parent: string): boolean {
  const c = foldCase ? child.toLowerCase() : child;
  const p = foldCase ? parent.toLowerCase() : parent;
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 目标(按字面与 realpath 两种形态)落在任一受保护路径之内 → 返回命中的那条,否则 null。 */
export function matchProtected(abs: string, list: string[]): string | null {
  const forms = [path.resolve(abs), canonicalFuturePath(abs)];
  for (const p of list) if (forms.some((f) => pathWithin(f, p))) return p;
  return null;
}

/** 读凭据文件?(所有 run 一律拒)。 */
export function credentialReadTarget(abs: string): string | null {
  return matchProtected(abs, credentialPaths());
}

/** Electron userData(桌面配置 / 本地存储所在):宿主给的 FORSION_AMADEUS_CONFIG 就住在里面;没给(非桌面形态)→ null。 */
function desktopUserDataDir(): string | null {
  const amadeusCfg = process.env.FORSION_AMADEUS_CONFIG?.trim();
  return amadeusCfg ? path.dirname(amadeusCfg) : null;
}

/**
 * 远程污点 run 的写入禁区(契约 C4「~/.forsion(-dev) 配置」按整片理解):Forsion 共享域 / 正式与 dev 家目录 / 引擎 home /
 * 桌面 userData 之内一律不许写 —— 那里的 skills/、plugins/、spaces/、别的 Agent 的 config.toml(approval_mode!)、
 * state.db 都会在下一次**本机** run 里生效。唯一例外:agents|teams|engines/<名>/Library(私聊 / 团队 / 引擎会话的 cwd
 * 就是它们,是工作区不是配置)。命中返回所在禁区根,否则 null。
 */
/** 目标(字面或真实路径)是否落在 Forsion 家目录 / 引擎 home / 桌面 userData 之内。 */
export function withinForsionDomains(abs: string): boolean {
  const roots = withCanonical([...forsionDomains(), ...tanguHomes(), ...[desktopUserDataDir()].filter((d): d is string => !!d)]);
  const forms = [path.resolve(abs), canonicalFuturePath(abs)];
  return roots.some((r) => forms.some((f) => pathWithin(f, r)));
}

export function remoteForbiddenRoot(abs: string): string | null {
  const homes = tanguHomes();
  const roots = withCanonical([...forsionDomains(), ...homes, ...[desktopUserDataDir()].filter((d): d is string => !!d)]);
  const libBases = withCanonical(homes);
  const literal = path.resolve(abs);
  const real = canonicalFuturePath(abs);
  // 例外只认**真实路径**落在 Library 里:Library 里的软链指向别处(别的 Agent 的技能目录…)不算(Codex 二轮)。
  // Library 里的 .tangu/ 与旧 .forsion/ 工作区控制目录(项目技能 / 项目指令)照样禁:私聊的 cwd 就是 Library,
  // 写进去的技能下一次本机 run 会装载。
  const inLibrary = libBases.some((h) => {
    if (!pathWithin(real, h)) return false;
    const parts = path.relative(foldCase ? h.toLowerCase() : h, foldCase ? real.toLowerCase() : real).split(path.sep);
    return parts.length >= 3 && ['agents', 'teams', 'engines'].includes(parts[0]) && parts[1] !== '' && parts[2].toLowerCase() === 'library'
      && !parts.slice(3).some((seg) => seg.toLowerCase() === '.tangu' || seg.toLowerCase() === '.forsion');
  });
  if (inLibrary) return null;
  for (const r of roots) if (pathWithin(literal, r) || pathWithin(real, r)) return r;
  return null;
}
