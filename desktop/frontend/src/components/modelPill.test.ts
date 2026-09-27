import { describe, it, expect } from 'vitest'
import { catalogForDefaultSlot, contextLimitOptions, contextRingWindow, effortAt, effortStopAt, ultraContextWindow } from './ModelPill'
import type { CtxInfo, ModelInfo } from '../types'

describe('Effort slider', () => {
  it('把拖动 index 精确映射到七档，并夹住越界值', () => {
    expect(effortAt(0)).toBe('off')
    expect(effortAt(3)).toBe('medium')
    expect(effortAt(6)).toBe('max')
    expect(effortAt(99)).toBe('max')
    expect(effortAt(-4)).toBe('off')
  })

  it('Ultra 格:只在 allowUltra 时存在(第 8 格 = max + ultra),其余格显式关 Ultra;不给入口时行为与七档完全一致', () => {
    expect(effortStopAt(7, true)).toEqual({ level: 'max', ultra: true })
    expect(effortStopAt(6, true)).toEqual({ level: 'max', ultra: false }) // 停在 Max ≠ Ultra
    expect(effortStopAt(3, true)).toEqual({ level: 'medium', ultra: false })
    expect(effortStopAt(6, false)).toEqual({ level: 'max' }) // 没有 ultra 键:不碰会话里的开关
    expect(effortStopAt(7, false)).toEqual({ level: 'max' }) // 越界仍夹回七档
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
  it('Ultra(09-27):行上显示拉满后的窗口,勾选仍是本机存的设置;手动覆盖照旧;本来不超上限的不变', () => {
    expect(contextLimitOptions(m({ contextWindow: cap, contextWindowSource: 'family', maxContextWindow: 1_000_000 }), cap, true))
      .toEqual({ current: 1_000_000, defaultTokens: cap, maxTokens: 1_000_000, selected: 'default' })
    expect(contextLimitOptions(m({ contextWindow: 500_000, contextWindowSource: 'override', maxContextWindow: 1_000_000 }), cap, true))
      .toMatchObject({ current: 500_000, selected: null })
    expect(ultraContextWindow(m({ contextWindow: cap, contextWindowSource: 'model', maxContextWindow: 1_000_000 }))).toBe(1_000_000)
    expect(ultraContextWindow(m({ contextWindow: 200_000, contextWindowSource: 'family', maxContextWindow: 200_000 }))).toBe(200_000)
    expect(ultraContextWindow(m({ contextWindow: 128_000, contextWindowSource: 'override', maxContextWindow: 1_000_000 }))).toBe(128_000)
    expect(ultraContextWindow(m({ contextWindow: cap, contextWindowSource: 'family' }))).toBe(cap) // 老引擎不下发 max:按原值
    expect(ultraContextWindow(undefined)).toBeUndefined()
  })
})

describe('输入框进度环分母(09-27 Ultra 拉满:切了开关还没发下一条时按下一轮的窗口现算)', () => {
  const model: ModelInfo = { id: 'm1', name: 'M', provider: 'p', source: 'forsion', contextWindow: 272_000, contextWindowSource: 'family', maxContextWindow: 1_000_000 }
  const info = (over: Partial<CtxInfo>): CtxInfo => ({ ctxWindow: 272_000, ctxWindowSource: 'family', ctxWindowMax: 1_000_000, sections: [], files: [], filesTruncated: false, historyCount: 0, historyTokens: 0, ...over })
  const base = { contextWindow: 272_000, model, engineUncapped: true }

  it('上一轮不开 Ultra(272k):切进 Ultra → 1M 且那份标过时;没切 → 照用它', () => {
    expect(contextRingWindow({ ...base, ctxInfo: info({}), ultra: true })).toEqual({ window: 1_000_000, stale: true })
    expect(contextRingWindow({ ...base, ctxInfo: info({}), ultra: false })).toEqual({ window: 272_000, stale: false })
  })
  it('上一轮是 Ultra(1M):切回来 → 272k;在飞的 run 照用它自己报的', () => {
    expect(contextRingWindow({ ...base, contextWindow: 1_000_000, ctxInfo: info({ ctxWindow: 1_000_000, ultra: true }), ultra: false })).toEqual({ window: 272_000, stale: true })
    expect(contextRingWindow({ ...base, contextWindow: 272_000, ctxInfo: info({}), ultra: true, running: true })).toEqual({ window: 272_000, stale: false })
  })
  it('还没有 context_info:Ultra 开着 → 1M;不开 → 原值', () => {
    expect(contextRingWindow({ ...base, ultra: true })).toEqual({ window: 1_000_000, stale: false })
    expect(contextRingWindow({ ...base, ultra: false })).toEqual({ window: 272_000, stale: false })
  })
  it('老引擎(没声明 ultraUncapped,Ultra 也封顶、context_info 不带 ultra):Ultra 不改分母(Codex 09-27)', () => {
    expect(contextRingWindow({ ...base, engineUncapped: undefined, ctxInfo: info({}), ultra: true })).toEqual({ window: 272_000, stale: false })
    expect(contextRingWindow({ ...base, engineUncapped: undefined, ultra: true })).toEqual({ window: 272_000, stale: false })
  })
})
