import { describe, it, expect } from 'vitest'
import { catalogForDefaultSlot, contextLimitOptions, effortAt } from './ModelPill'
import type { ModelInfo } from '../types'

describe('Effort slider', () => {
  it('把拖动 index 精确映射到七档，并夹住越界值', () => {
    expect(effortAt(0)).toBe('off')
    expect(effortAt(3)).toBe('medium')
    expect(effortAt(6)).toBe('max')
    expect(effortAt(99)).toBe('max')
    expect(effortAt(-4)).toBe('off')
  })
})

describe('advanced default-model catalogs', () => {
  const models: ModelInfo[] = [
    { id: 'vision', name: 'Vision', provider: 'p', source: 'forsion', modelType: 'llm', supportsVision: true },
    { id: 'text', name: 'Text', provider: 'p', source: 'forsion', modelType: 'llm', supportsVision: false },
    { id: 'image', name: 'Image', provider: 'p', source: 'forsion', modelType: 'image_gen' },
  ]

  it('辅助模型列全部 LLM，生图只列 image_gen，识图排除明确无视觉的模型', () => {
    expect(catalogForDefaultSlot(models, 'backgroundModelId').map((m) => m.id)).toEqual(['vision', 'text'])
    expect(catalogForDefaultSlot(models, 'imageModelId').map((m) => m.id)).toEqual(['image'])
    expect(catalogForDefaultSlot(models, 'visionModelId').map((m) => m.id)).toEqual(['vision'])
  })
})

describe('上下文上限行(模型窗口 > 缺省上限才露;选项写本机 modelOverrides)', () => {
  const cap = 272_000
  const m = (over: Partial<ModelInfo>): ModelInfo => ({ id: 'x', name: 'X', provider: 'p', source: 'forsion', ...over })

  it('1M 模型默认封在 272k:露出「默认 / 最大」两档,勾默认', () => {
    expect(contextLimitOptions(m({ contextWindow: cap, contextWindowSource: 'family', maxContextWindow: 1_000_000 }), cap))
      .toEqual({ current: cap, defaultTokens: cap, maxTokens: 1_000_000, selected: 'default' })
  })
  it('开到最大 = 覆盖值等于模型窗口 → 勾最大;设置页手填的其它值两档都不勾,行上照实显示', () => {
    expect(contextLimitOptions(m({ contextWindow: 1_000_000, contextWindowSource: 'override', maxContextWindow: 1_000_000 }), cap)?.selected).toBe('max')
    expect(contextLimitOptions(m({ contextWindow: 500_000, contextWindowSource: 'override', maxContextWindow: 1_000_000 }), cap))
      .toMatchObject({ current: 500_000, selected: null })
  })
  it('窗口不超上限的模型不露;但手动覆盖过的仍露(只剩「默认」,好改回去);老引擎不下发 max → 不露', () => {
    expect(contextLimitOptions(m({ contextWindow: 200_000, contextWindowSource: 'family', maxContextWindow: 200_000 }), cap)).toBeNull()
    expect(contextLimitOptions(m({ contextWindow: 128_000, contextWindowSource: 'override', maxContextWindow: 200_000 }), cap))
      .toEqual({ current: 128_000, defaultTokens: 200_000, selected: null })
    expect(contextLimitOptions(m({ contextWindow: 1_000_000, contextWindowSource: 'family' }), cap)).toBeNull()
    expect(contextLimitOptions(m({ contextWindow: cap, maxContextWindow: 1_000_000 }), undefined)).toBeNull()
  })
})
