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
const NO_RULE = new Set(['xai', 'opencode'])

describe('provider presets', () => {
  it('every preset host hits an engine capability rule (or is a known exemption)', () => {
    for (const p of PROVIDER_PRESETS) {
      if (NO_RULE.has(p.id)) continue
      const rule = resolveModelCapability({ baseUrl: p.baseUrl, protocol: p.protocol, modelId: SAMPLE[p.id] }).rule
      expect(rule, `${p.id} → ${rule}`).not.toMatch(/^default/)
    }
  })

  it('Anthropic uses the native Messages protocol', () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === 'anthropic')?.protocol).toBe('anthropic-messages')
  })

  it('does not reuse a taken connection name', () => {
    expect(presetProviderId('openai', [])).toBe('openai')
    expect(presetProviderId('openai', [{ providerId: 'openai', baseUrl: 'x' }, { providerId: 'openai-2', baseUrl: 'x' }])).toBe('openai-3')
  })
})
