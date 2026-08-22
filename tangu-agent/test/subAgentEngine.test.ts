/**
 * 引擎子代理的事件翻译器单测:ACP 引擎事件 → 子聊天区 `subagent` 事件。
 * 关键不变式:一次工具调用只吐一条 phase:'tool'(appStore 每条追加一行,吐两条=重复行)。
 */
import { describe, it, expect } from 'vitest';
import { createEngineEventTranslator } from '../src/services/subAgent.js';

describe('createEngineEventTranslator', () => {
  it('token / reasoning 直通,空 delta 丢弃', () => {
    const t = createEngineEventTranslator('sub-1');
    expect(t('token', { delta: 'hi' })).toEqual({ phase: 'token', subId: 'sub-1', delta: 'hi' });
    expect(t('reasoning', { delta: 'think' })).toEqual({ phase: 'reasoning', subId: 'sub-1', delta: 'think' });
    expect(t('token', { delta: '' })).toBeNull();
  });

  it('tool_call 不出事件,tool_result 合并成唯一一条 tool', () => {
    const t = createEngineEventTranslator('sub-1');
    expect(t('tool_call', { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' })).toBeNull();
    expect(t('tool_result', { id: 'c1', name: 'read_file', result: 'contents', isError: false })).toEqual({
      phase: 'tool', subId: 'sub-1', name: 'read_file', args: '{"path":"a.ts"}', isError: false, preview: 'contents',
    });
  });

  it('对象形态的 arguments 序列化;结果与参数各自截断到 400', () => {
    const t = createEngineEventTranslator('s');
    t('tool_call', { id: 'c1', name: 'x', arguments: { a: 1 } });
    const ev = t('tool_result', { id: 'c1', name: 'x', result: 'y'.repeat(1000) })!;
    expect(ev.args).toBe('{"a":1}');
    expect(ev.preview).toHaveLength(400);
  });

  it('没配对的 tool_result 也出事件(args 空),且参数用后即清不串到下一次', () => {
    const t = createEngineEventTranslator('s');
    expect(t('tool_result', { id: 'ghost', name: 'x', result: 'r' })).toMatchObject({ args: '', name: 'x' });
    t('tool_call', { id: 'c1', name: 'x', arguments: '{"k":1}' });
    expect(t('tool_result', { id: 'c1', name: 'x', result: 'r' })!.args).toBe('{"k":1}');
    expect(t('tool_result', { id: 'c1', name: 'x', result: 'r' })!.args).toBe('');
  });

  it('isError 透传;usage/status 等子聊天区不渲染的事件丢弃', () => {
    const t = createEngineEventTranslator('s');
    t('tool_call', { id: 'c1', name: 'bash', arguments: '{}' });
    expect(t('tool_result', { id: 'c1', name: 'bash', result: 'boom', isError: true })!.isError).toBe(true);
    expect(t('usage', { prompt: 10 })).toBeNull();
    expect(t('status', { detail: 'x' })).toBeNull();
  });
});

// ── 接线级:delegate 的 engine 参数面 + 引擎子代理真的把任务交给 engines.run ──
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions, executeTool, type ToolContext } from '../src/tools/registry.js';
import { runSubAgent } from '../src/services/subAgent.js';
import { delegateProvider } from '../src/tools/builtin/delegate.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

type FakeEngine = { id: string; name: string; available: boolean };

/** 装一套最小 deps:state 只收事件(publish 走 appendEvent,免起 DB),engines 名册/结果可控。 */
function setup(opts: { engines?: FakeEngine[]; run?: (ctx: any) => any } = {}) {
  const events: Array<{ type: string; payload: any }> = [];
  const runCalls: any[] = [];
  const engines = opts.engines;
  configureTangu({
    profile,
    brain: stub,
    store: stub,
    state: { appendEvent: async (_r: string, type: string, payload: any) => { events.push({ type, payload }); return events.length; }, drain: async () => {} } as any,
    ...(engines ? {
      engines: {
        list: () => engines.map((e) => ({ id: e.id, name: e.name, available: e.available, status: e.available ? 'available' : 'not-installed' })),
        has: (id: string) => engines.some((e) => e.id === id),
        capabilities: async () => ({ models: [], commands: [] }),
        setDefaultModel: () => {},
        run: async (ctx: any) => { runCalls.push(ctx); return opts.run ? opts.run(ctx) : { content: 'engine says done' }; },
        dispose: async () => {},
      } as any,
    } : {}),
  } as any);
  return { events, runCalls };
}

function hostCtx(over: Partial<ToolContext> = {}): ToolContext {
  return { userId: 'u', sessionId: 's', appId: 'tangu', execMode: 'host', cwd: '/work', profile, modelId: 'm1', runId: 'r1', ...over } as ToolContext;
}

function delegateDef(): any {
  return getToolDefinitions(hostCtx()).find((t: any) => t.function?.name === 'delegate');
}

describe('delegate 的 engine 参数面', () => {
  it('没有可用引擎时不暴露 engine(工具定义与改动前逐字节一致)', () => {
    setup();
    expect(delegateDef()?.function.parameters.properties.engine).toBeUndefined();
    setup({ engines: [{ id: 'codex', name: 'Codex', available: false }] });
    expect(delegateDef()?.function.parameters.properties.engine).toBeUndefined();
  });

  it('有可用引擎时 engine 追加在 properties 末尾,enum = 已登录的那些', () => {
    setup({ engines: [
      { id: 'claude-code', name: 'Claude Code', available: true },
      { id: 'codex', name: 'Codex', available: false },
    ] });
    const props = delegateDef()!.function.parameters.properties;
    expect(props.engine.enum).toEqual(['claude-code']);
    expect(Object.keys(props).at(-1)).toBe('engine'); // append-only:老参数字节位置不动
  });
});

describe('引擎子代理', () => {
  it('把契约+任务交给 engines.run,结论原样回父上下文,子聊天区收到 start/tool/done', async () => {
    const { events, runCalls } = setup({
      engines: [{ id: 'codex', name: 'Codex', available: true }],
      run: (ctx: any) => {
        ctx.publish('token', { delta: 'working' });
        ctx.publish('tool_call', { id: 't1', name: 'bash', arguments: '{"cmd":"ls"}' });
        ctx.publish('tool_result', { id: 't1', name: 'bash', result: 'a.ts' });
        return { content: 'the report' };
      },
    });
    const out = await runSubAgent({ task: 'audit the parser', parentCtx: hostCtx(), modelId: 'm1', engineId: 'codex' });

    expect(out).toBe('the report');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({ engineId: 'codex', sessionId: 's', userId: 'u', cwd: '/work' });
    // ACP 无 system 位:子代理契约必须随正文一起过去,否则外部 agent 不知道要交自洽终稿
    expect(runCalls[0].message).toContain('audit the parser');
    expect(runCalls[0].message).toContain('self-contained final report');

    const sub = events.filter((e) => e.type === 'subagent').map((e) => e.payload.phase);
    expect(events.some((e) => e.type === 'subchat')).toBe(true);
    expect(sub).toEqual(['start', 'token', 'tool', 'done']); // 一次工具调用只一条 tool
  });

  it('引擎失败也收尾 done(否则子聊天区那条永远转圈)', async () => {
    const { events } = setup({
      engines: [{ id: 'codex', name: 'Codex', available: true }],
      run: () => { throw new Error('spawn failed'); },
    });
    await expect(runSubAgent({ task: 't', parentCtx: hostCtx(), modelId: 'm1', engineId: 'codex' })).rejects.toThrow('spawn failed');
    expect(events.filter((e) => e.type === 'subagent').map((e) => e.payload.phase)).toEqual(['start', 'done']);
  });
});

describe('delegate 的引擎前置闸', () => {
  const call = (args: any, ctx: ToolContext) =>
    executeTool({ id: 'x', type: 'function', function: { name: 'delegate', arguments: JSON.stringify(args) } } as any, ctx);

  it('未知/未登录引擎 → 报错并列出可用 id,不 spawn', async () => {
    const { runCalls } = setup({ engines: [{ id: 'codex', name: 'Codex', available: true }] });
    const r = await call({ task: 't', engine: 'gemini' }, hostCtx());
    expect(r.result).toContain('codex');
    expect(r.isError).toBe(true);
    expect(runCalls).toHaveLength(0);
  });

  // 直接打 execute:executeTool 外层会把一切异常收成 ToolResult,而这里要验的正是「有没有抛出去」——
  // 抛出去 registry 才能按 scopedCtx.signal 判定「超时」并给出可操作文案;吞成字符串就变成一条普通结论。
  const rawExecute = (args: any, ctx: ToolContext) => delegateProvider.tools()[0].execute(args, ctx);

  it('引擎路径的中止必须重抛:它的 message 不是自有 loop 那个 aborted 字面量,只能按信号态判', async () => {
    setup({ engines: [{ id: 'codex', name: 'Codex', available: true }], run: () => { throw new Error('Query closed before response received'); } });
    const ac = new AbortController();
    ac.abort();
    await expect(rawExecute({ task: 't', engine: 'codex' }, hostCtx({ signal: ac.signal }))).rejects.toThrow(/Query closed/);
    // 对照:信号没中止 → 引擎的普通失败仍收成结论串,不往上抛
    setup({ engines: [{ id: 'codex', name: 'Codex', available: true }], run: () => { throw new Error('spawn failed'); } });
    await expect(rawExecute({ task: 't', engine: 'codex' }, hostCtx())).resolves.toContain('spawn failed');
  });

  it('无 runId(无人值守 run)→ 拒绝:引擎的审批请求没人应答会永久挂起', async () => {
    const { runCalls } = setup({ engines: [{ id: 'codex', name: 'Codex', available: true }] });
    const r = await call({ task: 't', engine: 'codex' }, hostCtx({ runId: undefined }));
    expect(r.result).toContain('interactive run');
    expect(runCalls).toHaveLength(0);
  });
});
