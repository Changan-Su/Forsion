import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { checkWritePath, isOutsideWorkspace } from '../src/tools/fsPolicy.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';
import { enterRunContext } from '../src/seams/runContext.js';

const ctx = (cwd: string, extraRoots?: string[]) => ({ cwd, extraRoots } as any);
const ws = path.resolve('/tmp/forsion-ws-test');

describe('fsPolicy.checkWritePath', () => {
  it('allows writes inside the workspace root', () => {
    expect(checkWritePath(ctx(ws), path.join(ws, 'a/b.ts'))).toEqual({ ok: true, hardDeny: false, reason: '' });
  });

  it('flags writes outside the workspace as escalation (not hardDeny)', () => {
    const v = checkWritePath(ctx(ws), path.resolve('/tmp/other/x.ts'));
    expect(v.ok).toBe(false);
    expect(v.hardDeny).toBe(false);
  });

  it('hard-denies writes into .git even inside the workspace', () => {
    expect(checkWritePath(ctx(ws), path.join(ws, '.git', 'config')).hardDeny).toBe(true);
  });

  it('hard-denies writes into ~/.ssh', () => {
    expect(checkWritePath(ctx(ws), path.join(os.homedir(), '.ssh', 'id_rsa')).hardDeny).toBe(true);
  });

  it('allows the agent to write its own Library (home is a writable root, no escalation)', () => {
    const lib = path.join(agentsDir(), DEFAULT_AGENT_SLUG, 'Library', 'notes.md');
    expect(checkWritePath(ctx(ws), lib)).toEqual({ ok: true, hardDeny: false, reason: '' });
  });
  it('额外工作文件夹并入可写根:不再判越界写', () => {
    const extra = path.resolve('/tmp/forsion-extra-test');
    expect(checkWritePath(ctx(ws, [extra]), path.join(extra, 'docs/a.md')).ok).toBe(true);
    expect(isOutsideWorkspace(ctx(ws, [extra]), path.join(extra, 'docs/a.md'))).toBe(false);
    // 没加进来的目录照旧升审批
    expect(isOutsideWorkspace(ctx(ws, [extra]), path.resolve('/tmp/nope/a.md'))).toBe(true);
  });

  it('⚠️额外工作文件夹提不了权:受保护路径仍硬拒', () => {
    const ssh = path.join(os.homedir(), '.ssh');
    expect(checkWritePath(ctx(ws, [ssh]), path.join(ssh, 'id_rsa')).hardDeny).toBe(true);
    const repo = path.resolve('/tmp/forsion-extra-test');
    expect(checkWritePath(ctx(ws, [repo]), path.join(repo, '.git', 'config')).hardDeny).toBe(true);
  });

});

describe('agent 身份/自进化文件硬拒(Codex 评审 #1 + 复核软链绕过)', () => {
  // 真实临时 agent 目录(软链测试需要真文件系统)。
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fsp-agent-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('generic 写自己 SOUL.md/config.toml/HARNESS.md/journal → 硬拒;Library/MEMORY 照常可写', () => {
    enterRunContext('u1', 'r1', DEFAULT_AGENT_SLUG, 'testbot');
    for (const f of ['SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md']) {
      // 展示身份与记忆域两个 slug 的目录都拒
      expect(checkWritePath(ctx(ws), path.join(agentsDir(), 'testbot', f)).hardDeny, f).toBe(true);
      expect(checkWritePath(ctx(ws), path.join(agentsDir(), DEFAULT_AGENT_SLUG, f)).hardDeny, `mem:${f}`).toBe(true);
    }
    // 可写根是记忆域 slug 的目录(writableRoots 既有行为):Library/MEMORY 照常
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), DEFAULT_AGENT_SLUG, 'Library', 'n.md')).ok).toBe(true);
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), DEFAULT_AGENT_SLUG, 'MEMORY.md')).ok).toBe(true);
    // 别人的 SOUL 不在此判(manage_agent/用户域):不硬拒
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), 'someone-else', 'SOUL.md')).hardDeny).toBe(false);
  });

  it('软链绕不过:Library 里指向 SOUL.md 的 symlink 照样硬拒', () => {
    const agentDir = path.join(tmp, 'agents', 'linky');
    mkdirSync(path.join(agentDir, 'Library'), { recursive: true });
    writeFileSync(path.join(agentDir, 'SOUL.md'), 'soul');
    symlinkSync('../SOUL.md', path.join(agentDir, 'Library', 'soul-link'));
    const prevHome = process.env.TANGU_HOME;
    process.env.TANGU_HOME = tmp; // agentsDir() → tmp/agents
    try {
      enterRunContext('u1', 'r1', 'linky', 'linky');
      expect(checkWritePath(ctx(ws), path.join(agentDir, 'Library', 'soul-link')).hardDeny).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
    }
  });
});

describe('fsPolicy.isOutsideWorkspace', () => {
  it('true for out-of-workspace, false for in-workspace, false for hardDeny (handled by tool)', () => {
    expect(isOutsideWorkspace(ctx(ws), path.resolve('/tmp/other/x.ts'))).toBe(true);
    expect(isOutsideWorkspace(ctx(ws), path.join(ws, 'x.ts'))).toBe(false);
    expect(isOutsideWorkspace(ctx(ws), path.join(os.homedir(), '.ssh', 'k'))).toBe(false); // hardDeny ≠ escalation
  });
});
