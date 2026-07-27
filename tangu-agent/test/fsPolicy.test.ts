import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { checkWritePath, isOutsideWorkspace } from '../src/tools/fsPolicy.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';

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

describe('fsPolicy.isOutsideWorkspace', () => {
  it('true for out-of-workspace, false for in-workspace, false for hardDeny (handled by tool)', () => {
    expect(isOutsideWorkspace(ctx(ws), path.resolve('/tmp/other/x.ts'))).toBe(true);
    expect(isOutsideWorkspace(ctx(ws), path.join(ws, 'x.ts'))).toBe(false);
    expect(isOutsideWorkspace(ctx(ws), path.join(os.homedir(), '.ssh', 'k'))).toBe(false); // hardDeny ≠ escalation
  });
});
