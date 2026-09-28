/**
 * known-safe `git` 只信任「git 的仓库发现落在受保护的 `.git` 上」的仓库(P1 · K10b 评审 finding 2;评估正文
 * docs/remote-bash-protected-paths.md 的 R5)。
 *
 * 洞:isKnownSafeBash 把 git status / log / diff / show / rev-parse / describe 当免审批,但 git 会读**发现到的** git dir 的 config。
 * git 的发现在每一级先看 `D/.git`,再看 `D` 自己像不像 git dir(HEAD + objects/ + refs/)—— 后者可以用普通的结构化写
 * (没有 `.git` 段,auto-edit 下工作区内免审批)摆出来,config 里 core.fsmonitor 写任意命令,`git status` 就在「免审批」名义下执行它。
 * 本机 auto-edit run(被网页 / 文件提示注入)与远程 run 同样中招;远程那条会改写 config.json 的上限档(见 remoteBashProtectedResidual R5)。
 *
 * 负对照:下面标「修复前」的断言在修复前的 approvals.ts 上实跑为红(输出见交付报告)。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: vi.fn(async () => 1) }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isKnownSafeBash } from '../src/services/approvals.js';
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const GIT_ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const prevEnv: Partial<Record<(typeof GIT_ENV_KEYS)[number], string | undefined>> = {};
let base: string;
let marker: string;

const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;
const gitInit = (dir: string, ...extra: string[]): void => {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', ...extra], { cwd: dir, env: process.env });
};
/** 摆一个「看起来像 git dir」的目录:HEAD / config(core.worktree + core.fsmonitor = touch marker)/ objects / refs。 */
function plant(dir: string, worktree: string): void {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'objects', 'keep'), '');
  writeFileSync(join(dir, 'refs', 'keep'), '');
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree}\n\tfsmonitor = "touch '${marker}'; false"\n`);
}
let seq = 0;
/** 本机 run(没有 remote)过一次闸:弹了审批卡就立刻中止。 */
async function gateLocal(c: ToolCall, cwd: string): Promise<{ asked: boolean; action: string }> {
  const ac = new AbortController();
  const runId = `KSG${++seq}`;
  let asked = false;
  const p = gateToolCall(runId, c, { sessionId: `KSG${seq}`, execMode: 'host', approvalMode: 'auto-edit', cwd, profile } as any, ac.signal);
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 200))]);
  if (!settled) { asked = true; ac.abort(); }
  return { asked, action: (await p).action };
}

beforeAll(() => {
  // git 的行为不能由这台机器的 ~/.gitconfig / 系统 gitconfig 决定
  for (const k of GIT_ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-ksg-')));
  marker = join(base, 'FSMONITOR-RAN');
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile, state: { getAgentConfig: async () => null } as any } as any);
});
afterAll(() => {
  for (const k of GIT_ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('known-safe git 只信任落在受保护 .git 上的仓库发现', () => {
  // 只有这条要跑摆进来的 fsmonitor 载荷(POSIX shell 的 touch);其余用例不执行 git 的钩子,Windows 上照跑(path.sep / `.GIT` 折叠)
  it.skipIf(process.platform === 'win32')('实证:摆出来的目录确实被 git 当成 git dir,`git status` 执行了它的 core.fsmonitor', () => {
    const parent = join(base, 'proof');
    const dir = join(parent, 'ws');
    plant(dir, parent);
    const r = spawnSync('git', ['status'], { cwd: dir, env: process.env, encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });

  it('cwd 本身被摆成 git dir(没有 .git 祖先):git status / log / rev-parse / describe / branch / remote 都不免审批(修复前:全部免审批)', () => {
    const parent = join(base, 'a');
    const dir = join(parent, 'ws');
    plant(dir, parent);
    for (const c of ['git status', 'git status --short', 'git log --oneline', 'git rev-parse --show-toplevel', 'git describe']) {
      expect(isKnownSafeBash(c, dir), c).toBe(false);
    }
    // branch / remote 的列表形态同样读这份 config(今天没有探到会执行命令的键,但 log.showSignature + gpg.program 之类
    // 只看 config 的执行点不止 fsmonitor):git 子命令一律按同一份发现判定,不逐个论证(修复前:两个都免审批)
    for (const c of ['git branch --list', 'git remote -v']) expect(isKnownSafeBash(c, dir), c).toBe(false);
  });

  it('真 git 仓里的子目录被摆成 git dir,cwd 在它里面(或更深):不免审批(修复前:免审批);仓根照旧免审批', () => {
    const repo = join(base, 'b');
    gitInit(repo);
    const sub = join(repo, 'sub');
    plant(sub, repo);
    mkdirSync(join(sub, 'deeper'));
    expect(isKnownSafeBash('git status', sub)).toBe(false);
    expect(isKnownSafeBash('git log --oneline', join(sub, 'deeper'))).toBe(false);
    // 负对照:仓根与普通子目录照旧免审批
    mkdirSync(join(repo, 'src'));
    expect(isKnownSafeBash('git status', repo)).toBe(true);
    expect(isKnownSafeBash('git status', join(repo, 'src'))).toBe(true);
    expect(isKnownSafeBash('git diff --no-ext-diff --no-textconv', join(repo, 'src'))).toBe(true);
    expect(isKnownSafeBash('git branch --list', repo)).toBe(true);
    expect(isKnownSafeBash('git remote -v', join(repo, 'src'))).toBe(true);
  });

  it('不在任何仓库里(一路到根都没有 .git 也没有 HEAD):git 只会报「不是仓库」,无参数的读照旧免审批;diff / show / 带路径的照旧要批', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(isKnownSafeBash('git status', plain)).toBe(true); // Tangu 默认文件夹里模型开局常跑,别平白多一张卡
    expect(isKnownSafeBash('git log', plain)).toBe(true);
    expect(isKnownSafeBash('git diff --no-ext-diff --no-textconv', plain)).toBe(false);
    expect(isKnownSafeBash('git log a.txt', plain)).toBe(false);
    // 同一个目录一旦被摆进 HEAD,就不再是「没有仓库」
    writeFileSync(join(plain, 'HEAD'), 'ref: refs/heads/main\n');
    expect(isKnownSafeBash('git status', plain)).toBe(false);
  });

  it('.git 是文件:指向 .git/worktrees/<name>(git worktree)照旧免审批;指向没有 .git 段的目录(--separate-git-dir)不免审批', () => {
    const main = join(base, 'main');
    gitInit(main);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main, env: process.env });
    const wt = join(base, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: main, env: process.env });
    expect(isKnownSafeBash('git status', wt)).toBe(true);
    expect(isKnownSafeBash('git log --oneline', wt)).toBe(true);

    // 子模块:lib/.git 是 `gitdir: ../.git/modules/lib`
    const host = join(base, 'sm-host');
    gitInit(host);
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', main, 'lib'], { cwd: host, env: process.env });
    expect(readFileSync(join(host, 'lib', '.git'), 'utf8')).toMatch(/gitdir: \.\.[\\/]\.git[\\/]modules[\\/]lib/);
    expect(isKnownSafeBash('git status', join(host, 'lib'))).toBe(true);

    // --separate-git-dir:gitdir 落在工作区里一个普通目录 → 结构化写能改它的 config
    const sep = join(base, 'sep');
    mkdirSync(sep);
    execFileSync('git', ['init', '-q', `--separate-git-dir=${join(sep, 'meta')}`, join(sep, 'work')], { env: process.env });
    expect(isKnownSafeBash('git status', join(sep, 'work'))).toBe(false);
  });

  it('.git 目录存在但不是有效的 git dir(缺 HEAD):git 会越过它继续发现,不免审批', () => {
    const odd = join(base, 'odd');
    mkdirSync(join(odd, '.git'), { recursive: true });
    expect(isKnownSafeBash('git status', odd)).toBe(false);
  });

  it('审批闸 · 本机 auto-edit run:摆好的目录里 git status 弹审批卡(修复前:直接放行);真仓根不弹', async () => {
    const parent = join(base, 'gate');
    const dir = join(parent, 'ws');
    plant(dir, parent);
    const planted = await gateLocal(call('run_bash', { command: 'git status' }), dir);
    expect(planted.asked, 'planted git dir: git status must ask').toBe(true);
    const repo = join(base, 'gate-repo');
    gitInit(repo);
    const legit = await gateLocal(call('run_bash', { command: 'git status' }), repo);
    expect(legit.asked).toBe(false);
    expect(legit.action).toBe('approve');
  });
});
