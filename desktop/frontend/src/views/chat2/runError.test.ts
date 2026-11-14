/**
 * 订阅直连(codex / xai)凭证过期的识别。
 *
 * 钉住两条不变式:
 * 1. 上游那句英文必须被翻译(此前它未命中任何规则 → 原样甩给用户看英文);
 * 2. 「重新登录」按钮只在**确实是订阅直连**时出现 —— 导错登录入口比不给按钮更坏,
 *    所以 Forsion 云端 / BYO-key 的鉴权错误一律不给。
 */
import { describe, expect, it } from 'vitest'
import { humanizeRunError, subLoginProvider } from './EditorialMessage'

// 用户实测报的原句(codex 直连;xAI 同样句式)
const UPSTREAM = 'Provided authentication token is expired. Please try signing in again.'
const t = (k: string) => k // 只关心命中了哪个 key,不关心译文本身

describe('订阅登录过期', () => {
  it('上游原句命中 chat.err.subExpired,而不是笼统的 chat.err.auth', () => {
    expect(humanizeRunError(UPSTREAM, t)).toContain('chat.err.subExpired')
  })

  it('原文保留在括号里供排查', () => {
    expect(humanizeRunError(UPSTREAM, t)).toContain(UPSTREAM)
  })

  it('模型 id 前缀 = provider id', () => {
    expect(subLoginProvider(UPSTREAM, 'codex/gpt-5.6-sol')).toBe('codex')
    expect(subLoginProvider(UPSTREAM, 'xai/grok-3')).toBe('xai')
  })

  it('不是订阅直连的模型 → 不给按钮(免得把人导去重登直连账号)', () => {
    expect(subLoginProvider(UPSTREAM, 'forsion/claude-sonnet-5')).toBeNull()
    expect(subLoginProvider(UPSTREAM, 'gpt-4o')).toBeNull() // 无前缀
    expect(subLoginProvider(UPSTREAM, undefined)).toBeNull()
  })

  it('别的鉴权错误不算订阅过期 —— Forsion 自家 token 过期要走 /login,不是重登直连账号', () => {
    expect(subLoginProvider('401 Unauthorized', 'codex/gpt-5.6-sol')).toBeNull()
    expect(subLoginProvider('invalid api key', 'codex/gpt-5.6-sol')).toBeNull()
    expect(humanizeRunError('401 Unauthorized', t)).toContain('chat.err.auth')
  })
})

describe('远程设备驱动外部引擎(契约 C6)', () => {
  it('engine_unavailable_remote 命中专门文案,原码留在括号里', () => {
    const out = humanizeRunError('engine_unavailable_remote', t)
    expect(out).toContain('chat.err.engineRemote')
    expect(out).toContain('engine_unavailable_remote')
  })
  it('本机的 engine_unavailable:<id>(引擎被移除)不误判成远程', () => {
    expect(humanizeRunError('engine_unavailable:codex', t)).not.toContain('chat.err.engineRemote')
  })
})

describe('额度用完 ≠ 限流', () => {
  // 引擎 openaiResponses 把 Codex usage_limit_reached 拼成这样(真实报文没有「429」字样)
  const CODEX = 'The usage limit has been reached (resets in ~45 min, at 2099-10-28T11:40:00.000Z)'
  const tv = (k: string, v?: Record<string, unknown>) => (v?.time ? `${k}[${v.time}]` : k)
  it('Codex 订阅额度用完:说额度用完并带重置时刻,不说限流', () => {
    const out = humanizeRunError(CODEX, tv)
    expect(out).toMatch(/^chat\.err\.quotaUsedAt\[/)
    expect(out).not.toContain('chat.err.rate')
  })
  it('账单配额(insufficient_quota)也是额度用完;秒级 429 仍是限流', () => {
    expect(humanizeRunError('429 insufficient_quota: You exceeded your current quota', tv)).toMatch(/^chat\.err\.quotaUsed\(/)
    expect(humanizeRunError('429 Too Many Requests: rate limit', tv)).toMatch(/^chat\.err\.rate\(/)
  })
  it('一分钟窗口的「quota exceeded」是限流', () => {
    expect(humanizeRunError('429 Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_minute_per_base_model', tv)).toMatch(/^chat\.err\.rate\(/)
    expect(humanizeRunError('Allocated quota exceeded, please increase your quota limit.', tv)).toMatch(/^chat\.err\.rate\(/)
  })
  it('「先问我」的尾巴不给人看', () => {
    expect(humanizeRunError('usage_limit_reached [quota_fallback_ask:forsion/auto]', tv)).not.toContain('quota_fallback_ask')
  })
})

describe('外部引擎的当前模型缺 API key(DSH 只用账号登录、不选模型时每一句都这样失败)', () => {
  // DSH 0.2.2-rc.3 的原话,和引擎换成的那一句 —— 与 tangu-agent/src/engines/acpEngine.credential.test.ts 里断言的是同一句,两边一起改。
  const DSH_RAW = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment'
  const WITH_OTHERS = 'engine_model_no_api_key {"engine":"Fake Harness","model":"deepseek-v4-flash","others":["DeepSeek-V4.1-Flash","DeepSeek-V4-Pro"]}: Fake Harness needs an API key for its current model ("deepseek-v4-flash") and none is set up. '
    + 'Pick another model in the model menu and send again. Other models it offers include: "DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro". '
    + `[${DSH_RAW}]`
  const NO_OTHERS = 'engine_model_no_api_key {"engine":"Fake Harness","model":"deepseek-v4-flash","others":[]}: Fake Harness needs an API key for its current model ("deepseek-v4-flash") and none is set up. '
    + 'It offers no other model: sign in or add an API key in Fake Harness itself, then send again. '
    + `[${DSH_RAW}]`
  // 把传进来的变量也印出来:看得到引擎名、当前模型、可以换的模型有没有进到译文里
  const tv = (k: string, v?: Record<string, unknown>) => (k === 'chat.err.listSep' ? ' | ' : v ? `${k}${JSON.stringify(v)}` : k)

  it('有别的模型可换:点名引擎、当前模型和能换成哪些;括号里只留引擎的原话', () => {
    expect(humanizeRunError(WITH_OTHERS, tv)).toBe(
      `chat.err.engineModelNoKeyPick${JSON.stringify({ engine: 'Fake Harness', model: 'deepseek-v4-flash', others: 'DeepSeek-V4.1-Flash | DeepSeek-V4-Pro' })}(${DSH_RAW})`,
    )
  })

  it('没有别的模型:说去引擎那边登录或填 key,不叫人换模型', () => {
    const out = humanizeRunError(NO_OTHERS, tv)
    expect(out.startsWith('chat.err.engineModelNoKeyOnly{')).toBe(true)
    expect(out).toContain('"engine":"Fake Harness"')
    expect(out.endsWith(`(${DSH_RAW})`)).toBe(true)
  })

  it('句式被截断拆不开:给不点名的说法,整句留在括号里;不落到别的规则上', () => {
    const cut = WITH_OTHERS.slice(0, 140)
    expect(humanizeRunError(cut, t)).toBe(`chat.err.engineModelNoKey(${cut})`)
  })

  it('DSH 的原话没经引擎换过(老引擎):原样透出,不冒认', () => {
    expect(humanizeRunError(DSH_RAW, t)).toBe(DSH_RAW)
  })
})

describe('缺 API key 的码只认整句开头', () => {
  it('别的报错里引到这几个字,照原来的规则走', () => {
    const raw = 'Internal error: failed to read configuration field "engine_model_no_api_key:"'
    expect(humanizeRunError(raw, t)).toBe(raw)
  })
})

describe('会员档位用不了这个模型(model_tier_locked)', () => {
  const tv = (k: string, v?: Record<string, unknown>) => (v?.model ? `${k}:${v.model}` : k)
  it('裸码 → 用会话模型名说人话,不再挂机器码;不会被通用 403 规则抢走', () => {
    expect(humanizeRunError('model_tier_locked', tv, 'GPT-6 Sol')).toBe('chat.err.tierLocked:GPT-6 Sol')
    expect(humanizeRunError('model_tier_locked', tv)).toBe('chat.err.tierLockedBare')
  })
  it('HTTP 403 的 JSON 回包里带 modelName 时优先用它', () => {
    const raw = JSON.stringify({ detail: 'model_tier_locked', code: 'model_tier_locked', modelId: 'x', modelName: 'Claude Z', multiplier: 5, cap: 2.5 })
    expect(humanizeRunError(raw, tv, 'Other')).toBe('chat.err.tierLocked:Claude Z')
  })
  it('真实中英文案', async () => {
    const { translateFor } = await import('../../i18n')
    expect(humanizeRunError('model_tier_locked', (k, v) => translateFor('zh', k, v), 'GPT-6 Sol')).toBe('当前会员档位不能使用 GPT-6 Sol。升级会员或换一个模型。')
    expect(humanizeRunError('model_tier_locked', (k, v) => translateFor('en', k, v), 'GPT-6 Sol')).toBe("Your current plan can't use GPT-6 Sol. Upgrade your membership or pick another model.")
  })
})
