import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectGitState, formatRuntimeContext, renderTodoState, runVerifyCommand } from './runtimeContext.js';
import { hostSandboxBackend } from '../sandbox/hostSandbox.js';
import type { TodoItem } from '../tools/builtin/todo.js';

const T = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

describe('renderTodoState', () => {
  it('有未完项才注入;空单/全完成 = null(不占 token)', () => {
    expect(renderTodoState([])).toBeNull();
    expect(renderTodoState([T('a', 'completed'), T('b', 'completed')])).toBeNull();
    const s = renderTodoState([T('修 bug', 'completed'), T('写测试', 'in_progress'), T('更新文档', 'pending')])!
    expect(s).toContain('[x] 修 bug')
    expect(s).toContain('[~] 写测试')
    expect(s).toContain('[ ] 更新文档')
  })
})

describe('formatRuntimeContext', () => {
  it('全空 = null;有货则包 <runtime_context> 并声明非用户所写', () => {
    expect(formatRuntimeContext([null, undefined])).toBeNull()
    const s = formatRuntimeContext(['[A]\nx', null, '[B]\ny'])!
    expect(s.startsWith('<runtime_context>')).toBe(true)
    expect(s.endsWith('</runtime_context>')).toBe(true)
    expect(s).toContain('NOT written by the user')
    expect(s).toContain('[A]\nx\n\n[B]\ny')
  })
})

describe('collectGitState(真 git 仓集成)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangu-git-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('非 git 目录 / 无 cwd → null 静默跳过', async () => {
    expect(await collectGitState(undefined)).toBeNull()
    expect(await collectGitState(tmpdir())).toBeNull()
  })

  it('分支 + 脏文件 + 最近提交都在;干净树报 clean', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
    git('init', '-b', 'trunk')
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'hello')
    git('add', '.'); git('commit', '-m', 'first commit')
    const clean = (await collectGitState(dir))!
    expect(clean).toContain('branch: trunk')
    expect(clean).toContain('working tree clean')
    expect(clean).toContain('first commit')
    writeFileSync(join(dir, 'b.txt'), 'dirty')
    const dirty = (await collectGitState(dir))!
    expect(dirty).toContain('dirty files (1)')
    expect(dirty).toContain('b.txt')
  })
})


describe('verification lifecycle and frozen sandbox policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'tangu-verify-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('cancels a verification process tree and reports failure', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const result = runVerifyCommand('sleep 600 & wait', cwd, controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await result).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it.skipIf(!hostSandboxBackend().available)('runs verification within the same workspace boundary', async () => {
    const ctx = { cwd, hostSandbox: { mode: 'workspace-write', network: 'deny' } } as const;
    const inside = join(cwd, 'verified.txt');
    const outside = join(root, 'outside.txt');
    const allowed = await runVerifyCommand(`echo verified > '${inside}'`, cwd, undefined, ctx);
    expect(allowed, allowed.tail).toMatchObject({ ok: true, code: 0 });
    expect(readFileSync(inside, 'utf8').trim()).toBe('verified');
    const denied = await runVerifyCommand(`echo denied > '${outside}'`, cwd, undefined, ctx);
    expect(denied, denied.tail).toMatchObject({ ok: false });
    expect(existsSync(outside)).toBe(false);
  });
});

describe('git state disables executable repository configuration', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tangu-fsmonitor-'));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  it('does not invoke a repository fsmonitor hook, with or without native restrictions', async () => {
    git('init', '-b', 'trunk');
    git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Sandbox fixture');
    writeFileSync(join(cwd, 'file.txt'), 'content'); git('add', '.'); git('commit', '-m', 'fixture');
    const marker = join(cwd, 'hook-invoked');
    const hook = join(cwd, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\necho invoked > '${marker}'\n`, { mode: 0o755 });
    git('config', 'core.fsmonitor', hook);
    git('status', '--porcelain');
    expect(existsSync(marker)).toBe(true); // prove the fixture triggers without our override
    rmSync(marker);
    expect(await collectGitState(cwd)).toContain('branch: trunk');
    expect(existsSync(marker)).toBe(false);
    if (hostSandboxBackend().available) {
      const result = await collectGitState(cwd, { cwd, hostSandbox: { mode: 'workspace-write', network: 'deny' } });
      expect(result).toContain('branch: trunk');
      expect(existsSync(marker)).toBe(false);
    }
  });
});
