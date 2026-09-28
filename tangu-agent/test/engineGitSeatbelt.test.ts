/**
 * P1 · G5 方案 B(docs/remote-bash-protected-paths.md「方案 B」):远程命令能在工作区仓库的 `.git` 里摆 git 会替人跑的程序
 * (filter / fsmonitor / post-index-change 钩子 / …),本机一条看似无害的 git 读命令就以用户身份执行它。
 *   ① 分类器(各平台):仓库级配置(含已检出的子模块、.gitmodules 没登记的嵌套仓)配了这类程序 → `git status` 不再免审批;干净的仓库、
 *      worktree、子模块照旧免审批;闸门对免审批的 git 给 writeProtect,别的 known-safe 程序不给。
 *   ② 执行(仅 macOS,真 sandbox-exec):项目详情面板的 git(runGit 不带 ctx)与闸门放行的 git 读命令都套写拒绝 profile,
 *      摆下的 filter 改不动 config.json;面板照常出仓库信息。
 * 负对照(实跑见方案 B 交付报告):去掉 isKnownSafeBash 里的 repoGitPrograms 判定 → ① 的「配置了」各条红;
 *   去掉 runGit 的 writeProtectShell → ② 面板那条红。
 * 跑:cd tangu-agent && npx vitest run test/engineGitSeatbelt.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: vi.fn(async () => 1) }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isKnownSafeBash } from '../src/services/approvals.js';
import { repoGitPrograms, indexGitlinks } from '../src/services/gitRepoPrograms.js';
import { gitSummary } from '../src/services/projectContext.js';
import { prepareHostCommand, hostSandboxBackend } from '../src/sandbox/hostSandbox.js';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { configFile } from '../src/core/tanguHome.js';
import type { ToolCall } from '../src/core/types.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const seatbelt = process.platform === 'darwin' && hostSandboxBackend().available;
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'TANGU_HOME', 'GIT_CONFIG_PARAMETERS'] as const;
const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const CFG0 = JSON.stringify({ remote: { maxApprovalMode: 'auto-edit' } });
const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

let base: string;
let cfgPath: string;
let payload: string;

const G = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', '-c', 'advice.addEmbeddedRepo=false'];
const git = (cwd: string, ...a: string[]): string => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8' });
/** 一个有一次提交的干净仓库。 */
function repoAt(dir: string, ...initArgs: string[]): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', ...initArgs);
  writeFileSync(join(dir, 'f.txt'), 'a');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-qm', 'i');
  return dir;
}
const call = (command: string): ToolCall => ({ id: 'c1', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command }) } }) as ToolCall;
let seq = 0;
async function gate(command: string, cwd: string): Promise<{ asked: boolean; decision?: any }> {
  const ac = new AbortController();
  const p = gateToolCall(`EG${++seq}`, call(command), { sessionId: `EG${seq}`, execMode: 'host', approvalMode: 'auto-edit', cwd, profile } as any, ac.signal);
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 200))]);
  if (!settled) { ac.abort(); await p.catch(() => undefined); return { asked: true }; }
  return { asked: false, decision: await p };
}

beforeAll(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-g5b-')));
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.GIT_CONFIG_PARAMETERS;
  process.env.TANGU_HOME = join(base, 'forsion', 'tangu');
  mkdirSync(process.env.TANGU_HOME, { recursive: true });
  cfgPath = configFile();
  writeFileSync(cfgPath, CFG0);
  payload = join(base, 'payload.sh');
  writeFileSync(payload, `cp /dev/null ${q(cfgPath)}; cat\n`);
  configureTangu({ profile } as any);
});
afterEach(() => { writeFileSync(cfgPath, CFG0); });
afterAll(() => {
  for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('① 分类器:仓库配置了 git 会替人跑的程序 → known-safe git 收回(各平台)', () => {
  it('干净仓库照旧免审批;repo 级配置里的各类程序逐条收回;core.fsmonitor=false 不算', () => {
    const dir = repoAt(join(base, 'matrix'));
    expect(repoGitPrograms(dir)).toEqual({ keys: [], engine: [] });
    expect(isKnownSafeBash('git status', dir)).toBe(true);
    const cases: Array<[string, string, boolean]> = [
      ['filter.x.clean', 'sh evil', true], ['filter.x.smudge', 'sh evil', true], ['filter.x.process', 'evil', true],
      ['core.fsmonitor', 'sh evil', false], ['core.hooksPath', '/tmp/hooks', false], ['diff.external', 'evil', false],
      ['diff.bin.textconv', 'evil', false], ['diff.bin.command', 'evil', false], ['core.pager', 'evil', false], ['pager.status', 'evil', false],
      ['gpg.program', 'evil', false], ['gpg.ssh.program', 'evil', false], ['core.sshCommand', 'evil', false], ['credential.helper', 'evil', false],
      ['alias.st', '!sh evil', false], ['core.editor', 'evil', false], ['include.path', '/tmp/x.inc', true], ['includeIf.onbranch:main.path', '/tmp/x.inc', true],
      ['uploadpack.packObjectsHook', 'evil', false], ['hook.pre.command', 'evil', true],
    ];
    for (const [key, value, engine] of cases) {
      git(dir, 'config', key, value);
      const r = repoGitPrograms(dir);
      expect(r, key).not.toBe('unknown');
      expect((r as any).keys.length, key).toBeGreaterThan(0);
      expect((r as any).engine.length > 0, `${key} engine`).toBe(engine);
      expect(isKnownSafeBash('git status', dir), key).toBe(false);
      expect(isKnownSafeBash('git log --oneline', dir), key).toBe(false);
      execFileSync('git', ['config', '--unset-all', key], { cwd: dir });
      expect(isKnownSafeBash('git status', dir), `${key} unset`).toBe(true);
    }
    git(dir, 'config', 'alias.lg', 'log --oneline'); // 非 ! 别名不执行程序
    git(dir, 'config', 'core.fsmonitor', 'false');
    expect(isKnownSafeBash('git status', dir)).toBe(true);
  });

  it('post-index-change 钩子(git status 刷新 index 时会跑,实测)收回;别的钩子(pre-commit)不影响读命令', () => {
    const dir = repoAt(join(base, 'hooks'));
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    expect(isKnownSafeBash('git status', dir)).toBe(true);
    writeFileSync(join(dir, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\n');
    expect(isKnownSafeBash('git status', dir)).toBe(false);
  });

  it('worktree 读的是主仓配置;子模块与 .gitmodules 没登记的嵌套仓按 index 的 gitlink 找(git status 会递归进去,实测)', () => {
    const main = repoAt(join(base, 'wt-main'));
    const wt = join(base, 'wt-linked');
    git(main, 'worktree', 'add', '-q', wt);
    expect(isKnownSafeBash('git status', wt)).toBe(true);
    git(main, 'config', 'filter.x.clean', 'evil');
    expect(isKnownSafeBash('git status', wt)).toBe(false);
    git(main, 'config', '--unset', 'filter.x.clean');

    // 子模块(git submodule add:lib/.git = gitdir: ../.git/modules/lib,那份 config 天生带 core.worktree 指回 lib)
    const lib = repoAt(join(base, 'lib-src'));
    const host = repoAt(join(base, 'sm-host'));
    git(host, 'submodule', 'add', '-q', lib, 'lib');
    expect(isKnownSafeBash('git status', host)).toBe(true);
    expect(isKnownSafeBash('git status', join(host, 'lib'))).toBe(true);
    git(join(host, 'lib'), 'config', 'filter.x.clean', 'evil'); // 写进 .git/modules/lib/config
    expect(isKnownSafeBash('git status', host)).toBe(false);
    git(join(host, 'lib'), 'config', '--unset', 'filter.x.clean');
    expect(isKnownSafeBash('git status', host)).toBe(true);

    // 嵌套仓:`git add sub`(没有 .gitmodules)照样是 gitlink,git status 进去跑它的 filter
    const outer = repoAt(join(base, 'nested'));
    repoAt(join(outer, 'sub'));
    git(outer, 'add', 'sub');
    git(outer, 'commit', '-qm', 'sub');
    expect(indexGitlinks(join(outer, '.git', 'index'))).toEqual(['sub']);
    expect(isKnownSafeBash('git status', outer)).toBe(true);
    git(join(outer, 'sub'), 'config', 'filter.x.clean', 'evil');
    expect(isKnownSafeBash('git status', outer)).toBe(false);
    // index v4(路径前缀压缩)同样认得出
    git(outer, 'update-index', '--index-version', '4');
    expect(indexGitlinks(join(outer, '.git', 'index'))).toEqual(['sub']);
    expect(isKnownSafeBash('git status', outer)).toBe(false);
    git(join(outer, 'sub'), 'config', '--unset', 'filter.x.clean');
    expect(isKnownSafeBash('git status', outer)).toBe(true);
    // 分拆 index(大部分条目在另一个文件里)读不懂 → 收回
    git(outer, 'update-index', '--split-index');
    expect(indexGitlinks(join(outer, '.git', 'index'))).toBe('unknown');
    expect(isKnownSafeBash('git status', outer)).toBe(false);
  });

  it('sha256 仓库的 index 也认得出 gitlink', () => {
    const outer = repoAt(join(base, 'sha256'), '--object-format=sha256');
    repoAt(join(outer, 'sub'), '--object-format=sha256');
    git(outer, 'add', 'sub');
    expect(indexGitlinks(join(outer, '.git', 'index'), 32)).toEqual(['sub']);
    expect(isKnownSafeBash('git status', outer)).toBe(true);
    git(join(outer, 'sub'), 'config', 'filter.x.clean', 'evil');
    expect(isKnownSafeBash('git status', outer)).toBe(false);
  });

  it('环境里的 GIT_CONFIG_PARAMETERS(git 用的配置不止仓库那几份)→ 不免审批', () => {
    const dir = repoAt(join(base, 'envp'));
    process.env.GIT_CONFIG_PARAMETERS = `'filter.x.clean'='evil'`;
    try { expect(isKnownSafeBash('git status', dir)).toBe(false); } finally { delete process.env.GIT_CONFIG_PARAMETERS; }
    expect(isKnownSafeBash('git status', dir)).toBe(true);
  });

  it('闸门:免审批的 git 读命令带 writeProtect;别的 known-safe 程序不带;配置了 filter 的仓库 git status 弹卡', async () => {
    const dir = repoAt(join(base, 'gate'));
    expect(await gate('git status', dir)).toEqual({ asked: false, decision: { action: 'approve', writeProtect: true } });
    expect(await gate('git log --oneline', dir)).toEqual({ asked: false, decision: { action: 'approve', writeProtect: true } });
    expect(await gate('ls', dir)).toEqual({ asked: false, decision: { action: 'approve' } });
    git(dir, 'config', 'filter.x.clean', 'evil');
    expect((await gate('git status', dir)).asked).toBe(true);
  });
});

describe.skipIf(!seatbelt)('② 执行:引擎的 git 与免审批的 git 读命令套写保护(macOS,宿主沙箱关,真 sandbox-exec)', { timeout: 30_000 }, () => {
  /** 仓库 + 摆好的 clean filter(改写 config.json);每次调用前挪 mtime,git status 必须重新 hash → 必走 filter。 */
  function plantedRepo(name: string): { dir: string; touch: () => void } {
    const dir = repoAt(join(base, name));
    git(dir, 'config', 'filter.x.clean', `sh ${payload}`);
    writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(dir, 'f.txt'), 'b');
    const touch = (): void => { const t = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 60_000)); utimesSync(join(dir, 'f.txt'), t, t); };
    touch();
    return { dir, touch };
  }

  it('项目详情面板(runGit 不带 ctx):照常出仓库信息,摆下的 filter 改不动 config.json;不套时这条链是真的', async () => {
    const { dir, touch } = plantedRepo('panel');
    const s = await gitSummary(dir);
    expect(s).toMatchObject({ available: true, repo: true });
    expect(s.changes?.some((c) => c.path === 'f.txt')).toBe(true);
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    touch();
    execFileSync('git', ['status', '--porcelain'], { cwd: dir });
    expect(readFileSync(cfgPath, 'utf8')).toBe(''); // 对照:裸跑就被清空
  });

  it('prepareHostCommand:writeProtectShell 在本机 run 也包成 sandbox-exec;宿主沙箱开时沿用那一档自己的 profile', () => {
    const ctx = { cwd: base } as ToolContext;
    expect(prepareHostCommand(ctx, ['/bin/sh', '-c', 'true']).file).toBe('/bin/sh');
    const p = prepareHostCommand({ ...ctx, writeProtectShell: true }, ['/bin/sh', '-c', 'true']);
    expect(p.file).toBe('/usr/bin/sandbox-exec');
    expect(p.args.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'true']);
    const sb = prepareHostCommand({ ...ctx, writeProtectShell: true, hostSandbox: { mode: 'workspace-write', network: 'deny' } }, ['/bin/sh', '-c', 'true']);
    try { expect(sb.args.join('\n')).toContain('(deny default)'); } finally { sb.cleanup(); }
  });

  it('run_bash 带 writeProtectShell(闸门放行的 known-safe git):filter 改不动 config.json;用户亲手批的(不带)照旧不包', async () => {
    const { dir, touch } = plantedRepo('bash');
    const ctx = { userId: 'u1', sessionId: 'EG', appId: 'test', cwd: dir, execMode: 'host' } as ToolContext;
    const out = await HOST_TOOLS.run_bash.execute({ command: 'git status --porcelain' }, { ...ctx, writeProtectShell: true });
    expect(out).toMatch(/f\.txt/);
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    touch();
    await HOST_TOOLS.run_bash.execute({ command: 'git status --porcelain' }, ctx);
    expect(readFileSync(cfgPath, 'utf8')).toBe(''); // 本机亲手批准的命令:行为不变
  });
});
