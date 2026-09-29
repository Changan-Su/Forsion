/**
 * 仓库自带会执行程序的配置 × 用户信任(Codex 评审 09-27 P0):
 *   - 识别:过滤器 / include → read + write;hooksPath / sshCommand / 凭据助手 / 有执行位的钩子 → write;.sample 与没执行位的钩子不算
 *   - 信任记在宿主家目录,按 git common dir 的 dev/ino + 创建时间绑定:删了重建的同名仓 = 不再信任(Linux 会复用 inode,只比 dev/ino 不够)
 *   - **零点击路径**:打开项目详情就跑的摘要、每个 run 开头的 [Git state],未信任时都不读改动 —— clean 过滤器一次都不跑
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isRepoTrusted, repoConfigRisks, trustRepo, untrustedRisks } from './gitTrust.js';
import { gitSummary } from './projectContext.js';
import { collectGitState } from './runtimeContext.js';

let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const repo = (name: string): string => {
  const p = path.join(root, name); mkdirSync(p, { recursive: true });
  git(p, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(p, 'a.txt'), 'a'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'base');
  return p;
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gittrust-'));
  const globalConfig = path.join(root, 'gitconfig'); writeFileSync(globalConfig, '');
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'home'),
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('repoConfigRisks', () => {
  it('干净的仓 → 没有风险;不是仓 → null', async () => {
    const cwd = repo('clean');
    expect(await repoConfigRisks(cwd)).toMatchObject({ read: [], write: [] });
    const plain = path.join(root, 'plain'); mkdirSync(plain);
    expect(await repoConfigRisks(plain)).toBeNull();
  });

  it('过滤器 / include 是 read 级(也算 write);hooksPath / sshCommand / 凭据助手只算 write', async () => {
    const cwd = repo('risky');
    git(cwd, 'config', 'filter.lfs.clean', 'x');
    git(cwd, 'config', 'include.path', '../elsewhere');
    git(cwd, 'config', 'core.hooksPath', '.husky/_');
    git(cwd, 'config', 'core.sshCommand', 'ssh -i key');
    git(cwd, 'config', 'credential.https://example.com.helper', 'store');
    const risk = (await repoConfigRisks(cwd))!;
    expect(risk.read.sort()).toEqual(['filter.lfs.clean', 'include.path']);
    expect(risk.write).toEqual(expect.arrayContaining(['filter.lfs.clean', 'include.path', 'core.hookspath', 'core.sshcommand', 'credential.https://example.com.helper']));
  });

  it('推送的传输:ext:: 地址、放开协议、远端助手、URL 改写都算 write;worktreeConfig 按 read 级拦(不展开读 config.worktree)', async () => {
    const cwd = repo('transport');
    git(cwd, 'remote', 'add', 'origin', 'ext::sh -c touch% /tmp/x');
    git(cwd, 'config', 'protocol.ext.allow', 'always');
    git(cwd, 'config', 'remote.origin.vcs', 'evil');
    git(cwd, 'config', 'url.ext::sh.insteadOf', 'https://');
    const risk = (await repoConfigRisks(cwd))!;
    expect(risk.write).toEqual(expect.arrayContaining(['protocol.ext.allow', 'remote.origin.vcs', 'url.ext::sh.insteadof']));
    expect(risk.write.some((r) => r.startsWith('remote.origin.url=ext::'))).toBe(true);
    expect(risk.read).toEqual([]);
    const wt = repo('worktree-config');
    git(wt, 'config', 'extensions.worktreeConfig', 'true');
    expect((await repoConfigRisks(wt))!.read).toContain('extensions.worktreeconfig');
  });

  it.skipIf(process.platform === 'win32')('钩子目录:软链一律算(git 跟着它执行);有执行位的真钩子算;.sample 与没执行位的不算', async () => {
    const cwd = repo('hooks');
    const hooks = path.join(cwd, '.git', 'hooks');
    writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\n'); chmodSync(path.join(hooks, 'pre-push'), 0o644);
    const target = path.join(root, 'outside-hook.sh'); writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(target, path.join(hooks, 'pre-commit'));
    const risk = (await repoConfigRisks(cwd))!;
    expect(risk.write).toContain('hooks/post-checkout');
    expect(risk.write).toContain('hooks/pre-commit');
    expect(risk.write.some((r) => r.includes('pre-push') || r.endsWith('.sample'))).toBe(false);
    expect(risk.read).toEqual([]);
  });
});

describe('信任记录', () => {
  it('记在宿主侧、按目录身份绑定:同一路径删掉重建的仓不再被信任', async () => {
    const cwd = repo('identity');
    const common = (await repoConfigRisks(cwd))!.commonDir;
    expect(await isRepoTrusted(common)).toBe(false);
    await trustRepo(common);
    expect(await isRepoTrusted(common)).toBe(true);
    expect(existsSync(path.join(process.env.TANGU_HOME!, 'git-trust.json'))).toBe(true);
    rmSync(path.join(cwd, '.git'), { recursive: true, force: true });
    git(cwd, 'init', '-q');
    expect(await isRepoTrusted(common)).toBe(false);
  });

  it('inode 被复用也不认:dev/ino 相同、创建时间不同 → 不信任;没记创建时间的旧记录同样不认', async () => {
    // Linux(ext4)删掉 .git 立刻重建常复用同一个 inode —— macOS 上复现不出来,这里直接改记录模拟「同 dev/ino、不同目录」
    const cwd = repo('inode-reuse');
    const common = (await repoConfigRisks(cwd))!.commonDir;
    await trustRepo(common);
    expect(await isRepoTrusted(common)).toBe(true);
    const file = path.join(process.env.TANGU_HOME!, 'git-trust.json');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    const key = Object.keys(store.repos).find((k) => k.endsWith(path.join('inode-reuse', '.git')))!;
    store.repos[key].birth += 1;
    writeFileSync(file, JSON.stringify(store));
    expect(await isRepoTrusted(common)).toBe(false);
    delete store.repos[key].birth;
    writeFileSync(file, JSON.stringify(store));
    expect(await isRepoTrusted(common)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('零点击路径:未信任就不读工作区', () => {
  // 合并 P1(G5 方案 B)之后:Linux 没有写保护沙箱,仓库配了会执行的程序时引擎自己的 git 一条都不跑(engineGitBlocked),
  // 信任也不放开 —— 信任按目录身份绑定,挡不住事后被远程命令摆进来的过滤器。macOS 每条套写保护,走下面信任前后两段。
  const engineGitBlocked = process.platform !== 'darwin';
  const evil = (name: string): { cwd: string; marker: string } => {
    const cwd = repo(name);
    const marker = path.join(root, `${name}-filter-ran`);
    git(cwd, 'config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`);
    writeFileSync(path.join(cwd, '.gitattributes'), '*.txt filter=evil\n');
    // 同样大小的改动:只看 stat 判不出来,status 必须把内容过一遍 clean 过滤器 —— 否则「没跑」证明不了什么
    writeFileSync(path.join(cwd, 'a.txt'), 'b');
    return { cwd, marker };
  };

  it('信任判定本身(不依赖平台:Linux 上 G5 整条拦截挡在前面时,下面两条走不到这道闸,由这条钉住):未信任 → read 级风险拦着;信任后放行', async () => {
    const { cwd, marker } = evil('decision');
    expect(await untrustedRisks(cwd, 'read')).toMatchObject({ risks: expect.arrayContaining(['filter.evil.clean']) });
    await trustRepo((await repoConfigRisks(cwd))!.commonDir);
    expect(await untrustedRisks(cwd, 'read')).toBeNull();
    expect(existsSync(marker)).toBe(false); // 判定只读配置,不跑 status
  });

  it('项目详情的摘要:分支 / 提交照读,改动标成未读取,过滤器没跑;信任后才读', async () => {
    const { cwd, marker } = evil('summary');
    if (engineGitBlocked) {
      await expect(gitSummary(cwd)).rejects.toThrow(/Engine git skipped/); // 面板那层吞成 available:false
      await trustRepo((await repoConfigRisks(cwd))!.commonDir);
      await expect(gitSummary(cwd)).rejects.toThrow(/Engine git skipped/);
      expect(existsSync(marker)).toBe(false);
      return;
    }
    const s = await gitSummary(cwd);
    expect(s).toMatchObject({ repo: true, branch: 'main', changesUnread: true, trusted: false });
    expect(s.commits?.[0]?.subject).toBe('base');
    expect(s.configRisks).toContain('filter.evil.clean');
    expect(existsSync(marker)).toBe(false);
    await trustRepo((await repoConfigRisks(cwd))!.commonDir);
    const after = await gitSummary(cwd);
    expect(after.changesUnread).toBeUndefined();
    expect(after.changesTotal).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(true); // 负对照:同一个仓,信任之后 status 确实会跑它
  });

  it('每个 run 开头的 [Git state]:不列脏文件、说明原因,过滤器没跑', async () => {
    const { cwd, marker } = evil('runtime');
    if (engineGitBlocked) {
      expect(await collectGitState(cwd)).toBeNull(); // 整段 [Git state] 不注入
      await trustRepo((await repoConfigRisks(cwd))!.commonDir);
      expect(await collectGitState(cwd)).toBeNull();
      expect(existsSync(marker)).toBe(false);
      return;
    }
    const state = (await collectGitState(cwd))!;
    expect(state).toContain('branch: main');
    expect(state).toContain('working tree: not read');
    expect(state).not.toContain('dirty files');
    expect(existsSync(marker)).toBe(false);
    await trustRepo((await repoConfigRisks(cwd))!.commonDir);
    expect(await collectGitState(cwd)).toMatch(/dirty files \(\d+\)/);
    expect(existsSync(marker)).toBe(true); // 负对照:信任之后同一条路径确实会跑它
  });
});
