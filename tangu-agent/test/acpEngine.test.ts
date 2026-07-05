/**
 * 外部引擎 ACP 翻译器单测：喂伪造的 ACP 通知/权限请求，断言映射到 Tangu eventBus 事件 + 审批桥接。
 * 不 spawn 任何进程（createAcpClient 是纯翻译器）。
 */
import { describe, it, expect } from 'vitest';
import { createAcpClient, pickPermissionOption, mapAcpModels, mapAcpCommands, type AcpClientCtx } from '../src/engines/acpEngine.js';
import type { ApprovalDecision } from '../src/services/approvals.js';

type Ev = { type: string; payload: any };

function mkCtx(opts?: {
  approve?: ApprovalDecision;
  aborted?: boolean;
  onApprovalPreview?: (preview: string) => void;
}): { ctx: AcpClientCtx; events: Ev[] } {
  const events: Ev[] = [];
  const ac = new AbortController();
  if (opts?.aborted) ac.abort();
  const ctx: AcpClientCtx = {
    signal: ac.signal,
    publish: (type, payload) => events.push({ type, payload }),
    requestApproval: async (preview) => {
      opts?.onApprovalPreview?.(preview);
      return opts?.approve ?? { action: 'approve' };
    },
  };
  return { ctx, events };
}

const PERMS = [
  { optionId: 'a', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'aa', name: 'Always', kind: 'allow_always' as const },
  { optionId: 'r', name: 'Reject', kind: 'reject_once' as const },
];

describe('createAcpClient — sessionUpdate → Tangu events', () => {
  it('streams agent_message_chunk to token + accumulates content', async () => {
    const { ctx, events } = mkCtx();
    const { client, result } = createAcpClient('Claude Code', ctx);
    await client.sessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } as any);
    await client.sessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } } as any);
    expect(events.filter((e) => e.type === 'token').map((e) => e.payload.delta)).toEqual(['Hello', ' world']);
    expect(result().content).toBe('Hello world');
  });

  it('maps agent_thought_chunk to reasoning', async () => {
    const { ctx, events } = mkCtx();
    const { client, result } = createAcpClient('X', ctx);
    await client.sessionUpdate({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } as any);
    expect(events).toEqual([{ type: 'reasoning', payload: { delta: 'thinking' } }]);
    expect(result().reasoning).toBe('thinking');
  });

  it('tool_call → tool_call event + recorded; tool_call_update(completed) → tool_result with backfilled name', async () => {
    const { ctx, events } = mkCtx();
    const { client, result } = createAcpClient('X', ctx);
    await client.sessionUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', rawInput: { cmd: 'ls' } } } as any);
    await client.sessionUpdate({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file.txt' } }],
      },
    } as any);

    const call = events.find((e) => e.type === 'tool_call')!;
    expect(call.payload).toMatchObject({ id: 't1', name: 'Bash', arguments: JSON.stringify({ cmd: 'ls' }) });
    const res = events.find((e) => e.type === 'tool_result')!;
    expect(res.payload).toMatchObject({ id: 't1', name: 'Bash', result: 'file.txt', isError: false });
    expect(result().toolCalls).toHaveLength(1);
    expect(result().toolResults).toHaveLength(1);
  });

  it('tool_call_update(failed) marks isError; in-progress is ignored', async () => {
    const { ctx, events } = mkCtx();
    const { client } = createAcpClient('X', ctx);
    await client.sessionUpdate({ update: { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'in_progress' } } as any);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(0);
    await client.sessionUpdate({ update: { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', content: [] } } as any);
    expect(events.find((e) => e.type === 'tool_result')!.payload.isError).toBe(true);
  });

  it('usage_update → usage event', async () => {
    const { ctx, events } = mkCtx();
    const { client } = createAcpClient('X', ctx);
    await client.sessionUpdate({ update: { sessionUpdate: 'usage_update', inputTokens: 10, outputTokens: 5, totalTokens: 15 } } as any);
    expect(events).toEqual([{ type: 'usage', payload: { prompt: 10, completion: 5, total: 15 } }]);
  });
});

describe('createAcpClient — requestPermission ↔ Tangu approval', () => {
  it('approve → selects allow_once option', async () => {
    const { ctx } = mkCtx({ approve: { action: 'approve' } });
    const { client } = createAcpClient('Claude Code', ctx);
    const r = await client.requestPermission!({ options: PERMS, toolCall: { toolCallId: 't', title: 'Write', rawInput: { path: 'x' } } } as any);
    expect(r).toEqual({ outcome: { outcome: 'selected', optionId: 'a' } });
  });

  it('approve_always → allow_always; reject → reject_once', async () => {
    const always = createAcpClient('X', mkCtx({ approve: { action: 'approve_always' } }).ctx);
    expect(await always.client.requestPermission!({ options: PERMS, toolCall: {} } as any)).toEqual({ outcome: { outcome: 'selected', optionId: 'aa' } });
    const rej = createAcpClient('X', mkCtx({ approve: { action: 'reject' } }).ctx);
    expect(await rej.client.requestPermission!({ options: PERMS, toolCall: {} } as any)).toEqual({ outcome: { outcome: 'selected', optionId: 'r' } });
  });

  it('builds a human preview from the ACP tool call', async () => {
    let seen = '';
    const { ctx } = mkCtx({ onApprovalPreview: (p) => (seen = p) });
    const { client } = createAcpClient('Claude Code', ctx);
    await client.requestPermission!({ options: PERMS, toolCall: { toolCallId: 't', title: 'Write file', rawInput: { path: 'a.txt' } } } as any);
    expect(seen).toContain('[Claude Code]');
    expect(seen).toContain('Write file');
    expect(seen).toContain('a.txt');
  });

  it('aborted signal → cancelled without prompting the user', async () => {
    let prompted = false;
    const { ctx } = mkCtx({ aborted: true, onApprovalPreview: () => (prompted = true) });
    const { client } = createAcpClient('X', ctx);
    const r = await client.requestPermission!({ options: PERMS, toolCall: {} } as any);
    expect(r).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(prompted).toBe(false);
  });
});

describe('pickPermissionOption — kind matching + fallback', () => {
  it('exact kind match', () => {
    expect(pickPermissionOption(PERMS as any, 'approve')).toBe('a');
    expect(pickPermissionOption(PERMS as any, 'approve_always')).toBe('aa');
    expect(pickPermissionOption(PERMS as any, 'reject')).toBe('r');
  });
  it('falls back to same-family option when exact kind absent', () => {
    const onlyAlways = [{ optionId: 'aa', name: 'Always', kind: 'allow_always' as const }];
    expect(pickPermissionOption(onlyAlways as any, 'approve')).toBe('aa'); // wants allow_once → falls back to allow_*
  });
  it('returns null for empty options', () => {
    expect(pickPermissionOption([], 'approve')).toBeNull();
  });
});

describe('probe mappers — newSession.models / available_commands', () => {
  it('mapAcpModels: modelId→id, name 回退 id, 带 currentModelId', () => {
    const r = mapAcpModels({
      availableModels: [
        { modelId: 'opus', name: 'Claude Opus' },
        { modelId: 'sonnet' }, // 无 name → 用 id
      ],
      currentModelId: 'sonnet',
    });
    expect(r.models).toEqual([
      { id: 'opus', name: 'Claude Opus', description: undefined },
      { id: 'sonnet', name: 'sonnet', description: undefined },
    ]);
    expect(r.currentModelId).toBe('sonnet');
  });
  it('mapAcpModels: 空/缺字段 → 空列表', () => {
    expect(mapAcpModels(undefined)).toEqual({ models: [], currentModelId: undefined });
    expect(mapAcpModels({}).models).toEqual([]);
  });
  it('mapAcpCommands: 取 name/description/input.hint', () => {
    expect(
      mapAcpCommands([
        { name: 'compact', description: 'Compact context', input: { hint: '<focus>' } },
        { name: 'clear' }, // 无 description/input
      ]),
    ).toEqual([
      { name: 'compact', description: 'Compact context', hint: '<focus>' },
      { name: 'clear', description: '', hint: undefined },
    ]);
  });
  it('mapAcpCommands: 空 → []', () => {
    expect(mapAcpCommands(undefined)).toEqual([]);
  });
});
