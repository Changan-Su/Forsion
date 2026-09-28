/**
 * P1 · G5 方案 A(docs/remote-bash-protected-paths.md):宿主沙箱关时,macOS 上远程污点 run 的 shell 套 Seatbelt 写拒绝 profile。
 * 真 sandbox-exec、真 run_bash / run_background / write_process_input 执行面,只在 darwin 上跑(别的平台是方案 C:如实告知,没有这层)。
 *
 * 目录形态照桌面托管:TANGU_HOME = <root>/tangu,共享域 = <root>;HOME 指到一个假家目录(家目录启动项 / 顶层点文件的断言
 * 绝不碰开发机的真 ~/.zshrc);桌面 userData 经 FORSION_AMADEUS_CONFIG 推出,急停锁文件经 FORSION_REMOTE_LOCK_FILE 单独放。
 * root 的目录名里故意带双引号、反斜杠、空格和正则元字符 —— profile 的转义要扛得住。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { startBackgroundProcess, writeStdin, waitForOutput, disposeAllProcesses } from '../src/tools/processRegistry.js';
import { prepareHostCommand, hostSandboxBackend, remoteShellSeatbeltApplies } from '../src/sandbox/hostSandbox.js';
import { renderRemoteShellProfile, ciRegexLiteral, RemoteShellProtectionError } from '../src/sandbox/remoteShellSeatbelt.js';
import { remoteShellWriteDenySpec } from '../src/sandbox/hostSandboxProtection.js';
import { taintRunRemote, clearRunRemoteTaint } from '../src/services/remoteOrigin.js';
import { collectGitState } from '../src/services/runtimeContext.js';
import { configFile } from '../src/core/tanguHome.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const REMOTE = { via: 'tunnel' as const, marked: true };
const seatbelt = process.platform === 'darwin' && hostSandboxBackend().available;
const ENV_KEYS = ['TANGU_HOME', 'HOME', 'FORSION_AMADEUS_CONFIG', 'FORSION_REMOTE_LOCK_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'TANGU_WECHAT_STATE_DIR'] as const;
const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let base: string; // 所有夹具的父目录
let root: string; // 共享域(= 桌面 ~/.forsion)
let home: string; // 假家目录
let ws: string; // 远程会话工作区
let userData: string;
let lockFile: string;
let cfgPath: string;
const CFG0 = JSON.stringify({ remote: { maxApprovalMode: 'auto-edit' } });

const ctxOf = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ userId: 'u1', sessionId: 'G5', appId: 'test', cwd: ws, execMode: 'host', hostSandbox: undefined, ...over }) as ToolContext;
const remoteCtx = (over: Partial<ToolContext> = {}): ToolContext => ctxOf({ remote: REMOTE, ...over });
const bash = (ctx: ToolContext, command: string): Promise<string> => HOST_TOOLS.run_bash.execute({ command }, ctx) as Promise<string>;
const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

beforeAll(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-g5-seatbelt-')));
  root = join(base, 'forsion "q" \\b (x)+[y]^$');
  home = join(base, 'home');
  ws = join(base, 'ws');
  userData = join(home, 'Library', 'Application Support', 'Forsion');
  lockFile = join(base, 'lockdir', 'sub', 'remote-lock.json');
  for (const d of [join(root, 'tangu', 'agents', 'xyra', 'Library'), join(root, 'tangu', 'skills'), home, ws, userData, join(home, '.npm'), join(base, 'lockdir', 'sub')]) mkdirSync(d, { recursive: true });
  process.env.TANGU_HOME = join(root, 'tangu');
  process.env.HOME = home;
  process.env.FORSION_AMADEUS_CONFIG = join(userData, 'amadeus.json');
  process.env.FORSION_REMOTE_LOCK_FILE = lockFile;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.TANGU_WECHAT_STATE_DIR;
  cfgPath = configFile();
});
afterEach(() => { writeFileSync(cfgPath, CFG0); });
afterAll(() => {
  disposeAllProcesses();
  for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('远程 shell 写保护:判定与形态(各平台)', () => {
  it('只在 macOS + 宿主沙箱关 + 远程污点时套;本机 run、宿主沙箱开、Linux / Windows 都不套', () => {
    expect(remoteShellSeatbeltApplies(remoteCtx(), 'darwin')).toBe(true);
    expect(remoteShellSeatbeltApplies(ctxOf(), 'darwin')).toBe(false);
    expect(remoteShellSeatbeltApplies(remoteCtx({ hostSandbox: { mode: 'workspace-write', network: 'deny' } }), 'darwin')).toBe(false);
    expect(remoteShellSeatbeltApplies(remoteCtx(), 'linux')).toBe(false);
    expect(remoteShellSeatbeltApplies(remoteCtx(), 'win32')).toBe(false);
  });

  it('本机 run 的命令形态与改动前逐字相同(沙箱关:原命令,不包)', () => {
    const p = prepareHostCommand(ctxOf(), ['/bin/sh', '-c', 'true']);
    expect({ file: p.file, args: p.args }).toEqual({ file: '/bin/sh', args: ['-c', 'true'] });
  });

  it('路径转义:字母大小写不敏感、正则元字符转义、控制字符拒绝渲染', () => {
    expect(ciRegexLiteral('/a.B')).toBe('/[aA]\\.[bB]');
    expect(ciRegexLiteral('x"y\\z')).toBe('[xX]"[yY]\\\\[zZ]');
    expect(() => ciRegexLiteral('/tmp/a\nb')).toThrow(RemoteShellProtectionError);
    const profile = renderRemoteShellProfile({ ...remoteShellWriteDenySpec(), protectedTrees: ['/tmp/a"b\\c'] });
    // Scheme 字符串里 `"` → `\"`、`\` → `\\`(正则那层的 `\\` 再翻倍)
    expect(profile).toContain('(deny file-write* (regex "^/[tT][mM][pP]/[aA]\\"[bB]\\\\\\\\[cC](/|$)"))');
    expect(profile.startsWith('(version 1)\n(allow default)\n')).toBe(true);
  });
});

describe.skipIf(!seatbelt)('远程 shell 写保护:真 sandbox-exec(仅 macOS)', () => {
  it('远程 run_bash 改 config.json(R3 的执行那一步)被拒:文件不变,输出带 Operation not permitted 与「别换写法重试」说明', async () => {
    writeFileSync(cfgPath, CFG0);
    const out = await bash(remoteCtx(), `printf '%s' '{"remote":{"maxApprovalMode":"full-auto"}}' > ${q(cfgPath)}`);
    expect(out).toMatch(/Operation not permitted/);
    expect(out).toMatch(/exit_code: [1-9]/);
    expect(out).toMatch(/Do not retry them another way/);
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
  });

  it('本机 run 照写不误(没有这层)', async () => {
    const out = await bash(ctxOf(), `printf '%s' local > ${q(cfgPath)}`);
    expect(out).toMatch(/exit_code: 0/);
    expect(readFileSync(cfgPath, 'utf8')).toBe('local');
  });

  it('工作区照常可写:文件、git init + commit', async () => {
    const out = await bash(remoteCtx(), `printf ok > artifact.txt && git init -q && git -c user.name=t -c user.email=t@t add artifact.txt && git -c user.name=t -c user.email=t@t commit -qm init && git log --oneline | wc -l`);
    expect(out).toMatch(/exit_code: 0/);
    expect(readFileSync(join(ws, 'artifact.txt'), 'utf8')).toBe('ok');
    expect(existsSync(join(ws, '.git', 'HEAD'))).toBe(true);
  });

  it('§6.3 名单逐项:引擎 home / 技能 / Agent 配置 / 项目 .tangu / 家目录启动项 / 顶层点文件 / userData / 急停锁文件 / .agents 都写不进;Library 与点目录里面照常可写', async () => {
    const lib = join(root, 'tangu', 'agents', 'xyra', 'Library');
    const denied = [
      join(root, 'auth.json'), join(root, 'provider-auth.json'), join(root, 'tangu', 'skills', 'evil', 'SKILL.md'),
      join(root, 'tangu', 'agents', 'xyra', 'config.toml'), join(root, 'tangu', 'agents', 'other', 'config.toml'),
      join(root, 'tangu', 'plugins', 'x.js'), join(root, 'tangu', 'hooks.json'),
      join(lib, '.tangu', 'skills', 'x', 'SKILL.md'), join(lib, '.zshrc'), join(ws, '.tangu', 'AGENTS.md'), join(ws, '.TANGU', 'x.md'),
      join(ws, '.agents', 'skills', 'x.md'), join(ws, 'dotfiles', '.zshrc'),
      join(home, '.zshrc'), join(home, '.gitconfig'), join(home, '.newdot'), join(home, '.config', 'fish', 'x.fish'),
      join(home, 'Library', 'LaunchAgents', 'evil.plist'), join(home, '.local', 'bin', 'git'), join(home, '.ssh', 'authorized_keys'),
      join(userData, 'remote-sessions.json'), join(home, 'Library', 'Application Support', 'forsion-desktop-dev', 'x.json'), lockFile,
    ];
    for (const f of denied) {
      const out = await bash(remoteCtx(), `mkdir -p ${q(join(f, '..'))} 2>/dev/null; printf x > ${q(f)}`);
      expect(existsSync(f) ? readFileSync(f, 'utf8') : null, `${f} must stay unwritten\n${out}`).not.toBe('x');
    }
    for (const f of [join(lib, 'notes.md'), join(lib, 'sub', 'deep.md'), join(home, '.npm', 'cache-entry'), join(ws, 'src', 'a.ts')]) {
      const out = await bash(remoteCtx(), `mkdir -p ${q(join(f, '..'))} && printf x > ${q(f)}`);
      expect(readFileSync(f, 'utf8'), `${f} must stay writable\n${out}`).toBe('x');
    }
  });

  it('绕路也不行:硬链接到 config.json、把保护路径的祖先整个挪走', async () => {
    const hl = await bash(remoteCtx(), `ln ${q(cfgPath)} hl.json`);
    expect(hl).toMatch(/Operation not permitted/);
    expect(existsSync(join(ws, 'hl.json'))).toBe(false);
    const mv = await bash(remoteCtx(), `mv ${q(join(base, 'lockdir', 'sub'))} ${q(join(base, 'lockdir', 'moved'))}`);
    expect(mv).toMatch(/Operation not permitted/);
    expect(existsSync(join(base, 'lockdir', 'sub'))).toBe(true);
  });

  it('run 中途被远端 steer 染色:下一条命令就套上(按 runId 现查)', async () => {
    const runId = `G5-steer-${Date.now()}`;
    const ctx = ctxOf({ runId });
    try {
      expect(prepareHostCommand(ctx, ['/bin/sh', '-c', 'true']).file).toBe('/bin/sh');
      taintRunRemote(runId, REMOTE);
      expect(prepareHostCommand(ctx, ['/bin/sh', '-c', 'true']).file).toBe('/usr/bin/sandbox-exec');
      const out = await bash(ctx, `printf x > ${q(cfgPath)}`);
      expect(out).toMatch(/Operation not permitted/);
      expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    } finally { clearRunRemoteTaint(runId); }
  });

  it('run_background 同样套上;本机起的进程不收远程 run 的 stdin,远程自己起的照收', async () => {
    const bg = startBackgroundProcess('G5-bg', `printf x > ${q(cfgPath)}; echo done`, ws, remoteCtx({ sessionId: 'G5-bg' }));
    if (typeof bg === 'string') throw new Error(bg);
    await waitForOutput(bg, 0, { idleMs: 300, capMs: 3000 });
    for (let i = 0; i < 50 && bg.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(bg.output).toMatch(/Operation not permitted/);
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);

    const localSh = startBackgroundProcess('G5-bg', '/bin/sh', ws, ctxOf({ sessionId: 'G5-bg' }));
    if (typeof localSh === 'string') throw new Error(localSh);
    const refused = writeStdin('G5-bg', localSh.id, `printf x > ${q(cfgPath)}`, true, remoteCtx({ sessionId: 'G5-bg' }));
    expect(refused).toMatch(/^Error: .*outside the remote-session write protection/);
    expect(writeStdin('G5-bg', localSh.id, '\x03', false, remoteCtx({ sessionId: 'G5-bg' }))).toMatch(/SIGINT/); // 中断照旧放行

    const remoteSh = startBackgroundProcess('G5-bg', '/bin/sh', ws, remoteCtx({ sessionId: 'G5-bg' }));
    if (typeof remoteSh === 'string') throw new Error(remoteSh);
    expect(writeStdin('G5-bg', remoteSh.id, `printf x > ${q(cfgPath)} || echo blocked`, true, remoteCtx({ sessionId: 'G5-bg' }))).toMatch(/^wrote /);
    await waitForOutput(remoteSh, 0, { idleMs: 300, capMs: 3000 });
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
  });

  it('宿主沙箱开:沿用原 profile(deny default),不换成这一层', () => {
    const p = prepareHostCommand(remoteCtx({ hostSandbox: { mode: 'workspace-write', network: 'deny' } }), ['/bin/sh', '-c', 'true']);
    expect(p.args[1]).toMatch(/^\(version 1\)\n\(deny default\)/);
    p.cleanup();
  });

  it('名单渲染失败即关:保护路径带控制字符 → 工具错误,命令没跑', async () => {
    process.env.TANGU_WECHAT_STATE_DIR = join(base, 'bad\ndir');
    try {
      const marker = join(ws, 'ran-anyway');
      const out = await bash(remoteCtx(), `touch ${q(marker)}`);
      expect(out).toMatch(/^Error: This command comes from a remote session/);
      expect(existsSync(marker)).toBe(false);
      const bg = startBackgroundProcess('G5-bad', `touch ${q(marker)}`, ws, remoteCtx({ sessionId: 'G5-bad' }));
      expect(bg).toMatch(/^Error: This command comes from a remote session/);
    } finally { delete process.env.TANGU_WECHAT_STATE_DIR; }
  });

  it('sandbox_apply 失败(引擎自己跑在沙箱里 / 自带沙箱的工具)时附上嵌套沙箱说明', async () => {
    const out = await bash(remoteCtx(), `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`);
    expect(out).toMatch(/sandbox_apply/);
    expect(out).toMatch(/--disable-sandbox/);
  });

  // 方案 A 刻意不拒 `.git`(远程 run 要能 commit / init / clone),于是被批准的远程命令能在工作区仓库里摆 clean filter;
  // 引擎自己在每个 host run 开头收集 git 现场(runtimeContext.collectGitState → runGit),runGit 的固定前缀关了 fsmonitor / hooks /
  // 外部 diff / gpg,没关 filter。远程污点 run(input.remote 或中途 steer 染色的 runId)的这一跑经 prepareHostCommand 套同一层写保护
  // (agentLoop 把 remote / runId 带进 ctx,真 loop 那条见 remoteGitStateSeatbelt.test.ts);本机 run 与项目详情面板不套 —— 残余钉。
  it('远程命令摆进仓库的 clean filter:远程污点(含 steer 染色)的 git 现场收集执行它也改不动 config.json;本机收集照旧执行(残余钉)', async () => {
    const repo = join(base, 'filter-repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'a');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'f.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: repo });
    writeFileSync(cfgPath, CFG0);
    writeFileSync(join(repo, 'payload.sh'), `cp /dev/null ${q(cfgPath)}; cat\n`); // 远程 run 用 write_file 在工作区里就能写
    const plant = await bash(remoteCtx({ cwd: repo }), `git config filter.x.clean ${q(`sh ${join(repo, 'payload.sh')}`)} && printf '* filter=x\\n' > .gitattributes && printf b > f.txt`);
    expect(plant).toMatch(/exit_code: 0/); // 写保护之内:.git/config 与工作区都可写
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    // 同尺寸改内容 + 挪开 mtime:每次 git status 都必须重新 hash f.txt → 必走 clean filter
    const touch = () => { const t = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 60_000)); utimesSync(join(repo, 'f.txt'), t, t); };
    touch();
    expect(await collectGitState(repo, { cwd: repo, execMode: 'host', remote: REMOTE })).toContain('f.txt');
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    taintRunRemote('R-G5-GIT', REMOTE);
    try {
      touch();
      expect(await collectGitState(repo, { cwd: repo, execMode: 'host', runId: 'R-G5-GIT' })).toContain('f.txt');
      expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    } finally { clearRunRemoteTaint('R-G5-GIT'); }
    touch();
    await collectGitState(repo, { cwd: repo, execMode: 'host' });
    expect(readFileSync(cfgPath, 'utf8')).toBe(''); // 残余:本机收集(与项目详情面板)不套,filter 以用户身份执行
  });

  it('git fsmonitor 的子进程继承同一个 profile(R5 执行面的最小复现)', async () => {
    const repo = join(base, 'fsm');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'core.fsmonitor', `cp /dev/null ${q(cfgPath)}; false`], { cwd: repo });
    const out = await bash(remoteCtx({ cwd: repo }), 'git status');
    expect(readFileSync(cfgPath, 'utf8'), out).toBe(CFG0);
  });
});
