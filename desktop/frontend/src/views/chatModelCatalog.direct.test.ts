import { describe, expect, it } from 'vitest'
import type { ModelInfo, ModelsResponse } from '../../../../tangu-agent/src/contracts/clientTypes'
import { isDirectModelId } from './chatModelCatalog'

const m = (id: string, source: 'forsion' | 'direct') => ({ id, name: id, provider: source === 'forsion' ? 'forsion' : id.split('/')[0], source }) as ModelInfo
const models = [m('kimi/kimi-k3', 'forsion'), m('deepseek/deepseek-v4-pro', 'direct')]
const r = { models, defaultModelId: null, directProviders: [{ providerId: 'deepseek', modelIds: ['deepseek-v4-pro', 'deepseek-chat'] }] } as unknown as ModelsResponse

describe('isDirectModelId', () => {
  it('目录里有就看 source:云端的 kimi/kimi-k3 不因带斜杠被当直连', () => {
    expect(isDirectModelId('kimi/kimi-k3', models, r)).toBe(false)
    expect(isDirectModelId('deepseek/deepseek-v4-pro', models, r)).toBe(true)
  })
  it('目录外照注册表规则:直连前缀 / 旧会话裸 ID 都算;别的不算', () => {
    expect(isDirectModelId('deepseek/new-model', models, r)).toBe(true)
    expect(isDirectModelId('deepseek-chat', models, r)).toBe(true)
    expect(isDirectModelId('Auto', models, r)).toBe(false)
    expect(isDirectModelId('deepseek/x', models, null)).toBe(false)
  })
})
