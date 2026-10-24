/**
 * 散文类审批预览的结构化版(approval_request.previewI18n):桌面卡按界面语言渲染,preview 照旧是英文。
 * 钉三条:两件工具给对键与值;值与英文那句过同一道 previewText(伪装字符不因换了渲染路径漏过去);闸门把它带进事件。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ publish: vi.fn(async () => 1) }));
vi.mock('./eventBus.js', () => ({ publish: state.publish }));
vi.mock('../hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
// 工具自声明「每次都问」走注册表;单测里没装内置工具,只把这一项答成 always
vi.mock('../tools/toolRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../tools/toolRegistry.js')>()),
  declaredApproval: (name: string) => (name === 'publish_web_page' ? 'always' : undefined),
}));

import { approvalPreview, approvalPreviewI18n, gateToolCall, resolveApproval } from './approvals.js';
import type { ToolCall } from '../core/types.js';

const call = (name: string, args: unknown): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

beforeEach(() => state.publish.mockClear());

describe('approvalPreviewI18n', () => {
  it('publish_web_page:发布 / 下线各给一个键,名字缺省取文件名', () => {
    expect(approvalPreviewI18n(call('publish_web_page', { path: 'site/tea-signup.html', slug: 'tea-signup' })))
      .toEqual({ key: 'approval.preview.webPublish', vars: { path: 'site/tea-signup.html', name: 'tea-signup', slug: 'tea-signup' } });
    expect(approvalPreviewI18n(call('publish_web_page', { action: 'unpublish', slug: 'tea-signup' })))
      .toEqual({ key: 'approval.preview.webUnpublish', vars: { slug: 'tea-signup' } });
  });

  it('forsion_account_action:三个动作', () => {
    expect(approvalPreviewI18n(call('forsion_account_action', { action: 'use_reset_card' }))).toEqual({ key: 'approval.preview.resetCard' });
    expect(approvalPreviewI18n(call('forsion_account_action', { action: 'move_quota_to_background', percent: 30 })))
      .toEqual({ key: 'approval.preview.moveQuota', vars: { percent: 30 } });
    expect(approvalPreviewI18n(call('forsion_account_action', { action: 'send_feedback', message: '第一行\n第二行' })))
      .toEqual({ key: 'approval.preview.feedback', vars: { message: '第一行\n第二行' } });
  });

  it('请求无效、命令 / 路径类工具:不给(卡上照旧显示英文 preview)', () => {
    expect(approvalPreviewI18n(call('publish_web_page', { slug: 'x' }))).toBeUndefined();
    expect(approvalPreviewI18n(call('forsion_account_action', { action: 'move_quota_to_background', percent: 0 }))).toBeUndefined();
    expect(approvalPreviewI18n(call('run_bash', { command: 'ls' }))).toBeUndefined();
  });

  it('值与英文 preview 同样转义伪装字符(双向覆写 / 零宽)', () => {
    const c = call('publish_web_page', { path: 'a.html', slug: 'abc', name: 'evil‮txt.exe​' });
    const p = approvalPreviewI18n(c)!;
    expect(p.vars!.name).toBe('evil\\u202Etxt.exe\\u200B');
    expect(approvalPreview(c)).toContain(`"${p.vars!.name}"`);
  });
});

describe('闸门把 previewI18n 带进 approval_request', () => {
  it('publish_web_page(每次都问)带上;preview 仍是英文那句', async () => {
    const c = call('publish_web_page', { path: '/tmp/tea.html', slug: 'tea-signup' });
    const pending = gateToolCall('pi1', c, { sessionId: 'pi-s1', execMode: 'host', approvalMode: 'full-auto', cwd: '/tmp' });
    await vi.waitFor(() => expect(state.publish).toHaveBeenCalledWith('pi1', 'approval_request', expect.anything()));
    const ev = (state.publish.mock.calls.find((a: any[]) => a[0] === 'pi1') as any)[2];
    expect(ev.preview).toBe(approvalPreview(c));
    expect(ev.previewI18n).toEqual({ key: 'approval.preview.webPublish', vars: { path: '/tmp/tea.html', name: 'tea', slug: 'tea-signup' } });
    resolveApproval(ev.approvalId, { action: 'reject' });
    await expect(pending).resolves.toMatchObject({ action: 'reject' });
  });
});
