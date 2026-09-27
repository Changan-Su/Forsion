/**
 * Codex 评审(09-27 跟进轮)#2:家目录顶层点目录是指向某个 Agent Library 的软链(~/.local → …/agents/x/Library)。
 * 真实路径落在 Library,但 ~/.local/bin 在 PATH 上 —— 别的程序按**字面路径**用它。远程写 ~/.local/bin/tool 必须硬拒。
 * 要在家目录顶层建软链,所以把 os.homedir() 换成临时目录(整份文件单独一个模块图,不影响别的用例)。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/tangu-homelink-${process.pid}-${Date.now()}`);
vi.mock('node:os', async (orig) => {
  const m = await orig<typeof import('node:os')>();
  return { ...m, homedir: () => H, default: { ...(m as any).default, homedir: () => H } };
});

import { checkWritePath } from '../src/tools/fsPolicy.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const REMOTE = { via: 'tunnel' as const, marked: true };
const lib = join(H, '.forsion-dev', 'tangu', 'agents', 'x', 'Library');

beforeAll(() => {
  mkdirSync(join(lib, 'bin'), { recursive: true });
  mkdirSync(join(H, 'proj'), { recursive: true });
  symlinkSync(lib, join(H, '.local'));
  process.env.TANGU_HOME = join(H, '.forsion-dev', 'tangu');
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  rmSync(H, { recursive: true, force: true });
});

describe('家目录点目录软链到 Library', () => {
  it('远程写 ~/.local/bin/tool 硬拒(字面路径在家目录点目录里);直接写 Library 照旧放行', () => {
    const ctx = { userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: join(H, 'proj'), remote: REMOTE } as ToolContext;
    expect(checkWritePath(ctx, join(H, '.local', 'bin', 'tool')).hardDeny).toBe(true);
    expect(checkWritePath({ ...ctx, cwd: lib }, join(lib, 'bin', 'tool'))).toMatchObject({ ok: true, hardDeny: false });
    expect(checkWritePath({ ...ctx, remote: undefined }, join(H, '.local', 'bin', 'tool')).hardDeny).toBe(false); // 本机不受影响
  });
});
