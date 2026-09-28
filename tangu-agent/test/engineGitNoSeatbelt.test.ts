/**
 * P1 · G5 方案 B 的 Linux / Windows 一半:没有 Seatbelt,引擎自己的 git(runGit:git 现场、项目详情面板)在仓库配了
 * 固定前缀中和不了的程序(filter / include / …)时**不跑**(失败即关),前缀中和得了的(fsmonitor、hooksPath、sshCommand …)照跑。
 * 在 macOS 上把 process.platform 打桩成 'linux' 跑真 git:runGit / prepareHostCommand / engineGitBlocked 都在调用时读 platform,
 * 走的就是非 darwin 那条路(不包 sandbox-exec)。
 * 负对照(实跑见方案 B 交付报告):去掉 runGit 开头的 engineGitBlocked → filter 那条红(config.json 被清空);
 *   去掉 gitRepoPrograms classify 的 lfs 分支 → git-lfs 形状那条红。
 * 跑:cd tangu-agent && npx vitest run test/engineGitNoSeatbelt.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectGitState, runGit, EngineGitSkipped } from '../src/services/runtimeContext.js';
import { gitSummary } from '../src/services/projectContext.js';
import { engineGitBlocked } from '../src/services/gitRepoPrograms.js';
import { isKnownSafeBash } from '../src/services/approvals.js';
import { prepareHostCommand } from '../src/sandbox/hostSandbox.js';
import { configFile } from '../src/core/tanguHome.js';

const realPlatform = process.platform;
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'TANGU_HOME', 'GIT_DIR'] as const;
const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const CFG0 = JSON.stringify({ remote: { maxApprovalMode: 'auto-edit' } });
const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;
let base: string;
let cfgPath: string;
let payload: string;

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
function repoAt(name: string): { dir: string; touch: () => void } {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'f.txt'), 'a');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-qm', 'i');
  writeFileSync(join(dir, 'f.txt'), 'b');
  const touch = (): void => { const t = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 60_000)); utimesSync(join(dir, 'f.txt'), t, t); };
  touch();
  return { dir, touch };
}
const host = (dir: string) => ({ cwd: dir, execMode: 'host' as const });

beforeAll(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-g5b-linux-')));
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.TANGU_HOME = join(base, 'forsion', 'tangu');
  mkdirSync(process.env.TANGU_HOME, { recursive: true });
  cfgPath = configFile();
  writeFileSync(cfgPath, CFG0);
  payload = join(base, 'payload.sh');
  writeFileSync(payload, `cp /dev/null ${q(cfgPath)}; cat\n`);
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});
afterEach(() => { writeFileSync(cfgPath, CFG0); });
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe.skipIf(realPlatform === 'win32')('非 darwin(没有 Seatbelt):引擎的 git 遇前缀中和不了的程序就不跑', () => {
  it('打桩生效:非 darwin 不包 sandbox-exec(哪怕 writeProtectShell)', () => {
    const p = prepareHostCommand({ cwd: base, writeProtectShell: true }, ['/bin/sh', '-c', 'true']);
    expect(p.file).toBe('/bin/sh');
  });

  it('干净仓库:git 现场与面板照常;known-safe git 照常(非 darwin 不看 sandbox-exec)', async () => {
    const { dir } = repoAt('clean');
    expect(engineGitBlocked(dir)).toBe(false);
    expect(await collectGitState(dir, host(dir))).toContain('f.txt');
    expect(await gitSummary(dir)).toMatchObject({ available: true, repo: true });
    expect(isKnownSafeBash('git status', dir)).toBe(true);
  });

  it('仓库摆了 clean filter:git 现场不注入(null)、面板显示不可用、runGit 抛 EngineGitSkipped,config.json 不变;裸跑时这条链是真的', async () => {
    const { dir, touch } = repoAt('filter');
    git(dir, 'config', 'filter.x.clean', `sh ${payload}`);
    writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
    touch();
    expect(engineGitBlocked(dir)).toBe(true);
    expect(await collectGitState(dir, host(dir))).toBeNull();
    expect(await gitSummary(dir).catch(() => 'rejected')).toBe('rejected'); // projectContext 吞成 available:false
    await expect(runGit(dir, ['status', '--porcelain'])).rejects.toThrow(EngineGitSkipped);
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    expect(isKnownSafeBash('git status', dir)).toBe(false);
    touch();
    execFileSync('git', ['status', '--porcelain'], { cwd: dir });
    expect(readFileSync(cfgPath, 'utf8')).toBe('');
  });

  it('git-lfs 形状:filter.lfs 在全局配置、仓库配置只有 lfs.extension.*.clean → 同样不跑;裸跑时这条链是真的', async () => {
    // 本机没装 git-lfs:用一个照 git-lfs 行为写的替身 —— 全局 filter.lfs.clean 调起它,它从仓库配置读 lfs.extension.<名>.clean 并执行
    // (真 git-lfs 的 clean 对每个扩展都这么做,见 git-lfs-config 手册)。仓库配置里没有任何 filter.* 键,挡住它的只有 lfs 那一类。
    const fakeLfs = join(base, 'fake-git-lfs.sh');
    writeFileSync(fakeLfs, `cmd=$(git config --get-regexp '^lfs\\.extension\\..*\\.clean$' | head -n1 | cut -d' ' -f2-)\n[ -n "$cmd" ] && exec sh -c "$cmd"\nexec cat\n`);
    const globalCfg = join(base, 'global-lfs.gitconfig');
    writeFileSync(globalCfg, `[filter "lfs"]\n\tclean = sh ${q(fakeLfs)} %f\n\trequired = true\n`);
    const { dir, touch } = repoAt('lfs');
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    try {
      git(dir, 'config', 'lfs.extension.evil.clean', `sh ${payload}`);
      writeFileSync(join(dir, '.gitattributes'), '* filter=lfs\n');
      touch();
      expect(engineGitBlocked(dir)).toBe(true);
      expect(await collectGitState(dir, host(dir))).toBeNull();
      expect(await gitSummary(dir).catch(() => 'rejected')).toBe('rejected');
      expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
      expect(isKnownSafeBash('git status', dir)).toBe(false);
      touch();
      execFileSync('git', ['status', '--porcelain'], { cwd: dir });
      expect(readFileSync(cfgPath, 'utf8')).toBe('');
    } finally { process.env.GIT_CONFIG_GLOBAL = '/dev/null'; }
  });

  it('子模块 / 嵌套仓里的 filter 同样挡住(git status 会递归进去)', async () => {
    const { dir } = repoAt('outer');
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q'); writeFileSync(join(sub, 'g.txt'), 'a'); git(sub, 'add', 'g.txt'); git(sub, 'commit', '-qm', 'i');
    git(dir, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub');
    expect(engineGitBlocked(dir)).toBe(false);
    git(sub, 'config', 'filter.x.clean', `sh ${payload}`);
    expect(engineGitBlocked(dir)).toBe(true);
    expect(await collectGitState(dir, host(dir))).toBeNull();
  });

  it('前缀中和得了的(fsmonitor / hooksPath / sshCommand / credential)照跑,且确实没被执行', async () => {
    const { dir } = repoAt('neutral');
    const marker = join(base, 'fsmonitor-ran');
    git(dir, 'config', 'core.fsmonitor', `touch ${q(marker)}; false`);
    git(dir, 'config', 'core.sshCommand', 'evil');
    git(dir, 'config', 'credential.helper', 'evil');
    writeFileSync(join(dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch ${q(marker)}\n`);
    execFileSync('chmod', ['+x', join(dir, '.git', 'hooks', 'post-index-change')]);
    expect(engineGitBlocked(dir)).toBe(false);
    expect(await collectGitState(dir, host(dir))).toContain('f.txt');
    expect(existsSync(marker)).toBe(false);
    expect(isKnownSafeBash('git status', dir)).toBe(false); // 模型的裸 git 没有前缀:分类器照样收回
  });

  it('发现落在不受保护的 git 目录(工作区里摆出的 HEAD 布局)→ 不跑;环境里的 GIT_DIR 不影响引擎(runGit 本就剥掉它)', async () => {
    const planted = join(base, 'planted');
    mkdirSync(join(planted, 'objects'), { recursive: true });
    mkdirSync(join(planted, 'refs'), { recursive: true });
    writeFileSync(join(planted, 'HEAD'), 'ref: refs/heads/main\n');
    expect(engineGitBlocked(planted)).toBe(true);
    expect(await collectGitState(planted, host(planted))).toBeNull();
    const { dir } = repoAt('gitdir-env');
    process.env.GIT_DIR = join(base, 'nowhere');
    try {
      expect(engineGitBlocked(dir)).toBe(false);
      expect(await collectGitState(dir, host(dir))).toContain('f.txt');
      expect(isKnownSafeBash('git status', dir)).toBe(false); // 模型的 git 继承这个变量:不认
    } finally { delete process.env.GIT_DIR; }
  });
});
