/**
 * 明暗偏好解析(light|dark|system)的键优先级 + system→当前系统明暗。
 * 这段容易错在「键回退顺序」和「system 没解析成落地明暗」,故钉死。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listSkins, resolveInitialEffectiveMode, resolveInitialMode, resolveInitialModePref, resolveInitialSkin, systemMode,
} from './registry'

const g = globalThis as unknown as { localStorage?: unknown; window?: unknown }
let ls: Record<string, string>

function mockSystemDark(dark: boolean): void {
  g.window = { matchMedia: (q: string) => ({ matches: dark && /dark/.test(q) }) }
}

beforeEach(() => {
  ls = {}
  g.localStorage = {
    getItem: (k: string) => (k in ls ? ls[k] : null),
    setItem: (k: string, v: string) => { ls[k] = v },
    removeItem: (k: string) => { delete ls[k] },
  }
  mockSystemDark(false)
})
afterEach(() => { delete g.localStorage; delete g.window })

describe('resolveInitialModePref — 键优先级', () => {
  it('新键 forsion_theme_pref 最高', () => {
    ls['forsion_theme_pref'] = 'system'
    ls['forsion_theme'] = 'dark' // 老键在场也不该盖过新键
    expect(resolveInitialModePref()).toBe('system')
  })

  it('无新键时回退老键 forsion_theme(老用户显式明暗平滑迁移)', () => {
    ls['forsion_theme'] = 'dark'
    expect(resolveInitialModePref()).toBe('dark')
  })

  it('都没有 → light', () => {
    expect(resolveInitialModePref()).toBe('light')
  })

  it('非法值忽略,回退', () => {
    ls['forsion_theme_pref'] = 'rainbow'
    ls['forsion_theme'] = 'light'
    expect(resolveInitialModePref()).toBe('light')
  })
})

describe('resolveInitialMode — system 解析成落地明暗', () => {
  it('pref=system + 系统深色 → dark', () => {
    ls['forsion_theme_pref'] = 'system'
    mockSystemDark(true)
    expect(resolveInitialMode()).toBe('dark')
  })

  it('pref=system + 系统浅色 → light', () => {
    ls['forsion_theme_pref'] = 'system'
    mockSystemDark(false)
    expect(resolveInitialMode()).toBe('light')
  })

  it('显式 pref 不看系统', () => {
    ls['forsion_theme_pref'] = 'light'
    mockSystemDark(true)
    expect(resolveInitialMode()).toBe('light')
  })
})

describe('resolveInitialEffectiveMode — 含 forced_scheme(首屏防闪,codex High-1)', () => {
  it('forced_scheme=system 压过用户 pref=light,按系统解析', () => {
    ls['forsion_theme_forced_scheme'] = 'system'
    ls['forsion_theme_pref'] = 'light'
    mockSystemDark(true)
    expect(resolveInitialEffectiveMode()).toBe('dark')
  })

  it('forced_scheme=dark 直取(单侧锁定主题)', () => {
    ls['forsion_theme_forced_scheme'] = 'dark'
    ls['forsion_theme_pref'] = 'light'
    mockSystemDark(false)
    expect(resolveInitialEffectiveMode()).toBe('dark')
  })

  it('无 forced_scheme → 回落用户偏好解析', () => {
    ls['forsion_theme_pref'] = 'dark'
    expect(resolveInitialEffectiveMode()).toBe('dark')
  })

  it('脏 forced_scheme(如 "auto")忽略,回落偏好', () => {
    ls['forsion_theme_forced_scheme'] = 'auto'
    ls['forsion_theme_pref'] = 'light'
    mockSystemDark(true)
    expect(resolveInitialEffectiveMode()).toBe('light')
  })
})

describe('systemMode', () => {
  it('随 matchMedia', () => {
    mockSystemDark(true); expect(systemMode()).toBe('dark')
    mockSystemDark(false); expect(systemMode()).toBe('light')
  })
  it('无 matchMedia 兜底 light', () => {
    delete g.window
    expect(systemMode()).toBe('light')
  })
})

describe('知语言拆回独立配色轴', () => {
  it('旧 zhi + cream 默认位只迁一次到知蓝，保持升级前观感', () => {
    ls['forsion_theme_lang'] = 'zhi'
    ls['forsion_theme_skin'] = 'cream'
    expect(resolveInitialSkin()).toBe('zhi')
    expect(ls['forsion_theme_skin']).toBe('zhi')
    expect(ls['forsion_theme_zhi_skin_v1']).toBe('1')
  })

  it('迁移标记在场后尊重用户重新选择的 cream', () => {
    ls['forsion_theme_lang'] = 'zhi'
    ls['forsion_theme_skin'] = 'cream'
    ls['forsion_theme_zhi_skin_v1'] = '1'
    expect(resolveInitialSkin()).toBe('cream')
  })

  it('旧用户明确选过的其他配色不被迁移覆盖', () => {
    ls['forsion_theme_lang'] = 'zhi'
    ls['forsion_theme_skin'] = 'coral'
    expect(resolveInitialSkin()).toBe('coral')
  })

  it('知蓝是独立命名配色且位于自定义之前', () => {
    const ids = listSkins().map((skin) => skin.id)
    expect(ids).toContain('zhi')
    expect(ids.indexOf('zhi')).toBeLessThan(ids.indexOf('custom'))
  })
})
