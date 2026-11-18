// 图标选择器里的每一枚都得能存进标注的元数据位(Notion 对齐 A5):isCalloutIcon 认不出的那格点了不会有任何反应。
import { describe, expect, it } from 'vitest'
import { EMOJI_ALL } from './emoji'
import { isCalloutIcon, parseCalloutMeta } from '../../../../shared/amadeus/calloutToken'

describe('图标选择器 × 标注图标', () => {
  it('选择器里的每一枚都是合法的标注图标,且解析回来还是图标', () => {
    const bad = EMOJI_ALL.filter((e) => !isCalloutIcon(e) || parseCalloutMeta(`${e} blue`).icon !== e)
    expect(bad).toEqual([])
  })
})
