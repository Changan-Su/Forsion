/**
 * Agent 专属轻量浏览器工具。实现取向参考 Hermes 的 browser_* 工具集，但保持 Tangu 的
 * TypeScript / provider 注册风格：本地调用 agent-browser CLI，按 session 隔离浏览器状态。
 *
 * 接管用户自己的 Chrome(09-24):用户在 chrome://inspect/#remote-debugging 打开远程调试后,
 * browser_* 全族改为驱动**用户正在用的那个 Chrome**(看得见已开的标签、带着登录态),
 * 否则仍是 Tangu 自己的后台浏览器。见 userBrowserEndpoint。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { assertPublicHttpUrl } from '../../core/util/urlSafety.js';
import { tanguHome } from '../../core/tanguHome.js';
import { getRawSection } from '../../core/config.js';
import { formatToolOutput } from '../outputPersist.js';
import { currentExtensionClient, extensionCall, extensionClientAlive, extensionConnected } from '../../services/browserExtension.js';
import type { ToolDef, ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 4 * 1024 * 1024;
const SNAPSHOT_MAX_CHARS = 40_000;
// browser_tabs 读一个标签:正文 + 可交互元素 refs 内联返回(不走落盘预览——多一轮 read_file 就是多 20s)
const TAB_TEXT_MAX_CHARS = 15_000;
const TAB_REFS_MAX_CHARS = 6_000;

// 模型面文案一律英文(项目约定)
const NOT_CONNECTED_HINT =
  "Not connected to the user's own browser, so their open tabs cannot be seen. "
  + 'Tell the user the one-time setup: install the "Tangu for Chrome" extension (Tangu → Settings → Browser → Chrome extension has the steps) '
  + 'and paste the connect code shown there into the extension. Safari and Firefox are not supported. '
  + "Until then, the other browser_* tools use Tangu's separate background browser, which has none of the user's tabs or logins.";
const OWN_BROWSER_EMPTY_NOTE =
  "This is Tangu's own background browser, not the user's, and it shows nothing (no page loaded, or no interactive elements). "
  + 'To see what the user has open in their browser, use browser_tabs.';
const ALLOW_PROMPT_HINT = 'If Chrome is showing an "Allow remote debugging?" prompt, the user must click Allow there.';

type BrowserEngine = 'auto' | 'chrome' | 'lightpanda';
type SearchEngine = 'duckduckgo' | 'bing' | 'google' | 'baidu';

interface BrowserCommandResult {
  success: boolean;
  data?: any;
  error?: string;
  raw?: string;
  stderr?: string;
}

// 浏览器设置:config.json 的 browser 段为底,env(TANGU_BROWSER_*)覆盖(运维逃生口 / 桌面注入)。
function browserCfg(): any { return getRawSection('browser') || {}; }

function browserEnabled(): boolean {
  if (process.env.TANGU_BROWSER_ENABLED !== undefined) return process.env.TANGU_BROWSER_ENABLED !== '0';
  return browserCfg().enabled !== false; // 默认开
}

function allowPrivateUrls(): boolean {
  if (process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS !== undefined)
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS).toLowerCase());
  return browserCfg().allowPrivateUrls === true; // 默认禁私网
}

function browserEngine(): BrowserEngine {
  const v = String(process.env.TANGU_BROWSER_ENGINE || browserCfg().engine || 'auto').toLowerCase();
  return v === 'chrome' || v === 'lightpanda' ? v : 'auto';
}

function searchEngine(): SearchEngine {
  const v = String(process.env.TANGU_BROWSER_SEARCH_ENGINE || browserCfg().searchEngine || 'duckduckgo').toLowerCase();
  return v === 'bing' || v === 'google' || v === 'baidu' ? v : 'duckduckgo';
}

function commandTimeout(): number {
  const envV = Number(process.env.TANGU_BROWSER_COMMAND_TIMEOUT_MS);
  if (Number.isFinite(envV) && envV >= 5_000) return envV;
  const cfgV = Number(browserCfg().commandTimeoutMs);
  return Number.isFinite(cfgV) && cfgV >= 5_000 ? cfgV : DEFAULT_TIMEOUT_MS;
}

function sessionName(ctx: ToolContext): string {
  const h = createHash('sha1').update(`${ctx.appId}:${ctx.sessionId}`).digest('hex').slice(0, 16);
  return `tangu_${h}`;
}

// ── 接管用户的 Chrome ───────────────────────────────────────────────────────────────
// Chrome ≥144 在 chrome://inspect/#remote-debugging 打开「允许远程调试」后,会在自己的 user-data-dir
// 写 DevToolsActivePort(第 1 行端口,第 2 行 /devtools/browser/<id>);此模式下 HTTP /json/* 一律 404,
// 只能拿这条 ws 直连。实测(09-24):
//  - Chrome **每条新连接**都弹「允许远程调试?」→ 所有会话共用一个 agent-browser session = 一条常驻连接;
//  - Chrome 退出**不删**这个文件 → 必须探端口活着,不能只看文件在不在;
//  - agent-browser 的 session 守护进程记死首次的 --cdp 地址,Chrome 重启后同名 session 永远连不上
//    → session 名带 ws 地址的哈希,Chrome 换了实例就自然换一个守护进程;
//  - 守护进程只有「当前标签」一个全局游标,`open` 覆盖它、`tab tN` 把 tN 切到前台;闲置退出重开后标签 id 从 t1 重新编号
//    → 见下方 withAttachLock / boundTabs(Codex 09-24 #2)。

function chromeUserDataDirs(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser']
      .map((d) => path.join(base, d));
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return ['Google/Chrome/User Data', 'Google/Chrome Beta/User Data', 'Google/Chrome SxS/User Data', 'Chromium/User Data', 'Microsoft/Edge/User Data', 'BraveSoftware/Brave-Browser/User Data']
      .map((d) => path.join(base, d));
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser']
    .map((d) => path.join(base, d));
}

function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 第一个「DevToolsActivePort 可解析且端口活着」的浏览器的 ws 端点;都没有 → null。 */
async function findUserBrowser(dirs: string[] = chromeUserDataDirs()): Promise<string | null> {
  for (const dir of dirs) {
    let raw: string;
    try { raw = await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8'); } catch { continue; }
    const [portLine, wsPath] = raw.trim().split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0 || !wsPath?.startsWith('/devtools/browser/')) continue;
    if (await portOpen(port)) return `ws://127.0.0.1:${port}${wsPath}`;
  }
  return null;
}

/** 无人值守 run:Muse(ctx.muse,且自带 automationOrigin='muse')、自动化规则唤起的 agent run(automationOrigin,
 *  full-auto 且无人看着 —— Codex 09-24 #1)、异步审批档的 run(approvalDeferral)。子代理从父 ctx 继承这些字段。 */
function isBackgroundRun(ctx: Pick<ToolContext, 'muse' | 'approvalDeferral' | 'automationOrigin'>): boolean {
  return !!(ctx.muse || ctx.approvalDeferral || ctx.automationOrigin);
}

/**
 * 本次调用该接管的用户浏览器 ws 端点;null = 用 Tangu 自己的后台浏览器。
 * browser.cdp(env TANGU_BROWSER_CDP):'auto'(缺省,自动发现)| 'off' | 显式 ws 地址(台架 / 非常规安装)。
 * 后台 run(Muse、无人值守自动化)绝不碰用户的浏览器:它们开的标签、点的按钮会直接出现在用户眼前。
 */
export async function userBrowserEndpoint(ctx: Pick<ToolContext, 'muse' | 'approvalDeferral' | 'automationOrigin'>): Promise<string | null> {
  if (isBackgroundRun(ctx)) return null;
  const v = String(process.env.TANGU_BROWSER_CDP ?? browserCfg().cdp ?? 'auto').trim();
  if (['off', '0', 'false'].includes(v.toLowerCase())) return null;
  if (v && v.toLowerCase() !== 'auto') return v;
  return findUserBrowser();
}

/** 接管态下以用户身份在已登录页面上动手的工具(含让用户的标签后退跳走的 back):与 browser_task 同一审批档(approvals.ts)。 */
export const USER_BROWSER_ACTIONS: ReadonlySet<string> = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_console', 'browser_back']);

/** 守护进程按「Chrome 实例 × 引擎家目录」分:dev / 正式版 / CLI 各用各的游标,进程级锁管不到别的引擎进程
 *  (Codex 09-24:别的进程在「核对游标 → 执行」之间切走游标,点击就落到别的标签)。代价:每套各点一次「允许」。
 *  ponytail: 同一家目录的两个引擎进程同时驱动用户浏览器仍会共用游标;真撞上再上跨进程锁。 */
function attachSessionName(endpoint: string): string {
  return `tangu_chrome_${createHash('sha1').update(`${endpoint}|${tanguHome()}`).digest('hex').slice(0, 10)}`;
}

// 连不上用户的 Chrome(用户点了「拒绝」/ 弹框没人理)后按端点短暂冷却:模型连试几次 = 用户那边叠几个弹框。
const ATTACH_COOLDOWN_MS = 20_000;
const attachFailures = new Map<string, { until: number; error: string }>(); // 端点 → 冷却

const NO_TAB_BOUND = "No tab is selected for this conversation in the user's Chrome. Use browser_tabs to pick one of the user's tabs, "
  + "or browser_navigate to open a page in Tangu's own tab.";

// 一次工具调用内钉死接管目标:外壳判过的端点传给里面每条命令,中途 Chrome 开关远程调试也不会半截换浏览器(Codex 09-24 #4)。
const pinnedEndpoint = new WeakMap<ToolContext, string | null>();
async function endpointOf(ctx: ToolContext): Promise<string | null> {
  return pinnedEndpoint.has(ctx) ? pinnedEndpoint.get(ctx) ?? null : userBrowserEndpoint(ctx);
}

// 所有会话共用一个守护进程、一个「当前标签」游标:接管态的每次工具调用在进程级锁里跑完整段「切标签 → 操作」,
// 别的 run 插不进来切走游标(否则 A 的 open 可能落到 B 刚选中的用户标签上)。
let attachChain: Promise<unknown> = Promise.resolve();
function withAttachLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = attachChain.then(fn, fn);
  attachChain = next.catch(() => undefined);
  return next;
}

// `${端点}|${会话}` → 本会话选中 / 打开的标签 + 当时的守护进程 pid(守护进程闲置退出重开后标签 id 重新编号,旧 id 会指到别的标签)。
const boundTabs = new Map<string, { endpoint: string; tab: string; kind: 'id' | 'label'; daemon: string }>();
const MAX_BOUND_TABS = 200; // ponytail: 按插入序淘汰最老的;长跑引擎里每个用过接管的会话一条,够用
/** 守护进程 pid;pid 文件不在、或进程已死(崩溃会留下旧文件)→ ''。 */
async function daemonPid(endpoint: string): Promise<string> {
  let pid = '';
  try { pid = (await fs.readFile(path.join(browserSocketDir(), `${attachSessionName(endpoint)}.pid`), 'utf8')).trim(); } catch { return ''; }
  if (!/^[1-9]\d*$/.test(pid)) return ''; // kill(0, …) 会发给整个进程组
  try { process.kill(Number(pid), 0); return pid; } catch (e: any) { return e?.code === 'EPERM' ? pid : ''; }
}
async function bindTab(ctx: ToolContext, endpoint: string, tab: string, kind: 'id' | 'label'): Promise<void> {
  const key = `${endpoint}|${ctx.sessionId}`;
  boundTabs.delete(key);
  boundTabs.set(key, { endpoint, tab, kind, daemon: await daemonPid(endpoint) });
  if (boundTabs.size > MAX_BOUND_TABS) boundTabs.delete(boundTabs.keys().next().value!);
}
/**
 * 把游标切回本会话的标签;返回给模型的错误文案,成功 null。切之前、切之后各核一次守护进程还是绑定时那一个
 * (切之后那次防「刚好闲置退出、tab 命令拉起了新守护进程」——新进程里同一个 id 是别的标签)。
 * 绑定时拿不到 pid(pid 文件缺失 / 平台不写,Windows 未实测)→ 无从核验 → 失败即关闭:只许读,不许点按(Codex 三轮)。
 */
async function rebindTab(ctx: ToolContext, endpoint: string): Promise<string | null> {
  const key = `${endpoint}|${ctx.sessionId}`;
  const b = boundTabs.get(key);
  if (!b) return NO_TAB_BOUND;
  // ponytail: Windows 未实测 —— 若 agent-browser 在那边不写 <session>.pid,接管态点按类工具恒拒(读照常);真机验过再放
  if (!b.daemon) {
    boundTabs.delete(key);
    return "Acting on the user's tabs is unavailable here: the browser bridge's process id can't be verified, so a tab id might point at a different tab. "
      + 'Reading tabs with browser_tabs still works.';
  }
  if (b.daemon !== await daemonPid(endpoint)) { boundTabs.delete(key); return NO_TAB_BOUND; }
  // agent-browser 的 `tab <id>` 哪怕切到**当前**标签也会清空元素 refs(09-24 实测:之后 click @eN → Unknown ref,
  // dev 里用户实翻)→ 游标已在本会话的标签上就不切;顺带同一标签上连续操作不再每次把它激活到前台。
  const list = await runBrowserCommand(ctx, 'tab', ['list'], commandTimeout(), endpoint);
  const current = list.success && Array.isArray(list.data?.tabs) ? list.data.tabs.find((t: any) => t?.active) : undefined;
  const onBound = current && (b.kind === 'id' ? current.tabId === b.tab : current.label === b.tab); // 标识按绑定时的类型比,别的标签的 label 不能冒充 id
  if (onBound && b.daemon === await daemonPid(endpoint)) return null;
  const sw = await runBrowserCommand(ctx, 'tab', [b.tab], commandTimeout(), endpoint);
  if (sw.success && b.daemon === await daemonPid(endpoint)) return null;
  boundTabs.delete(key);
  return sw.success ? NO_TAB_BOUND : `The tab this conversation was using in the user's Chrome is no longer available (${sw.error}). Pick one again with browser_tabs.`;
}
/**
 * 审批闸用:此刻有没有哪个会话在用户的 Chrome 里绑着活的标签。接管态的点按类工具**只能**作用在绑定标签上
 * (没绑定执行侧直接拒),所以「有活绑定」正是它们可能落到用户浏览器上的充要前提 —— 闸门不再自己探端口
 * (探测抖一下就会和执行侧判得不一样,Codex 09-24 复审 #4);不按会话比对,子代理的工具 ctx 用的是 subId。
 */
/**
 * 审批闸用(approvals.ts):这个会话的点按类动作会不会落到用户**自己的**标签上。
 * 扩展那一路:会话绑的是 Tangu 标签组里的页(它自己的地盘)→ 不批;绑的是用户的标签 → 批。
 * 本会话没有扩展绑定(比如子代理,闸门拿的是父会话 id)→ 看全局有没有绑用户标签的,再退回远程调试那一路的判定。
 */
export async function userBrowserActionGated(sessionId: string): Promise<boolean> {
  const own = extBound.get(sessionId);
  if (own && extensionClientAlive(own.clientId)) return !own.sandbox;
  for (const b of extBound.values()) if (!b.sandbox && extensionClientAlive(b.clientId)) return true;
  return userBrowserBound();
}

export async function userBrowserBound(): Promise<boolean> {
  // pid 未知的绑定执行侧会拒,这里仍算上:宁可多问一次(安全侧)
  for (const b of boundTabs.values()) if (!b.daemon || b.daemon === await daemonPid(b.endpoint)) return true;
  return false;
}

// browser_search / browser_navigate 自己切到本会话的 Tangu 标签(navigate);其余都只作用在本会话选中 / 打开的标签上。
const OPENS_OWN_TAB = new Set(['browser_search', 'browser_navigate']);
/** browser_* 外壳:没接管 → 原样执行;接管 → 锁内、钉死端点、先切回本会话的标签再执行。 */
function onOwnTab(t: ToolDef): ToolDef {
  return {
    ...t,
    execute: async (args, ctx) => {
      if (useExtension(ctx)) return extensionExecute(t.name, args, ctx);
      const cdp = await userBrowserEndpoint(ctx);
      const scoped: ToolContext = { ...ctx };
      pinnedEndpoint.set(scoped, cdp);
      if (!cdp) return t.execute(args, scoped);
      return withAttachLock(async () => {
        if (ctx.signal?.aborted) return toJson({ success: false, error: 'aborted' });
        if (!OPENS_OWN_TAB.has(t.name)) {
          const err = await rebindTab(scoped, cdp);
          if (err) return toJson({ success: false, attached: true, error: err });
        }
        return t.execute(args, scoped);
      });
    },
  };
}

/**
 * agent-browser 的 unix domain socket 根目录。
 * macOS sun_path 上限 ~103B,而 agent-browser 会在此目录下用 session 名再拼 `<name>.sock`;
 * 若用 os.tmpdir()(macOS 是超长的 /var/folders/.../T)并再嵌一层 name,socket 路径会超限报
 * "Session name too long / Socket path would be N bytes (max 103)" → 浏览器工具全部失败。
 * 故根目录必须短且不嵌 name:非 Windows 用 /tmp 并按 uid 隔离;Windows 用命名管道不受此限。
 * 可用 TANGU_BROWSER_SOCKET_DIR 覆盖。
 */
function browserSocketDir(): string {
  const override = (process.env.TANGU_BROWSER_SOCKET_DIR || '').trim();
  if (override) return override;
  if (process.platform === 'win32') return path.join(tmpdir(), 'tangu-agent-browser');
  let uid = '';
  try { uid = String(process.getuid?.() ?? ''); } catch { /* ignore */ }
  return path.join('/tmp', uid ? `tangu-br-${uid}` : 'tangu-br');
}

function screenshotDir(): string {
  return path.join(tanguHome(), 'browser', 'screenshots');
}

async function validateUrl(raw: string): Promise<string> {
  if (allowPrivateUrls()) {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are allowed');
    return u.href;
  }
  return (await assertPublicHttpUrl(raw)).href;
}

export const __browserToolInternals = {
  validateUrl,
  navigate,
  findUserBrowser,
  pickTabs: (tabs: TabInfo[], select: string) => pickTabs(tabs, select),
  bindTab: (ctx: ToolContext, endpoint: string, tab: string, kind: 'id' | 'label' = 'id') => bindTab(ctx, endpoint, tab, kind),
  attachSessionName: (endpoint: string) => attachSessionName(endpoint),
  clearBindings: () => boundTabs.clear(),
};

function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'bing': return `https://www.bing.com/search?q=${q}`;
    case 'google': return `https://www.google.com/search?q=${q}`;
    case 'baidu': return `https://www.baidu.com/s?wd=${q}`;
    case 'duckduckgo':
    default:
      return `https://duckduckgo.com/?q=${q}`;
  }
}

function clipSnapshot(s: string): string {
  return s.length > SNAPSHOT_MAX_CHARS ? `${s.slice(0, SNAPSHOT_MAX_CHARS)}\n...[snapshot truncated]` : s;
}

function parseJsonOrRaw(stdout: string, stderr: string): BrowserCommandResult {
  const text = stdout.trim();
  if (!text) return { success: false, error: stderr.trim() || 'agent-browser returned no output' };
  try {
    return JSON.parse(text) as BrowserCommandResult;
  } catch {
    return { success: true, raw: text, stderr: stderr.trim() || undefined };
  }
}

// 没全局装 agent-browser 时,原先每条命令都 `npx agent-browser`:npm 自身启动 ~0.5s/次、偶发查 registry 到数秒,
// browser_tabs 读一页(3 条命令)实测 2.6–8s,直连原生二进制 0.65s。首次经 npx 解析出缓存里的真身,本进程复用。
// 包里的 bin/agent-browser.js 只是按平台挑原生二进制再转调(全局安装时它的 postinstall 也把 shim 改成直连);
// linux 要判 musl → 仍走那个 js 包装;windows 的 cmd 没有 command -v → 照旧逐条 npx。
let agentBrowserBin = 'agent-browser';
let npxBin: Promise<string | null> | null = null;
function resolveNpxBin(): Promise<string | null> {
  npxBin ??= new Promise((resolve) => {
    if (process.platform === 'win32') { resolve(null); return; }
    execFile('npx', ['-y', '-p', 'agent-browser', '-c', 'command -v agent-browser'], { timeout: 120_000 }, (err, stdout) => {
      const link = String(stdout || '').trim().split('\n').pop();
      if (err || !link) { resolve(null); return; }
      void (async () => {
        try {
          const js = await fs.realpath(link);
          const native = path.join(path.dirname(js), `agent-browser-${process.platform}-${process.arch}`);
          const nativeOk = process.platform === 'darwin' && await fs.access(native, fsConstants.X_OK).then(() => true, () => false);
          resolve(nativeOk ? native : js);
        } catch { resolve(null); }
      })();
    });
  });
  return npxBin;
}

function installHint(): string {
  return 'agent-browser CLI not found. Install with: npm install -g agent-browser && agent-browser install';
}

async function spawnAgentBrowser(
  executable: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserCommandResult & { enoent?: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ success: false, error: e?.code === 'ENOENT' ? installHint() : String(e?.message || e), enoent: e?.code === 'ENOENT' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: BrowserCommandResult & { enoent?: boolean }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ success: false, error: `browser command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = (): void => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ success: false, error: 'aborted' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => { if (stdout.length < OUTPUT_CAP) stdout += d.toString(); });
    child.stderr?.on('data', (d) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString(); });
    child.on('error', (e: any) => {
      finish({ success: false, error: e?.code === 'ENOENT' ? installHint() : String(e?.message || e), enoent: e?.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (done) return;
      const parsed = parseJsonOrRaw(stdout, stderr);
      if (code && code !== 0 && parsed.success) {
        finish({ success: false, error: stderr.trim() || `agent-browser exited ${code}`, raw: stdout.trim() || undefined });
      } else {
        finish(parsed);
      }
    });
  });
}

async function runBrowserCommand(
  ctx: ToolContext,
  command: string,
  args: string[] = [],
  timeoutMs = commandTimeout(),
  endpoint?: string | null, // 调用方已判过接管就传进来(一次工具调用内多条命令口径一致);undefined = 现判
): Promise<BrowserCommandResult & { attached?: boolean }> {
  if (!browserEnabled()) return { success: false, error: 'Browser tools are disabled (TANGU_BROWSER_ENABLED=0)' };
  const cdp = endpoint === undefined ? await endpointOf(ctx) : endpoint;
  const cooling = cdp ? attachFailures.get(cdp) : undefined;
  if (cooling && Date.now() < cooling.until) return { success: false, attached: true, error: cooling.error };
  const name = cdp ? attachSessionName(cdp) : sessionName(ctx);
  const fresh = !!cdp && !(await daemonPid(cdp)); // 守护进程还没起 = 这条命令要新建连接,Chrome 会弹授权框
  const socketDir = browserSocketDir();
  await fs.mkdir(socketDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    // 接管态闲置 30 分钟才断:每次重连 Chrome 都要用户再点一次「允许」
    AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || (cdp ? '1800000' : '600000'),
  };
  const engine = browserEngine();
  const baseArgs = ['--session', name];
  if (cdp) baseArgs.push('--cdp', cdp);
  else if (engine !== 'auto') baseArgs.push('--engine', engine);
  baseArgs.push('--json', command, ...args);

  const explicit = process.env.TANGU_AGENT_BROWSER_BIN;
  let r: BrowserCommandResult & { enoent?: boolean } = await spawnAgentBrowser(explicit || agentBrowserBin, baseArgs, env, timeoutMs, ctx.signal);
  if (r.enoent && !explicit) {
    if (agentBrowserBin !== 'agent-browser') { agentBrowserBin = 'agent-browser'; npxBin = null; } // npx 缓存被清了:重新解析
    const bin = await resolveNpxBin();
    if (bin) {
      r = await spawnAgentBrowser(bin, baseArgs, env, timeoutMs, ctx.signal);
      if (!r.enoent) agentBrowserBin = bin;
    }
    if (!bin || r.enoent) r = await spawnAgentBrowser('npx', ['agent-browser', ...baseArgs], env, timeoutMs, ctx.signal);
  }
  if (!cdp) return r;
  // 连 CDP 本身失败(实测措辞 "CDP WebSocket connect failed: …";页面自己的 net::ERR_CONNECTION_* 不算),
  // 或首连超时(授权框没人点)→ 按端点冷却并说清去哪点;已连上后的超时就是页面慢,不提授权框。
  if (!r.success && (/CDP WebSocket|WebSocket connect/i.test(r.error || '') || (fresh && /timed out/i.test(r.error || '')))) {
    const error = `Could not connect to the user's Chrome (${r.error}). ${ALLOW_PROMPT_HINT} Ask them, then retry once — every attempt pops another prompt.`;
    attachFailures.set(cdp, { until: Date.now() + ATTACH_COOLDOWN_MS, error });
    return { ...r, attached: true, error };
  }
  if (r.success) attachFailures.delete(cdp);
  return { ...r, attached: true };
}

async function navigate(ctx: ToolContext, rawUrl: string): Promise<Record<string, any>> {
  const url = await validateUrl(rawUrl);
  const navTimeout = Math.max(commandTimeout(), NAVIGATE_TIMEOUT_MS);
  const cdp = await endpointOf(ctx);
  let opened;
  if (cdp) {
    // 用户的 Chrome 里,agent-browser 的 open 会直接覆盖当前绑定的那个标签(可能正是用户在看的页)
    // → 只在本会话自己的 Tangu 标签(按会话打 label)里跳;还没有就新开一个。会话之间不共用,免得互相冲掉页面。
    const label = `tangu-${createHash('sha1').update(ctx.sessionId).digest('hex').slice(0, 6)}`;
    const own = await runBrowserCommand(ctx, 'tab', [label], commandTimeout(), cdp);
    opened = own.success
      ? await runBrowserCommand(ctx, 'open', [url], navTimeout, cdp)
      : /No tab with label/i.test(own.error || '') // 其余失败(连不上等)原样上报,别再多开一次连接
        ? await runBrowserCommand(ctx, 'tab', ['new', '--label', label, url], navTimeout, cdp)
        : own;
    if (opened.success) await bindTab(ctx, cdp, label, 'label');
  } else {
    opened = await runBrowserCommand(ctx, 'open', [url], navTimeout, null);
  }
  if (!opened.success) return { success: false, error: opened.error || 'navigation failed' };
  const data = opened.data || {};
  const out: Record<string, any> = {
    success: true,
    url: data.url || url,
    title: data.title || '',
  };
  if (cdp) out.note = "Opened in Tangu's own tab in the user's Chrome.";
  const snap = await runBrowserCommand(ctx, 'snapshot', ['-c'], commandTimeout(), cdp);
  if (snap.success) {
    out.snapshot = clipSnapshot(String(snap.data?.snapshot || snap.raw || ''));
    out.element_count = snap.data?.refs ? Object.keys(snap.data.refs).length : undefined;
  } else {
    // 页面打开了但快照失败(实测 Bing 跳转页让 snapshot 卡满 30s 超时):必须把错误带出去,
    // 否则模型拿到「success 且无内容」只会换关键词重搜,再烧一轮 30-60s(2026-09-11 实锤)。
    out.snapshotError = snap.error || 'snapshot failed';
  }
  return out;
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function refArg(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.startsWith('@') ? s : `@${s}`;
}

export const browserToolsProvider: ToolProvider = {
  id: 'builtin:browser-tools',
  tools: () => ([
    {
      name: 'browser_search',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: NAVIGATE_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_search',
          description:
            // E2 之后 browser_click/browser_type 已转 deferred:这句若不说「先 load_tools」,
            // 模型会直接调一个不在面上的工具,白烧一轮才被 registry 的未知工具提示引回来。
            // 但 plan mode 把控制族整族滤掉(PLAN_MODE_TOOLS 只放行 snapshot/screenshot),目录里
            // 根本没有它们 —— 故措辞只承诺「目录里出现时再 load」,不承诺一定解得开(否则 plan mode
            // 下模型照样白烧一轮换来 "Unavailable in this session")。
            'Open a search engine in the local lightweight browser and return a page snapshot. Use this as a fallback when web_search is unavailable or you need to interact with the results page — it is slower and may hit captchas. To act on the @eN refs in the results, load the browser control tools (browser_click/browser_type/...) with load_tools when they appear in the "Additional Tools" catalog; they are not offered in plan mode.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search keywords' },
              engine: { type: 'string', enum: ['duckduckgo', 'bing', 'google', 'baidu'], description: 'Optional search engine, defaults to the configured value' },
            },
            required: ['query'],
          },
        },
      },
      execute: async (args, ctx) => {
        const query = String(args.query ?? '').trim();
        if (!query) return 'Error: query is required';
        const primary = (['duckduckgo', 'bing', 'google', 'baidu'].includes(args.engine) ? args.engine : searchEngine()) as SearchEngine;
        const first = await navigate(ctx, searchUrl(primary, query));
        if (first.success) return toJson({ ...first, query, engine: primary });
        if (primary !== 'bing') {
          const fallback = await navigate(ctx, searchUrl('bing', query));
          return toJson({ ...fallback, query, engine: 'bing', fallbackFrom: primary, firstError: first.error });
        }
        return toJson({ ...first, query, engine: primary });
      },
    },
    {
      name: 'browser_navigate',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: NAVIGATE_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_navigate',
          description: 'Open a public http/https URL in the local lightweight browser and return the title, final URL, and a compact snapshot.',
          parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL' } }, required: ['url'] },
        },
      },
      execute: async (args, ctx) => toJson(await navigate(ctx, String(args.url ?? ''))),
    },
    // ── 以下细粒度操作工具整族按需装载(E2,§五)──────────────────────────────────────
    // 入口(browser_search / browser_navigate / browser_task)常驻,且两个入口的返回值里已内嵌
    // compact 快照与 @eN refs;真要逐步操作页面时才 load_tools 一次,deferGroup 让整套一起到位。
    {
      name: 'browser_snapshot',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Re-read the current page as a snapshot with @eN refs (loads the whole browser control set below).',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_snapshot',
          description: 'Read the accessibility-tree snapshot of the current browser page. compact=true (the default) returns a shorter view of interactive elements; a full snapshot (compact=false) is large — oversized output is offloaded to a file with only a preview inline, so prefer compact unless you truly need the whole tree.',
          parameters: { type: 'object', properties: { compact: { type: 'boolean', description: 'Defaults to true' } }, required: [] },
        },
      },
      execute: async (args, ctx) => {
        const compact = args.compact !== false;
        const r = await runBrowserCommand(ctx, 'snapshot', compact ? ['-c'] : [], commandTimeout());
        const snapshot = clipSnapshot(String(r.data?.snapshot || r.raw || ''));
        // 09-24 反馈:模型在后台浏览器读到空页,当成「用户浏览器看不到」又去试屏幕控制和 browser_task,一问烧了 5 轮。
        const note = !r.attached && snapshot === '(empty page)' ? OWN_BROWSER_EMPTY_NOTE : undefined;
        const out = toJson(r.success ? { success: true, snapshot, element_count: r.data?.refs ? Object.keys(r.data.refs).length : undefined, note } : r);
        // 全量快照动辄 40KB(实测 cookie 弹窗页 42KB 直灌上下文):超 8KB 走落盘+预览,模型按需 read_file。
        // browser_search/browser_navigate 的内嵌快照恒为 compact('-c'),实测个位数 KB,不做此处理。
        return formatToolOutput(ctx, 'browser_snapshot', out);
      },
    },
    {
      name: 'browser_click',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Click an @eN element ref on the current page.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_click',
          description: 'Click an element ref from the snapshot, e.g. @e5. After clicking, typically call browser_snapshot to refresh the page state.',
          parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref, e.g. @e5' } }, required: ['ref'] },
        },
      },
      execute: async (args, ctx) => {
        const ref = refArg(args.ref);
        if (!ref) return 'Error: ref is required';
        return toJson(await runBrowserCommand(ctx, 'click', [ref], commandTimeout()));
      },
    },
    {
      name: 'browser_type',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Type text into an @eN input ref on the current page.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_type',
          description: 'Fill text into an input element ref from the snapshot; clears the existing value before typing.',
          parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] },
        },
      },
      execute: async (args, ctx) => {
        const ref = refArg(args.ref);
        if (!ref) return 'Error: ref is required';
        return toJson(await runBrowserCommand(ctx, 'fill', [ref, String(args.text ?? '')], commandTimeout()));
      },
    },
    {
      name: 'browser_scroll',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Scroll the current page up or down.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_scroll',
          description: 'Scroll the current page. direction is up or down, pixels defaults to 500.',
          parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, pixels: { type: 'number' } }, required: ['direction'] },
        },
      },
      execute: async (args, ctx) => {
        const direction = String(args.direction ?? '');
        if (direction !== 'up' && direction !== 'down') return 'Error: direction must be up or down';
        const pixels = Number.isFinite(Number(args.pixels)) && Number(args.pixels) > 0 ? String(Number(args.pixels)) : '500';
        return toJson(await runBrowserCommand(ctx, 'scroll', [direction, pixels], commandTimeout()));
      },
    },
    {
      name: 'browser_back',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Go back to the previous page.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: { name: 'browser_back', description: 'Navigate the browser back to the previous page.', parameters: { type: 'object', properties: {}, required: [] } },
      },
      execute: async (_args, ctx) => toJson(await runBrowserCommand(ctx, 'back', [], commandTimeout())),
    },
    {
      name: 'browser_press',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Press a key (Enter/Tab/Escape) on the current page.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_press',
          description: 'Press a key on the current page, e.g. Enter, Tab, Escape.',
          parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        },
      },
      execute: async (args, ctx) => {
        const key = String(args.key ?? '').trim();
        if (!key) return 'Error: key is required';
        return toJson(await runBrowserCommand(ctx, 'press', [key], commandTimeout()));
      },
    },
    {
      name: 'browser_console',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Read the page console/errors, or evaluate a JS expression in the page.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_console',
          description: 'Read console/errors, or when an expression is provided, evaluate a JS expression in the page context.',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string', description: 'Optional JS expression; omit to read console/errors' },
              clear: { type: 'boolean', description: 'Clear the buffer after reading' },
            },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        if (args.expression != null) return toJson(await runBrowserCommand(ctx, 'eval', [String(args.expression)], commandTimeout()));
        const flag = args.clear ? ['--clear'] : [];
        const consoleOut = await runBrowserCommand(ctx, 'console', flag, commandTimeout());
        const errors = await runBrowserCommand(ctx, 'errors', flag, commandTimeout());
        return toJson({ success: consoleOut.success || errors.success, console: consoleOut, errors });
      },
    },
    {
      name: 'browser_screenshot',
      mode: 'host',
      isEnabledFor: (profile) => profile.features.webSearch && profile.capabilities.hostExec,
      deferred: true,
      deferGroup: 'browser',
      deferHint: 'Save a PNG screenshot of the current page and return its path.',
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      definition: {
        type: 'function',
        function: {
          name: 'browser_screenshot',
          description: 'Save a screenshot of the current page to ~/.tangu/browser/screenshots and return the screenshot_path.',
          parameters: {
            type: 'object',
            properties: { full_page: { type: 'boolean', description: 'Defaults to true' }, annotate: { type: 'boolean', description: 'Overlay numbers on interactive elements' } },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        await fs.mkdir(screenshotDir(), { recursive: true });
        const file = path.join(screenshotDir(), `browser_screenshot_${randomUUID()}.png`);
        const cmdArgs: string[] = [];
        if (args.annotate) cmdArgs.push('--annotate');
        if (args.full_page !== false) cmdArgs.push('--full');
        cmdArgs.push(file);
        const r = await runBrowserCommand(ctx, 'screenshot', cmdArgs, commandTimeout());
        return toJson(r.success ? { success: true, screenshot_path: r.data?.path || file } : r);
      },
    },
  ] as ToolDef[]).map(onOwnTab),
};

interface TabInfo { tab: string; title: string; url: string; focused?: true; tangu?: true }

/** select → 唯一标签:先按标签 id 精确命中,否则按标题/URL 子串(不分大小写)。0 个或多个都不猜,交回模型挑。 */
function pickTabs(tabs: TabInfo[], select: string): TabInfo[] {
  const exact = tabs.filter((t) => t.tab === select);
  if (exact.length) return exact;
  const q = select.toLowerCase();
  return tabs.filter((t) => `${t.title}\n${t.url}`.toLowerCase().includes(q));
}

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated — scroll or use browser_snapshot for more]` : s;
}

/**
 * browser_tabs —— 「看我浏览器里开着的那个页」的入口(09-24 反馈:Tangu 看不到用户正在用的浏览器)。
 * 单独一个 provider、注册在 registry 最末:新工具只许追加,旧工具定义字节不动(前缀缓存)。
 * Chrome 不告诉外部哪个标签在前台(实测只有逐个标签求值 visibilityState 能判,那要再开一条连接 = 再弹一次授权框),
 * 所以列出全部标签交给模型按用户的描述挑。
 */
export const browserTabsProvider: ToolProvider = {
  id: 'builtin:browser-tabs',
  tools: () => [
    {
      name: 'browser_tabs',
      mode: 'host',
      // 后台 run(Muse 周期跑 plan mode,白名单里有它)永不接管用户浏览器:给它看只会拿到「没连上,去教用户开开关」的误导
      isEnabledFor: (profile, ctx) => profile.features.webSearch && profile.capabilities.hostExec && !isBackgroundRun(ctx),
      capabilities: { sideEffect: 'browser', parallel: false, concurrencyKey: 'browser', defaultTimeoutMs: 60_000 },
      definition: {
        type: 'function',
        function: {
          name: 'browser_tabs',
          description:
            "See the tabs open in the user's own Chrome and read one of them. Use this whenever the user refers to something already open in their browser "
            + '("this page", "the video I have open") — not browser_task, which starts a separate browser without the user\'s tabs. '
            + 'Without `select`, lists the open tabs (id, title, URL). With `select` — a tab id such as "t3", or text found in exactly one tab\'s title or URL — '
            + 'reads that tab and returns its text plus element refs (eN) that the browser_* control tools then act on. '
            + 'The tab the user is looking at is marked focused when that is known; otherwise match what they describe, and ask if several tabs fit. '
            + 'Tabs Tangu opened itself are marked tangu. If Tangu is not connected, the result explains the one-time setup to relay to the user.',
          parameters: {
            type: 'object',
            properties: {
              select: { type: 'string', description: 'Tab id (e.g. "t3") or text from the tab title/URL; omit to just list the tabs' },
            },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        if (useExtension(ctx)) return extensionTabs(ctx, String(args.select ?? '').trim());
        const cdp = await userBrowserEndpoint(ctx);
        if (!cdp) return toJson({ success: false, connected: false, error: NOT_CONNECTED_HINT });
        return withAttachLock(() => readUserTabs(ctx, cdp, String(args.select ?? '').trim()));
      },
    },
  ],
};

/** browser_tabs 本体(已在 withAttachLock 内):列标签;select 命中唯一一个 → 切过去、绑定给本会话、读正文与 refs。 */
async function readUserTabs(ctx: ToolContext, cdp: string, select: string): Promise<string> {
  if (ctx.signal?.aborted) return toJson({ success: false, error: 'aborted' });
  const list = await runBrowserCommand(ctx, 'tab', ['list'], commandTimeout(), cdp);
  if (!list.success) return toJson({ success: false, error: list.error });
  const tabs: TabInfo[] = (Array.isArray(list.data?.tabs) ? list.data.tabs : []).map((t: any) => ({
    tab: String(t.tabId), title: String(t.title || ''), url: String(t.url || ''), ...(String(t.label || '').startsWith('tangu') ? { tangu: true as const } : {}),
  }));
  if (!select) return toJson({ success: true, tabs });
  const hits = pickTabs(tabs, select);
  if (hits.length !== 1) {
    return toJson({
      success: false,
      error: hits.length ? `"${select}" matches ${hits.length} tabs — call again with one tab id.` : `No open tab matches "${select}".`,
      tabs: hits.length ? hits : tabs,
    });
  }
  const sw = await runBrowserCommand(ctx, 'tab', [hits[0].tab], commandTimeout(), cdp);
  if (!sw.success) return toJson({ success: false, error: sw.error });
  await bindTab(ctx, cdp, hits[0].tab, 'id'); // 之后本会话的 browser_click / snapshot … 都落在这个标签上
  const text = await runBrowserCommand(ctx, 'get', ['text', 'body'], commandTimeout(), cdp);
  const refs = await runBrowserCommand(ctx, 'snapshot', ['-i', '-c'], commandTimeout(), cdp);
  return toJson({
    success: true,
    tab: hits[0].tab,
    title: sw.data?.title || hits[0].title,
    url: sw.data?.url || hits[0].url,
    ...(text.success ? { text: clipText(String(text.data?.text ?? ''), TAB_TEXT_MAX_CHARS) } : { textError: text.error }),
    ...(refs.success ? { refs: clipText(String(refs.data?.snapshot ?? ''), TAB_REFS_MAX_CHARS) } : {}),
  });
}

// ── 扩展这一路(Tangu for Chrome;装了且连上就优先于远程调试)───────────────────────────────
// 按 Chrome 标签 id 直接寻址:没有共享游标 → 不用锁、不切标签、不激活;远程调试那一路的锁 / pid / 重绑全用不上。
// 标签 id 只在它所属的那条扩展连接(那个浏览器)里有意义 → 绑定一律带 clientId,连接没了绑定就作废。
// sandbox(点按免审批)只认「本引擎亲手开的标签」—— 组名谁都能改,用户把已登录的页拖进同名组不能换来免审批(Codex 09-24)。
const extBound = new Map<string, { clientId: number; tabId: number; sandbox: boolean }>(); // 会话 → 它正在操作的标签
const extOwnTab = new Map<string, { clientId: number; tabId: number }>(); // 会话 → 它自己开的那一页
const extOpened = new Set<string>(); // `${clientId}:${tabId}`:本引擎经 tabs.open 开的标签
const MAX_EXT_OPENED = 1000;
const openedKey = (clientId: number, tabId: number): string => `${clientId}:${tabId}`;

function useExtension(ctx: ToolContext): boolean {
  return !isBackgroundRun(ctx) && extensionConnected(); // 无人值守 run 永不碰用户的浏览器(与远程调试那一路同口径)
}

function extBind(ctx: ToolContext, clientId: number, tabId: number): void {
  extBound.delete(ctx.sessionId);
  extBound.set(ctx.sessionId, { clientId, tabId, sandbox: extOpened.has(openedKey(clientId, tabId)) });
  if (extBound.size > MAX_BOUND_TABS) extBound.delete(extBound.keys().next().value!);
}

const LOAD_TIMEOUT_NOTE = 'The page was still loading when Tangu stopped waiting; the content below may be incomplete.';

const tabRef = (id: number): string => `t${id}`;
const refOf = (v: unknown): string => String(v ?? '').trim().replace(/^@/, '');
const errText = (e: any): string => String(e?.message || e);

async function extensionTabs(ctx: ToolContext, select: string): Promise<string> {
  try {
    const clientId = currentExtensionClient();
    if (clientId == null) return toJson({ success: false, connected: false, error: NOT_CONNECTED_HINT });
    const { tabs } = await extensionCall<{ tabs: any[] }>('tabs.list', {}, undefined, clientId);
    const list: TabInfo[] = tabs.map((t) => ({
      tab: tabRef(t.id), title: String(t.title || ''), url: String(t.url || ''),
      ...(t.focused ? { focused: true as const } : {}), ...(t.tangu ? { tangu: true as const } : {}),
    }));
    if (!select) return toJson({ success: true, tabs: list });
    const hits = pickTabs(list, select);
    if (hits.length !== 1) {
      return toJson({
        success: false,
        error: hits.length ? `"${select}" matches ${hits.length} tabs — call again with one tab id.` : `No open tab matches "${select}".`,
        tabs: hits.length ? hits : list,
      });
    }
    const tabId = Number(hits[0].tab.slice(1));
    const page = await extensionCall<any>('page.read', { tabId, maxText: TAB_TEXT_MAX_CHARS }, undefined, clientId);
    extBind(ctx, clientId, tabId); // 之后本会话的 browser_click / snapshot … 都落在这个标签上(按 id,不切前台)
    return toJson({
      success: true,
      tab: hits[0].tab,
      title: page.title || hits[0].title,
      url: page.url || hits[0].url,
      text: clipText(String(page.text || ''), TAB_TEXT_MAX_CHARS),
      refs: clipText(String(page.snapshot || ''), TAB_REFS_MAX_CHARS),
    });
  } catch (e) {
    return toJson({ success: false, error: errText(e) });
  }
}

/** 在本会话自己的那一页里打开(没有就在 Tangu 标签组里后台新开一个);绝不动用户正看着的标签。 */
async function extensionNavigate(ctx: ToolContext, rawUrl: string): Promise<Record<string, any>> {
  const url = await validateUrl(rawUrl);
  const clientId = currentExtensionClient();
  if (clientId == null) throw new Error('The Tangu Chrome extension is not connected');
  const own = extOwnTab.get(ctx.sessionId);
  let tab: any = null;
  // 自己那一页只在同一个浏览器里复用;被用户关了 / 换了浏览器 → 重开一页
  if (own && own.clientId === clientId) { try { tab = await extensionCall('tabs.navigate', { tabId: own.tabId, url }, undefined, clientId); } catch { tab = null; } }
  if (!tab) {
    tab = await extensionCall('tabs.open', { url }, undefined, clientId);
    extOpened.add(openedKey(clientId, tab.id));
    if (extOpened.size > MAX_EXT_OPENED) extOpened.delete(extOpened.values().next().value!);
  }
  extOwnTab.delete(ctx.sessionId);
  extOwnTab.set(ctx.sessionId, { clientId, tabId: tab.id });
  if (extOwnTab.size > MAX_BOUND_TABS) extOwnTab.delete(extOwnTab.keys().next().value!);
  extBind(ctx, clientId, tab.id);
  const out: Record<string, any> = {
    success: true,
    url: tab.url || url,
    title: tab.title || '',
    note: "Opened in the background in the \"Tangu\" tab group of the user's Chrome; the tab the user is on was not touched.",
  };
  if (tab.loadTimedOut) out.warning = LOAD_TIMEOUT_NOTE;
  try {
    const snap = await extensionCall<any>('page.snapshot', { tabId: tab.id }, undefined, clientId);
    out.snapshot = clipSnapshot(String(snap.snapshot || ''));
    out.element_count = snap.refCount;
  } catch (e) {
    out.snapshotError = errText(e);
  }
  return out;
}

async function extensionExecute(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  try {
    if (name === 'browser_navigate') return toJson(await extensionNavigate(ctx, String(args.url ?? '')));
    if (name === 'browser_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: query is required';
      const engine = (['duckduckgo', 'bing', 'google', 'baidu'].includes(args.engine) ? args.engine : searchEngine()) as SearchEngine;
      return toJson({ ...(await extensionNavigate(ctx, searchUrl(engine, query))), query, engine });
    }
    const bound = extBound.get(ctx.sessionId);
    if (!bound || !extensionClientAlive(bound.clientId)) return toJson({ success: false, error: NO_TAB_BOUND });
    const { tabId, clientId } = bound;
    const call = <T = any>(method: string, params: Record<string, unknown>): Promise<T> => extensionCall<T>(method, params, undefined, clientId);
    switch (name) {
      case 'browser_snapshot': {
        const r = await call<any>('page.snapshot', { tabId });
        return formatToolOutput(ctx, 'browser_snapshot', toJson({ success: true, url: r.url, title: r.title, snapshot: clipSnapshot(String(r.snapshot || '')), element_count: r.refCount }));
      }
      case 'browser_click': {
        const ref = refOf(args.ref);
        if (!ref) return 'Error: ref is required';
        const r = await call<any>('page.click', { tabId, ref });
        return toJson({ success: true, clicked: ref, url: r.url, title: r.title });
      }
      case 'browser_type': {
        const ref = refOf(args.ref);
        if (!ref) return 'Error: ref is required';
        const r = await call<any>('page.type', { tabId, ref, text: String(args.text ?? '') });
        return toJson({ success: true, value: r.value, url: r.url, title: r.title });
      }
      case 'browser_scroll': {
        const direction = String(args.direction ?? '');
        if (direction !== 'up' && direction !== 'down') return 'Error: direction must be up or down';
        const px = Number.isFinite(Number(args.pixels)) && Number(args.pixels) > 0 ? Number(args.pixels) : 500;
        const r = await call<any>('page.scroll', { tabId, dy: direction === 'up' ? -px : px });
        return toJson({ success: true, scrollY: r.y, maxScrollY: r.max });
      }
      case 'browser_back': {
        const r = await call<any>('page.back', { tabId });
        return toJson({ success: true, url: r.url, title: r.title, ...(r.loadTimedOut ? { warning: LOAD_TIMEOUT_NOTE } : {}) });
      }
      case 'browser_press': {
        const key = String(args.key ?? '').trim();
        if (!key) return 'Error: key is required';
        const r = await call<any>('page.press', { tabId, key });
        const note = r.synthetic ? 'Sent as a synthetic key event (the trusted path was unavailable); the page may ignore it — check the result with browser_snapshot.' : undefined;
        return toJson({ success: true, key, url: r.url, title: r.title, ...(note ? { note } : {}) });
      }
      case 'browser_console': {
        if (args.expression == null) {
          return toJson({ success: false, error: 'Reading console logs is not available through the Tangu Chrome extension yet; pass an expression to evaluate instead.' });
        }
        const r = await call<any>('page.eval', { tabId, expression: String(args.expression) });
        return toJson(r?.ok === false ? { success: false, error: r.error } : { success: true, result: r?.result, type: r?.type });
      }
      case 'browser_screenshot': {
        const r = await call<any>('page.screenshot', { tabId, full: args.full_page !== false });
        if (r?.ok === false) return toJson({ success: false, error: r.error });
        await fs.mkdir(screenshotDir(), { recursive: true });
        const file = path.join(screenshotDir(), `browser_screenshot_${randomUUID()}.png`);
        await fs.writeFile(file, Buffer.from(String(r.data || ''), 'base64'));
        return toJson({ success: true, screenshot_path: file });
      }
      default:
        return toJson({ success: false, error: `${name} is not supported through the Tangu Chrome extension` });
    }
  } catch (e) {
    return toJson({ success: false, error: errText(e) });
  }
}

