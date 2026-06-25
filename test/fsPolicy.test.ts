import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { checkWritePath, isOutsideWorkspace } from '../src/tools/fsPolicy.js';

const ctx = (cwd: string) => ({ cwd } as any);
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
});

describe('fsPolicy.isOutsideWorkspace', () => {
  it('true for out-of-workspace, false for in-workspace, false for hardDeny (handled by tool)', () => {
    expect(isOutsideWorkspace(ctx(ws), path.resolve('/tmp/other/x.ts'))).toBe(true);
    expect(isOutsideWorkspace(ctx(ws), path.join(ws, 'x.ts'))).toBe(false);
    expect(isOutsideWorkspace(ctx(ws), path.join(os.homedir(), '.ssh', 'k'))).toBe(false); // hardDeny ≠ escalation
  });
});
