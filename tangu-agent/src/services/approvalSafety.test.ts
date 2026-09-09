import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ publish: vi.fn(async () => 1) }));
vi.mock('./eventBus.js', () => ({ publish: state.publish }));
vi.mock('../hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
vi.mock('../tools/toolRegistry.js', () => ({ declaredApproval: vi.fn() }));
import { gateToolCall, resolveApproval } from './approvals.js';
import type { ToolCall } from '../core/types.js';

beforeEach(() => state.publish.mockClear());
const call = (command: string): ToolCall => ({ id: 'safe-regression', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command }) } });

describe('shell approval gate regression (no command execution)', () => {
  for (const approvalMode of ['readonly', 'auto-edit'] as const) {
    it(`${approvalMode} asks before wrapper/find/git mutation commands`, async () => {
      for (const [index, command] of ['env touch /tmp/not-executed', 'find /tmp -delete', 'git branch -D unused', 'git remote add unused https://example.invalid/repo'].entries()) {
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
    await expect(gateToolCall('safe-ls', call('ls -la'), { sessionId: 'approval-safety', execMode: 'host', approvalMode: 'readonly' })).resolves.toEqual({ action: 'approve' });
    expect(state.publish).not.toHaveBeenCalled();
  });
});
