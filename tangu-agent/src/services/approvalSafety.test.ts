import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ publish: vi.fn(async () => 1) }));
vi.mock('./eventBus.js', () => ({ publish: state.publish }));
vi.mock('../hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
// canonicalToolName:gateToolCall 入口拿它归一工具名(旧别名不得绕过用户规则),mock 必须给,
// 但本块不测归一(那在 approvalAlias.test.ts),原样返回即可。
vi.mock('../tools/toolRegistry.js', () => ({ declaredApproval: vi.fn(), canonicalToolName: (n: string) => n }));
import { gateToolCall, resolveApproval } from './approvals.js';
import type { ToolCall } from '../core/types.js';

beforeEach(() => state.publish.mockClear());
const call = (command: string): ToolCall => ({ id: 'safe-regression', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command }) } });

describe('shell approval gate regression (no command execution)', () => {
  for (const approvalMode of ['readonly', 'auto-edit'] as const) {
    it(`${approvalMode} asks before wrapper/find/git mutation commands`, async () => {
      const commands = ['env touch /tmp/not-executed', 'find /tmp -delete', 'git branch -D unused', 'git remote add unused https://example.invalid/repo'];
      if (process.platform === 'win32') commands.push('dir /b | more', 'type a.txt,b.txt', 'dir %USERPROFILE%', 'git status', 'findstr /f:files text');
      for (const [index, command] of commands.entries()) {
        state.publish.mockClear();
        const pending = gateToolCall(`approval-${approvalMode}-${index}`, call(command), { sessionId: 'approval-safety', execMode: 'host', approvalMode });
        await vi.waitFor(() => expect(state.publish).toHaveBeenCalledWith(expect.any(String), 'approval_request', expect.objectContaining({ name: 'run_bash' })));
        const request = state.publish.mock.calls.find((args: any[]) => args[1] === 'approval_request') as any;
        expect(resolveApproval(request[2].approvalId, { action: 'reject' })).toBe(true);
        await expect(pending).resolves.toEqual({ action: 'reject' });
      }
    });
  }
  it('keeps simple read-only calls immediate', async () => {
    const commands = process.platform === 'win32' ? ['dir /b "Library"', 'type "Journal\\today.md"', 'dir 2>nul & echo --- & dir /b', 'findstr text file.txt'] : ['ls -la'];
    for (const [index, command] of commands.entries()) {
      await expect(gateToolCall(`safe-read-${index}`, call(command), { sessionId: 'approval-safety', execMode: 'host', approvalMode: 'readonly' })).resolves.toEqual({ action: 'approve' });
    }
    expect(state.publish).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')('Muse ask/agent reads bypass deferred approval without asking a judge', async () => {
    for (const approvalDeferral of ['queue', 'agent'] as const) {
      for (const command of ['dir /b Library 2>nul & echo --- & dir /b Journal', 'cd /d Space && findstr text notes.md']) {
        await expect(gateToolCall(`muse-${approvalDeferral}`, call(command), {
          sessionId: 'muse-read-safety', execMode: 'host', approvalMode: 'auto-edit', approvalDeferral, unattended: true,
        })).resolves.toEqual({ action: 'approve' });
      }
    }
    expect(state.publish).not.toHaveBeenCalled();
  });
});
