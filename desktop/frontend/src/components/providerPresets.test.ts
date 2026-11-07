import { describe, expect, it } from 'vitest'
import { resolveModelCapability } from '../../../../tangu-agent/src/llm/modelCapabilities'
import { PROVIDER_PRESETS, presetProviderId } from './providerPresets'

// 每家一个现役模型名:预设地址必须让引擎能力表按 host / 协议命中专属规则,而不是落到 prefix 兜底。
const SAMPLE: Record<string, string> = {
  openai: 'gpt-5.6-luna',
  anthropic: 'claude-sonnet-5-5',
  deepseek: 'deepseek-v4-pro',
  bailian: 'qwen3.8-max',
  siliconflow: 'Qwen/Qwen3.8-Max',
  moonshot: 'kimi-k3',
  zhipu: 'glm-5.3',
  openrouter: 'google/gemini-3-pro',
  gemini: 'gemini-3-pro',
}
// ponytail: 已知没有专属规则的网关 —— 只发 prefix 兜底;OpenCode 上的 Kimi K3 因此跑不到 moonshot-k3 那条(见日志)
const NO_RULE = new Set(['xai', 'opencode', 'opencode-go'])

describe('provider presets', () => {
  it('every preset host hits an engine capability rule (or is a known exemption)', () => {
    for (const p of PROVIDER_PRESETS) {
      if (NO_RULE.has(p.id)) continue
      const rule = resolveModelCapability({ baseUrl: p.baseUrl, protocol: p.protocol, modelId: SAMPLE[p.id] }).rule
      expect(rule, `${p.id} → ${rule}`).not.toMatch(/^default/)
    }
  })

  it('OpenCode Go is a key preset whose base serves both /models and /chat/completions', () => {
    // /inference/go/openai/v1/models 是 404(11-05 探针):拉模型只拼 {baseUrl}/models,base 必须是 /inference/go/v1
    expect(PROVIDER_PRESETS.find((p) => p.id === 'opencode-go')).toEqual({
      id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/v1', protocol: 'openai', keyUrl: 'https://opencode.ai/console',
    })
  })

  it('every preset says where to get a key, over https (the first-run key form links to it)', () => {
    for (const p of PROVIDER_PRESETS) expect(p.keyUrl, p.id).toMatch(/^https:\/\//)
  })

  it('Anthropic uses the native Messages protocol', () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === 'anthropic')?.protocol).toBe('anthropic-messages')
  })

  it('does not reuse a taken connection name', () => {
    expect(presetProviderId('openai', [])).toBe('openai')
    expect(presetProviderId('openai', [{ providerId: 'openai', baseUrl: 'x' }, { providerId: 'openai-2', baseUrl: 'x' }])).toBe('openai-3')
  })
})
