/**
 * 模型能力表 —— 「哪个端点 × 哪个模型族,思考档位该怎么发线」的**唯一真源**。
 *
 * 背景:此前只有 `tuneOpenAiDirectPayload` 对官方 api.openai.com + `^gpt-5` 做特判,其余所有
 * provider(Anthropic / Gemini / DeepSeek / Qwen / GLM / Kimi / OpenRouter / 自建网关)的
 * thinkingLevel 被**静默吞掉**——用户拨了档位,payload 里什么都没变。本表把「档位 → 线上字段」
 * 这件事集中成数据,两条推理面共用:
 *   - 直连面:tangu-agent multiBrain(用户自带 key)
 *   - 托管面:server/src/services/thinkingAdapter.ts(Forsion 托管目录)
 * server 经 `@forsion/tangu-agent` 导入本模块(改这里须跑 `npm run vendor:tangu`)。
 *
 * 设计参考 Temp_Repo/pi 的 `OpenAICompletionsCompat.thinkingFormat` + `Model.thinkingLevelMap`
 * (packages/ai/src/types.ts / api/openai-completions.ts)。刻意**不**照搬 PI 的 models.dev 生成式
 * catalog:那要引外部数据源 + 定期同步。这里是手写表,规则粒度到「host + 模型族」,够用且可读。
 *
 * 铁律:**未知端点绝不发未知字段**。严格网关见到不认识的 `enable_thinking` / `thinking` 会 400,
 * 所以族级规则只在 KNOWN_GATEWAY 白名单上生效,其余一律退到 prefix(只改系统提示,零协议风险)。
 */

import type { ThinkingLevel } from '../core/types.js';

// ── 档位词表 ────────────────────────────────────────────────────────────────

export type { ThinkingLevel };

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 思考「开」的档位,由弱到强(降档遍历用)。 */
export const THINKING_ON_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v);
}

/**
 * 脏值/旧值 → 合法档位。兼容早期的布尔开关(`enable_thinking`)与大小写/空白。
 * 落盘的 agent frontmatter、DB 里的历史值都从这里过一道。
 */
export function normalizeThinkingLevel(v: unknown, fallback: ThinkingLevel = 'medium'): ThinkingLevel {
  if (typeof v === 'boolean') return v ? 'medium' : 'off';
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  if (isThinkingLevel(s)) return s;
  if (s === 'none' || s === 'disabled' || s === 'false' || s === '0') return 'off';
  if (s === 'on' || s === 'enabled' || s === 'true') return 'medium';
  if (s === 'minimal_effort' || s === 'min') return 'minimal';
  if (s === 'ultra' || s === 'highest') return 'max';
  return fallback;
}

// ── 能力描述 ────────────────────────────────────────────────────────────────

/**
 * 思考参数的线上形态。每种对应 provider 家的一套字段:
 *   openai-effort      `reasoning_effort: <string>`(OpenAI / Gemini OpenAI 兼容层 / 多数网关)
 *   anthropic-budget   `thinking: {type:'enabled', budget_tokens:<n>}`(Claude 扩展思考)
 *   anthropic-effort   `thinking: {type:'adaptive'}` + `output_config: {effort}`(Claude 自适应档)
 *   gemini-budget      `generationConfig.thinkingConfig.thinkingBudget`(Gemini 原生 REST)
 *   qwen               `enable_thinking: <bool>` + `thinking_budget: <n>`(Qwen3 / DashScope)
 *   qwen-chat-template `chat_template_kwargs.enable_thinking`(vLLM/SGLang 托的 Qwen3)
 *   zai                `thinking: {type:'enabled'|'disabled'}`(智谱 GLM / z.ai)
 *   deepseek           同 zai 形状,但 reasoner 系自带思考走 none
 *   openrouter         `reasoning: {effort}`(OpenRouter 归一层)
 *   none               模型自带思考且不可调 —— 什么都不发
 *   prefix             无原生支持 —— 退到系统提示兜底(唯一不碰协议字段的形态)
 */
export type ThinkingFormat =
  | 'openai-effort'
  | 'anthropic-budget'
  | 'anthropic-effort'
  | 'gemini-budget'
  | 'qwen'
  | 'qwen-chat-template'
  | 'zai'
  | 'deepseek'
  | 'openrouter'
  | 'none'
  | 'prefix';

/**
 * 档位 → 线上取值。`null` = **该模型不支持此档**(须降档);缺键同 null。
 * 取值类型随 format:effort 类是字符串,budget 类是数字,开关类是布尔。
 */
export type LevelMap = Partial<Record<ThinkingLevel, string | number | boolean | null>>;

export interface ModelCapability {
  /** 命中的规则 id。排障/测试断言用——「为什么这个模型是这么发的」一眼可查。 */
  rule: string;
  format: ThinkingFormat;
  levels: LevelMap;
  /** max tokens 的字段名。OpenAI 推理模型只认 max_completion_tokens。 */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** 该端点拒收 temperature(OpenAI 推理模型:temperature≠1 报「insufficient permissions」)。 */
  dropTemperature?: boolean;
  /** 思考开时必须改道 /v1/responses(chat/completions + tools + effort 会被官方拒)。 */
  viaResponses?: boolean;
}

// ── 档位映射预设 ────────────────────────────────────────────────────────────

/**
 * OpenAI gpt-5.x 公开 API('none' 即关)。`max` 保守压到 'xhigh' —— 公开 API 的档位文档只到 xhigh,
 * 发未知值会 400;ChatGPT 后端另有 EFFORT_CODEX。
 */
const EFFORT_FULL: LevelMap = {
  off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh',
};

/** Codex 订阅(ChatGPT 后端)。档位取自 codex-rs 的 ReasoningEffort 枚举,'max' 是真档不是别名。 */
const EFFORT_CODEX: LevelMap = {
  off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

/** 只认 low/medium/high 的 effort 端点(o 系、Gemini 兼容层、多数网关):关不掉 → off:null。 */
const EFFORT_LMH: LevelMap = {
  off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/** 认 'none' 的 low/medium/high 端点(Gemini OpenAI 兼容层可关思考)。 */
const EFFORT_LMH_OFF: LevelMap = { ...EFFORT_LMH, off: 'none' };

/** OpenRouter 归一 effort:'minimal' 也认。 */
const EFFORT_OPENROUTER: LevelMap = {
  off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/** 纯开关型(zai / deepseek-chat / qwen 的 enable 位)。 */
const TOGGLE: LevelMap = {
  off: false, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};

/**
 * Claude 扩展思考的 token 预算。刻意取保守值:模型的 max output 各不相同(Opus 32k / Sonnet 64k),
 * 表里不存每模型上限,改由 applyThinking 用 `max_tokens - MIN_OUTPUT_TOKENS` 兜底夹紧。
 */
const CLAUDE_BUDGETS: LevelMap = {
  off: null, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768,
};

/** Claude 自适应思考档(Opus 4.7+ / Sonnet 5 起)。 */
const CLAUDE_EFFORT: LevelMap = {
  off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh',
};

/** Gemini thinkingBudget。-1 = 动态(模型自己决定深度),0 = 关。 */
const GEMINI_BUDGETS: LevelMap = {
  off: 0, minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: -1,
};

/** Qwen3 thinking_budget(官方区间 0–38912)。off 由 enable_thinking:false 表达。 */
const QWEN_BUDGETS: LevelMap = {
  off: false, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 38912,
};

/** 全档不可调(模型自带思考)。 */
const FIXED: LevelMap = {
  off: null, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};

// ── 规则表 ──────────────────────────────────────────────────────────────────

interface Rule {
  id: string;
  /** baseUrl 的 hostname 匹配。 */
  host?: RegExp;
  /** 直连 provider id / 托管 provider 名。 */
  provider?: RegExp;
  /** apiModelId(或 modelId)匹配。 */
  model?: RegExp;
  /** 直连协议标记(订阅登录路径:anthropic-messages / openai-responses)。 */
  protocol?: RegExp;
  cap: Omit<ModelCapability, 'rule'>;
}

/**
 * 已知「宽松」网关:允许在其上按**模型族**下发厂商私有字段(enable_thinking 等)。
 * 不在此列的端点一律只走 prefix —— 未知网关见到不认识的字段会 400,宁可不发。
 */
const KNOWN_GATEWAY =
  /(^|\.)(siliconflow\.cn|modelscope\.cn|aliyuncs\.com|openrouter\.ai|together\.(ai|xyz)|novita\.ai|deepinfra\.com|bigmodel\.cn|z\.ai|volces\.com|bailian\.aliyuncs\.com)$/i;

/** 模型 id 看着就自带思考(prefix 兜底时别再灌「一步步想」的废话)。 */
const SELF_REASONING = /(^|[-_/])(o\d|qwq|r1|reasoner|thinking|think|reasoning)([-_./]|$)/i;

const DEFAULT_CAP: Omit<ModelCapability, 'rule'> = {
  format: 'prefix',
  levels: TOGGLE,
  maxTokensField: 'max_tokens',
};

/** 首条命中即生效 —— 特例在前,族规则居中,兜底在后。 */
const RULES: Rule[] = [
  // ── 订阅登录(协议已定,不看 host)────────────────────────────────────────
  {
    // Codex 订阅(ChatGPT 额度)走 chatgpt.com/backend-api/codex/responses,支持完整 effort 档。
    // 此前 tuneOpenAiDirectPayload 见到 PROTOCOL_MARK 直接 return,导致订阅路径**永远拿不到档位**。
    id: 'codex-subscription',
    protocol: /^openai-responses$/,
    cap: { format: 'openai-effort', levels: EFFORT_CODEX, maxTokensField: 'max_completion_tokens', dropTemperature: true },
  },
  {
    // Claude 订阅(Claude Code 额度)走原生 /v1/messages。此前**完全没有** thinking 字段。
    id: 'claude-subscription',
    protocol: /^anthropic-messages$/,
    cap: { format: 'anthropic-budget', levels: CLAUDE_BUDGETS, maxTokensField: 'max_tokens' },
  },

  // ── OpenAI 官方 ────────────────────────────────────────────────────────
  {
    // gpt-5.x:chat/completions + tools 必须显式 'none';思考开只能改道 /v1/responses。
    // temperature≠1 被拒(错误文案是离谱的「insufficient permissions」);max_tokens 要换名。
    id: 'openai-gpt5',
    host: /(^|\.)api\.openai\.com$/,
    model: /^gpt-5/i,
    cap: {
      format: 'openai-effort', levels: EFFORT_FULL, maxTokensField: 'max_completion_tokens',
      dropTemperature: true, viaResponses: true,
    },
  },
  {
    // o 系:chat/completions 缺省档位即可带 tools,但**不认 'none'**(关不掉思考)。
    id: 'openai-o-series',
    host: /(^|\.)api\.openai\.com$/,
    model: /^o\d/i,
    cap: { format: 'openai-effort', levels: EFFORT_LMH, maxTokensField: 'max_completion_tokens', dropTemperature: true },
  },
  {
    // gpt-4o 等非推理模型:发 reasoning_effort 会被拒「Unrecognized request argument」。
    id: 'openai-nonreasoning',
    host: /(^|\.)api\.openai\.com$/,
    cap: { format: 'prefix', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },

  // ── Anthropic 原生 ─────────────────────────────────────────────────────
  {
    // Opus 4.7+ / Sonnet 5 / Fable 5 起支持自适应思考档(比 budget 更贴模型自身判断)。
    id: 'anthropic-adaptive',
    host: /(^|\.)api\.anthropic\.com$/,
    model: /(opus-4\.[7-9]|opus-[5-9]|sonnet-[5-9]|fable-[5-9])/i,
    cap: { format: 'anthropic-effort', levels: CLAUDE_EFFORT, maxTokensField: 'max_tokens' },
  },
  {
    id: 'anthropic-budget',
    host: /(^|\.)api\.anthropic\.com$/,
    model: /(claude-3-7|claude-(sonnet|opus|haiku)-4|claude-4)/i,
    cap: { format: 'anthropic-budget', levels: CLAUDE_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    // claude-3-5 及更早:无扩展思考。
    id: 'anthropic-legacy',
    host: /(^|\.)api\.anthropic\.com$/,
    cap: { format: 'prefix', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },
  {
    // 托管目录里的 anthropic/claude(baseUrl 可能是代理),按 provider 名走 budget。
    id: 'anthropic-provider',
    provider: /^(anthropic|claude)/i,
    cap: { format: 'anthropic-budget', levels: CLAUDE_BUDGETS, maxTokensField: 'max_tokens' },
  },

  // ── Google Gemini ──────────────────────────────────────────────────────
  {
    // 托管面走 Gemini 原生 REST(generationConfig)。2.5-pro 关不掉思考 → off:null。
    id: 'gemini-native-pro',
    provider: /^(gemini|google)/i,
    model: /2\.5-pro/i,
    cap: { format: 'gemini-budget', levels: { ...GEMINI_BUDGETS, off: null }, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gemini-native',
    provider: /^(gemini|google)/i,
    cap: { format: 'gemini-budget', levels: GEMINI_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    // 直连走 Google 的 OpenAI 兼容层,那边只认 reasoning_effort。
    id: 'gemini-openai-compat',
    host: /(^|\.)generativelanguage\.googleapis\.com$/,
    cap: { format: 'openai-effort', levels: EFFORT_LMH_OFF, maxTokensField: 'max_tokens' },
  },

  // ── 中国厂商直连 ───────────────────────────────────────────────────────
  {
    id: 'deepseek-reasoner',
    host: /(^|\.)deepseek\.com$/,
    model: /(reasoner|r1)/i,
    cap: { format: 'none', levels: FIXED, maxTokensField: 'max_tokens' },
  },
  {
    id: 'deepseek-chat',
    host: /(^|\.)deepseek\.com$/,
    cap: { format: 'deepseek', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },
  {
    // 智谱 GLM / z.ai:thinking:{type},**不认** reasoning_effort。
    id: 'zhipu-glm',
    host: /(^|\.)(bigmodel\.cn|z\.ai)$/,
    cap: { format: 'zai', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },
  {
    // 阿里百炼 DashScope:Qwen3 系 enable_thinking + thinking_budget。
    id: 'dashscope-qwen',
    host: /(^|\.)(dashscope\.aliyuncs\.com|dashscope-intl\.aliyuncs\.com|bailian\.aliyuncs\.com)$/,
    cap: { format: 'qwen', levels: QWEN_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    // Moonshot Kimi:thinking 模型自带,普通模型无档可调;两者都不认 reasoning_effort。
    id: 'moonshot-thinking',
    host: /(^|\.)moonshot\.(cn|ai)$/,
    model: /thinking/i,
    cap: { format: 'none', levels: FIXED, maxTokensField: 'max_tokens' },
  },
  {
    id: 'moonshot',
    host: /(^|\.)moonshot\.(cn|ai)$/,
    cap: { format: 'prefix', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },

  // ── 聚合网关 ───────────────────────────────────────────────────────────
  {
    id: 'openrouter',
    host: /(^|\.)openrouter\.ai$/,
    cap: { format: 'openrouter', levels: EFFORT_OPENROUTER, maxTokensField: 'max_tokens' },
  },
  {
    // xAI:grok-3-mini 只有 low/high 两档;grok-4 起不接受 reasoning_effort。
    id: 'xai-grok-mini',
    host: /(^|\.)x\.ai$/,
    model: /grok-3-mini/i,
    cap: {
      format: 'openai-effort',
      levels: { off: null, minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'high' },
      maxTokensField: 'max_tokens',
    },
  },
  {
    id: 'xai-grok',
    host: /(^|\.)x\.ai$/,
    cap: { format: 'none', levels: FIXED, maxTokensField: 'max_tokens' },
  },

  // ── 族规则(仅在已知宽松网关上生效)────────────────────────────────────
  {
    id: 'gateway-qwen3',
    host: KNOWN_GATEWAY,
    model: /qwen-?3|qwen3/i,
    cap: { format: 'qwen', levels: QWEN_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gateway-glm',
    host: KNOWN_GATEWAY,
    model: /glm-/i,
    cap: { format: 'zai', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gateway-self-reasoning',
    host: KNOWN_GATEWAY,
    model: SELF_REASONING,
    cap: { format: 'none', levels: FIXED, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gateway-generic',
    host: KNOWN_GATEWAY,
    cap: { format: 'openai-effort', levels: EFFORT_LMH_OFF, maxTokensField: 'max_tokens' },
  },
];

// ── 解析 ────────────────────────────────────────────────────────────────────

export interface CapabilityQuery {
  /** 端点根(直连的 provider.baseUrl / 托管的 default_base_url)。 */
  baseUrl?: string;
  /** provider id / 名。 */
  provider?: string;
  /** 发给厂商的真实模型 id(apiModelId 优先;没有就用 modelId)。 */
  modelId?: string;
  /** 直连协议标记(anthropic-messages / openai-responses)。 */
  protocol?: string;
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/** 端点 + 模型 → 能力。永远返回一条(兜底 prefix),调用方无需判空。 */
export function resolveModelCapability(q: CapabilityQuery): ModelCapability {
  const host = hostOf(q.baseUrl);
  const model = q.modelId || '';
  const provider = q.provider || '';
  const protocol = q.protocol || '';

  for (const r of RULES) {
    if (r.protocol && !r.protocol.test(protocol)) continue;
    if (r.host && !(host && r.host.test(host))) continue;
    if (r.provider && !r.provider.test(provider)) continue;
    if (r.model && !r.model.test(model)) continue;
    if (!r.protocol && !r.host && !r.provider && !r.model) continue; // 空规则不算命中
    return { rule: r.id, ...r.cap };
  }

  // 兜底:自带思考的模型别再灌 prefix 废话,其余给系统提示兜底。
  return SELF_REASONING.test(model)
    ? { rule: 'default-self-reasoning', format: 'none', levels: FIXED, maxTokensField: 'max_tokens' }
    : { rule: 'default', ...DEFAULT_CAP };
}

/** 该能力实际支持的档位(levels 里非 null 的)。UI 据此收窄可选项。 */
export function supportedThinkingLevels(cap: ModelCapability): ThinkingLevel[] {
  return THINKING_LEVELS.filter((l) => cap.levels[l] !== null && cap.levels[l] !== undefined);
}

/**
 * 把用户请求的档位夹到模型真支持的档上。
 * 规则:请求档可用就用;否则**先往下**找更弱的档(宁可少想别报错),下面没有再往上找;
 * 一个都没有 → 'off'。模型强制思考(off:null)时请求 off 会落到最弱的可用档。
 */
export function clampThinkingLevel(cap: ModelCapability, level: ThinkingLevel): ThinkingLevel {
  if (cap.levels[level] !== null && cap.levels[level] !== undefined) return level;
  if (level === 'off') return THINKING_ON_LEVELS.find((l) => cap.levels[l] != null) ?? 'off';
  const idx = THINKING_ON_LEVELS.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    const l = THINKING_ON_LEVELS[i];
    if (cap.levels[l] != null) return l;
  }
  for (let i = idx + 1; i < THINKING_ON_LEVELS.length; i++) {
    const l = THINKING_ON_LEVELS[i];
    if (cap.levels[l] != null) return l;
  }
  return cap.levels.off !== null && cap.levels.off !== undefined ? 'off' : 'off';
}

// ── 下发 ────────────────────────────────────────────────────────────────────

/** Claude 预算思考:留给正文的最小输出额度。 */
const MIN_OUTPUT_TOKENS = 1024;
/** 未指定 max_tokens 时,为预算思考补的上限(取所有 Claude 型号都吃得下的保守值)。 */
const CLAUDE_MAX_TOKENS_CEILING = 32000;

/** prefix 兜底的系统提示(英文——模型提示一律英文)。 */
const PREFIX_INSTRUCTIONS: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  minimal: 'Answer directly. Only pause to think when the question is genuinely ambiguous.',
  low: 'Before answering, briefly plan your approach in one or two sentences, then respond.',
  medium:
    'Think through the problem step by step before responding. Consider edge cases and alternatives, then give a clear answer.',
  high: 'Reason carefully and exhaustively before answering. Break the problem into sub-problems, evaluate multiple approaches, surface assumptions, then give a detailed, well-justified answer.',
  xhigh:
    'Reason exhaustively before answering. Decompose the problem, enumerate the approaches worth considering, stress-test each against edge cases and failure modes, state your assumptions explicitly, then give a detailed, well-justified answer.',
  max: 'Reason exhaustively before answering. Decompose the problem, enumerate every approach worth considering, stress-test each against edge cases and failure modes, actively look for what your first answer would miss, state your assumptions explicitly, then give a detailed, well-justified answer.',
};

export interface ApplyThinkingResult {
  /** 夹紧后实际生效的档位(可能 ≠ 请求档)。 */
  effective: ThinkingLevel;
  /** 是否需要把请求改道 /v1/responses。 */
  viaResponses: boolean;
}

/**
 * 把思考档位写进 **OpenAI 形态** payload(两条推理面在此汇合)。
 * Anthropic / Responses / Gemini 的真实请求体由各自的转换器读这些字段再翻译,
 * 所以「档位怎么算」只有这一处,「字段怎么翻」在各转换器 —— 职责不重叠。
 *
 * @param appendSystem prefix 形态用:把兜底指令拼进系统提示(两侧的系统提示表示法不同,由调用方给)
 */
export function applyThinking(
  payload: any,
  level: ThinkingLevel,
  cap: ModelCapability,
  appendSystem?: (text: string) => void,
): ApplyThinkingResult {
  // 字段名/温度这类 quirk 与档位无关,先无条件修正。
  if (cap.dropTemperature) delete payload.temperature;
  if (cap.maxTokensField === 'max_completion_tokens' && payload.max_tokens != null) {
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }

  const effective = clampThinkingLevel(cap, level);
  const wire = cap.levels[effective];
  const on = effective !== 'off';
  const result: ApplyThinkingResult = { effective, viaResponses: false };

  switch (cap.format) {
    case 'none':
      break; // 模型自带思考,发什么都是噪音

    case 'prefix':
      if (on) appendSystem?.(PREFIX_INSTRUCTIONS[effective as Exclude<ThinkingLevel, 'off'>]);
      break;

    case 'openai-effort':
      if (typeof wire === 'string') payload.reasoning_effort = wire;
      result.viaResponses = !!cap.viaResponses && on;
      break;

    case 'openrouter':
      if (typeof wire === 'string') payload.reasoning = { effort: wire };
      break;

    case 'anthropic-effort':
      if (!on) payload.thinking = { type: 'disabled' };
      else {
        payload.thinking = { type: 'adaptive' };
        if (typeof wire === 'string') payload.output_config = { effort: wire };
      }
      break;

    case 'anthropic-budget':
      if (!on) payload.thinking = { type: 'disabled' };
      else if (typeof wire === 'number') {
        // Claude 强制 max_tokens > budget_tokens。调用方给了上限就把预算夹进去,没给就补一个。
        const cap0 = typeof payload.max_tokens === 'number' && payload.max_tokens > 0 ? payload.max_tokens : 0;
        let budget = wire;
        if (cap0) {
          if (cap0 - MIN_OUTPUT_TOKENS < 1024) {
            payload.thinking = { type: 'disabled' }; // 额度小到装不下思考,老实关掉
            result.effective = 'off';
            break;
          }
          budget = Math.min(budget, cap0 - MIN_OUTPUT_TOKENS);
        } else {
          payload.max_tokens = Math.min(budget + 4096, CLAUDE_MAX_TOKENS_CEILING);
        }
        payload.thinking = { type: 'enabled', budget_tokens: budget };
      }
      break;

    case 'gemini-budget':
      if (typeof wire === 'number') {
        payload.generationConfig = payload.generationConfig || {};
        payload.generationConfig.thinkingConfig = { thinkingBudget: wire, includeThoughts: on };
      }
      break;

    case 'qwen':
      payload.enable_thinking = on;
      if (on && typeof wire === 'number') payload.thinking_budget = wire;
      break;

    case 'qwen-chat-template':
      payload.chat_template_kwargs = { enable_thinking: on, preserve_thinking: true };
      break;

    case 'zai':
    case 'deepseek':
      payload.thinking = { type: on ? 'enabled' : 'disabled' };
      break;
  }

  return result;
}
