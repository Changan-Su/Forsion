/**
 * 每次都问(capabilities.approval:'always')的工具绝不进无人值守排队:闸门在 deferApproval 之前就拒。
 * 收件箱卡 / Muse 清单因此只会见到命令 / 路径类预览 —— 账号动作与发布网页的本地化预览(previewI18n)只用在实时卡上,
 * 排队行不存它。这条一松,排队行就会出现只有英文的散文预览,而且是替用户花钱 / 公开发布的动作。
 */
import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ publish: vi.fn(async () => 1), defer: vi.fn(async () => ({ action: 'reject' as const })) }));
vi.mock('./eventBus.js', () => ({ publish: state.publish }));
vi.mock('../hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
// 单测里没装内置工具,只把这两件答成 always(与 webPublish.ts / forsionAccount.ts 的声明一致)
vi.mock('../tools/toolRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../tools/toolRegistry.js')>()),
  declaredApproval: (name: string) => (name === 'publish_web_page' || name === 'forsion_account_action' ? 'always' : undefined),
}));
vi.mock('./pendingApprovals.js', () => ({ deferApproval: state.defer }));

import { gateToolCall } from './approvals.js';
import type { ToolCall } from '../core/types.js';

const call = (name: string, args: unknown): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

describe('每次都问的工具不进无人值守排队', () => {
  it.each([
    ['publish_web_page', 'queue', { path: '/tmp/tea.html', slug: 'tea-signup' }],
    ['publish_web_page', 'agent', { path: '/tmp/tea.html', slug: 'tea-signup' }],
    ['forsion_account_action', 'queue', { action: 'use_reset_card' }],
    ['forsion_account_action', 'agent', { action: 'use_reset_card' }],
  ] as const)('%s × approvalDeferral=%s → 闸门直接拒,不排队、不发卡', async (name, deferral, args) => {
    const d = await gateToolCall('aq1', call(name, args), { sessionId: 'aq-s1', execMode: 'host', approvalMode: 'full-auto', cwd: '/tmp', approvalDeferral: deferral });
    expect(d).toMatchObject({ action: 'reject', rejectReason: expect.stringMatching(/cannot run unattended/) });
    expect(state.defer).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });
});
