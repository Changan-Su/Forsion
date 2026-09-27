/**
 * 审批托盘握手(POST /agent/runs 带 approval_tray → agentLoop 登记 setApprovalTray)下,同 run 的审批
 * 不再串行:桌面把待批卡攒在输入框上方、按 approvalId 各自兑现。没握手的 run(TUI 单槽 / 通道首个决定即退订)
 * 照旧一次只发一张 —— 两条一起钉,免得哪天为了托盘把全局串行摘掉。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ publish: vi.fn(async () => 1) }));
vi.mock('./eventBus.js', () => ({ publish: state.publish }));

import { requestApproval, resolveApproval, setApprovalTray } from './approvals.js';
import type { ToolCall } from '../core/types.js';

const call = (cmd: string): ToolCall =>
  ({ id: cmd, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: cmd }) } }) as ToolCall;
const requests = (runId: string): Array<{ approvalId: string; preview: string }> =>
  state.publish.mock.calls.filter((c: any[]) => c[0] === runId && c[1] === 'approval_request').map((c: any[]) => c[2]);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => state.publish.mockClear());

describe('同 run 多个审批', () => {
  it('没握手的 run:第二张等第一张兑现后才发', async () => {
    const a = requestApproval('r-serial', call('a'), '$ a');
    const b = requestApproval('r-serial', call('b'), '$ b');
    await tick();
    expect(requests('r-serial').map((r) => r.preview)).toEqual(['$ a']);
    resolveApproval(requests('r-serial')[0].approvalId, { action: 'approve' });
    await expect(a).resolves.toEqual({ action: 'approve' });
    await tick();
    expect(requests('r-serial').map((r) => r.preview)).toEqual(['$ a', '$ b']);
    resolveApproval(requests('r-serial')[1].approvalId, { action: 'reject' });
    await expect(b).resolves.toEqual({ action: 'reject' });
  });

  it('托盘 run:一起发出,各自兑现(后发的先批也行)', async () => {
    setApprovalTray('r-tray', true);
    try {
      const a = requestApproval('r-tray', call('a'), '$ a');
      const b = requestApproval('r-tray', call('b'), '$ b');
      await tick();
      const [ra, rb] = requests('r-tray');
      expect([ra?.preview, rb?.preview]).toEqual(['$ a', '$ b']);
      resolveApproval(rb.approvalId, { action: 'approve' });
      await expect(b).resolves.toEqual({ action: 'approve' });
      resolveApproval(ra.approvalId, { action: 'reject' });
      await expect(a).resolves.toEqual({ action: 'reject' });
    } finally {
      setApprovalTray('r-tray', false);
    }
  });

  it('握手随 run 撤销:同一 runId 撤销后又回到串行', async () => {
    setApprovalTray('r-once', true);
    setApprovalTray('r-once', false);
    const a = requestApproval('r-once', call('a'), '$ a');
    void requestApproval('r-once', call('b'), '$ b');
    await tick();
    expect(requests('r-once')).toHaveLength(1);
    resolveApproval(requests('r-once')[0].approvalId, { action: 'reject' });
    await a;
    await tick();
    resolveApproval(requests('r-once')[1].approvalId, { action: 'reject' });
  });
});
