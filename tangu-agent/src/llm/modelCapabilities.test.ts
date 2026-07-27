import { describe, it, expect } from 'vitest';
import {
  resolveModelCapability,
  clampThinkingLevel,
  supportedThinkingLevels,
  normalizeThinkingLevel,
  applyThinking,
  type ThinkingLevel,
} from './modelCapabilities.js';

/**
 * 能力表的回归仪器。新增/改规则先在这里加一行断言,再动 applyThinking。
 * 「拨了档位却什么都没发」这类静默失败,只有矩阵测试能挡住。
 */

const cap = (q: Parameters<typeof resolveModelCapability>[0]) => resolveModelCapability(q);
const apply = (q: Parameters<typeof resolveModelCapability>[0], level: ThinkingLevel, payload: any = {}) => {
  const sys: string[] = [];
  const r = applyThinking(payload, level, cap(q), (t) => sys.push(t));
  return { payload, sys, ...r };
};

describe('resolveModelCapability — 路由矩阵', () => {
  const cases: Array<[string, Parameters<typeof resolveModelCapability>[0], string]> = [
    ['OpenAI gpt-5', { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.6-luna' }, 'openai-gpt5'],
    ['OpenAI o 系', { baseUrl: 'https://api.openai.com/v1', modelId: 'o3-mini' }, 'openai-o-series'],
    ['OpenAI gpt-4o', { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini' }, 'openai-nonreasoning'],
    ['Claude 自适应', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4.8' }, 'anthropic-adaptive'],
    ['Claude 预算', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4-20250514' }, 'anthropic-budget'],
    ['Claude 旧款', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-3-5-haiku' }, 'anthropic-legacy'],
    ['Codex 订阅', { protocol: 'openai-responses', modelId: 'gpt-5.6-codex' }, 'codex-subscription'],
    ['Claude 订阅', { protocol: 'anthropic-messages', modelId: 'claude-sonnet-5' }, 'claude-subscription'],
    ['Gemini 兼容层', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-2.5-flash' }, 'gemini-openai-compat'],
    ['Gemini 托管 pro', { provider: 'gemini', modelId: 'gemini-2.5-pro' }, 'gemini-native-pro'],
    ['DeepSeek reasoner', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-reasoner' }, 'deepseek-reasoner'],
    ['DeepSeek chat', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' }, 'deepseek-chat'],
    ['智谱 GLM', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-4.6' }, 'zhipu-glm'],
    ['DashScope Qwen', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-max' }, 'dashscope-qwen'],
    ['Kimi thinking', { baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2-thinking' }, 'moonshot-thinking'],
    ['OpenRouter', { baseUrl: 'https://openrouter.ai/api/v1', modelId: 'anthropic/claude-sonnet-4' }, 'openrouter'],
    ['Grok mini', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-3-mini' }, 'xai-grok-mini'],
    ['Grok 4', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-4' }, 'xai-grok'],
    ['硅基流动 Qwen3', { baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'Qwen/Qwen3-235B-A22B' }, 'gateway-qwen3'],
    ['硅基流动 R1', { baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'deepseek-ai/DeepSeek-R1' }, 'gateway-self-reasoning'],
    ['Ollama 本地', { baseUrl: 'http://localhost:11434/v1', modelId: 'llama3' }, 'default'],
    ['自建网关', { baseUrl: 'https://llm.mycorp.internal/v1', modelId: 'my-model' }, 'default'],
  ];
  it.each(cases)('%s → %s', (_name, q, ruleId) => {
    expect(cap(q).rule).toBe(ruleId);
  });
});

describe('未知端点零协议风险', () => {
  const unknown = { baseUrl: 'https://llm.mycorp.internal/v1', modelId: 'my-model' };

  it('只改系统提示,不下发任何厂商私有字段', () => {
    const { payload, sys } = apply(unknown, 'high');
    expect(payload).toEqual({}); // 一个字段都没往 body 里塞
    expect(sys).toHaveLength(1);
  });

  it('思考关 → 连系统提示也不动(与改造前行为一致)', () => {
    const { payload, sys } = apply(unknown, 'off');
    expect(payload).toEqual({});
    expect(sys).toHaveLength(0);
  });

  it('自带思考的模型不灌 prefix 废话', () => {
    const { sys } = apply({ baseUrl: 'https://llm.mycorp.internal/v1', modelId: 'my-qwq-32b' }, 'high');
    expect(sys).toHaveLength(0);
  });
});

describe('applyThinking — 各家线上形态', () => {
  it('OpenAI gpt-5 思考关:reasoning_effort=none + 剥 temperature + 不改道', () => {
    const { payload, viaResponses } = apply(
      { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.6-luna' },
      'off',
      { temperature: 0.7 },
    );
    expect(payload.reasoning_effort).toBe('none');
    expect(payload.temperature).toBeUndefined();
    expect(viaResponses).toBe(false);
  });

  it('OpenAI gpt-5 思考开:改道 responses + max_tokens 换名', () => {
    const { payload, viaResponses } = apply(
      { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.6-luna' },
      'medium',
      { max_tokens: 1200 },
    );
    expect(payload.reasoning_effort).toBe('medium');
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.max_completion_tokens).toBe(1200);
    expect(viaResponses).toBe(true);
  });

  it('Codex 订阅拿得到档位(改造前这里永远是空的)', () => {
    const { payload, effective } = apply({ protocol: 'openai-responses', modelId: 'gpt-5.6-codex' }, 'xhigh');
    expect(payload.reasoning_effort).toBe('xhigh');
    expect(effective).toBe('xhigh');
  });

  it('Claude 订阅拿得到 thinking(改造前完全没有此字段)', () => {
    const { payload } = apply({ protocol: 'anthropic-messages', modelId: 'claude-sonnet-5' }, 'medium');
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('Claude 预算:未给 max_tokens 时自动补到大于预算', () => {
    const { payload } = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4' }, 'high');
    expect(payload.thinking.budget_tokens).toBe(16384);
    expect(payload.max_tokens).toBeGreaterThan(payload.thinking.budget_tokens);
  });

  it('Claude 预算:给了小 max_tokens 时把预算夹进去而不是超发', () => {
    const { payload } = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4' }, 'max', {
      max_tokens: 4096,
    });
    expect(payload.thinking.budget_tokens).toBe(4096 - 1024);
    expect(payload.max_tokens).toBe(4096);
  });

  it('Claude 预算:额度小到装不下思考就老实关掉', () => {
    const { payload, effective } = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4' }, 'high', {
      max_tokens: 1500,
    });
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(effective).toBe('off');
  });

  it('Claude 自适应:thinking:adaptive + output_config.effort', () => {
    const { payload } = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4.8' }, 'max');
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(payload.output_config).toEqual({ effort: 'xhigh' });
  });

  it('Qwen:enable_thinking + thinking_budget', () => {
    const on = apply({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-max' }, 'low');
    expect(on.payload).toMatchObject({ enable_thinking: true, thinking_budget: 2048 });
    const off = apply({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-max' }, 'off');
    expect(off.payload).toEqual({ enable_thinking: false });
  });

  it('智谱 GLM / DeepSeek chat:thinking:{type}', () => {
    expect(apply({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-4.6' }, 'high').payload.thinking)
      .toEqual({ type: 'enabled' });
    expect(apply({ baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' }, 'off').payload.thinking)
      .toEqual({ type: 'disabled' });
  });

  it('OpenRouter:reasoning:{effort}', () => {
    const { payload } = apply({ baseUrl: 'https://openrouter.ai/api/v1', modelId: 'openai/gpt-5' }, 'minimal');
    expect(payload.reasoning).toEqual({ effort: 'minimal' });
  });

  it('Gemini 托管:generationConfig.thinkingConfig', () => {
    const { payload } = apply({ provider: 'gemini', modelId: 'gemini-2.5-flash' }, 'medium');
    expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192, includeThoughts: true });
  });

  it('自带思考的模型什么都不发', () => {
    const { payload } = apply({ baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-reasoner' }, 'max', {});
    expect(payload).toEqual({});
  });
});

describe('clampThinkingLevel — 降档', () => {
  it('模型没有的档位往下降', () => {
    const c = cap({ baseUrl: 'https://api.x.ai/v1', modelId: 'grok-3-mini' });
    expect(clampThinkingLevel(c, 'max')).toBe('max'); // max→'high' 有值,不算降档
    expect(supportedThinkingLevels(c)).not.toContain('off');
  });

  it('关不掉思考的模型:请求 off 落到最弱可用档', () => {
    const c = cap({ baseUrl: 'https://api.openai.com/v1', modelId: 'o3-mini' });
    expect(clampThinkingLevel(c, 'off')).toBe('minimal');
  });

  it('gpt-5 七档全支持', () => {
    const c = cap({ baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.6-luna' });
    expect(supportedThinkingLevels(c)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('Gemini 2.5-pro 关不掉思考', () => {
    const c = cap({ provider: 'gemini', modelId: 'gemini-2.5-pro' });
    expect(supportedThinkingLevels(c)).not.toContain('off');
    expect(clampThinkingLevel(c, 'off')).toBe('minimal');
  });
});

describe('normalizeThinkingLevel — 旧值兼容', () => {
  it.each([
    [true, 'medium'],
    [false, 'off'],
    ['HIGH', 'high'],
    ['none', 'off'],
    ['enabled', 'medium'],
    ['xhigh', 'xhigh'],
    ['垃圾值', 'medium'],
    [undefined, 'medium'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeThinkingLevel(input)).toBe(expected);
  });

  it('可指定兜底档', () => {
    expect(normalizeThinkingLevel(undefined, 'off')).toBe('off');
  });
});
