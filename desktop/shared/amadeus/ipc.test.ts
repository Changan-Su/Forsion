/** Amadeus 插件 manifest 门禁单测:cmpVersion 排序 + gatePluginManifest 四种情形 + sanitizeOnboarding 消毒。 */
import { describe, it, expect } from 'vitest'
import { cmpVersion, gatePluginManifest, sanitizeOnboarding, requirementKey, AMADEUS_PLUGIN_API } from './ipc'

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

describe('sanitizeOnboarding · requires(2026-09-21:可实测的前置条件)', () => {
  it('三类合法条件原样保留;只有 requires 的 onboarding 也算可渲染(它是一道闸)', () => {
    const ob = sanitizeOnboarding({ requires: [
      { kind: 'setting', key: 'events' },
      { kind: 'permission', id: 'computerAccessibility' },
      { kind: 'check', id: 'rtc' },
    ] })
    expect(ob?.requires).toEqual([
      { kind: 'setting', key: 'events' },
      { kind: 'permission', id: 'computerAccessibility' },
      { kind: 'check', id: 'rtc' },
    ])
  })

  it('未知 kind / 不认识的权限 id / 非法键名 / 附带文案 → 逐条丢弃(不因一条坏的拖垮整张卡)', () => {
    const ob = sanitizeOnboarding({ intro: 'x', requires: [
      { kind: 'env', tool: 'ffmpeg' },              // 不存在这一类:宿主不做「渲染层传工具名 → 主进程 spawn」
      { kind: 'install', type: 'skill', slug: 'a' }, // 同上:市场上架的 space / skill 为 0,不是闸
      { kind: 'permission', id: 'root' },
      { kind: 'setting', key: '../../etc' },
      { kind: 'check', id: '' },
      { kind: 'setting', key: 'ok', label: '<b>文案不进契约</b>' },
      null, 'setting', 42,
    ] })
    expect(ob?.requires).toEqual([{ kind: 'setting', key: 'ok' }])
  })

  it('⚠ 前面塞满重复 / 坏条目,后面的合法条件照样收得到(先砍前 8 条再挑会把真闸吃掉)', () => {
    const noisy = [
      ...Array.from({ length: 6 }, () => ({ kind: 'check', id: 'dup' })),
      { kind: 'env', tool: 'ffmpeg' }, { kind: 'nope' },
      { kind: 'setting', key: 'realOne' },
    ]
    expect(sanitizeOnboarding({ requires: noisy })?.requires).toEqual([
      { kind: 'check', id: 'dup' }, { kind: 'setting', key: 'realOne' },
    ])
  })

  it('同一条件重复声明只留一次;上限 8 条', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'check', id: `c${i}` }))
    expect(sanitizeOnboarding({ requires: [{ kind: 'check', id: 'a' }, { kind: 'check', id: 'a' }] })?.requires).toHaveLength(1)
    expect(sanitizeOnboarding({ requires: many })?.requires).toHaveLength(8)
  })

  it('requires 全坏 → 字段缺席;其余字段照常(降级成使用说明,不是整条丢)', () => {
    const ob = sanitizeOnboarding({ intro: '说明', requires: [{ kind: 'nope' }] })
    expect(ob).toEqual({ intro: '说明' })
  })

  it('requirementKey 稳定且按类区分(setting:x 与 check:x 不撞)', () => {
    expect(requirementKey({ kind: 'setting', key: 'x' })).toBe('setting:x')
    expect(requirementKey({ kind: 'check', id: 'x' })).toBe('check:x')
    expect(requirementKey({ kind: 'permission', id: 'camera' })).toBe('permission:camera')
  })
})
