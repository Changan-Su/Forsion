import { describe, it, expect } from 'vitest';
import { buildOpenAiCompatPayload, tuneOpenAiDirectPayload, PROTOCOL_MARK, ACCOUNT_MARK } from './openaiCompat.js';
import { openaiToResponsesBody } from './openaiResponses.js';
import { createProviderRegistry } from './providerRegistry.js';

// 直连面的档位下发契约。「哪个模型该发什么」的矩阵在 modelCapabilities.test.ts;
// 这里只守 tune 这一层的职责:查表 → 写 payload → 需要时打改道标记。
describe('tuneOpenAiDirectPayload(直连档位下发)', () => {
  const base = () => ({ model: 'gpt-5.6-luna', temperature: 0.7, messages: [], tools: [{}] }) as any;
  const OFFICIAL = 'https://api.openai.com/v1';

  it.each(['codex', 'openai'])('GPT-6 Astra 经 %s 注册表→payload→Responses 保留工具与有效档位', (providerId) => {
    const subscription = providerId === 'codex';
    const reg = createProviderRegistry([{
      providerId, baseUrl: subscription ? 'https://chatgpt.com/backend-api/codex' : OFFICIAL,
      ...(subscription ? { protocol: 'openai-responses' as const, accountId: 'test-account' } : {}),
      modelIds: ['gpt-6-astra'],
    }]);
    const resolved = reg.resolve(`${providerId}/gpt-6-astra`)!;
    for (const requested of [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const p = buildOpenAiCompatPayload({
        model: resolved.model, apiModelId: resolved.apiModelId,
        messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'read file' }],
        maxTokens: 1200,
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      });
      Object.assign(p, { top_p: 0.8, top_logprobs: 2, logprobs: true, include: ['message.output_text.logprobs'] });
      const effective = tuneOpenAiDirectPayload(p, requested, { baseUrl: resolved.baseUrl, apiModelId: resolved.apiModelId });
      const expected = !requested || ['off', 'minimal'].includes(requested) ? 'low' : requested;
      expect(effective).toBe(expected);
      expect(p[PROTOCOL_MARK]).toBe('openai-responses');
      const wire = openaiToResponsesBody(p);
      expect(wire.model).toBe('gpt-6-astra');
      expect(wire.reasoning.effort).toBe(expected);
      expect(wire.instructions).toBe('SYSTEM');
      expect(wire.tools[0]).toMatchObject({ type: 'function', name: 'read_file' });
      expect(wire.include).toEqual(['reasoning.encrypted_content']);
      for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs', PROTOCOL_MARK, ACCOUNT_MARK]) expect(wire).not.toHaveProperty(key);
      expect(wire.max_output_tokens).toBe(subscription ? undefined : 1200);
    }
  });

  it('思考关 → 补 reasoning_effort:none + 剥 temperature,仍走 chat/completions', () => {
    const p = base();
    tuneOpenAiDirectPayload(p, 'off', OFFICIAL);
    expect(p.reasoning_effort).toBe('none');
    expect(p.temperature).toBeUndefined();
    expect(p[PROTOCOL_MARK]).toBeUndefined();
  });

  it('思考开 → 打 openai-responses 协议标记,effort 随传', () => {
    const p = base();
    tuneOpenAiDirectPayload(p, 'medium', OFFICIAL);
    expect(p[PROTOCOL_MARK]).toBe('openai-responses');
    expect(p.reasoning_effort).toBe('medium');
  });

  it('max_tokens → max_completion_tokens(压缩等通道会带上限)', () => {
    const p = { ...base(), max_tokens: 1200 };
    tuneOpenAiDirectPayload(p, 'off', OFFICIAL);
    expect(p.max_tokens).toBeUndefined();
    expect(p.max_completion_tokens).toBe(1200);
  });

  it('官方但非 gpt-5 族(gpt-4o)不发 effort(实测会被拒),退到系统提示兜底', () => {
    const p = { ...base(), model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'BASE' }] };
    tuneOpenAiDirectPayload(p, 'high', OFFICIAL);
    expect(p.reasoning_effort).toBeUndefined();
    expect(p.messages[0].content).toContain('BASE');
    expect(p.messages[0].content.length).toBeGreaterThan('BASE'.length);
  });

  it('未知网关:不发任何厂商私有字段,只动系统提示', () => {
    const p = { ...base(), model: 'my-model', messages: [{ role: 'system', content: 'BASE' }] };
    tuneOpenAiDirectPayload(p, 'high', 'https://llm.mycorp.internal/v1');
    expect(p.reasoning_effort).toBeUndefined();
    expect(p.thinking).toBeUndefined();
    expect(p.enable_thinking).toBeUndefined();
    expect(p.temperature).toBe(0.7);
  });

  it('未知网关思考关:一个字都不改(与改造前逐字节一致)', () => {
    const p = { ...base(), model: 'my-model', messages: [{ role: 'system', content: 'BASE' }] };
    tuneOpenAiDirectPayload(p, 'off', 'https://llm.mycorp.internal/v1');
    expect(p.messages[0].content).toBe('BASE');
    expect(p.temperature).toBe(0.7);
  });

  it('没有 system 消息时 prefix 兜底会补一条', () => {
    const p = { ...base(), model: 'my-model', messages: [{ role: 'user', content: 'hi' }] };
    tuneOpenAiDirectPayload(p, 'low', 'https://llm.mycorp.internal/v1');
    expect(p.messages[0].role).toBe('system');
    expect(p.messages[1].role).toBe('user');
  });

  it('Codex 订阅(已带协议标记)现在也能拿到档位', () => {
    const p = { ...base(), model: 'gpt-5.6-codex', [PROTOCOL_MARK]: 'openai-responses' };
    tuneOpenAiDirectPayload(p, 'high', { baseUrl: 'https://chatgpt.com/backend-api/codex' });
    expect(p.reasoning_effort).toBe('high');
    expect(p[PROTOCOL_MARK]).toBe('openai-responses');
  });

  it('Claude 订阅拿到 thinking(改造前此路径完全无思考字段)', () => {
    // 4.6 及更早仍是手动扩展思考(budget_tokens)
    const p = { ...base(), model: 'claude-sonnet-4-6', [PROTOCOL_MARK]: 'anthropic-messages' };
    tuneOpenAiDirectPayload(p, 'high', { baseUrl: 'https://api.anthropic.com' });
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('⚠️Claude 5 走自适应:发 budget_tokens 或 temperature 都是 400', () => {
    const p = { ...base(), model: 'claude-sonnet-5', [PROTOCOL_MARK]: 'anthropic-messages' };
    tuneOpenAiDirectPayload(p, 'high', { baseUrl: 'https://api.anthropic.com' });
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p.temperature).toBeUndefined();
  });

  it('阿里 DashScope 的 Qwen3 拿到 enable_thinking(改造前是静默无效)', () => {
    const p = { ...base(), model: 'qwen3-max' };
    tuneOpenAiDirectPayload(p, 'medium', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    expect(p.enable_thinking).toBe(true);
    expect(p.thinking_budget).toBe(8192);
  });

  it('返回夹紧后的实际档位', () => {
    const p = { ...base(), model: 'o3-mini' };
    expect(tuneOpenAiDirectPayload(p, 'off', OFFICIAL)).toBe('minimal'); // o 系关不掉思考
  });
});
