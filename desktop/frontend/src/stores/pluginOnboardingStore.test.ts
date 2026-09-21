// 插件检查卡(2026-09-21)的判据单测。钉的是「什么算满足」—— 每一格都对应一次会让徽标说谎的实现:
//  · setting:默认值是占位串时,「非空」恒真;SettingRow 回到默认会删键;点过「完成设置」≠ 填过。
//  · permission:computerScreen 稳态是 unverified;win32 是 not-required;helper 没装 ≠ 判断不了。
//  · check:没注册 / 抛错 / 超时 / 回了个怪值 —— 一律 unknown,绝不 unmet。
// 走真 pluginStore:插件在 setup 里真调 registerSetting / registerReadiness,测的是整条接缝。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin, ReadinessContribution } from '@amadeus/plugins/types'
import type { DesktopPermissionsSnapshot } from '../../../shared/desktopPermissions'
import {
  CHECK_TIMEOUT_MS, checkResult, isGate, needsOnboarding, permissionResult, settingState, usePluginOnboarding,
} from './pluginOnboardingStore'

const mem = new Map<string, string>()
const fakeLocalStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
}

function plugin(id: string, opts: {
  requires?: NonNullable<AmadeusPlugin['onboarding']>['requires']
  setting?: { key: string; default: string }
  readiness?: ReadinessContribution
  intro?: string
} = {}): AmadeusPlugin {
  return {
    id, name: id, version: '0',
    onboarding: opts.requires || opts.intro ? { intro: opts.intro, requires: opts.requires } : undefined,
    setup: (ctx) => {
      if (opts.setting) ctx.registerSetting({ key: opts.setting.key, label: opts.setting.key, type: 'text', default: opts.setting.default })
      if (opts.readiness) ctx.registerReadiness?.(opts.readiness)
    },
  }
}

const snap = (over: Omit<Partial<DesktopPermissionsSnapshot>, 'permissions'> & { permissions?: Partial<DesktopPermissionsSnapshot['permissions']> }): DesktopPermissionsSnapshot => ({
  platform: 'darwin', appName: 'Forsion', computerUseAvailable: true, helperInstalled: true, helperRunning: true,
  ...over,
  permissions: {
    computerAccessibility: 'unknown', computerScreen: 'unknown', microphone: 'unknown', camera: 'unknown', screen: 'unknown',
    ...over.permissions,
  },
})

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('localStorage', fakeLocalStorage)
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
  usePluginOnboarding.setState({ pluginId: null, results: {}, checking: {}, version: 0 })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('isGate:只有 requires 才是闸', () => {
  it('只有使用说明(intro / steps)的 onboarding 不是闸 —— 不弹、不挂徽标', () => {
    expect(isGate(plugin('guide', { intro: '怎么用' }))).toBe(false)
    expect(isGate(plugin('gate', { requires: [{ kind: 'check', id: 'x' }] }))).toBe(true)
  })
  it('被门禁挡下的插件不参与(它压根激活不了)', () => {
    expect(isGate({ ...plugin('b', { requires: [{ kind: 'check', id: 'x' }] }), blocked: 'api' })).toBe(false)
  })
})

describe('setting:已填 = 用户写过、非空白、且 ≠ 默认', () => {
  const DEFAULT = '示例大日子 2026-12-31' // 倒数日的真实默认值:占位串,非空
  beforeEach(() => {
    usePluginStore.getState().init([plugin('countdown', { requires: [{ kind: 'setting', key: 'events' }], setting: { key: 'events', default: DEFAULT } })])
  })

  it.each([
    ['从没写过(键不存在 = 生效值就是默认)', null],
    ['空串(用户清空了输入框)', ''],
    ['纯空白', '   '],
    ['与默认值逐字相同', DEFAULT],
    ['默认值两侧多了空白', `  ${DEFAULT} `],
  ])('负对照 · %s → unmet', (_label, raw) => {
    if (raw !== null) mem.set('plugin.countdown.events', raw)
    expect(settingState('countdown', 'events')).toBe('unmet')
  })

  it('负对照 · 只有老的 __setupDone === "1"(点过「完成设置」)→ 仍是 unmet', () => {
    mem.set('plugin.countdown.__setupDone', '1')
    expect(settingState('countdown', 'events')).toBe('unmet')
  })

  it('用户真写了自己的日子 → ok', () => {
    mem.set('plugin.countdown.events', '毕设答辩 2026-09-10')
    expect(settingState('countdown', 'events')).toBe('ok')
  })

  it('插件没启用(setup 没跑,拿不到 def)/ 键名写错 → unknown,不是 unmet', () => {
    expect(settingState('countdown', 'nope')).toBe('unknown')
    expect(settingState('other', 'events')).toBe('unknown')
  })
})

describe('permission:三态映射', () => {
  it.each([
    ['granted', 'ok'], ['not-required', 'ok'],
    ['denied', 'unmet'], ['not-determined', 'unmet'], ['restricted', 'unmet'],
    ['unknown', 'unknown'], ['unavailable', 'unknown'], ['unverified', 'unknown'],
  ] as const)('microphone = %s → %s', (state, want) => {
    expect(permissionResult(snap({ permissions: { microphone: state } }), 'microphone').state).toBe(want)
  })

  it('⚠ unverified 既不算通过也不算未授权 —— 预检成功不等于真能用(主进程原话),但它又是被动轮询的稳态', () => {
    // 算 ok = 假绿(授权面板同时显示「待验证」);算 unmet = 永远催一个已经授过权的人。
    expect(permissionResult(snap({ permissions: { computerScreen: 'unverified' } }), 'computerScreen').state).toBe('unknown')
  })

  it('macOS 上 helper 还没装 → unmet(授权给的是 helper,它不在就一定还没授)', () => {
    const r = permissionResult(snap({ helperInstalled: false, permissions: { computerAccessibility: 'unknown' } }), 'computerAccessibility')
    expect(r).toEqual({ state: 'unmet', detail: 'helperMissing' })
  })

  it('helper 装了没在跑 → 读数 unknown,判断不了(不能当未授权去催)', () => {
    expect(permissionResult(snap({ helperRunning: false, permissions: { computerAccessibility: 'unknown' } }), 'computerAccessibility').state).toBe('unknown')
  })

  it('本机不支持电脑操作 / 本端没有授权 API(web · 手机 · Unit)→ unknown', () => {
    expect(permissionResult(snap({ computerUseAvailable: false, permissions: { computerAccessibility: 'denied' } }), 'computerAccessibility').state).toBe('unknown')
    expect(permissionResult(null, 'camera').state).toBe('unknown')
  })
})

describe('check:插件自报,宿主兜住所有「判断不了」', () => {
  const reg = (check: ReadinessContribution['check']) => {
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disposers: {}, readiness: [] }) // init 只认第一次
    usePluginStore.getState().init([plugin('p', { requires: [{ kind: 'check', id: 'c' }], readiness: { id: 'c', label: 'c', check } })])
  }

  it('没注册(插件没启用 / 旧版插件)→ unknown', async () => {
    expect(await checkResult('p', 'c')).toEqual({ state: 'unknown' })
  })
  it('回字符串或 { state, detail } 都认', async () => {
    reg(async () => 'ok')
    expect(await checkResult('p', 'c')).toEqual({ state: 'ok' })
    reg(async () => ({ state: 'unmet', detail: '服务端未配置 LIVEKIT_URL' }))
    expect(await checkResult('p', 'c')).toEqual({ state: 'unmet', detail: '服务端未配置 LIVEKIT_URL' })
  })
  it('抛错 / 回了个怪值 → unknown(断网时不能谎报「服务端没配」)', async () => {
    reg(async () => { throw new Error('offline') })
    expect((await checkResult('p', 'c')).state).toBe('unknown')
    reg(async () => 'yes' as never)
    expect((await checkResult('p', 'c')).state).toBe('unknown')
  })
  it('超时 → unknown(卡着不回的检查不能让卡片永远转圈)', async () => {
    vi.useFakeTimers()
    reg(() => new Promise(() => {}))
    const pending = checkResult('p', 'c')
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 1)
    expect(await pending).toEqual({ state: 'unknown', detail: 'timeout' })
  })
})

describe('evaluate + needsOnboarding:徽标只认实测为 unmet 的', () => {
  it('非闸插件永远不挂徽标', async () => {
    const p = plugin('guide', { intro: '怎么用' })
    usePluginStore.getState().init([p])
    await usePluginOnboarding.getState().evaluate('guide', { checks: true })
    expect(needsOnboarding(p)).toBe(false)
  })

  it('setting 未填 → 挂;填上 → 自己消失(不需要任何人点「完成」)', async () => {
    const p = plugin('habit', { requires: [{ kind: 'setting', key: 'habitName' }], setting: { key: 'habitName', default: '每日习惯' } })
    usePluginStore.getState().init([p])
    await usePluginOnboarding.getState().evaluate('habit')
    expect(needsOnboarding(p)).toBe(true)
    mem.set('plugin.habit.habitName', '晨间写作')
    await usePluginOnboarding.getState().evaluate('habit')
    expect(needsOnboarding(p)).toBe(false)
  })

  it('check 不带 checks 时不跑(启动期不打远端),沿用上次结果;带了才跑', async () => {
    let calls = 0
    const p = plugin('call', { requires: [{ kind: 'check', id: 'rtc' }], readiness: { id: 'rtc', label: 'rtc', check: async () => { calls++; return 'unmet' } } })
    usePluginStore.getState().init([p])
    await usePluginOnboarding.getState().evaluate('call')
    expect(calls).toBe(0)
    expect(needsOnboarding(p)).toBe(false) // 没跑过 = unknown,不挂
    await usePluginOnboarding.getState().evaluate('call', { checks: true })
    expect(calls).toBe(1)
    expect(needsOnboarding(p)).toBe(true)
    await usePluginOnboarding.getState().evaluate('call') // 平时沿用上一次
    expect(calls).toBe(1)
    expect(needsOnboarding(p)).toBe(true)
  })

  it('停用的插件全部 unknown —— 不给停用插件挂红徽标', async () => {
    const p = plugin('off', { requires: [{ kind: 'setting', key: 'k' }], setting: { key: 'k', default: '' } })
    usePluginStore.getState().init([p])
    usePluginStore.getState().disable('off')
    await usePluginOnboarding.getState().evaluate('off', { checks: true })
    expect(needsOnboarding(p)).toBe(false)
  })

  it('⚠ 慢 check 的旧结果不许盖掉它跑起来之后的新状态(否则填完设置徽标会自己回来)', async () => {
    let release: (v: 'ok' | 'unmet') => void = () => {}
    const p = plugin('slow', {
      requires: [{ kind: 'setting', key: 'k' }, { kind: 'check', id: 'c' }],
      setting: { key: 'k', default: '占位' },
      readiness: { id: 'c', label: 'c', check: () => new Promise((r) => { release = r }) },
    })
    usePluginStore.getState().init([p])
    const slow = usePluginOnboarding.getState().evaluate('slow', { checks: true }) // 这一轮读到的 setting 是「未填」
    mem.set('plugin.slow.k', '用户填好了')
    await usePluginOnboarding.getState().evaluate('slow') // 新一轮:setting 已就绪
    expect(usePluginOnboarding.getState().results.slow['setting:k'].state).toBe('ok')
    release('ok')
    await slow
    expect(usePluginOnboarding.getState().results.slow['setting:k'].state).toBe('ok') // 旧轮次被丢弃
    expect(usePluginOnboarding.getState().checking.slow).toBe(false)
  })

  it('unknown 从不算 unmet:本端没有授权 API 时权限类条件不挂徽标', async () => {
    const p = plugin('cu', { requires: [{ kind: 'permission', id: 'computerAccessibility' }] })
    usePluginStore.getState().init([p])
    await usePluginOnboarding.getState().evaluate('cu') // node 下没有 window.tangu
    expect(needsOnboarding(p)).toBe(false)
    await usePluginOnboarding.getState().evaluate('cu', { permissions: snap({ permissions: { computerAccessibility: 'denied' } }) })
    expect(needsOnboarding(p)).toBe(true)
  })
})
