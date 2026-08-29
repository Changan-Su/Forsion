import { describe, it, expect } from 'vitest';
import {
  resolveModelCapability,
  clampThinkingLevel,
  supportedThinkingLevels,
  normalizeThinkingLevel,
  applyThinking,
  modelSupportsVision,
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
    ['OpenAI gpt-5.6+', { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.6-luna' }, 'openai-gpt5-latest'],
    ['OpenAI gpt-5.5', { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.5' }, 'openai-gpt5'],
    ['OpenAI gpt-5.5-pro', { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.5-pro' }, 'openai-gpt5-pro'],
    ['OpenAI o 系', { baseUrl: 'https://api.openai.com/v1', modelId: 'o3-mini' }, 'openai-o-series'],
    ['OpenAI gpt-4o', { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini' }, 'openai-nonreasoning'],
    ['Claude 自适应', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4.8' }, 'anthropic-adaptive'],
    // ⚠️ 官方 id 是**连字符**形态,旧正则只认点号 → 真 id 全落 budget → 400。这是本轮的判别式用例。
    ['Claude Opus 4.7(连字符真 id)', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4-7' }, 'anthropic-adaptive'],
    ['Claude Opus 5', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-5' }, 'anthropic-adaptive'],
    ['Claude Fable 5(思考常开)', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-fable-5' }, 'anthropic-always-on'],
    // 4.6 及更早仍是手动扩展思考,不许被自适应族吞掉
    ['Claude Sonnet 4.6', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4-6' }, 'anthropic-budget'],
    ['Claude Opus 4.5 快照', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4-5-20251101' }, 'anthropic-budget'],
    ['Claude Haiku 4.5', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-haiku-4-5-20251001' }, 'anthropic-budget'],
    ['Claude 托管 provider(5 家族)', { provider: 'anthropic', modelId: 'claude-sonnet-5' }, 'anthropic-provider-adaptive'],
    ['Claude 托管 provider(4.6)', { provider: 'anthropic', modelId: 'claude-sonnet-4-6' }, 'anthropic-provider'],
    ['Claude 预算', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4-20250514' }, 'anthropic-budget'],
    ['Claude 旧款', { baseUrl: 'https://api.anthropic.com', modelId: 'claude-3-5-haiku' }, 'anthropic-legacy'],
    ['Codex 订阅', { protocol: 'openai-responses', modelId: 'gpt-5.6-codex' }, 'codex-subscription'],
    ['Anthropic API key(5 家族)', { protocol: 'anthropic-messages', modelId: 'claude-sonnet-5' }, 'anthropic-messages-adaptive'],
    ['Anthropic API key(4.6)', { protocol: 'anthropic-messages', modelId: 'claude-sonnet-4-6' }, 'anthropic-messages'],
    ['Gemini 兼容层', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-2.5-flash' }, 'gemini-openai-compat'],
    ['Gemini 托管 pro', { provider: 'gemini', modelId: 'gemini-2.5-pro' }, 'gemini-native-nodisable'],
    ['Gemini 3 托管', { provider: 'google', modelId: 'gemini-3.1-pro-preview' }, 'gemini-native-nodisable'],
    ['Gemini 2.5-flash 托管(可关)', { provider: 'gemini', modelId: 'gemini-2.5-flash' }, 'gemini-native'],
    ['Gemini 3 兼容层', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-3-flash-preview' }, 'gemini-openai-compat-3'],
    // ⚠️ 同一个 host,只有路径能区分原生 REST 与兼容层;而调用方**同时**传 provider 与 baseUrl。
    // provider 规则若排在前面,配了兼容层地址的 provider 会拿到原生 generationConfig(静默失效)。
    ['provider=google + 兼容层地址', { provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-3.1-pro' }, 'gemini-openai-compat-3'],
    ['provider=gemini + 原生 REST 地址', { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId: 'gemini-3.1-pro' }, 'gemini-native-nodisable'],
    ['火山方舟转售的 GLM(不该被豆包规则吞)', { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'zai-org/GLM-5.3' }, 'gateway-glm53'],
    ['DeepSeek V4 flash', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-v4-flash' }, 'deepseek-v4'],
    ['DeepSeek V4 pro', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-v4-pro' }, 'deepseek-v4'],
    // 反例:v4 规则必须锚在 `deepseek-v4` 前缀,别把同 host 上的自定义 id 一起吞了。
    ['DeepSeek 自定义含 v4', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'myv4legacy' }, 'deepseek-chat'],
    ['假冒 deepseek 域名', { baseUrl: 'https://notdeepseek.com/v1', modelId: 'deepseek-v4-flash' }, 'default'],
    ['DeepSeek reasoner', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-reasoner' }, 'deepseek-reasoner'],
    ['DeepSeek chat', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' }, 'deepseek-chat'],
    ['智谱 GLM', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-4.6' }, 'zhipu-glm'],
    ['智谱 GLM-5.3', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.3' }, 'zhipu-glm53'],
    ['z.ai GLM-5.3-flash', { baseUrl: 'https://api.z.ai/api/paas/v4', modelId: 'glm-5.3-flash' }, 'zhipu-glm53'],
    // 5.2 仍可关思考、effort 词表也不同(七档全支持)→ 自己一条规则,不许被 5.3 规则吞
    ['智谱 GLM-5.2', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.2' }, 'zhipu-glm52'],
    ['智谱 GLM-4.7(强制思考)', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-4.7' }, 'zhipu-glm-always-on'],
    ['智谱 GLM-4.5V(强制思考)', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-4.5v' }, 'zhipu-glm-always-on'],
    ['火山方舟豆包', { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seed-2-0-pro' }, 'volcengine-doubao'],
    ['百炼纯思考模型', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.7-max-preview' }, 'dashscope-qwen-pure'],
    ['DashScope Qwen', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-max' }, 'dashscope-qwen'],
    ['DashScope Qwen3.8', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.8-max' }, 'dashscope-qwen38'],
    ['DashScope Qwen3.7', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.7-plus' }, 'dashscope-qwen'],
    ['DeepSeek V4 视觉实验版', { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-v4-flash-vision-exp' }, 'deepseek-v4'],
    ['Kimi thinking', { baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2-thinking' }, 'moonshot-thinking'],
    ['Kimi K3', { baseUrl: 'https://api.moonshot.ai/v1', modelId: 'kimi-k3' }, 'moonshot-k3'],
    ['OpenRouter', { baseUrl: 'https://openrouter.ai/api/v1', modelId: 'anthropic/claude-sonnet-4' }, 'openrouter'],
    ['Grok mini', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-3-mini' }, 'xai-grok-mini'],
    ['Grok 4.6', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-4.6' }, 'xai-grok-effort'],
    // grok-4 与 4.20 的 reasoning/non-reasoning 变体收到 reasoning_effort 会报错 → 继续走 none
    ['Grok 4', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-4' }, 'xai-grok'],
    ['Grok 4.20 reasoning', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-4.20-reasoning' }, 'xai-grok'],
    ['硅基流动 Qwen3', { baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'Qwen/Qwen3-235B-A22B' }, 'gateway-qwen3'],
    ['硅基流动 Qwen3.8', { baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'Qwen/Qwen3.8-2.4T-A95B' }, 'gateway-qwen38'],
    ['硅基流动 GLM-5.3', { baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'zai-org/GLM-5.3' }, 'gateway-glm53'],
    ['硅基流动 GLM-4.6', { baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'zai-org/GLM-4.6' }, 'gateway-glm'],
    // ⚠️ OpenRouter 上的 GLM-5.3 必须继续走 OpenRouter 自己的归一层(reasoning:{effort}),
    // 不能被 zai 族规则抢走改发厂商私有字段 —— 族规则整段刻意排在 openrouter 规则之后。
    // 但它是「思考不可关」的型号,归一层的 effort:'none' 会被上游拒 → 专门一条只改 off 的规则。
    ['OpenRouter GLM-5.3', { baseUrl: 'https://openrouter.ai/api/v1', modelId: 'z-ai/glm-5.3' }, 'openrouter-mandatory-reasoning'],
    ['OpenRouter 普通模型', { baseUrl: 'https://openrouter.ai/api/v1', modelId: 'openai/gpt-5.6' }, 'openrouter'],
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
    const { payload } = apply({ protocol: 'anthropic-messages', modelId: 'claude-sonnet-4-6' }, 'medium');
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('⚠️Claude 5 / Opus 4.7+ 三个入口都不许再发 budget_tokens(发了是 400,不是降级)', () => {
    for (const q of [
      { baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4-7' },
      { protocol: 'anthropic-messages', modelId: 'claude-sonnet-5' },
      { provider: 'anthropic', modelId: 'claude-opus-5' },
      { provider: 'claude-proxy', modelId: 'claude-fable-5' },
    ]) {
      const { payload } = apply(q, 'high', { temperature: 0.7 });
      expect(payload.thinking).toEqual({ type: 'adaptive' });
      expect(payload.output_config).toEqual({ effort: 'high' });
      expect(payload.thinking.budget_tokens).toBeUndefined();
      expect(payload.temperature).toBeUndefined(); // 非默认 temperature 在 Sonnet 5 上同样是 400
    }
  });

  it('Claude 自适应:能关思考;Fable 5 常开只能夹到最弱档', () => {
    const off = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-5' }, 'off');
    expect(off.payload).toEqual({ thinking: { type: 'disabled' } }); // 不带 effort:disabled+xhigh/max 是 400
    expect(off.effective).toBe('off');
    const fable = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-fable-5' }, 'off');
    expect(fable.payload.thinking).toEqual({ type: 'adaptive' });
    expect(fable.effective).toBe('minimal');
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

  it('Claude 自适应:thinking:adaptive + output_config.effort(max 是真档,别再折成 xhigh)', () => {
    const { payload } = apply({ baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-4.8' }, 'max');
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(payload.output_config).toEqual({ effort: 'max' });
  });

  it('gpt-5.6 起 effort 有真 max;5.5 到 xhigh 为止;两代都没有 minimal', () => {
    const oa = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://api.openai.com/v1', modelId: m }, lv).payload;
    expect(oa('gpt-5.6-luna', 'max').reasoning_effort).toBe('max');
    expect(oa('gpt-5.5', 'max').reasoning_effort).toBe('xhigh');
    // 官方模型页:5.5 与 5.6 的档表都是 none/low/medium/high/xhigh(+5.6 的 max),没有 minimal
    for (const m of ['gpt-5.6-luna', 'gpt-5.5']) expect(oa(m, 'minimal').reasoning_effort).toBe('low');
  });

  it('gpt-5.x-pro:最低只到 medium,且永远改道 Responses', () => {
    const pro = (lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.5-pro' }, lv);
    expect(pro('off').payload.reasoning_effort).toBe('medium'); // 关不掉,也没有 low
    expect(pro('low').payload.reasoning_effort).toBe('medium');
    expect(pro('max').payload.reasoning_effort).toBe('xhigh');
    expect(pro('off').viaResponses).toBe(true); // pro 不支持 chat/completions
    expect(supportedThinkingLevels(cap({ baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.5-pro' })))
      .not.toContain('off');
  });

  it('Kimi K3:顶层 reasoning_effort(low/high/max),思考不可关', () => {
    const k3 = (lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://api.moonshot.ai/v1', modelId: 'kimi-k3' }, lv);
    expect(k3('low').payload).toEqual({ reasoning_effort: 'low' });
    expect(k3('max').payload).toEqual({ reasoning_effort: 'max' });
    expect(k3('off').effective).toBe('minimal'); // 关不掉 → 夹到最弱档
    // K2 线仍然一个字段都不发(它们不认这个参数)
    expect(apply({ baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2-thinking' }, 'max').payload).toEqual({});
  });

  it('Grok 4.5+:reasoning_effort 回来了;grok-4 与 4.20 变体仍然什么都不发', () => {
    const x = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://api.x.ai/v1', modelId: m }, lv).payload;
    expect(x('grok-4.6', 'xhigh').reasoning_effort).toBe('xhigh');
    expect(x('grok-4.5', 'medium').reasoning_effort).toBe('medium');
    expect(x('grok-4.5', 'max').reasoning_effort).toBe('xhigh'); // 不支持 xhigh 的型号官方按 high 处理
    expect(x('grok-4', 'max')).toEqual({});
    expect(x('grok-4.20-reasoning', 'max')).toEqual({});
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

  it('DeepSeek V4:thinking:{type} + reasoning_effort(只发 low/high/max)', () => {
    const ds = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://api.deepseek.com/v1', modelId: m }, lv).payload;
    expect(ds('deepseek-v4-flash', 'low')).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
    expect(ds('deepseek-v4-pro', 'max')).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    // 'medium' 不是官方档位 → 必须落到 high,绝不原样上 wire。
    expect(ds('deepseek-v4-flash', 'medium').reasoning_effort).toBe('high');
    // 关思考时不带 effort(DeepSeek 非思考模式不认它)。
    expect(ds('deepseek-v4-flash', 'off')).toEqual({ thinking: { type: 'disabled' } });
    // 老 chat 线仍是纯开关,不许因本次改动多出 reasoning_effort。
    expect(ds('deepseek-chat', 'high')).toEqual({ thinking: { type: 'enabled' } });
  });

  it('GLM-5.3:思考关不掉 —— 拨「关」也发 enabled + 最弱档,绝不发 disabled', () => {
    const glm = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: m }, lv);
    // 官方已下线 thinking:{type:'disabled'} —— 发过去直接失败,故 off 被夹到 low。
    const off = glm('glm-5.3', 'off');
    expect(off.payload).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
    expect(off.effective).toBe('minimal');
    // 不发 effort = 每次都按官方缺省的 max 跑(拨了低档静默烧钱)。三档都要真的上 wire。
    expect(glm('glm-5.3', 'medium').payload.reasoning_effort).toBe('high');
    expect(glm('glm-5.3-flash', 'max').payload.reasoning_effort).toBe('max');
    expect(supportedThinkingLevels(cap({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.3' })))
      .not.toContain('off'); // 客户端据此把「关闭思考」标灰
    // 5.1 及更早才是纯开关,不许因本次改动多出 reasoning_effort
    expect(glm('glm-4.6', 'high').payload).toEqual({ thinking: { type: 'enabled' } });
    expect(glm('glm-4.6', 'off').payload).toEqual({ thinking: { type: 'disabled' } });
  });

  it('GLM-5.2:七档 effort 原样发;仍然可以关思考', () => {
    const glm = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: m }, lv).payload;
    expect(glm('glm-5.2', 'xhigh')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'xhigh' });
    expect(glm('glm-5.2', 'minimal').reasoning_effort).toBe('minimal');
    expect(glm('glm-5.2', 'off')).toEqual({ thinking: { type: 'disabled' } }); // 关思考时不带 effort
  });

  it('GLM-4.7 / 4.5V:强制思考且无深度档 —— 只发开关,off 夹到最弱', () => {
    const g = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: m }, lv);
    expect(g('glm-4.7', 'off').payload).toEqual({ thinking: { type: 'enabled' } });
    expect(g('glm-4.7', 'off').effective).toBe('minimal');
    expect(g('glm-4.5v', 'max').payload.reasoning_effort).toBeUndefined(); // 5.1 及以下不认 effort
  });

  it('豆包:effort 只发它认的四档,永远不发 none', () => {
    const d = (lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seed-2-0-pro' }, lv).payload;
    expect(d('off')).toEqual({ reasoning_effort: 'minimal' }); // minimal = 不思考
    expect(d('medium')).toEqual({ reasoning_effort: 'medium' });
    expect(d('max')).toEqual({ reasoning_effort: 'high' });
    for (const lv of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(['minimal', 'low', 'medium', 'high']).toContain(d(lv).reasoning_effort);
    }
  });

  it('Gemini 3 关不掉思考:请求 off 也不发 thinkingBudget:0', () => {
    const g3 = apply({ provider: 'google', modelId: 'gemini-3.1-pro-preview' }, 'off');
    expect(g3.effective).toBe('minimal');
    expect(g3.payload.generationConfig.thinkingConfig.thinkingBudget).toBe(512);
    // 2.5-flash 仍可关(不许把整族一起锁死)
    const f = apply({ provider: 'gemini', modelId: 'gemini-2.5-flash' }, 'off');
    expect(f.payload.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
  });

  it('百炼纯思考模型不发 enable_thinking(官方:该参数不存在)', () => {
    const q = apply({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.7-max-preview' }, 'high');
    expect(q.payload).toEqual({});
    // 混合思考的正常型号不受影响
    expect(apply({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.8-max' }, 'high')
      .payload.enable_thinking).toBe(true);
  });

  it('⚠️Qwen3.8 与 Qwen3.x 的预算量级不同,别混用一张表', () => {
    const dash = (m: string, lv: Parameters<typeof apply>[1]) =>
      apply({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: m }, lv).payload;
    // 3.8:官方 0–262144、缺省 131072,effort 对照 low=4096 / medium=16384 / xhigh=262144
    expect(dash('qwen3.8-max', 'low')).toMatchObject({ enable_thinking: true, thinking_budget: 4096 });
    expect(dash('qwen3.8-max', 'medium').thinking_budget).toBe(16384);
    expect(dash('qwen3.8-max', 'xhigh').thinking_budget).toBe(262144);
    expect(dash('qwen3.8-max', 'max').thinking_budget).toBe(262144);
    // 最高档绝不能低于官方缺省预算(131072),否则是「拨到最高反而降智」
    expect(dash('qwen3.8-max', 'max').thinking_budget).toBeGreaterThanOrEqual(131072);
    // 3.x 老线仍是 1–32768 的量级
    for (const lv of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(dash('qwen3-max', lv).thinking_budget).toBeLessThanOrEqual(32768);
    }
    expect(dash('qwen3.8-max', 'off')).toEqual({ enable_thinking: false });
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

describe('modelSupportsVision — 黑名单制', () => {
  it('未登记的模型一律当作有视觉(默认放行,含未来新模型)', () => {
    for (const id of ['gpt-5', 'claude-sonnet-5', 'gemini-3-pro', 'qwen3-max', 'openai/gpt-6-turbo', '', '某个还没出的模型']) {
      expect(modelSupportsVision(id)).toBe(true);
    }
  });

  it('已知纯文本族判为无视觉', () => {
    for (const id of ['gpt-3.5-turbo', 'o1-mini', 'o1-preview', 'deepseek-chat', 'deepseek-reasoner', 'qwq-32b', 'text-embedding-3-large', 'whisper-1']) {
      expect(modelSupportsVision(id)).toBe(false);
    }
  });

  // 2026-08-04 实例:表里写 `deepseek-(chat|coder|reasoner|v3|r1)`,DeepSeek-V4-Pro 一出就漏网,
  // 被判成能看图 → 图原样发过去 → 整 run 以「The model is not a VLM」报废。同族规则不许钉版本号。
  it('⚠️DeepSeek 整族无视觉,不按型号枚举(新版本不许漏网)', () => {
    for (const id of ['DeepSeek-V4-Pro', 'deepseek-v4-flash', 'deepseek-v5', 'deepseek-r2', 'deepseek-chat']) {
      expect(modelSupportsVision(id)).toBe(false);
    }
    expect(modelSupportsVision('deepseek-vl2')).toBe(true); // 唯一的视觉分支不能被族规则吞掉
  });

  // 2026-08:DeepSeek 出了官方视觉分支、GLM-5.3 反过来是纯文本 —— 两个方向都得钉住。
  it('⚠️族规则要按能力反查排除:DeepSeek 视觉分支不能被整族吞掉', () => {
    expect(modelSupportsVision('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(modelSupportsVision('deepseek-ai/DeepSeek-V4-Flash-Vision-Exp')).toBe(true);
    expect(modelSupportsVision('deepseek-v4-flash')).toBe(false); // 非视觉分支不受影响
  });

  it('GLM-5.3 官方明写纯文本 → 走辅助识图;但 5.3-Flash 是原生多模态,不许一起吞', () => {
    expect(modelSupportsVision('glm-5.3')).toBe(false);
    expect(modelSupportsVision('glm-5.3-0815')).toBe(false);
    expect(modelSupportsVision('glm-5.3-flash')).toBe(true); // GLM-5 系首个原生多模态,收图片/视频
    expect(modelSupportsVision('zai-org/GLM-5.3-Flash')).toBe(true);
    expect(modelSupportsVision('zai-org/GLM-5.3')).toBe(false);
    expect(modelSupportsVision('glm-4.5v')).toBe(true); // 视觉分支不许被吞
    expect(modelSupportsVision('glm-5.2')).toBe(true); // 只收 5.3,别扩到整族
  });

  it('带 <providerId>/ 前缀的直连 id 同样命中(只拿裸模型名匹配)', () => {
    expect(modelSupportsVision('siliconflow/deepseek-chat')).toBe(false);
    expect(modelSupportsVision('ollama/qwq')).toBe(false);
    // 只是名字里含 "text" 不算(锚点要求 text- 在段首)
    expect(modelSupportsVision('my-text-model')).toBe(true);
  });

  it('⚠️providerId 段绝不参与匹配(误伤是最坏的方向)', () => {
    // text-generation-webui 托的 LLaVA 是货真价实的视觉模型;匹配全串会被 `text-` 规则误杀
    expect(modelSupportsVision('text-generation-webui/llava-v1.6-mistral-7b')).toBe(true);
    expect(modelSupportsVision('openrouter/deepseek-ai/DeepSeek-R1')).toBe(false); // 裸名仍命中
  });

  it('显式 override 压过表(admin 标注 / provider noVisionModelIds)', () => {
    expect(modelSupportsVision('gpt-5', false)).toBe(false);
    expect(modelSupportsVision('deepseek-chat', true)).toBe(true);
    expect(modelSupportsVision('deepseek-chat', null)).toBe(false); // null = 没标注 → 查表
  });
});
