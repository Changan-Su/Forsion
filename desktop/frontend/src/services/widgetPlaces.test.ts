import { describe, expect, it } from 'vitest'
import { boardPath } from './widgetPlaces'

// 板名的词条在一张表里(不是字面量 t('…')),i18nCoverage 扫不到;漏了词条会落成 `Dashboards/amadeus.default.cardsBoard.dashboard.md`
describe('widget board files', () => {
  it('are named in both languages', () => {
    expect(boardPath('rail', 'zh')).toBe('Dashboards/卡片区.dashboard.md')
    expect(boardPath('rail', 'en')).toBe('Dashboards/Cards.dashboard.md')
    expect(boardPath('today', 'zh')).toBe('Dashboards/今天.dashboard.md')
    expect(boardPath('today', 'en')).toBe('Dashboards/Today.dashboard.md')
  })
})
