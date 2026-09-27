/**
 * 设备能力 MCP 方案 P0 · 第三轮(引擎)· 凭据读清单 / known-safe git / `.GIT` 大小写 / 通道发文件。
 * 负对照:每条都在 feat/p0-remote-hardening(e0a1bd09,修复前)上实跑为红 —— 见各 it 的「修复前」注。
 *
 *   E2 凭据读清单:引擎 home 的 .env / config.json(provider key、MCP headers/env)/ 旧 mcp.json / providers.json、
 *      桌面 userData 的 remotesync(.dev).json、以及 dev / 正式 / 旧名**兄弟** userData 整个目录;Linux 的 /proc/self/**、
 *      /proc/<pid>/{environ,cmdline,mem,maps…}。结构化读工具硬拒、known-safe 捷径不再免批;引擎自己照常读自己的配置。
 *   E3 git diff / show 的操作数与 cat 同一道凭据检查(字面 + 真实路径),且必须落在仓库顶层之内;--no-index 永不免批。
 *   E4 macOS / Windows 上 `.GIT` 就是 `.git`:保护判定按大小写折叠(远程写 .GIT/config、.GIT/hooks/pre-commit 硬拒)。
 *   E9 channel_send_file / channel_send_image 发送前过 checkReadPath(凭据文件不许发给通道对端)。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const sent = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: vi.fn(async () => 1) }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
vi.mock('../src/services/wechatRemote.js', () => ({
  wechatRemote: { sendMediaForSession: async (...a: any[]) => { sent.calls.push(a); return { ok: true }; } },
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isKnownSafeBash, customRules } from '../src/services/approvals.js';
import { checkReadPath, checkWritePath } from '../src/tools/fsPolicy.js';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { channelToolsProvider } from '../src/tools/builtin/channelTools.js';
import { fileSearchProvider } from '../src/tools/builtin/fileSearch.js';
import { enterRunContext } from '../src/seams/runContext.js';
import type { ToolCall } from '../src/core/types.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const REMOTE = { via: 'lan' as const, marked: true };
const foldCase = process.platform === 'darwin' || process.platform === 'win32';
let home: string; // TANGU_HOME = 共享域(basename 不是 tangu)
let appData: string; // 假的 appData 父目录(FORSION_AMADEUS_CONFIG 住在它的 Forsion/ 子目录里)
let repo: string; // 一个真 git 仓(工作区)
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;
const ctxOf = (cwd: string, extra: Partial<ToolContext> = {}): ToolContext =>
  ({ userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd, ...extra }) as ToolContext;
let seq = 0;
/** 过一次闸:弹了审批卡就立刻中止。 */
async function gate(c: ToolCall, ctx: Record<string, any>): Promise<{ asked: boolean; action: string }> {
  const ac = new AbortController();
  const runId = `RC${++seq}`;
  let asked = false;
  const p = gateToolCall(runId, c, { sessionId: `S${seq}`, execMode: 'host', cwd: repo, profile, ...ctx } as any, ac.signal);
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 200))]);
  if (!settled) { asked = true; ac.abort(); }
  return { asked, action: (await p).action };
}
/** 平台 appData(引擎独立推算兄弟 userData 用的同一口径):darwin ~/Library/Application Support、win32 %APPDATA%、其余 XDG 配置目录。 */
function platformAppData(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}
function withPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', orig); }
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-r3-cred-')));
  process.env.TANGU_HOME = home;
  appData = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-r3-appdata-')));
  mkdirSync(join(appData, 'Forsion'), { recursive: true });
  process.env.FORSION_AMADEUS_CONFIG = join(appData, 'Forsion', 'amadeus-config.json');
  writeFileSync(join(home, 'auth.json'), '{"token":"SECRET-AUTH"}');
  writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=SECRET-ENV\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ providers: { openai: { apiKey: 'SECRET-CFG' } }, approval: { base: 'readonly', deny: ['web_fetch'] } }));
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'x', env: { KEY: 'SECRET-MCP' } } } }));
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ openai: { apiKey: 'SECRET-PROV' } }));
  writeFileSync(join(home, 'notes.txt'), 'plain');
  writeFileSync(join(appData, 'Forsion', 'remotesync.json'), '{"s3":{"secret":"SECRET-S3"}}');
  mkdirSync(join(appData, 'forsion-desktop-dev'), { recursive: true });
  writeFileSync(join(appData, 'forsion-desktop-dev', 'tangu-desktop-config.json'), '{"unitHostSecret":"SECRET-DEV"}');
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-r3-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a');
  symlinkSync(home, join(repo, 'link')); // 仓里的软链指向凭据目录
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile, state: { getAgentConfig: async () => null } as any } as any);
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  delete process.env.FORSION_AMADEUS_CONFIG;
  for (const d of [home, appData, repo]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('E2 凭据读清单补全', () => {
  it('引擎 home 的 .env / config.json / mcp.json / providers.json 读硬拒(修复前:四个都放行)', async () => {
    for (const f of ['.env', 'config.json', 'mcp.json', 'providers.json']) {
      expect(checkReadPath(join(home, f)).ok, f).toBe(false);
      const out = await HOST_TOOLS.read_file.execute({ path: join(home, f) }, ctxOf(home));
      expect(out, f).toMatch(/^Error: Access denied/);
      expect(out).not.toMatch(/SECRET-/);
    }
    // ~/.tangu/.env(CLI 形态的引擎 home)与正式 / dev 共享域的 config.json 同样在清单里
    expect(checkReadPath(join(homedir(), '.tangu', '.env')).ok).toBe(false);
    expect(checkReadPath(join(homedir(), '.forsion', 'config.json')).ok).toBe(false);
    expect(checkReadPath(join(homedir(), '.forsion-dev', 'tangu', 'mcp.json')).ok).toBe(false);
    // 负对照:同目录的普通文件照读
    expect(checkReadPath(join(home, 'notes.txt')).ok).toBe(true);
    expect(await HOST_TOOLS.read_file.execute({ path: join(home, 'notes.txt') }, ctxOf(home))).toContain('plain');
  });

  it('引擎自己照常读自己的配置(拒的是工具,不是引擎):approval 段现读得到', () => {
    expect(customRules()).toMatchObject({ base: 'readonly', deny: ['web_fetch'] });
  });

  it('桌面 userData 的 remotesync.json、兄弟 userData(dev / 正式 / 旧名)整目录读硬拒(修复前:都放行)', () => {
    expect(checkReadPath(join(appData, 'Forsion', 'remotesync.json')).ok).toBe(false);
    expect(checkReadPath(join(appData, 'Forsion', 'remotesync.dev.json')).ok).toBe(false);
    expect(checkReadPath(join(appData, 'forsion-desktop-dev', 'tangu-desktop-config.json')).ok).toBe(false);
    expect(checkReadPath(join(appData, 'Tangu Agent', 'Local Storage', 'leveldb', '000003.log')).ok).toBe(false);
    // 独立形态(没有 FORSION_AMADEUS_CONFIG):按平台 appData 推算兄弟目录
    const saved = process.env.FORSION_AMADEUS_CONFIG;
    delete process.env.FORSION_AMADEUS_CONFIG;
    try {
      expect(checkReadPath(join(platformAppData(), 'Forsion', 'tangu-desktop-config.json')).ok).toBe(false);
      expect(checkReadPath(join(platformAppData(), 'forsion-desktop-dev', 'remotesync.dev.json')).ok).toBe(false);
      // 负对照:appData 里与 Forsion 无关的别的应用不在凭据清单(远程 cwd 另有 C8 规则)
      expect(checkReadPath(join(platformAppData(), 'SomeOtherApp', 'settings.json')).ok).toBe(true);
    } finally { process.env.FORSION_AMADEUS_CONFIG = saved; }
  });

  it('known-safe 捷径不再免批:cat .env / config.json(修复前:SAFE)', () => {
    expect(isKnownSafeBash(`cat ${join(home, '.env')}`, repo)).toBe(false);
    expect(isKnownSafeBash(`head -n 3 ${join(home, 'config.json')}`, repo)).toBe(false);
    expect(isKnownSafeBash(`cat ${join(appData, 'Forsion', 'remotesync.json')}`, repo)).toBe(false);
    expect(isKnownSafeBash(`cat ${join(home, 'notes.txt')}`, repo)).toBe(true); // 负对照
  });

  it('Linux:/proc/self/** 与 /proc/<pid>/{environ,cmdline,mem,maps} 读硬拒、cat 不免批(修复前:SAFE / 放行);其余 /proc 照读', () => {
    withPlatform('linux', () => {
      for (const p of ['/proc/self/environ', '/proc/self/cmdline', '/proc/thread-self/environ', `/proc/${process.pid}/status`, '/proc/1/environ', '/proc/1/cmdline', '/proc/1/mem', '/proc/1/maps', '/proc/1/task/1/environ']) {
        expect(checkReadPath(p).ok, p).toBe(false);
      }
      expect(isKnownSafeBash('cat /proc/1/environ', repo)).toBe(false);
      expect(isKnownSafeBash('cat /proc/self/environ', repo)).toBe(false);
      expect(isKnownSafeBash('grep -r TANGU /proc', repo)).toBe(false); // 递归读 /proc 同样不免批
      // 负对照:不带秘密的 /proc 条目照读
      expect(checkReadPath('/proc/cpuinfo').ok).toBe(true);
      expect(checkReadPath('/proc/1/status').ok).toBe(true);
      expect(isKnownSafeBash('cat /proc/cpuinfo', repo)).toBe(true);
    });
    // 非 Linux 没有 /proc:不改变任何判定
    withPlatform('darwin', () => { expect(checkReadPath('/proc/1/status').ok).toBe(true); });
  });

  it('Linux:search_files 的搜索根在 /proc 里 → 整次拒(修复前:照搜)', async () => {
    const search = fileSearchProvider.tools().find((t) => t.name === 'search_files')!;
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(await search.execute({ pattern: 'TANGU' }, ctxOf('/proc/self'))).toMatch(/^Error: Access denied/);
    } finally { Object.defineProperty(process, 'platform', orig); }
  });
});

describe('凭据读清单:通道令牌 / 插件设置 / Agent 浏览器登录态(09-27 终审 P2)', () => {
  it('微信 iLink 令牌目录、插件设置文件、browser-use 的 chrome-profile 读硬拒、cat 不免批;插件数据目录与 Agent Library 照常', async () => {
    const files = [
      join(home, 'wechat', 'accounts.json'),
      join(home, 'agents', 'a1', 'plugins', 'someplugin.json'),
      join(home, 'plugins-config', 'p1', 'settings.json'),
      join(home, 'browser-use', 'chrome-profile', 'Default', 'Cookies'),
    ];
    for (const f of files) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, 'SECRET-R3P2');
      expect(checkReadPath(f).ok, f).toBe(false);
      expect(await HOST_TOOLS.read_file.execute({ path: f }, ctxOf(home)), f).toMatch(/^Error: Access denied/);
      expect(isKnownSafeBash(`cat ${f}`, repo), f).toBe(false);
    }
    // 负对照:插件的 -files 数据目录、Agent 的 Library(solo 会话工作目录)照读、照免批
    const data = join(home, 'agents', 'a1', 'plugins', 'someplugin-files', 'note.txt');
    const lib = join(home, 'agents', 'a1', 'Library', 'draft.md');
    for (const f of [data, lib]) { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, 'plain'); expect(checkReadPath(f).ok, f).toBe(true); }
    expect(isKnownSafeBash('rg plain .', join(home, 'agents', 'a1', 'Library'))).toBe(true);
    // 递归根会扫到插件设置 → 不免批
    expect(isKnownSafeBash('rg SECRET .', join(home, 'agents', 'a1'))).toBe(false);
    expect(isKnownSafeBash(`rg SECRET ${join(home, 'plugins-config')}`, repo)).toBe(false);
  });
});

describe('E3 known-safe git diff / show 不碰凭据、不越出仓库', () => {
  const G = 'git diff --no-ext-diff --no-textconv';
  it('绝对 / 相对 / 软链三种写法的凭据操作数都要审批(修复前:三种都 SAFE);cat 为负对照', () => {
    const abs = join(home, 'auth.json');
    const rel = relative(repo, abs);
    expect(isKnownSafeBash(`${G} ${abs} /dev/null`, repo)).toBe(false);
    expect(isKnownSafeBash(`${G} ${rel} /dev/null`, repo)).toBe(false);
    expect(isKnownSafeBash(`${G} link/auth.json /dev/null`, repo)).toBe(false);
    expect(isKnownSafeBash(`git show --no-ext-diff --no-textconv ${abs}`, repo)).toBe(false);
    expect(isKnownSafeBash(`${G} -- link/auth.json`, repo)).toBe(false);
    // 负对照:cat 早就不免批
    expect(isKnownSafeBash(`cat ${abs}`, repo)).toBe(false);
    expect(isKnownSafeBash('cat link/auth.json', repo)).toBe(false);
  });

  it('仓库顶层之外的任何路径操作数、--no-index、不在仓库里的 diff 都不免批(修复前:前两种 SAFE)', () => {
    const outside = join(home, 'notes.txt'); // 不是凭据,但在仓库外 → git diff 静默切成 --no-index
    expect(isKnownSafeBash(`${G} ${outside} /dev/null`, repo)).toBe(false);
    expect(isKnownSafeBash(`${G} a.txt /dev/null`, repo)).toBe(false);
    expect(isKnownSafeBash(`${G} --no-index a.txt b.txt`, repo)).toBe(false);
    expect(isKnownSafeBash(`${G} a.txt`, home)).toBe(false); // home 不是 git 仓
    // 负对照:仓库内的正常用法照旧免批
    expect(isKnownSafeBash(G, repo)).toBe(true);
    expect(isKnownSafeBash(`${G} HEAD -- a.txt`, repo)).toBe(true);
    expect(isKnownSafeBash(`git show --no-ext-diff --no-textconv HEAD`, repo)).toBe(true);
    expect(isKnownSafeBash('git status --porcelain', repo)).toBe(true);
    expect(isKnownSafeBash('git log --oneline', repo)).toBe(true);
  });

  it('审批闸:本机 auto-edit 与远程 run 的凭据 git diff 都弹卡(修复前:直接放行)', async () => {
    const cmd = `${G} link/auth.json /dev/null`;
    expect((await gate(call('run_bash', { command: cmd }), { approvalMode: 'auto-edit' })).asked).toBe(true);
    expect((await gate(call('run_bash', { command: cmd }), { approvalMode: 'readonly', remote: REMOTE })).asked).toBe(true);
    // 负对照:仓库内 diff 照旧免批
    expect((await gate(call('run_bash', { command: G }), { approvalMode: 'auto-edit' })).action).toBe('approve');
  });
});

describe('E4 `.GIT` 大小写折叠', () => {
  it.skipIf(!foldCase)('远程写 .GIT/config、.GIT/hooks/pre-commit 硬拒;本机同路径同样是保护路径(修复前:工作区内放行)', async () => {
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    const remote = ctxOf(repo, { remote: REMOTE });
    for (const p of [join(repo, '.GIT', 'config'), join(repo, '.GIT', 'hooks', 'pre-commit'), join(repo, '.Git', 'HEAD')]) {
      expect(checkWritePath(remote, p), p).toMatchObject({ ok: false, hardDeny: true });
      expect(checkWritePath(ctxOf(repo), p).hardDeny, p).toBe(true);
    }
    // 保护路径的硬拒在写工具这一层(checkWritePath,任何档 / 任何 run 都一样;闸只管要不要问人)
    const out = await HOST_TOOLS.write_file.execute({ path: '.GIT/hooks/pre-commit', content: 'x' }, remote);
    expect(out).toMatch(/^Error/);
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    // 负对照:普通源码照写;.gitignore 这类独立段名不误伤
    expect(checkWritePath(remote, join(repo, 'src', 'a.ts'))).toMatchObject({ ok: true });
    expect(checkWritePath(remote, join(repo, '.GITIGNORE')).hardDeny).toBe(false);
  });

  it.skipIf(!foldCase)('同一类大小写绕过:~/.SSH、自己的 Soul.md 也是保护路径(修复前:按字面比,放行 / 只升越界审批)', () => {
    expect(checkWritePath(ctxOf(repo), join(homedir(), '.SSH', 'authorized_keys')).hardDeny).toBe(true);
    enterRunContext('u', 'r-fold', 'foldbot', 'foldbot');
    const agentDir = join(home, 'agents', 'foldbot');
    expect(checkWritePath(ctxOf(repo), join(agentDir, 'Soul.md')).hardDeny).toBe(true);
    expect(checkWritePath(ctxOf(repo), join(agentDir, 'CONFIG.toml')).hardDeny).toBe(true);
    expect(checkWritePath(ctxOf(repo), join(agentDir, 'Library', 'soul.md')).ok).toBe(true); // 负对照:Library 里同名笔记照写
  });
});

describe('E9 通道发文件过 C4 读闸', () => {
  const tool = (name: string) => channelToolsProvider.tools().find((t) => t.name === name)!;
  it('channel_send_file / channel_send_image 发凭据文件一律拒、一个字节都不发(修复前:原样发给通道对端)', async () => {
    sent.calls.length = 0;
    const ctx = ctxOf(home, { channelSession: true } as any);
    expect(await tool('channel_send_file').execute({ path: join(home, 'auth.json') }, ctx)).toMatch(/^Error: Access denied/);
    expect(await tool('channel_send_image').execute({ path: 'link/auth.json' }, ctxOf(repo))).toMatch(/^Error: Access denied/);
    expect(await tool('channel_send_file').execute({ path: join(appData, 'Forsion', 'remotesync.json') }, ctx)).toMatch(/^Error: Access denied/);
    expect(sent.calls).toHaveLength(0);
    // 负对照:普通文件照发
    expect(await tool('channel_send_file').execute({ path: join(home, 'notes.txt') }, ctx)).not.toMatch(/^Error/);
    expect(sent.calls).toHaveLength(1);
  });
});

describe('E4 保护路径段的平台口径(纯函数:Linux CI 上也跑,Codex 第三轮评审 P3)', () => {
  it('darwin / win32 折叠大小写;win32 另吞段尾点与空格;linux 原样', async () => {
    const { metadataSegment } = await import('../src/tools/fsPolicy.js');
    expect(metadataSegment('.GIT', 'darwin')).toBe('.git');
    expect(metadataSegment('.Git', 'win32')).toBe('.git');
    expect(metadataSegment('.git.', 'win32')).toBe('.git');
    expect(metadataSegment('.GIT . ', 'win32')).toBe('.git');
    expect(metadataSegment('.AGENTS', 'darwin')).toBe('.agents');
    expect(metadataSegment('.GIT', 'linux')).toBe('.GIT'); // Linux 大小写敏感:.GIT 是另一个目录
    expect(metadataSegment('.git.', 'darwin')).toBe('.git.'); // 吞尾点只在 Windows
    expect(metadataSegment('.gitignore', 'darwin')).toBe('.gitignore');
  });
});
