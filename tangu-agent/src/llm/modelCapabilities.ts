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
 *   zai                `thinking: {type}`(智谱 GLM / z.ai;GLM-5.3 起再带 `reasoning_effort`)
 *   deepseek           与 zai 同形状(V4 起也带 `reasoning_effort`);reasoner 系自带思考走 none
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
  off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh',
};

/**
 * gpt-5.x-pro:官方模型页写死 **medium(最低)/ high(缺省)/ xhigh**,且**不支持 chat/completions**
 * (只有 Responses 与 Batch)。所以 off/minimal/low 一档都不能露 —— 露了就是确定性的 400。
 */
const EFFORT_PRO: LevelMap = {
  off: null, minimal: 'medium', low: 'medium', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh',
};

/** gpt-5.6 起的公开 API:'max' 是真档(5.5 的档表到 xhigh 为止)。 */
const EFFORT_FULL_MAX: LevelMap = { ...EFFORT_FULL, max: 'max' };

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

/**
 * Claude 自适应思考的 effort 档。官方五档 low < medium < high(缺省)< xhigh < max
 * —— `max` 是真档不是 xhigh 的别名(官方 effort 文档),旧表把 max 折成 xhigh 是白丢一档。
 * `off: false` → 发 `thinking:{type:'disabled'}`:Opus 4.7/4.8、Opus 5、Sonnet 5 都支持关思考
 * (旧表写 off:null,导致「关闭思考」这一档在 Claude 上根本点不到)。
 */
const CLAUDE_EFFORT: LevelMap = {
  off: false, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

/** Fable 5 / Mythos:官方模型表标的是 Adaptive **(always on)** —— 思考关不掉,off 只能夹到 low。 */
const CLAUDE_EFFORT_ALWAYS_ON: LevelMap = { ...CLAUDE_EFFORT, off: null };

/** Gemini thinkingBudget。-1 = 动态(模型自己决定深度),0 = 关。 */
const GEMINI_BUDGETS: LevelMap = {
  off: 0, minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: -1,
};

/**
 * ⚠️ Qwen3.8 系(max/flash)的 thinking_budget 是**另一个量级**:官方 OpenAI 兼容文档给的是
 * **0–262144、缺省 131072**,并附 effort 对照 low=4096 / medium=16384 / xhigh=262144。
 * 拿下面那张 3.x 的表(上限 32768)套 3.8,等于把最高档压到缺省值的 1/4 —— 静默降智,比报错难发现。
 * high=65536 是文档没给的一档,按 medium 与 xhigh 之间插值取的,仍在合法区间内。
 * ⚠️ 官方同时注明 reasoning_effort 与 thinking_budget **不能同发**(同发报错),故这里只发 budget。
 */
const QWEN38_BUDGETS: LevelMap = {
  off: false, minimal: 1024, low: 4096, medium: 16384, high: 65536, xhigh: 262144, max: 262144,
};

/**
 * Qwen3 / Qwen3.7 的 thinking_budget。官方「深度思考」文档区间 **1–32768**,
 * 旧表的 38912 是 Qwen3 首发时的上限,已超出——超上限的值要么被静默夹、要么 400,一律按新上限发。
 * off 由 enable_thinking:false 表达。
 */
const QWEN_BUDGETS: LevelMap = {
  off: false, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 32768,
};

/**
 * 只认 low/high/max 三档的 effort 端点(DeepSeek V4 / GLM-5.3)。七档往下折,宁可少想也不发未知值。
 * `off: null` = 思考关不掉(GLM-5.3 就是),能关的族在自己的表里把 off 覆盖回去。
 */
const EFFORT_LHM: LevelMap = {
  off: null, minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max',
};

/**
 * DeepSeek V4:`thinking:{type}` 开关 + `reasoning_effort`,官方只认 low/high/max
 * (v4-flash 三档齐全;v4-pro 目前把 low 当 high、xhigh 当 max —— 发 low 安全,不会 400)。
 */
const DEEPSEEK_EFFORT: LevelMap = { ...EFFORT_LHM, off: false };

/**
 * GLM-5.2 的 effort 词表是各家里最全的(none/minimal/low/medium/high/xhigh/max,缺省 **max**),
 * 与 Tangu 七档一一对上,原样发即可(官方说明 low/medium 内部归 high、xhigh 归 max,不必预折)。
 * off 走 thinking:{type:'disabled'}(5.2 仍可关思考),那一格的 wire 值不会真上线。
 */
const GLM52_EFFORT: LevelMap = {
  off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

/**
 * 火山方舟豆包:`reasoning_effort` 认 minimal/low/medium/high(**minimal = 不思考**),**不认 'none'**。
 * 此前 volces.com 落在 gateway-generic 的通用 effort 表上,关思考时发的恰恰是它不认的 'none'。
 */
const DOUBAO_EFFORT: LevelMap = {
  off: 'minimal', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/** 强制思考(关不掉)且深度不可调:只发 thinking:{type:'enabled'},请求 off 夹到最弱档。 */
const TOGGLE_ALWAYS_ON: LevelMap = { ...TOGGLE, off: null };

/** 全档不可调(模型自带思考)。 */
const FIXED: LevelMap = {
  off: null, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};

// ── 规则表 ──────────────────────────────────────────────────────────────────

interface Rule {
  id: string;
  /** baseUrl 的 hostname 匹配。 */
  host?: RegExp;
  /** baseUrl 的**路径**匹配。同 host 不同协议面时唯一的区分手段(Gemini 原生 REST vs /v1beta/openai)。 */
  urlPath?: RegExp;
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

/**
 * Claude「自适应思考」族 = Opus 4.7 起 + Claude 5 家族(Sonnet/Opus/Fable/Mythos 5)。
 * 这些模型上手动扩展思考 `thinking:{type:'enabled',budget_tokens}` **返回 400**(官方迁移指南),
 * 不是降级——所以命中就必须走 anthropic-effort,不能退到 budget。
 *
 * ⚠️ 版本段要同时认 `-` 与 `.`:官方模型 id 是**连字符**形态(`claude-opus-4-7`),旧规则只写了
 * `opus-4\.[7-9]`(点),真 id 一个都不命中 → 静默落到 budget 规则 → 整条链路 400。
 * `([5-9]|\d\d)` 是给两位小版本留的口子(4.10 / sonnet-10 之类),别再按单个数字钉。
 */
const CLAUDE_ADAPTIVE = /(sonnet|opus|fable|mythos)-([5-9]|\d\d)|opus-4[-.]([7-9]|\d\d)|mythos-preview/i;

/** 其中思考常开、关不掉的那几支(官方模型表 Thinking = Adaptive (always on))。 */
const CLAUDE_ALWAYS_ON = /(fable|mythos)-([5-9]|\d\d)|mythos-preview/i;

/**
 * 自适应族的能力(三个入口——自有 key 的 host / 订阅协议 / 托管 provider——共用同一份,
 * 三处各写一遍正是本轮修的漂移:协议入口与托管入口此前对 Claude 5 仍发 budget_tokens)。
 * dropTemperature:Sonnet 5 明确「temperature/top_p/top_k 非默认值返回 400」;Opus 4.7/4.8
 * 官方没逐条写,这里按同族推断一起丢——丢了只是失去采样调节(静默),留着可能整请求 400。
 */
const CLAUDE_ADAPTIVE_CAP: Omit<ModelCapability, 'rule'> = {
  format: 'anthropic-effort', levels: CLAUDE_EFFORT, maxTokensField: 'max_tokens', dropTemperature: true,
};
const CLAUDE_ALWAYS_ON_CAP: Omit<ModelCapability, 'rule'> = { ...CLAUDE_ADAPTIVE_CAP, levels: CLAUDE_EFFORT_ALWAYS_ON };

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
    id: 'anthropic-messages-always-on',
    protocol: /^anthropic-messages$/,
    model: CLAUDE_ALWAYS_ON,
    cap: CLAUDE_ALWAYS_ON_CAP,
  },
  {
    // Claude 5 / Opus 4.7+ 走自适应。老规则不看模型一律 budget → 这些模型上 400。
    id: 'anthropic-messages-adaptive',
    protocol: /^anthropic-messages$/,
    model: CLAUDE_ADAPTIVE,
    cap: CLAUDE_ADAPTIVE_CAP,
  },
  {
    // Anthropic 原生 /v1/messages(用户自有 API key)。此前**完全没有** thinking 字段。
    // 留给 Sonnet 4.6 / Opus 4.5-4.6 / Haiku 4.5 这些仍走手动扩展思考的型号。
    id: 'anthropic-messages',
    protocol: /^anthropic-messages$/,
    cap: { format: 'anthropic-budget', levels: CLAUDE_BUDGETS, maxTokensField: 'max_tokens' },
  },

  // ── OpenAI 官方 ────────────────────────────────────────────────────────
  {
    // gpt-5.x-pro:档位表只到 medium 起步,且**不能走 chat/completions** —— 永远改道 Responses。
    // 必须排在下面两条 gpt-5 规则之前,否则 pro 会拿到含 off/minimal/low 的通用档表(必 400)。
    id: 'openai-gpt5-pro',
    host: /(^|\.)api\.openai\.com$/,
    model: /^gpt-5(\.\d+)?-pro/i,
    cap: {
      format: 'openai-effort', levels: EFFORT_PRO, maxTokensField: 'max_completion_tokens',
      dropTemperature: true, viaResponses: true,
    },
  },
  {
    // gpt-5.6 起官方 effort 表是 none/low/medium/high/xhigh/max —— `max` 成了真档(旧表折成 xhigh
    // 是白丢一档);而 'minimal' 在 5.6 的档位表里查不到(与通用 reasoning 指南的全量列表冲突),
    // 冲突按保守解:minimal 折到 'low' —— 少想不报错,发未知值会 400。其余 quirk 与 gpt-5 同。
    // 刻意只认 5.6-5.9:不给还没出的 gpt-6 预支档位(未命中会落到下面的保守规则,不会失败)。
    id: 'openai-gpt5-latest',
    host: /(^|\.)api\.openai\.com$/,
    model: /^gpt-5\.[6-9]/i,
    cap: {
      format: 'openai-effort', levels: EFFORT_FULL_MAX, maxTokensField: 'max_completion_tokens',
      dropTemperature: true, viaResponses: true,
    },
  },
  {
    // gpt-5.0–5.5(5.6 起走上面的 openai-gpt5-latest,那边多一档真 max):
    // chat/completions + tools 必须显式 'none';思考开只能改道 /v1/responses。
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
    id: 'anthropic-always-on',
    host: /(^|\.)api\.anthropic\.com$/,
    model: CLAUDE_ALWAYS_ON,
    cap: CLAUDE_ALWAYS_ON_CAP,
  },
  {
    id: 'anthropic-adaptive',
    host: /(^|\.)api\.anthropic\.com$/,
    model: CLAUDE_ADAPTIVE,
    cap: CLAUDE_ADAPTIVE_CAP,
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
    id: 'anthropic-provider-always-on',
    provider: /^(anthropic|claude)/i,
    model: CLAUDE_ALWAYS_ON,
    cap: CLAUDE_ALWAYS_ON_CAP,
  },
  {
    id: 'anthropic-provider-adaptive',
    provider: /^(anthropic|claude)/i,
    model: CLAUDE_ADAPTIVE,
    cap: CLAUDE_ADAPTIVE_CAP,
  },
  {
    // 托管目录里的 anthropic/claude(baseUrl 可能是代理),4.6 及更早按 provider 名走 budget。
    id: 'anthropic-provider',
    provider: /^(anthropic|claude)/i,
    cap: { format: 'anthropic-budget', levels: CLAUDE_BUDGETS, maxTokensField: 'max_tokens' },
  },

  // ── Google Gemini ──────────────────────────────────────────────────────
  // ⚠️ 顺序:兼容层(/v1beta/openai)在前,原生 REST 在后。两者**同一个 host**,只有路径能区分;
  // 而托管面同时传 provider 与 baseUrl —— 若把 provider 规则放前面,配了兼容层地址的直连/托管
  // provider 会拿到原生 generationConfig 字段,兼容层根本不认(档位静默失效)。
  {
    id: 'gemini-openai-compat-3',
    host: /(^|\.)generativelanguage\.googleapis\.com$/,
    urlPath: /\/openai(\/|$)/,
    model: /gemini-3/i,
    cap: { format: 'openai-effort', levels: EFFORT_LMH, maxTokensField: 'max_tokens' },
  },
  {
    // 直连走 Google 的 OpenAI 兼容层,那边只认 reasoning_effort。
    id: 'gemini-openai-compat',
    host: /(^|\.)generativelanguage\.googleapis\.com$/,
    urlPath: /\/openai(\/|$)/,
    cap: { format: 'openai-effort', levels: EFFORT_LMH_OFF, maxTokensField: 'max_tokens' },
  },
  {
    // 托管面走 Gemini 原生 REST(generationConfig)。关不掉思考的那几支 → off:null:
    // 2.5-pro,以及整个 3.x 线(官方 thinking 文档:3.1 Pro 明确不能关,3 Flash / Flash-Lite
    // 也不支持完全关闭)。thinkingBudget 本身在 3.x 上仍向后兼容(3 系开发指南),故只改 off 一格,
    // 不迁 thinking_level —— 那套各型号档位还不一致(3.7-flash 不认 minimal),现在迁是净增风险。
    id: 'gemini-native-nodisable',
    provider: /^(gemini|google)/i,
    model: /2\.5-pro|gemini-3/i,
    cap: { format: 'gemini-budget', levels: { ...GEMINI_BUDGETS, off: null }, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gemini-native',
    provider: /^(gemini|google)/i,
    cap: { format: 'gemini-budget', levels: GEMINI_BUDGETS, maxTokensField: 'max_tokens' },
  },

  // ── 中国厂商直连 ───────────────────────────────────────────────────────
  {
    // DeepSeek V4(deepseek-v4-flash / deepseek-v4-pro):思考默认开,可用 thinking:{type} 关,
    // 深度用 reasoning_effort 调 —— 不再是「reasoner 系不可调 / chat 系只有开关」的老形态。
    // 老 id deepseek-chat / deepseek-reasoner 仍指向 v4-flash 的非思考 / 思考模式(官方标注下线),
    // 但它们**用模型名选模式**,故仍按下面两条老规则走,不套 effort。
    // 锚定 `deepseek-v4` 前缀而非裸 /v4/:后者在本 host 上会误吞 `myv4legacy` 这类自定义 id
    // (2026-08-03 Codex 评审)。留开放后缀是有意的——官方带日期/别名的 v4-* 变体应继续命中本规则。
    id: 'deepseek-v4',
    host: /(^|\.)deepseek\.com$/,
    model: /^deepseek-v4/i,
    cap: { format: 'deepseek', levels: DEEPSEEK_EFFORT, maxTokensField: 'max_tokens' },
  },
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
    // GLM-5.3 / 5.3-flash:思考**强制常开** —— 官方已不支持 `thinking:{type:'disabled'}`(发了直接失败),
    // 深度改由 `reasoning_effort: low|high|max` 控,**缺省 max**。所以这条规则有两个职责:
    //   ① off:null —— 用户拨「关」被夹到最弱的 low,而不是发一个必然失败的 disabled;
    //   ② 把档位真发出去 —— 不发就是每次都按最贵的 max 跑(拨了低档静默烧钱,正是本表要防的失败模式)。
    // GLM-5.2 及更早仍可关思考,继续走下面的 zhipu-glm 老规则(它们的 effort 词表也不同,不合并)。
    id: 'zhipu-glm53',
    host: /(^|\.)(bigmodel\.cn|z\.ai)$/,
    model: /glm-5\.3/i,
    cap: { format: 'zai', levels: EFFORT_LHM, maxTokensField: 'max_tokens' },
  },
  {
    // GLM-5.2:七档 effort 全支持(官方词表 none/minimal/low/medium/high/xhigh/max,缺省 max)。
    // 不发 = 一直按最贵的 max 跑;和 5.3 是同一类静默烧钱,只是它还能关思考。
    id: 'zhipu-glm52',
    host: /(^|\.)(bigmodel\.cn|z\.ai)$/,
    model: /glm-5\.2/i,
    cap: { format: 'zai', levels: GLM52_EFFORT, maxTokensField: 'max_tokens' },
  },
  {
    // GLM-4.7 / GLM-4.5V:官方深度思考对照表列为「强制思考,不可关闭」,但 5.1 及以下**不支持**
    // reasoning_effort —— 所以只有开关的一半:能开不能关,也没有深度档。
    id: 'zhipu-glm-always-on',
    host: /(^|\.)(bigmodel\.cn|z\.ai)$/,
    model: /glm-(4\.7|4\.5v)/i,
    cap: { format: 'zai', levels: TOGGLE_ALWAYS_ON, maxTokensField: 'max_tokens' },
  },
  {
    // 智谱 GLM(5.1 及更早的可关线):thinking:{type} 纯开关,**不认** reasoning_effort。
    id: 'zhipu-glm',
    host: /(^|\.)(bigmodel\.cn|z\.ai)$/,
    cap: { format: 'zai', levels: TOGGLE, maxTokensField: 'max_tokens' },
  },
  {
    // 百炼上的**纯思考**模型(官方:「纯思考模型无此参数」)—— qwen3.7-max 的两支 preview 快照,
    // 以及带 -thinking 后缀的型号。给它们发 enable_thinking 是发未知字段,一律什么都不发。
    id: 'dashscope-qwen-pure',
    host: /(^|\.)(dashscope\.aliyuncs\.com|dashscope-intl\.aliyuncs\.com|bailian\.aliyuncs\.com)$/,
    model: /qwen3\.7-max-(preview|2026-05-17)|thinking/i,
    cap: { format: 'none', levels: FIXED, maxTokensField: 'max_tokens' },
  },
  {
    // Qwen3.8 系:预算量级与 3.x 完全不同(见 QWEN38_BUDGETS)。
    id: 'dashscope-qwen38',
    host: /(^|\.)(dashscope\.aliyuncs\.com|dashscope-intl\.aliyuncs\.com|bailian\.aliyuncs\.com)$/,
    model: /qwen3\.8/i,
    cap: { format: 'qwen', levels: QWEN38_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    // 阿里百炼 DashScope:Qwen3 系 enable_thinking + thinking_budget。
    id: 'dashscope-qwen',
    host: /(^|\.)(dashscope\.aliyuncs\.com|dashscope-intl\.aliyuncs\.com|bailian\.aliyuncs\.com)$/,
    cap: { format: 'qwen', levels: QWEN_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    // Kimi K3(2026-07):思考常开不可关,深度用**顶层** reasoning_effort(low/high/max,缺省 max)。
    // 老规则把它当普通 moonshot 模型走 prefix —— 一个协议字段都不发 = 永远跑最贵的 max 档。
    id: 'moonshot-k3',
    host: /(^|\.)moonshot\.(cn|ai)$/,
    model: /^kimi-k3/i,
    cap: { format: 'openai-effort', levels: EFFORT_LHM, maxTokensField: 'max_tokens' },
  },
  {
    // 火山方舟(豆包 Doubao):thinking:{type} 与 reasoning_effort 都收,但 effort 词表是
    // minimal/low/medium/high(minimal 即不思考),**没有 'none'**。此前它只被 KNOWN_GATEWAY
    // 的通用规则兜着,关思考时发的正是 'none'。只发 effort 一个字段,不叠 thinking:{type}。
    // ⚠️ 必须带 model 条件:方舟上还转售 GLM / DeepSeek / Kimi / Qwen,只按 host 命中会把它们
    // 全部吞掉(它们本该落到后面的模型族规则),等于给它们发豆包专用的 effort 词表。
    id: 'volcengine-doubao',
    host: /(^|\.)volces\.com$/,
    model: /doubao/i,
    cap: { format: 'openai-effort', levels: DOUBAO_EFFORT, maxTokensField: 'max_tokens' },
  },
  {
    // Moonshot Kimi(K2 及更早):thinking 模型自带,普通模型无档可调;两者都不认 reasoning_effort。
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
    // OpenRouter 归一层用 effort:'none' 表达关思考,但对模型元数据里 `mandatory: true`
    // (思考不可关)的型号会被上游拒。保持 openrouter 形态不变,只把 off 这一格关掉。
    id: 'openrouter-mandatory-reasoning',
    host: /(^|\.)openrouter\.ai$/,
    model: /glm-5\.3|kimi-k3|gemini-3|grok-4\.[5-9]/i,
    cap: { format: 'openrouter', levels: { ...EFFORT_OPENROUTER, off: null }, maxTokensField: 'max_tokens' },
  },
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
    // grok-4.5 / 4.6:reasoning_effort 又回来了(4.5 认 low/medium/high;4.6 起多一档 xhigh,
    // 且官方明说不支持 xhigh 的型号**把它当 high 处理**、不报错 —— 故一条规则覆盖两代够用)。
    // 思考不可关 → off:null。grok-4 与 grok-4.20-reasoning/non-reasoning 收到该参数会**报错**,
    // 继续落下面的 'none' 兜底(default-deny:没实证的型号一律不发)。
    id: 'xai-grok-effort',
    host: /(^|\.)x\.ai$/,
    model: /grok-4\.[5-9]/i,
    cap: {
      format: 'openai-effort',
      levels: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
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
    id: 'gateway-qwen38',
    host: KNOWN_GATEWAY,
    model: /qwen-?3\.8/i,
    cap: { format: 'qwen', levels: QWEN38_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gateway-qwen3',
    host: KNOWN_GATEWAY,
    model: /qwen-?3|qwen3/i,
    cap: { format: 'qwen', levels: QWEN_BUDGETS, maxTokensField: 'max_tokens' },
  },
  {
    // 网关转售的 GLM-5.3(`zai-org/GLM-5.3` 之类):同样关不掉思考,同样要发 effort。
    // ⚠️ 本段整体在 `openrouter` 规则之后 —— OpenRouter 上的 glm-5.3 继续走它的 reasoning:{effort} 归一层。
    id: 'gateway-glm53',
    host: KNOWN_GATEWAY,
    model: /glm-5\.3/i,
    cap: { format: 'zai', levels: EFFORT_LHM, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gateway-glm52',
    host: KNOWN_GATEWAY,
    model: /glm-5\.2/i,
    cap: { format: 'zai', levels: GLM52_EFFORT, maxTokensField: 'max_tokens' },
  },
  {
    id: 'gateway-glm-always-on',
    host: KNOWN_GATEWAY,
    model: /glm-(4\.7|4\.5v)/i,
    cap: { format: 'zai', levels: TOGGLE_ALWAYS_ON, maxTokensField: 'max_tokens' },
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

function pathOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).pathname;
  } catch {
    return '';
  }
}

/** 端点 + 模型 → 能力。永远返回一条(兜底 prefix),调用方无需判空。 */
export function resolveModelCapability(q: CapabilityQuery): ModelCapability {
  const host = hostOf(q.baseUrl);
  const urlPath = pathOf(q.baseUrl);
  const model = q.modelId || '';
  const provider = q.provider || '';
  const protocol = q.protocol || '';

  for (const r of RULES) {
    if (r.protocol && !r.protocol.test(protocol)) continue;
    if (r.host && !(host && r.host.test(host))) continue;
    if (r.urlPath && !r.urlPath.test(urlPath)) continue;
    if (r.provider && !r.provider.test(provider)) continue;
    if (r.model && !r.model.test(model)) continue;
    if (!r.protocol && !r.host && !r.provider && !r.model && !r.urlPath) continue; // 空规则不算命中
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

    // 两家线上形态字面相同(历史上分开写,DeepSeek V4 与 GLM-5.3 先后加了 effort 后已无差异)。
    // 深度可调的族在 levels 里给字符串档;老的纯开关族 levels 是布尔 → 只发开关,不发未知字段。
    case 'zai':
    case 'deepseek':
      payload.thinking = { type: on ? 'enabled' : 'disabled' };
      if (on && typeof wire === 'string') payload.reasoning_effort = wire;
      break;
  }

  return result;
}

// ── 视觉(图像识别)能力 ──────────────────────────────────────────────────────
/**
 * **黑名单制**:2026 年的主流对话模型绝大多数原生多模态,所以默认当作**有视觉**,只登记已知的
 * 纯文本族。误判方向是刻意选的——判错「有视觉」→ 图发过去 provider 直接报错(用户立刻看得见);
 * 判错「无视觉」→ 白跑一次辅助模型、丢掉原图细节(静默劣化,最难发现)。宁可默认放行。
 *
 * 覆盖顺序:显式 override(托管面 admin 在模型上标 supportsVision=false / 直连 provider 的
 * noVisionModelIds)> 本表。表刻意保持短:新模型不断出,靠标注比靠猜准。
 *
 * ⚠️**同族规则不要钉版本号**。原来写 `deepseek-(chat|coder|reasoner|v3|r1)`,DeepSeek-V4-Pro
 * 一出就漏网,被判成能看图 → 整 run 以「The model is not a VLM」报废(2026-08-04 实例)。
 * 一整族都没视觉的,按族写 + 反查排除已知的视觉分支,别按型号枚举。
 */
const NO_VISION_PATTERNS: readonly RegExp[] = [
  /(^|[-_])(embedding|embed|rerank|reranker|tts|whisper|moderation)([-_.]|$)/i, // 非对话模型
  /^gpt-3\.5/i,
  /^o1-(mini|preview)/i,
  /^(text|davinci|babbage|curie|ada)-/i,
  // DeepSeek 官方线整族纯文本,除两支视觉分支:deepseek-vl*(不在官方 API)与 2026-08 上线的
  // `deepseek-v4-flash-vision-exp`(官方 API 现役,支持图像输入)。后者被族规则吞掉 = 静默劣化
  // (白跑辅助模型 + 丢原图),正是本表最不愿意的误判方向,故按能力反查排除而非按型号枚举。
  /^deepseek-(?!vl|.*vision)/i,
  // GLM-5.3 官方文档明写「目前仅支持处理文本模态信息」。**但 5.3-Flash 是原生多模态**
  // (GLM-5 系首个原生多模态模型,收图片/视频)—— 同族里一支纯文本一支能看图,必须反查排除,
  // 否则把 Flash 判成无视觉 = 白跑辅助模型 + 丢原图(静默劣化,本表最不愿意的方向)。
  /^glm-5\.3(?!-flash)($|[-.])/i,
  /(^|[-_])qwq([-_.]|$)/i, // QwQ 推理模型纯文本
];

/**
 * 模型是否能直接「看」图。override 来自后端标注(null/undefined = 没标注 → 查表)。
 *
 * ⚠️只拿**裸模型名**(最后一个 `/` 之后)去匹配,绝不匹配 providerId 段:
 * `text-generation-webui/llava-v1.6-mistral-7b` 是个货真价实的视觉模型,匹配全串会被 `text-`
 * 规则误杀(2026-07-27 Codex 评审实例)。反过来「命名里带分隔符的别名漏网」(`azure-gpt-3.5-turbo`)
 * 是**刻意接受**的:漏网 → 图发过去 provider 报错,用户当场看得见;误伤 → 静默劣化。见上方误判方向。
 */
export function modelSupportsVision(modelId: string, override?: boolean | null): boolean {
  if (typeof override === 'boolean') return override;
  const id = (modelId || '').trim();
  if (!id) return true; // 未知模型不拦(见上:默认放行)
  const bare = id.slice(id.lastIndexOf('/') + 1);
  return !NO_VISION_PATTERNS.some((re) => re.test(bare));
}
