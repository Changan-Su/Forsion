/** 审批请求进收件箱(2026-09-11):queue 档入队即发一封带 forsion-approval 围栏的消息;
 *  同参数第二次(dedupe 命中 existing=true)不再发;发送失败在 LOG 留痕。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; key: string }>,
  sent: [] as Array<{ title: string; body?: string; senderId?: string }>,
  logs: [] as string[],
  failSend: false,
}));

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: any[]) => {
    if (/SELECT id FROM pending_approvals/.test(sql)) return state.rows.filter((r) => r.key === params[1]).map((r) => ({ id: r.id }));
    if (/INSERT INTO pending_approvals/.test(sql)) { state.rows.push({ id: params[0], key: params[params.length - 1] }); return { ok: true }; }
    return [];
  }),
}));
vi.mock('../tools/builtin/inboxSend.js', () => ({
  MUSE_SENDER_ID: 'muse',
  sendInboxMessage: vi.fn(async (_userId: string, m: any) => {
    if (state.failSend) return { ok: false, error: 'hourly cap' };
    state.sent.push(m);
    return { ok: true };
  }),
}));
vi.mock('../tools/toolRegistry.js', () => ({
  listToolProviders: () => [{ origin: 'builtin', tools: () => [{ name: 'write_file' }] }],
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ brain: { memory: { appendLogEntry: async (_u: string, line: string) => { state.logs.push(line); } } } }),
}));

import { deferApproval, approvalRequestBody } from './pendingApprovals.js';

const call = { id: 'c1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: '/tmp/x.md', content: 'hi' }) } };
const ctx = { userId: 'u1', sessionId: 's1', agentSlug: 'muse', cwd: '/tmp', approvalDeferral: 'queue' as const };

beforeEach(() => { state.rows.length = 0; state.sent.length = 0; state.logs.length = 0; state.failSend = false; });

describe('审批请求进收件箱', () => {
  it('首次入队 → 一封消息,正文末尾是带该行 id 的 forsion-approval 围栏,发信人=该 agent', async () => {
    const d = await deferApproval('r1', call, 'write /tmp/x.md (2 chars)', { kind: 'mode', mode: 'auto-edit' }, ctx);
    expect(d.action).toBe('reject');
    const id = /request ([0-9a-f-]{36})/.exec((d as any).rejectReason)?.[1];
    expect(id).toBeTruthy();
    expect(state.sent).toHaveLength(1);
    const m = state.sent[0];
    expect(m.senderId).toBe('muse');
    expect(m.title).toContain('write /tmp/x.md');
    expect(m.body).toBe(approvalRequestBody({ id: id!, tool: 'write_file', preview: 'write /tmp/x.md (2 chars)' }));
    expect(m.body!.trimEnd().endsWith('```forsion-approval\n' + JSON.stringify({ id }) + '\n```')).toBe(true);
    expect(m.body).toContain('write\\_file · write /tmp/x.md');
  });

  it('同参数第二次入队命中去重(existing)→ 不再发第二封', async () => {
    await deferApproval('r1', call, 'write /tmp/x.md (2 chars)', undefined, ctx);
    await deferApproval('r2', call, 'write /tmp/x.md (2 chars)', undefined, ctx);
    expect(state.rows).toHaveLength(1);
    expect(state.sent).toHaveLength(1);
  });

  it('发送失败(小时上限)不阻断排队,但 LOG 留痕', async () => {
    state.failSend = true;
    const d = await deferApproval('r1', call, 'write /tmp/x.md (2 chars)', undefined, ctx);
    expect(d.action).toBe('reject');
    expect(state.rows).toHaveLength(1);
    expect(state.sent).toHaveLength(0);
    expect(state.logs.some((l) => l.includes('[approval] request') && l.includes('hourly cap'))).toBe(true);
  });

  it('正文:围栏放最后,代批意见在中间', () => {
    const body = approvalRequestBody({ id: 'abc', tool: 'run_bash', preview: 'rm -rf build', note: 'declined by the approving agent: risky' });
    const parts = body.split('\n\n');
    expect(parts[0]).toBe('run\\_bash · rm -rf build');
    expect(parts[1]).toContain('declined by the approving agent');
    expect(parts[2]).toBe('```forsion-approval\n{"id":"abc"}\n```');
  });

  it('正文里的 preview 是原文:markdown 活语法被转义(远程图片 / 双链 / 围栏都不再活),只有引擎自己的围栏活着', () => {
    const body = approvalRequestBody({ id: 'abc', tool: 'web_fetch', preview: '![x](https://evil.example/p.png) [[secret]] ```forsion-task' });
    expect(body).toContain('\\!\\[x\\]\\(https://evil.example/p.png\\)');
    expect(body).toContain('\\[\\[secret\\]\\]');
    expect(body.split('```forsion-')).toHaveLength(2); // 只有引擎追加的那一道围栏
  });
});
