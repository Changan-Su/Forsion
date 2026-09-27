import path from 'node:path';
import os from 'node:os';
import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configFile, tanguHome, forsionSharedDir, agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../seams/runContext.js';

/** Resolve the nearest existing ancestor too, so a missing config under a home symlink is protected.
 *  A *dangling* symlink (its target does not exist yet) makes realpath fail, yet a write through it creates the target —
 *  so it is followed by hand (readlink, relative to its own directory) instead of being treated as a plain missing name
 *  (Codex 09-27: ws/link -> ~/.zshrc with no ~/.zshrc used to resolve to ws/link). Hop limit guards symlink loops. */
export function canonicalFuturePath(input: string, hops = 0): string {
  let cursor = path.resolve(input);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(cursor), ...tail.reverse()); }
    catch {
      if (hops < 40) {
        let link: string | null = null;
        try { if (lstatSync(cursor).isSymbolicLink()) link = readlinkSync(cursor); } catch { /* not there */ }
        if (link !== null) return canonicalFuturePath(path.join(path.resolve(path.dirname(cursor), link), ...tail.reverse()), hops + 1);
      }
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
/** 引擎 home 里决定下一次 run 行为的配置(与 protectedHostPaths 同一张表,另加 Special Agent 配置)。
 *  ⚠️ 不含 plugins/:本表也是**本机**「每次都问」的那张(protectedLocalWrite),整个插件目录进来 = 本机完全通行地开发
 *  引擎插件、插件自己放在那里的数据每写一次都要批(评审 B#6)。远程那半不靠它:remoteForbiddenRoot 整片禁引擎 home,
 *  protectedHostPaths 也列着 tanguHome/plugins。 */
const TANGU_CONFIG_NAMES = ['.env', 'mcp.json', 'engines.json', 'engine-prefs.json', 'providers.json', 'muse-state.json', 'special-agents.json'];

/** 当前共享域 + 正式 / dev 两个家目录:同一台机器上两套并存,dev 引擎的 run 同样不许碰正式那套(反之亦然)。 */
function forsionDomains(): string[] {
  return [...new Set([forsionSharedDir(), path.join(os.homedir(), '.forsion'), path.join(os.homedir(), '.forsion-dev')])];
}
function tanguHomes(): string[] {
  return [...new Set([tanguHome(), ...forsionDomains().map((d) => path.join(d, 'tangu')), path.join(os.homedir(), '.tangu')])];
}
const withCanonical = (list: string[]): string[] => [...new Set([...list.map((p) => path.resolve(p)), ...list.map(canonicalFuturePath)])];

/** 引擎 home 里明文存着密钥的文件(P0 第三轮 E2):.env(loadTanguEnv 灌进 process.env 的 KEY=VALUE)、旧 mcp.json(server 的 env / headers)、
 *  旧 providers.json(provider API key)。新形态的这些值都在 config.json 里 —— 它另按「引擎配置」整份收进来(见 credentialPaths)。 */
const TANGU_SECRET_NAMES = ['.env', 'mcp.json', 'providers.json', 'config.json'];

/** Electron userData 目录名:正式 / dev(`-dev` 后缀,main.ts 未打包时 setPath)/ 历史品牌名。与桌面 unitHostScope.USERDATA_SIBLINGS
 *  同一张表(那边再多一条就在这里加一条):同一台机器装着 dev 与正式两套时,一套的 run 不许读另一套的 tangu-desktop-config.json
 *  (unitHostSecret)、remotesync(.dev).json(S3 / WebDAV / Dropbox 凭据)、Local Storage(登录态)。 */
const USERDATA_NAMES = ['Forsion', 'forsion-desktop', 'forsion-desktop-dev', 'tangu-agent-desktop', 'tangu-agent-desktop2', 'Tangu Agent', 'Tangu Agent 2.0'];

/** 平台的 appData 父目录(Electron 的 app.getPath('appData') 同一口径):darwin ~/Library/Application Support、win32 %APPDATA%、
 *  其余 $XDG_CONFIG_HOME 或 ~/.config。引擎独立推算(standalone / CLI 形态也生效),不依赖桌面传参。 */
function platformAppDataDir(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
}

/** 本机所有 Forsion 桌面 userData 目录:宿主给的那一个(dirname FORSION_AMADEUS_CONFIG)+ 它与平台 appData 下的全部兄弟名(含 `-dev` 变体)。 */
function desktopUserDataDirs(): string[] {
  const own = desktopUserDataDir();
  const parents = [...new Set([platformAppDataDir(), ...(own ? [path.dirname(own)] : [])])];
  const names = [...new Set(USERDATA_NAMES.flatMap((n) => [n, `${n}-dev`]))];
  return [...new Set([...(own ? [own] : []), ...parents.flatMap((p) => names.map((n) => path.join(p, n)))])];
}

/** 凭据读清单(契约 C4):**结构化读工具**硬拒(read_file / read_document / view_image / search_files),known-safe 的 cat / rg / git diff
 *  捷径碰到它们就不再免批;写入本机要批、远程硬拒。
 *  ⚠️ 已接受的边界:shell(run_bash / run_background)照样能读这些文件 —— 那条路是**审批**把关,不是硬拒(D1 下本机或远端的人批准了
 *  那条命令就是同意);要彻底隔离得靠宿主沙箱(方案 §6.8)。
 *  引擎自己读自己的配置(core/config.ts、loadTanguEnv、mcp/config.ts)直接走 fs,不经这张表 —— 拒的是工具,不是引擎。 */
export function credentialPaths(): string[] {
  const out: string[] = [];
  for (const d of forsionDomains()) {
    out.push(...CREDENTIAL_FILE_NAMES.map((n) => path.join(d, n)), path.join(d, 'secrets'), path.join(d, 'config.json'));
  }
  // 引擎配置 config.json(provider key、MCP headers / env 都在里面)不一定在共享域:纯 standalone 形态它就在 ~/.tangu 里。
  out.push(configFile());
  for (const h of tanguHomes()) out.push(path.join(h, 'worker-key'), ...TANGU_SECRET_NAMES.map((n) => path.join(h, n)));
  // 桌面 userData(自己的 + 兄弟的):tangu-desktop-config.json(设备通道密钥 / cloudToken)、remotesync(.dev).json、
  // Local Storage / Cookies(登录态)都在里面,整目录收。引擎不知道 Electron 的 userData,但宿主给的 FORSION_AMADEUS_CONFIG
  // 就住在 userData 里(backendManager.amadeusConfigPath),兄弟目录按同一个 appData 父目录推。
  out.push(...desktopUserDataDirs());
  return withCanonical(out);
}

/** Linux /proc 里带秘密的条目(read_file 在**引擎进程内**执行:/proc/self/environ 就是引擎自己的 env,
 *  TANGU_TOKEN / TANGU_LOCAL_TOKEN / TANGU_REMOTE_MARK_SECRET 都在里面 —— C2 剥子进程环境挡不住这条)。
 *  /proc/self、/proc/thread-self、/proc/<引擎 pid> 整棵;别的 pid 只拒这些条目(fd / root / cwd / map_files 是通往任意文件的魔法链接)。 */
const PROC_PID_SECRETS = new Set(['environ', 'cmdline', 'mem', 'maps', 'smaps', 'smaps_rollup', 'pagemap', 'auxv', 'fd', 'fdinfo', 'map_files', 'root', 'cwd', 'exe', 'stack', 'syscall', 'task']);
/** Linux 上目标(字面或真实路径)是否落在 /proc 的秘密条目里 → 返回命中形态;其它平台没有 /proc,恒 null。 */
export function procCredentialTarget(abs: string): string | null {
  if (process.platform !== 'linux') return null;
  for (const f of new Set([path.resolve(abs), canonicalFuturePath(abs)])) {
    const rel = path.posix.relative('/proc', f.split(path.sep).join('/'));
    if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) continue;
    const [first, second] = rel.split('/');
    if (first === 'self' || first === 'thread-self') return f;
    if (/^\d+$/.test(first) && (Number(first) === process.pid || (second !== undefined && PROC_PID_SECRETS.has(second)))) return f;
  }
  return null;
}
/** 递归读取的根(rg / grep -r / search_files)会不会走进 /proc(Linux:根是 /proc 本身、它的祖先、或它里面)。 */
export function procTreeTouched(abs: string): boolean {
  if (process.platform !== 'linux') return false;
  return [path.resolve(abs), canonicalFuturePath(abs)].some((f) => pathWithin(f, '/proc') || pathWithin('/proc', f));
}

/** ~/.forsion(-dev) 下的本机配置:写入本机要批(完全通行也要)、远程硬拒。 */
export function forsionConfigPaths(): string[] {
  const out: string[] = [];
  for (const d of forsionDomains()) out.push(path.join(d, 'config.json'), path.join(d, 'config.json.lock'));
  for (const h of tanguHomes()) out.push(...TANGU_CONFIG_NAMES.map((n) => path.join(h, n)));
  return withCanonical(out);
}

/** macOS / Windows 默认文件系统大小写不敏感:路径段按小写比(`.Agents` 就是 `.agents`)。 */
export const foldCase = process.platform === 'darwin' || process.platform === 'win32';
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

/** 读凭据文件?(结构化读工具对所有 run 一律拒;Linux 另含 /proc 的秘密条目)。 */
export function credentialReadTarget(abs: string): string | null {
  return matchProtected(abs, credentialPaths()) ?? procCredentialTarget(abs);
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

/** 这个(已解析的)路径形态是否在引擎 home 的 agents|teams|engines/<名>/Library 之内,且不在其中的 .tangu / .forsion 控制目录里。 */
function inEngineLibrary(p: string, libBases: string[] = withCanonical(tanguHomes())): boolean {
  return libBases.some((h) => {
    if (!pathWithin(p, h)) return false;
    const parts = path.relative(foldCase ? h.toLowerCase() : h, foldCase ? p.toLowerCase() : p).split(path.sep);
    return parts.length >= 3 && ['agents', 'teams', 'engines'].includes(parts[0]) && parts[1] !== '' && parts[2].toLowerCase() === 'library'
      && !parts.slice(3).some((seg) => seg.toLowerCase() === '.tangu' || seg.toLowerCase() === '.forsion');
  });
}

export function remoteForbiddenRoot(abs: string): string | null {
  const homes = tanguHomes();
  const roots = withCanonical([...forsionDomains(), ...homes, ...[desktopUserDataDir()].filter((d): d is string => !!d)]);
  const libBases = withCanonical(homes);
  // Library 例外按**每一种形态**各判:字面与真实路径里,凡落在禁区的那个形态,自己也得落在 Library 里才算例外。
  //   · Library 里的软链指向别处(别的 Agent 的技能目录…):真实路径在禁区、不在 Library → 禁(Codex 二轮);
  //   · 禁区里的软链指向 Library(~/.forsion/tangu/skills-link → Library):字面路径在禁区、不在 Library → 禁 ——
  //     引擎按字面路径装载 skills/,内容落在 Library 也照样生效(Codex 09-27 跟进轮);
  //   · 项目里的软链指向 Library:字面路径不在禁区,真实路径在 Library → 放行。
  // Library 里的 .tangu/ 与旧 .forsion/ 工作区控制目录(项目技能 / 项目指令)照样禁:私聊的 cwd 就是 Library,
  // 写进去的技能下一次本机 run 会装载。
  for (const f of new Set([path.resolve(abs), canonicalFuturePath(abs)])) {
    if (inEngineLibrary(f, libBases)) continue;
    for (const r of roots) if (pathWithin(f, r)) return r;
  }
  return null;
}

// ── 契约 C8:远程 cwd / 项目路径 + 远程专属的家目录启动项禁写集。────────────────────────────────────────

/** shell 启动 / 登录时自动执行的文件(按文件名认,**任何位置**:dotfiles 仓常被软链进家目录,写仓里那份等于写 ~/.zshrc)。小写比。 */
const SHELL_STARTUP_NAMES = new Set([
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout',
  '.cshrc', '.tcshrc', '.login', '.logout', '.kshrc', '.mkshrc', 'config.fish',
  'microsoft.powershell_profile.ps1', 'profile.ps1',
]);

/** 家目录下的登录启动 / 应用配置区(远程整片禁写):~/.config(XDG 配置与 autostart)、macOS LaunchAgents、Windows「启动」文件夹。 */
function remoteStartupDirs(): string[] {
  const h = os.homedir();
  return withCanonical([
    path.join(h, '.config'),
    path.join(h, 'Library', 'LaunchAgents'),
    path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
  ]);
}

/**
 * 远程污点 run 的家目录启动项禁写(C8):下一次本机登录 / 开 shell / 跑工具时就会执行的位置。命中返回命中的路径,否则 null。
 *   ① 家目录顶层的点文件 / 点目录**及其内部**(~/.zshrc、~/.gitconfig、~/.npmrc,~/.local/bin、~/.oh-my-zsh/custom、~/.docker ……):
 *      C8 字面是「直接在 $HOME 下的点文件 + ~/.config/**」,这里按整棵点目录收 —— 点目录里的代码执行入口太多,逐个列必漏。
 *      Forsion / 引擎家目录(~/.forsion、~/.forsion-dev、~/.tangu)不在这条里判:它们另有整片禁写 + Library 例外(remoteForbiddenRoot),
 *      这里再判一遍会把私聊的 cwd(Library)一起禁掉。
 *   ② ~/.config/**、~/Library/LaunchAgents/**、Windows 启动文件夹;
 *   ③ shell rc / profile 文件名,任何位置。
 * 字面与真实路径两种形态都判;macOS / Windows 按大小写折叠。
 */
export function remoteHomeStartupTarget(abs: string): string | null {
  const forms = [...new Set([path.resolve(abs), canonicalFuturePath(abs)])];
  for (const f of forms) {
    if (SHELL_STARTUP_NAMES.has(path.basename(f).toLowerCase())) return f;
  }
  const domainRoots = withCanonical([...forsionDomains(), ...tanguHomes(), ...[desktopUserDataDir()].filter((d): d is string => !!d)]);
  const homes = withCanonical([os.homedir()]);
  for (const f of forms) {
    // 按形态各判:只有**这个形态本身**落在 Forsion / 引擎家目录里才交给 remoteForbiddenRoot(它有 Library 例外)。
    // ~/.local 是指向某 Agent Library 的软链时,真实路径在 Library,字面路径 ~/.local/bin 却在 PATH 上 —— 字面形态照样按点目录拒(Codex 09-27 跟进轮)。
    if (domainRoots.some((r) => pathWithin(f, r))) continue;
    for (const h of homes) {
      if (!pathWithin(f, h)) continue;
      const rel = path.relative(foldCase ? h.toLowerCase() : h, foldCase ? f.toLowerCase() : f);
      if (rel && rel.split(path.sep)[0].startsWith('.')) return f;
    }
  }
  for (const d of remoteStartupDirs()) if (forms.some((f) => pathWithin(f, d))) return d;
  return null;
}

/** 远程 cwd 不许是这些目录本身或它们的祖先(C8「an ancestor of any protected dir」):凭据 / 配置 / Forsion 与引擎家目录 /
 *  桌面 userData / 宿主沙箱那张表(含引擎包目录与 node 可执行文件)/ 家目录启动项区。 */
function remoteCwdProtectedDirs(): string[] {
  return [...new Set([
    ...protectedHostPaths(), ...credentialPaths(), ...forsionConfigPaths(),
    ...withCanonical([...forsionDomains(), ...tanguHomes(), ...[desktopUserDataDir()].filter((d): d is string => !!d)]),
    ...remoteStartupDirs(),
  ])];
}

/**
 * 契约 C8:远程请求带来的 cwd / 会话 project_path 能不能用。true = 拒(路由回 400 `REMOTE_CWD_FORBIDDEN`)。
 * 拒:realpath 是根目录 / 家目录 / 家目录的祖先(同 startProjectSession.isForbiddenProjectRoot —— 那边挂着整棵工具树,
 * 这层不能引它,三行判断照抄),或是任一受保护目录本身 / 它的祖先。
 * 为什么:cwd 是 auto-edit 下免审批的可写根 —— 远端把 cwd 设成 ~,~/.zshrc、~/Library/LaunchAgents 就都成了「工作区内」。
 * 字面与真实路径两种形态都判(软链指到家目录一样拒);路径不存在不抛(canonicalFuturePath 解析最深已存在的祖先)。
 * 相对路径按引擎进程 cwd 解析 —— 与 loop 里文件工具的解析口径一致。
 */
/** 应用配置 / 数据区(P0 第三轮 E11,C8 加固):远程 cwd 落在它们**之内**也拒(不只是祖先)。
 *  ~/Library(macOS:Application Support / Preferences / Cookies / Keychains / LaunchAgents …)、~/AppData 与 %APPDATA% / %LOCALAPPDATA%
 *  (Windows)、XDG 配置 / 数据 / 状态目录(~/.config、~/.local/share、~/.local/state 及其 $XDG_* 覆盖)。
 *  cwd 在 auto-edit 下是免审批的可写根:落在 ~/Library/Application Support/<别的应用> 里 = 那个应用的配置随便写。
 *  ⚠️ iCloud Drive(~/Library/Mobile Documents)也在 ~/Library 下,同样拒 —— 远程会话要用其中的项目,得在本机开。 */
function remoteAppConfigDirs(): string[] {
  const h = os.homedir();
  const env = (k: string): string[] => { const v = process.env[k]?.trim(); return v && path.isAbsolute(v) ? [v] : []; };
  return withCanonical([
    path.join(h, 'Library'), path.join(h, 'AppData'), ...env('APPDATA'), ...env('LOCALAPPDATA'),
    path.join(h, '.config'), path.join(h, '.local', 'share'), path.join(h, '.local', 'state'),
    ...env('XDG_CONFIG_HOME'), ...env('XDG_DATA_HOME'), ...env('XDG_STATE_HOME'),
  ]);
}

export function remoteCwdForbidden(p: string): boolean {
  const forms = [...new Set([path.resolve(p), canonicalFuturePath(p)])];
  const homes = withCanonical([os.homedir()]);
  const protectedDirs = remoteCwdProtectedDirs();
  const appDirs = remoteAppConfigDirs();
  return forms.some((f) =>
    f === path.parse(f).root
    || homes.some((h) => pathWithin(h, f)) // 家目录本身或其祖先(/Users、/home …)
    || protectedDirs.some((d) => pathWithin(d, f))
    // 应用配置区之内:引擎 home 的 Agent / 团队 / 引擎 Library 例外(引擎 home 被放进 ~/Library 时,私聊的 cwd 就在这里)
    || (appDirs.some((d) => pathWithin(f, d)) && !inEngineLibrary(f)));
}
