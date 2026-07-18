/** Amadeus 插件 manifest 门禁单测:cmpVersion 排序 + gatePluginManifest 四种情形 + sanitizeOnboarding 消毒。 */
import { describe, it, expect } from 'vitest'
import { cmpVersion, gatePluginManifest, sanitizeOnboarding, AMADEUS_PLUGIN_API } from './ipc'

describe('cmpVersion', () => {
  it('数值逐段比较,缺段=0,前导 v 忽略', () => {
    expect(cmpVersion('1.2.0', '1.10.0')).toBe(-1)
    expect(cmpVersion('v2.0', '2.0.0')).toBe(0)
    expect(cmpVersion('2.0.1', '2.0')).toBe(1)
  })
})

describe('gatePluginManifest', () => {
  it('缺 apiVersion 视为 1 → 放行(存量插件全兼容)', () => {
    expect(gatePluginManifest({}, '2.0.0')).toBeNull()
  })
  it('apiVersion 不等于宿主 → api', () => {
    expect(gatePluginManifest({ apiVersion: AMADEUS_PLUGIN_API + 1 }, '2.0.0')).toBe('api')
    expect(gatePluginManifest({ apiVersion: AMADEUS_PLUGIN_API }, '2.0.0')).toBeNull()
  })
  it('minAppVersion 高于应用版本 → minApp;不高 → 放行', () => {
    expect(gatePluginManifest({ minAppVersion: '99.0.0' }, '2.0.0')).toBe('minApp')
    expect(gatePluginManifest({ minAppVersion: '1.0.0' }, '2.0.0')).toBeNull()
  })
  it('appVersion 未知 → 跳过 minApp 检查(不误杀)', () => {
    expect(gatePluginManifest({ minAppVersion: '99.0.0' }, null)).toBeNull()
  })
})

describe('sanitizeOnboarding', () => {
  it('非对象/空对象/全垃圾字段 → undefined(不渲染空卡)', () => {
    expect(sanitizeOnboarding(undefined)).toBeUndefined()
    expect(sanitizeOnboarding('hi')).toBeUndefined()
    expect(sanitizeOnboarding({})).toBeUndefined()
    expect(sanitizeOnboarding({ steps: [{ description: '无标题步骤' }], recommends: [{ type: 'space' }] })).toBeUndefined()
  })
  it('合法字段透传;超限截断(steps≤8、recommends≤6、intro≤500)', () => {
    const spec = sanitizeOnboarding({
      intro: 'x'.repeat(600),
      steps: Array.from({ length: 10 }, (_, i) => ({ title: `步骤${i}` })),
      settings: true,
      recommends: Array.from({ length: 8 }, (_, i) => ({ type: 'space', slug: `sp-${i}` })),
    })!
    expect(spec.intro!.length).toBe(500)
    expect(spec.steps!.length).toBe(8)
    expect(spec.settings).toBe(true)
    expect(spec.recommends!.length).toBe(6)
  })
  it('recommends:未知 type / 非法 slug 丢弃;name/reason 可选保留', () => {
    const spec = sanitizeOnboarding({
      recommends: [
        { type: 'space', slug: 'meeting-desk', name: '会议台', reason: '同一套行动项纪律' },
        { type: 'evil', slug: 'x' },
        { type: 'plugin', slug: 'Bad Slug!' },
      ],
    })!
    expect(spec.recommends).toEqual([{ type: 'space', slug: 'meeting-desk', name: '会议台', reason: '同一套行动项纪律' }])
  })
  it('settings 数组:过滤非串、上限 16', () => {
    const spec = sanitizeOnboarding({ settings: ['a', 1, '', 'b'] })!
    expect(spec.settings).toEqual(['a', 'b'])
  })
})
