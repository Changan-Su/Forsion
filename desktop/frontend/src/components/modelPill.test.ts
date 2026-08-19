import { describe, it, expect } from 'vitest'
import { catalogForDefaultSlot, effortAt, subFlips } from './ModelPill'
import type { ModelInfo } from '../types'

// 视口宽 1000,子面板 200(未缩放局部 px),gap 6 / margin 8
describe('subFlips', () => {
  it('右边放得下 → 不翻', () => {
    expect(subFlips(700, 200, 1, 1000)).toBe(false)
  })
  it('右边放不下 → 翻到左侧', () => {
    expect(subFlips(820, 200, 1, 1000)).toBe(true)
  })
  it('⚠️ zoom≠1:同一个锚点,放大后就放不下了(subW 必须乘 zoom)', () => {
    // 700 + (6+200)*1 = 906 ≤ 992 放得下;×1.15 → 700+236.9=936.9 仍放得下,×1.6 → 1029.6 放不下
    expect(subFlips(700, 200, 1.15, 1000)).toBe(false)
    expect(subFlips(700, 200, 1.6, 1000)).toBe(true)
  })
})

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
