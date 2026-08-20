import { describe, it, expect } from 'vitest'
import { catalogForDefaultSlot, effortAt } from './ModelPill'
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
