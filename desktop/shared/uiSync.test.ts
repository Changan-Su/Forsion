import { describe, expect, it } from 'vitest'
import { normalizeUiSync } from './uiSync'

const axes = { lang: 'lovable', skin: 'teal', bg: 'teal', modePref: 'dark', seed: '#3d7f7a', bgSeed: '', glass: true, flat: false }

describe('normalizeUiSync', () => {
  it('两半各自可缺:只发主题 / 只发偏好都成立', () => {
    expect(normalizeUiSync({ theme: axes })).toEqual({ theme: axes, prefs: undefined })
    expect(normalizeUiSync({ prefs: { forsion_ui_zoom: '1.2' } })).toEqual({ theme: undefined, prefs: { forsion_ui_zoom: '1.2' } })
    expect(normalizeUiSync({})).toBeNull()
  })

  it('只留下已知字段(插件塞的大对象随多余属性一起丢掉)', () => {
    expect(normalizeUiSync({ theme: { ...axes, payload: 'x'.repeat(4096) }, junk: 1 })).toEqual({ theme: axes, prefs: undefined })
  })

  it('非法颜色归成空串(收方读作「保留本窗现值」),不让任意串进 CSS 变量与 localStorage', () => {
    expect(normalizeUiSync({ theme: { ...axes, seed: 'red; content: url(x)', bgSeed: 'x'.repeat(9999) } })?.theme)
      .toEqual({ ...axes, seed: '', bgSeed: '' })
  })

  it('坏轴 / 坏枚举 / 非布尔 → 丢掉主题那半', () => {
    expect(normalizeUiSync({ theme: { ...axes, lang: '../../etc/passwd' } })).toBeNull()
    expect(normalizeUiSync({ theme: { ...axes, skin: 'a'.repeat(65) } })).toBeNull()
    expect(normalizeUiSync({ theme: { ...axes, modePref: 'auto' } })).toBeNull()
    expect(normalizeUiSync({ theme: { ...axes, glass: 'on' } })).toBeNull()
    expect(normalizeUiSync(null)).toBeNull()
    expect(normalizeUiSync([axes])).toBeNull()
  })

  it('偏好:null=删键照收,坏键 / 超长值 / 非字符串逐条丢掉', () => {
    expect(normalizeUiSync({ prefs: {
      tangu_locale: 'en', forsion_ui_zoom: null, 'theme.soft.--radius': '12px',
      'bad key': 'x', forsion_font_ui: 'y'.repeat(129), forsion_glass: 1,
    } })?.prefs).toEqual({ tangu_locale: 'en', forsion_ui_zoom: null, 'theme.soft.--radius': '12px' })
  })
})
