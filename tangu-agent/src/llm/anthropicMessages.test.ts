import { describe, it, expect, afterEach, vi } from 'vitest';
import { openaiToAnthropicBody, streamAnthropicMessages } from './anthropicMessages.js';

describe('openaiToAnthropicBody', () => {
  it('lifts role:system to the top level verbatim — no injected client identity block', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'system', content: 'BE NICE' },
        { role: 'user', content: 'hi' },
      ],
    });
    // 回归闸:订阅 OAuth 分支(强制首块「You are Claude Code…」冒充官方 CLI)已于 2026-07-31 删除。
    // 这条断言的作用是让它加回来时立刻红,而不是悄悄多一块 system。
    expect(body.system).toEqual([{ type: 'text', text: 'BE NICE' }]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('converts assistant tool_calls → tool_use and coalesces tool results into one user turn', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'read a' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'FILE BODY' },
        { role: 'tool', tool_call_id: 't1b', content: 'SECOND' },
      ],
    });
    const asst = body.messages.find((m: any) => m.role === 'assistant');
    expect(asst.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } },
    ]);
    const toolUser = body.messages[body.messages.length - 1];
    expect(toolUser.role).toBe('user');
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'FILE BODY' },
      { type: 'tool_result', tool_use_id: 't1b', content: 'SECOND' },
    ]);
  });

  it('maps OpenAI tools → input_schema and tool_choice vocab', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }],
      tool_choice: 'auto',
    });
    expect(body.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });
});

describe('用户自有 API key 路径', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('无系统提示时整个 system 字段不发(别塞空数组)', () => {
    const bare = openaiToAnthropicBody({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(bare.system).toBeUndefined();
  });

  it('走 x-api-key;不发 Authorization、不发 oauth beta 头', async () => {
    let seen: any = null;
    vi.stubGlobal('fetch', (_u: string, init: any) => {
      seen = init.headers;
      return Promise.resolve({ ok: false, status: 401, body: null, json: () => Promise.resolve({ error: { message: 'x' } }) });
    });
    await streamAnthropicMessages({
      apiKey: 'sk-ant-api03-xxx',
      baseUrl: 'https://api.anthropic.com',
      payload: { model: 'claude-x', messages: [] },
    } as any).catch(() => {});
    expect(seen['x-api-key']).toBe('sk-ant-api03-xxx');
    // 同上,这两条是删除订阅 OAuth 分支的回归闸。
    expect(seen.Authorization).toBeUndefined();
    expect(seen['anthropic-beta']).toBeUndefined();
  });
});
