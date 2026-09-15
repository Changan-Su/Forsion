/**
 * 审批闸门的**工具名归一**(2026-09-15 回归)。旧别名 `muse_watch` → `manage_automation`:
 * executeTool 早就按正典名执行真工具,而 gateToolCall 从前是拿**模型原样吐出的名字**去比对
 * custom 审批规则的 —— 于是模型写别名就能整片绕过用户写的 deny/ask。
 *
 * 为什么这条特别要命:manage_automation 既不是写文件工具也不是跑命令工具、也不声明
 * capabilities.approval,custom 规则是它**唯一**的审批控制 —— 绕过规则 = 完全无人把关。
 * 而 delegate 的 grantTools 新开了「父代理授予、子代理调用管理面工具」这条模型可达的路,
 * 别名因此从「升级瞬间的存量兼容」变成了一条正经的活路径。
 *
 * 判据全在真实的 TOOL_NAME_ALIASES 上(本块**刻意不 mock** toolRegistry:归一表正是被测对象)。
 * 只 mock 配置读取(规则来源)与事件/hook(避免真去等订阅者)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  publish: vi.fn(async () => 1),
  rules: undefined as any,
}));
vi.mock('./eventBus.js', () => ({ publish: state.publish }));
vi.mock('../hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
// 原模块整份透传、只换 getRawSection:config.js 的其它导出还有别人(hostSandboxPolicy 等)在用。
vi.mock('../core/config.js', async (orig) => ({
  ...(await orig<typeof import('../core/config.js')>()),
  getRawSection: (name: string) => (name === 'approval' ? state.rules : undefined),
}));

import { gateToolCall, resolveApproval } from './approvals.js';
import { runHooks } from '../hooks/index.js';
import { currentAgentSlug } from '../seams/runContext.js';
import type { ToolCall } from '../core/types.js';

const call = (name: string): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify({ action: 'list' }) } }) as ToolCall;
const ctx = { sessionId: 'alias-s1', execMode: 'host', approvalMode: 'custom' as const, cwd: '/tmp' };

beforeEach(() => {
  state.publish.mockClear();
  vi.mocked(runHooks).mockClear();
  state.rules = undefined;
});

describe('gateToolCall 先把工具名归一,再比对 custom 规则', () => {
  it('deny 正典名 → 旧别名也被拒(从前:别名放行,真工具照跑)', async () => {
    state.rules = { base: 'auto-edit', deny: ['manage_automation'] };
    // 对照组:正典名本来就被拒。
    await expect(gateToolCall('r1', call('manage_automation'), ctx)).resolves.toEqual({
      action: 'reject', rejectReason: 'Denied by approval rule: manage_automation',
    });
    // 回归点:同一条规则必须挡住别名(executeTool 会把它改写成 manage_automation 去执行)。
    await expect(gateToolCall('r1', call('muse_watch'), ctx)).resolves.toEqual({
      action: 'reject', rejectReason: 'Denied by approval rule: manage_automation',
    });
  });

  it('deny 通配 `manage_*` → 旧别名也被拒(通配是按名字前缀比的,别名根本不以 manage 开头)', async () => {
    state.rules = { base: 'auto-edit', deny: ['manage_*'] };
    const d = await gateToolCall('r2', call('muse_watch'), ctx);
    expect(d.action).toBe('reject');
    expect(d.rejectReason).toBe('Denied by approval rule: manage_*');
  });

  it('ask 正典名 → 旧别名也弹审批,且弹窗里显示的是**真正会执行**的那个名字', async () => {
    state.rules = { base: 'auto-edit', ask: ['manage_automation'] };
    const pending = gateToolCall('r3', call('muse_watch'), ctx);
    await vi.waitFor(() =>
      expect(state.publish).toHaveBeenCalledWith('r3', 'approval_request', expect.objectContaining({ name: 'manage_automation' })),
    );
    const req = state.publish.mock.calls.find((a: any[]) => a[1] === 'approval_request') as any;
    expect(req[2].reason).toEqual({ kind: 'custom-ask', rule: 'manage_automation', mode: 'auto-edit' });
    expect(resolveApproval(req[2].approvalId, { action: 'reject' })).toBe(true);
    await expect(pending).resolves.toEqual({ action: 'reject' });
  });

  it('负对照:没有规则时别名照旧放行(归一没有顺手把它变成「总要审批」)', async () => {
    state.rules = { base: 'auto-edit' };
    await expect(gateToolCall('r4', call('muse_watch'), ctx)).resolves.toEqual({ action: 'approve' });
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('存量规则写的是旧名 muse_watch → 新名与旧名两种调用都被拒(升级不让用户规则静默失效;Codex 09-15 #1)', async () => {
    state.rules = { base: 'auto-edit', deny: ['muse_watch'] };
    await expect(gateToolCall('r6', call('manage_automation'), ctx)).resolves.toEqual({
      action: 'reject', rejectReason: 'Denied by approval rule: muse_watch',
    });
    await expect(gateToolCall('r6', call('muse_watch'), ctx)).resolves.toEqual({
      action: 'reject', rejectReason: 'Denied by approval rule: muse_watch',
    });
  });

  it('存量通配 muse_* 同样挡住两种拼写(通配按每个拼写各试一次前缀)', async () => {
    state.rules = { base: 'auto-edit', deny: ['muse_*'] };
    for (const n of ['manage_automation', 'muse_watch']) {
      const d = await gateToolCall('r7', call(n), ctx);
      expect(d.action, n).toBe('reject');
      expect(d.rejectReason).toBe('Denied by approval rule: muse_*');
    }
    // 负对照:通配不会误伤别的工具(web_fetch 既不是正典名也没有指向它的别名)。
    await expect(gateToolCall('r7', call('web_fetch'), ctx)).resolves.toEqual({ action: 'approve' });
  });

  it('PermissionRequest hook 看到的是**执行身份** execAgentSlug,不是父 run 的 ALS 身份(Codex 09-15 #2)', async () => {
    state.rules = { base: 'auto-edit', ask: ['manage_automation'] };
    const pending = gateToolCall('r8', call('manage_automation'), { ...ctx, execAgentSlug: 'subby' });
    await vi.waitFor(() =>
      expect(runHooks).toHaveBeenCalledWith('PermissionRequest', expect.objectContaining({ tool_name: 'manage_automation', agent_slug: 'subby' }), expect.anything()),
    );
    await vi.waitFor(() => expect(state.publish).toHaveBeenCalledWith('r8', 'approval_request', expect.anything()));
    const req = state.publish.mock.calls.find((a: any[]) => a[1] === 'approval_request') as any;
    resolveApproval(req[2].approvalId, { action: 'reject' });
    await expect(pending).resolves.toEqual({ action: 'reject' });
  });

  it('负对照:没有 execAgentSlug 时 hook 照旧拿 ALS 当前身份(深度 0 主 loop 零变化)', async () => {
    state.rules = { base: 'auto-edit', ask: ['manage_automation'] };
    const pending = gateToolCall('r9', call('manage_automation'), ctx);
    await vi.waitFor(() =>
      expect(runHooks).toHaveBeenCalledWith('PermissionRequest', expect.objectContaining({ agent_slug: currentAgentSlug() }), expect.anything()),
    );
    const hookInput = vi.mocked(runHooks).mock.calls[0][1] as any;
    expect(hookInput.agent_slug).not.toBe('subby');
    await vi.waitFor(() => expect(state.publish).toHaveBeenCalledWith('r9', 'approval_request', expect.anything()));
    const req = state.publish.mock.calls.find((a: any[]) => a[1] === 'approval_request') as any;
    resolveApproval(req[2].approvalId, { action: 'reject' });
    await expect(pending).resolves.toEqual({ action: 'reject' });
  });

  it('非别名的工具名一字不动(归一只认别名表里的那几个)', async () => {
    state.rules = { base: 'auto-edit', ask: ['web_fetch'] };
    const pending = gateToolCall('r5', call('web_fetch'), ctx);
    await vi.waitFor(() =>
      expect(state.publish).toHaveBeenCalledWith('r5', 'approval_request', expect.objectContaining({ name: 'web_fetch' })),
    );
    const req = state.publish.mock.calls.find((a: any[]) => a[1] === 'approval_request') as any;
    resolveApproval(req[2].approvalId, { action: 'reject' });
    await expect(pending).resolves.toEqual({ action: 'reject' });
  });
});
