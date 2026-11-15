/** 交接(底层第 3 步)的工具桥:真 HTTP + 真 MCP 客户端,审批闸和工具执行是假的。
 *  钉的是 11-15 实测得出的几条规矩(方案目录 instrument/acp-bridge-timeout-probe.cjs:DSH 等一次外部工具最多 60 秒,
 *  到点告诉模型失败,桥里的那次却照样跑完)——
 *   · 每次调用在时限内必回:等审批 / 没跑完就回编号,用 forsion_wait 取;工具只执行一次;
 *   · 一轮结束(close)撤掉挂着的审批、不再执行;
 *   · 回调里带上这个 Agent 的记忆域和身份(HTTP 回调不在 run 的异步链上);
 *   · 卡片按 Tangu 的原名发,落库形状同 runLoop;
 *   · 插件任务那条路不画卡、不限时、没有 forsion_wait。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  exec: vi.fn(),
  seen: [] as Array<{ agent?: string; display?: string; cwd?: string }>,
}));
vi.mock('../tools/toolRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../tools/toolRegistry.js')>()),
  resolveTools: () => new Map([
    ['remember', { name: 'remember', definition: { function: { name: 'remember', description: 'Remember a fact.', parameters: { type: 'object', properties: { content: { type: 'string' } } } } } }],
    ['intelligent_ui_html', { name: 'intelligent_ui_html', definition: { function: { name: 'intelligent_ui_html', description: 'Card.', parameters: { type: 'object', properties: {} } } } }],
    ['not_handed', { name: 'not_handed', definition: { function: { name: 'not_handed', description: 'x', parameters: { type: 'object', properties: {} } } } }],
  ]),
}));
vi.mock('../tools/registry.js', async (orig) => ({
  ...(await orig<typeof import('../tools/registry.js')>()),
  executeTool: h.exec,
  toolSourceOf: () => 'builtin',
}));
vi.mock('../services/approvals.js', async (orig) => ({ ...(await orig<typeof import('../services/approvals.js')>()), gateToolCall: h.gate }));
vi.mock('../seams/runtime.js', async (orig) => ({ ...(await orig<typeof import('../seams/runtime.js')>()), deps: () => ({ profile: {} }) }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRunToolServer, WAIT_TOOL } from './toolServer.js';
import { currentAgentSlug, currentDisplayAgentSlug, currentRunCwd } from '../seams/runContext.js';

type Bridge = Awaited<ReturnType<typeof createRunToolServer>>;
let bridge: Bridge | undefined;
let events: Array<{ type: string; payload: any }>;
let ac: AbortController;

async function connect(b: Bridge): Promise<Client> {
  const client = new Client({ name: 'probe', version: '0' });
  const headers = Object.fromEntries(b.server.headers.map((x) => [x.name, x.value]));
  await client.connect(new StreamableHTTPClientTransport(new URL(b.server.url), { requestInit: { headers } }));
  return client;
}
const textOf = (r: any): string => String(r?.content?.[0]?.text ?? '');

async function agentBridge(budgetMs = 150) {
  bridge = await createRunToolServer({ userId: 'u1', sessionId: 'S', runId: 'r1', cwd: '/work/here', approvalMode: 'auto-edit', signal: ac.signal } as any,
    ['remember', 'intelligent_ui_html'], {
      name: 'forsion', memorySlug: 'ds-mem', agentSlug: 'ds', budgetMs,
      cards: { publish: (type, payload) => events.push({ type, payload }), contentOffset: () => 7 },
    });
  return bridge;
}

beforeEach(() => {
  events = []; ac = new AbortController(); h.seen = [];
  h.gate.mockReset(); h.exec.mockReset();
  h.gate.mockResolvedValue({ action: 'approve' });
  h.exec.mockImplementation(async (call: any) => {
    h.seen.push({ agent: currentAgentSlug(), display: currentDisplayAgentSlug(), cwd: currentRunCwd() });
    return { toolCallId: call.id, name: call.function.name, result: `did ${call.function.arguments}`, isError: false };
  });
});
afterEach(async () => { await bridge?.close().catch(() => {}); bridge = undefined; });

describe('交接的工具桥', () => {
  it('列出交过去的工具和 forsion_wait;快的调用当场回结果,卡片按原名发,落库形状同 runLoop', async () => {
    const b = await agentBridge(2_000);
    expect(b.toolPrefix).toBe('mcp__forsion__');
    const c = await connect(b);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['remember', 'intelligent_ui_html', WAIT_TOOL]);
    const r = await c.callTool({ name: 'remember', arguments: { content: 'tea' } });
    expect(textOf(r)).toBe('did {"content":"tea"}');
    // 回调里是这个 Agent 的记忆域 / 身份 / 工作目录:不然 remember 会落到缺省 Agent
    expect(h.seen).toEqual([{ agent: 'ds-mem', display: 'ds', cwd: '/work/here' }]);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
    expect(events[0].payload).toMatchObject({ name: 'remember', arguments: '{"content":"tea"}', source: 'builtin' });
    expect(events[1].payload).toMatchObject({ id: events[0].payload.id, name: 'remember', result: 'did {"content":"tea"}', isError: false });
    expect(b.calls()).toEqual([expect.objectContaining({ id: events[0].payload.id, function: { name: 'remember', arguments: '{"content":"tea"}' }, ui_content_offset: 7 })]);
    expect(b.results()).toEqual([expect.objectContaining({ tool_call_id: events[0].payload.id, name: 'remember', content: 'did {"content":"tea"}', isError: false })]);
    await c.close();
  });

  it('HTML 卡对外叫 sketch(同 runLoop 的线上名)', async () => {
    const c = await connect(await agentBridge(2_000));
    await c.callTool({ name: 'intelligent_ui_html', arguments: {} });
    expect(events.map((e) => e.payload.name)).toEqual(['sketch', 'sketch']);
    expect(bridge!.calls()[0].function.name).toBe('sketch');
    await c.close();
  });

  it('审批等过了时限:先回编号;取结果的参数每次不一样;批了之后取到结果,工具只执行一次', async () => {
    let approve!: (d: any) => void;
    h.gate.mockImplementation(() => new Promise((r) => { approve = r; }));
    const c = await connect(await agentBridge(150));
    const first = textOf(await c.callTool({ name: 'remember', arguments: { content: 'x' } }));
    expect(first).toContain('waiting for the user to approve it');
    expect(first).toContain('{"ticket":"T1","attempt":1}');
    const second = textOf(await c.callTool({ name: WAIT_TOOL, arguments: { ticket: 'T1', attempt: 1 } }));
    expect(second).toContain('{"ticket":"T1","attempt":2}'); // DSH 对同参连调会提醒模型收尾,所以每次给新的参数
    expect(h.exec).not.toHaveBeenCalled();
    approve({ action: 'approve' });
    const third = await c.callTool({ name: WAIT_TOOL, arguments: { ticket: 'T1', attempt: 2 } });
    expect(textOf(third)).toBe('did {"content":"x"}');
    expect(h.exec).toHaveBeenCalledTimes(1);
    // 取走了就没了
    const again = await c.callTool({ name: WAIT_TOOL, arguments: { ticket: 'T1', attempt: 3 } });
    expect(again.isError).toBe(true);
    await c.close();
  });

  it('批了但跑得久:编号说「还在跑」,跑完取得到', async () => {
    let finish!: () => void;
    h.exec.mockImplementation(async (call: any) => { await new Promise<void>((r) => { finish = r; }); return { toolCallId: call.id, name: 'remember', result: 'slow done', isError: false }; });
    const c = await connect(await agentBridge(150));
    expect(textOf(await c.callTool({ name: 'remember', arguments: {} }))).toContain('is still running (ticket T1)');
    finish();
    expect(textOf(await c.callTool({ name: WAIT_TOOL, arguments: { ticket: 'T1', attempt: 1 } }))).toBe('slow done');
    await c.close();
  });

  it('拒了:回拒绝原因,卡片记成出错,不执行', async () => {
    h.gate.mockResolvedValue({ action: 'reject', rejectReason: 'Denied by approval rule: remember' });
    const c = await connect(await agentBridge(2_000));
    const r = await c.callTool({ name: 'remember', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Denied by approval rule: remember');
    expect(h.exec).not.toHaveBeenCalled();
    expect(bridge!.results()[0]).toMatchObject({ isError: true });
    await c.close();
  });

  it('一轮结束时还挂着审批:撤掉(审批闸收到中止),不再执行,卡片记成「这一轮结束了」', async () => {
    let gateSignal: AbortSignal | undefined;
    h.gate.mockImplementation((_r: string, _c: any, _ctx: any, signal: AbortSignal) => new Promise((resolve) => {
      gateSignal = signal;
      signal.addEventListener('abort', () => resolve({ action: 'reject', rejectReason: 'aborted' }), { once: true });
    }));
    const c = await connect(await agentBridge(100));
    expect(textOf(await c.callTool({ name: 'remember', arguments: {} }))).toContain('ticket T1');
    await c.close();
    await bridge!.close();
    expect(gateSignal?.aborted).toBe(true);
    expect(h.exec).not.toHaveBeenCalled();
    expect(bridge!.results()).toEqual([expect.objectContaining({ isError: true })]);
    expect(events[events.length - 1]).toMatchObject({ type: 'tool_result', payload: { isError: true } });
  });

  it('一轮结束时工具不听中止、还在跑:当场记成「这一轮结束了」,迟到的结果不再记、不再发(落库的调用都配得上结果)', async () => {
    let finish!: () => void;
    h.exec.mockImplementation(async (call: any) => { await new Promise<void>((r) => { finish = r; }); return { toolCallId: call.id, name: 'remember', result: 'late', isError: false }; });
    const c = await connect(await agentBridge(100));
    expect(textOf(await c.callTool({ name: 'remember', arguments: {} }))).toContain('is still running');
    await c.close();
    await bridge!.close();
    expect(bridge!.results()).toEqual([expect.objectContaining({ tool_call_id: bridge!.calls()[0].id, isError: true, content: expect.stringContaining('Stopped') })]);
    const n = events.length;
    finish(); await new Promise((r) => setTimeout(r, 20));
    expect(bridge!.results()).toHaveLength(1);
    expect(events).toHaveLength(n);
  }, 10_000);

  it('没交的工具调不了', async () => {
    const c = await connect(await agentBridge(2_000));
    await expect(c.callTool({ name: 'not_handed', arguments: {} })).rejects.toThrow();
    await c.close();
  });

  it('插件任务那条路照旧:不画卡、不列 forsion_wait、一直等到结果', async () => {
    bridge = await createRunToolServer({ userId: 'u1', sessionId: 'S', runId: 'r1', signal: ac.signal } as any, ['remember']);
    expect(bridge.server.name).toBe('forsion_task');
    const c = await connect(bridge);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['remember']);
    h.gate.mockImplementation(() => new Promise((r) => setTimeout(() => r({ action: 'approve' }), 300)));
    expect(textOf(await c.callTool({ name: 'remember', arguments: { content: 'p' } }))).toBe('did {"content":"p"}');
    expect(events).toEqual([]);
    expect(bridge.calls()).toEqual([]);
    await c.close();
  });
});
