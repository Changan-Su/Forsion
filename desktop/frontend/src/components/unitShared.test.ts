// @vitest-environment happy-dom
/**
 * 账号面板里「别人共享给当前账号的 Unit」:名册缓存(读失败不清空、旧版没有这一组、被撤判定)、
 * 分组与行状态、按 manifest id 找插件的主 Space、进去之后宿主画哪种状态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePluginSpace, sharedTargetKey, unitPanelModel } from './unitPanelModel'
import { onSharedRoster, sharedStillEnterable, useUnitRoster } from './unitRoster'
import { bodyErrorCode, sharedLoadState, WAKE_DEADLINE_MS, WAKE_RETRY_MAX, WAKE_RETRY_MS } from './UnitSwitcher'
import type { SharedUnit } from '../../../shared/sharedUnits'
import type { UnitInfo } from '../types'

const S1 = '9c0e1d2f-2222-4e8a-9c21-000000000003'
const S2 = '9c0e1d2f-3333-4e8a-9c21-000000000004'
const S3 = '9c0e1d2f-4444-4e8a-9c21-000000000005'
const OWN = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c'

const raw = (id: string, enter: 'frame' | 'none', extra: Record<string, unknown> = {}, sharedExtra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, name: `n-${id.slice(9, 13)}`, platform: 'linux', icon: null, online: true,
  shared: { group: { id: 'g1', title: { zh: '星河', en: 'Galaxy' } }, roleLabel: { zh: '管理员', en: 'Admin' }, enter, ...sharedExtra },
  ...(enter === 'frame' ? { webUrl: `https://${id}.u.test/api/units/${id}/proxy/web/` } : {}),
  ...extra,
})

describe('名册缓存 × 共享行', () => {
  afterEach(() => { useUnitRoster.getState().clear(); onSharedRoster(null); delete (window as { tangu?: unknown }).tangu })
  const stub = (answers: Array<unknown>): { calls: unknown[][] } => {
    const calls: unknown[][] = []
    ;(window as { tangu?: unknown }).tangu = {
      unitsList: async (...a: unknown[]) => { calls.push(a); const r = answers.shift(); if (r instanceof Error) throw r; return r },
    }
    return { calls }
  }

  it('带 { shared: true } 去要;好行留下、坏行丢掉', async () => {
    const { calls } = stub([{ status: 200, json: { units: [], shared: [raw(S1, 'frame'), raw(S2, 'frame', { webUrl: undefined }), raw(S3, 'none', {}, { enter: 'other' })] } }])
    await useUnitRoster.getState().refresh()
    expect(calls[0]).toEqual([{ shared: true }])
    expect(useUnitRoster.getState().shared.map((u) => u.id)).toEqual([S1])
  })
  it('旧版 Extend(回包没有 shared)→ 没有这一组,也不判被撤', async () => {
    stub([{ status: 200, json: { units: [{ id: OWN, name: 'mine', online: true }] } }])
    const seen = vi.fn()
    onSharedRoster(seen)
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().shared).toEqual([])
    expect(useUnitRoster.getState().units?.map((u) => u.id)).toEqual([OWN])
    expect(seen).not.toHaveBeenCalled()
  })
  it('读失败(抛错 / 5xx)≠ 空:已显示的共享组留着,不回调被撤判定', async () => {
    stub([{ status: 200, json: { units: [], shared: [raw(S1, 'frame')] } }, new Error('net'), { status: 502, json: null }])
    const seen = vi.fn()
    onSharedRoster(seen)
    await useUnitRoster.getState().refresh()
    expect(seen).toHaveBeenCalledTimes(1)
    await useUnitRoster.getState().refresh()
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().shared.map((u) => u.id)).toEqual([S1])
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('shared 形状不对(不是数组)= 不知道:沿用旧的、不回调', async () => {
    stub([{ status: 200, json: { units: [], shared: [raw(S1, 'frame')] } }, { status: 200, json: { units: [], shared: { oops: 1 } } }])
    const seen = vi.fn()
    onSharedRoster(seen)
    await useUnitRoster.getState().refresh()
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().shared.map((u) => u.id)).toEqual([S1])
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('401 = 没登录:共享组一起清', async () => {
    stub([{ status: 200, json: { units: [], shared: [raw(S1, 'frame')] } }, { status: 401, json: null }])
    await useUnitRoster.getState().refresh()
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toBeNull()
    expect(useUnitRoster.getState().shared).toEqual([])
  })
})

describe('被撤判定 sharedStillEnterable', () => {
  const rows = (enter: 'frame' | 'none'): SharedUnit[] => [{ id: S1, name: 'x', platform: null, icon: null, online: true, shared: { group: { id: 'g', title: { zh: 'g' } }, roleLabel: { zh: 'r' }, enter } }]
  it('还在且 enter = frame → 能进;不在了 / 变成 none → 被撤', () => {
    expect(sharedStillEnterable(rows('frame'), S1)).toBe(true)
    expect(sharedStillEnterable(rows('none'), S1)).toBe(false)
    expect(sharedStillEnterable([], S1)).toBe(false)
  })
})

describe('unitPanelModel × 共享行', () => {
  const su = (id: string, enter: 'frame' | 'none', o: Partial<SharedUnit> = {}, s: Partial<SharedUnit['shared']> = {}, group: SharedUnit['shared']['group'] = { id: 'g1', title: { zh: '星河', en: 'Galaxy' } }): SharedUnit =>
    ({ id, name: id.slice(9, 13), platform: 'linux', icon: null, online: true, shared: { group, roleLabel: { zh: '管理员', en: 'Admin' }, enter, ...s }, ...o })
  const base = { units: [{ id: OWN, name: 'mine', platform: 'darwin', icon: null, online: true }] as UnitInfo[], hostUnitId: null, lanOk: {}, p2p: false }
  it('按 group.id 分组(组按第一次出现的顺序),组标题和灰字按语言取、缺了回落', () => {
    const shared = [
      su(S1, 'frame'),
      su(S2, 'none', {}, { roleLabel: { zh: '成员' } }, { id: 'g2', title: { zh: '别组' } }),
      su(S3, 'frame', { sleeping: true }),
    ]
    const m = unitPanelModel({ ...base, remote: { active: false, key: null }, shared, lang: 'en' })
    expect(m.shared.map((g) => [g.id, g.title, g.rows.map((r) => r.unit.id)])).toEqual([['g1', 'Galaxy', [S1, S3]], ['g2', '别组', [S2]]])
    expect(m.shared[1].rows[0].role).toBe('成员')
    expect(m.shared[0].rows[1].sleeping).toBe(true)
    expect(m.offline).toEqual([]) // 共享行不折进「离线」
    expect(m.rows.map((r) => r.key)).toEqual([OWN])
  })
  it('行的动作:frame 能进;none + 找得到 Space → 打开 Space;none 找不到 / 没给 open → 点不动', () => {
    const shared = [su(S1, 'frame'), su(S2, 'none', {}, { open: { kind: 'space', plugin: 'biz' } }), su(S3, 'none', {}, { open: { kind: 'space', plugin: 'missing' } })]
    const pluginSpace = (id: string): string | null => (id === 'biz' ? 'space-biz' : null)
    const m = unitPanelModel({ ...base, remote: { active: false, key: null }, shared, pluginSpace })
    expect(m.shared[0].rows.map((r) => r.action)).toEqual([{ kind: 'frame' }, { kind: 'space', spaceId: 'space-biz' }, null])
    const noOpen = unitPanelModel({ ...base, remote: { active: false, key: null }, shared: [su(S2, 'none')], pluginSpace })
    expect(noOpen.shared[0].rows[0].action).toBeNull()
  })
  it('正看着共享的那台:那一行选中、「这台电脑」不勾、同 id 的自己名下的行不算选中', () => {
    const m = unitPanelModel({ ...base, remote: { active: true, key: sharedTargetKey(S1) }, shared: [su(S1, 'frame')] })
    expect(m.localCurrent).toBe(false)
    expect(m.shared[0].rows[0].current).toBe(true)
    expect(m.rows.every((r) => !r.current)).toBe(true)
    const own = unitPanelModel({ ...base, remote: { active: true, key: `${OWN}:tunnel` }, shared: [su(S1, 'frame')] })
    expect(own.shared[0].rows[0].current).toBe(false)
  })
  it('自己名下已有的 id、本机、手机不进共享组', () => {
    const shared = [su(OWN, 'frame'), su(S1, 'frame'), su(S2, 'frame', { kind: 'phone' })]
    const m = unitPanelModel({ ...base, hostUnitId: S1, remote: { active: false, key: null }, shared })
    expect(m.shared).toEqual([])
  })
})

describe('resolvePluginSpace', () => {
  const owner: Record<string, string> = { 'sp-a': 'biz', 'sp-b': 'market-11111111-2222-3333-4444-555555555555', 'sp-b2': 'market-11111111-2222-3333-4444-555555555555' }
  const ownerOf = (id: string): string | undefined => owner[id]
  it('运行身份等于 manifest id 的先认', () => {
    expect(resolvePluginSpace('biz', [{ id: 'biz' }], ['sp-x', 'sp-a'], ownerOf)).toBe('sp-a')
  })
  it('商店装的(market-<UUID>)按 packageId 对上,取它注册的第一个 Space', () => {
    const plugins = [{ id: 'market-11111111-2222-3333-4444-555555555555', packageId: 'shop-biz' }]
    expect(resolvePluginSpace('shop-biz', plugins, ['sp-b2', 'sp-b'], ownerOf)).toBe('sp-b2')
  })
  it('同一个 manifest id 对上两个插件(说不准)/ 没装 / 没注册 Space → null', () => {
    const two = [{ id: 'market-11111111-2222-3333-4444-555555555555', packageId: 'dup' }, { id: 'market-99999999-2222-3333-4444-555555555555', packageId: 'dup' }]
    expect(resolvePluginSpace('dup', two, ['sp-b'], ownerOf)).toBeNull()
    expect(resolvePluginSpace('nope', [{ id: 'biz' }], ['sp-a'], ownerOf)).toBeNull()
    expect(resolvePluginSpace('biz', [{ id: 'biz' }], ['sp-x'], ownerOf)).toBeNull()
  })
})

describe('进去之后宿主画哪种状态', () => {
  it('503 + UNIT_WAKING → 唤醒中;403 / 404 → 不能进入;其它错误 → 连不上;成功 → 照常', () => {
    expect(sharedLoadState(503, 'UNIT_WAKING')).toBe('waking')
    expect(sharedLoadState(503)).toBe('unreachable')
    expect(sharedLoadState(503, 'OTHER')).toBe('unreachable')
    expect(sharedLoadState(403)).toBe('forbidden')
    expect(sharedLoadState(404, 'UNIT_WAKING')).toBe('forbidden')
    expect(sharedLoadState(401)).toBe('unreachable')
    expect(sharedLoadState(500)).toBe('unreachable')
    expect(sharedLoadState(200)).toBeNull()
    expect(sharedLoadState(304)).toBeNull()
    expect(sharedLoadState(-1)).toBeNull()
  })
  it('从页面纯文本里取 JSON 的 code;不是 JSON = 没有', () => {
    expect(bodyErrorCode('{"code":"UNIT_WAKING","detail":"x"}')).toBe('UNIT_WAKING')
    expect(bodyErrorCode('  {"code":"X"}')).toBe('X')
    expect(bodyErrorCode('<html>')).toBeUndefined()
    expect(bodyErrorCode('{bad')).toBeUndefined()
    expect(bodyErrorCode('{"code":3}')).toBeUndefined()
    expect(bodyErrorCode(undefined)).toBeUndefined()
  })
  it('唤醒:每 5 秒一次、最多约 1 分钟', () => {
    expect(WAKE_RETRY_MS).toBe(5000)
    expect(WAKE_RETRY_MS * WAKE_RETRY_MAX).toBe(60_000)
    expect(WAKE_DEADLINE_MS).toBe(60_000) // 按墙钟封顶(每次回包本身也要时间,只数次数会拖过一分钟)
  })
})
