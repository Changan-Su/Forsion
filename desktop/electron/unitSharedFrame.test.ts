/**
 * 设备页补登录头 × 别人共享给当前账号的 Unit:绑定(只认 enter = frame、只在主窗、只用名册给的地址)、
 * 补头前缀只有那台子域、Authorization 替换、开窗拒共享行。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createUnitOpenGrants, handleUnitFrameBind, replaceAuthorization, sharedOnlyUnit, shouldInjectUnitAuth, unitAllowedPrefixes,
  type UnitFrameBinding, type UnitFrameBindDeps, type UnitFrameRosterRead,
} from './unitAuthScope'
import { parseRosterResponse } from './unitShortcut'
import type { SharedUnit } from '../shared/sharedUnits'

const CLOUD = 'https://api.example.test'
const OWN = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c'
const S = '9c0e1d2f-2222-4e8a-9c21-000000000003'
const NONE = '9c0e1d2f-3333-4e8a-9c21-000000000004'
const ACCT = 'user-1'
const SUB = `https://${S}.units.example.test`
const WEB = `${SUB}/api/units/${S}/proxy/web/`

const sharedRow = (id: string, enter: 'frame' | 'none', webUrl?: string): SharedUnit => ({
  id, name: id, platform: 'linux', icon: null, online: true,
  shared: { group: { id: 'g', title: { zh: '组' } }, roleLabel: { zh: '管理员' }, enter },
  ...(webUrl ? { webUrl } : {}),
})
const roster = (shared: SharedUnit[] = [sharedRow(S, 'frame', WEB), sharedRow(NONE, 'none', `https://${NONE}.units.example.test/api/units/${NONE}/proxy/web/`)]): UnitFrameRosterRead =>
  ({ ok: true, units: [{ id: OWN }], shared })

const deps = (over: Partial<UnitFrameBindDeps> = {}): UnitFrameBindDeps & { bind: ReturnType<typeof vi.fn> } => ({
  trusted: true, fromMain: true, guestAlive: () => true, generation: () => 0,
  accountKey: () => ACCT, cloudBase: () => CLOUD, readRoster: async () => roster(), bind: vi.fn(), ...over,
}) as UnitFrameBindDeps & { bind: ReturnType<typeof vi.fn> }

describe('handleUnitFrameBind × 共享过来的 Unit', () => {
  it('enter = frame:按名册里校验过的 webUrl 绑,回给渲染层的地址就是它', async () => {
    const d = deps()
    expect(await handleUnitFrameBind(S, d)).toEqual({ ok: true, url: WEB })
    expect(d.bind).toHaveBeenCalledWith({ unitId: S, accountKey: ACCT, cloudBase: CLOUD, webUrl: WEB })
  })
  it('enter = none(即使带了合格的地址)→ not_enterable,不绑', async () => {
    const d = deps()
    expect(await handleUnitFrameBind(NONE, d)).toEqual({ ok: false, code: 'not_enterable' })
    expect(d.bind).not.toHaveBeenCalled()
  })
  it('不是主窗发起(这台的 Unit 窗)→ not_enterable', async () => {
    const d = deps({ fromMain: false })
    expect(await handleUnitFrameBind(S, d)).toEqual({ ok: false, code: 'not_enterable' })
    expect(d.bind).not.toHaveBeenCalled()
  })
  it('webUrl 不合格(源 = 云端、http、别台路径)→ not_enterable', async () => {
    for (const bad of [`${CLOUD}/api/units/${S}/proxy/web/`, WEB.replace('https:', 'http:'), `${SUB}/api/units/${OWN}/proxy/`]) {
      const d = deps({ readRoster: async () => roster([sharedRow(S, 'frame', bad)]) })
      expect(await handleUnitFrameBind(S, d), bad).toEqual({ ok: false, code: 'not_enterable' })
      expect(d.bind).not.toHaveBeenCalled()
    }
  })
  it('旧版云端 / Extend(名册没有 shared)→ not_found;自己名下的照旧走中转', async () => {
    const d = deps({ readRoster: async () => ({ ok: true, units: [{ id: OWN }] }) })
    expect(await handleUnitFrameBind(S, d)).toEqual({ ok: false, code: 'not_found' })
    expect(await handleUnitFrameBind(OWN, d)).toEqual({ ok: true, url: `${CLOUD}/api/units/${OWN}/proxy/` })
  })
  it('同一个 id 既在自己名下又在共享里:按自己名下的(中转)绑', async () => {
    const d = deps({ readRoster: async () => ({ ok: true, units: [{ id: S }], shared: [sharedRow(S, 'frame', WEB)] }) })
    expect(await handleUnitFrameBind(S, d)).toEqual({ ok: true, url: `${CLOUD}/api/units/${S}/proxy/` })
    expect(d.bind).toHaveBeenCalledWith({ unitId: S, accountKey: ACCT, cloudBase: CLOUD })
  })
  it('名册回来时换了号 → account_changed', async () => {
    let acct = ACCT
    const d = deps({ accountKey: () => acct, readRoster: async () => { acct = 'user-2'; return roster() } })
    expect(await handleUnitFrameBind(S, d)).toEqual({ ok: false, code: 'account_changed' })
  })
})

describe('共享绑定的补头前缀', () => {
  const b: UnitFrameBinding = { unitId: S, accountKey: ACCT, cloudBase: CLOUD, webUrl: WEB }
  const decide = (url: string, secFetchSite = 'same-origin'): boolean => shouldInjectUnitAuth({ url, binding: b, accountKey: ACCT, cloudBase: CLOUD, secFetchSite })
  it('只有那台子域上的 /api/units/<id>/proxy/,没有云端中转那一条', () => {
    expect(unitAllowedPrefixes(CLOUD, S, WEB)).toEqual([`${SUB}/api/units/${S}/proxy/`])
    expect(unitAllowedPrefixes(CLOUD, S, `${CLOUD}/api/units/${S}/proxy/`)).toEqual([]) // 地址不合格:一个都不补
  })
  it('子域上自己的路径补(同源 / 主框架导航);云端中转、云端名册、别台子域、子域别的路径不补', () => {
    expect(decide(`${SUB}/api/units/${S}/proxy/web/`)).toBe(true)
    expect(decide(`${SUB}/api/units/${S}/proxy/unit/whoami`)).toBe(true)
    expect(decide(`${SUB}/api/units/${S}/proxy/web/`, 'none')).toBe(true)
    for (const u of [
      `${CLOUD}/api/units/${S}/proxy/`, `${CLOUD}/api/units`, `${CLOUD}/api/units/${S}`,
      `https://${OWN}.units.example.test/api/units/${OWN}/proxy/`, `${SUB}/api/units/${OWN}/proxy/`,
      `${SUB}/api/units`, `${SUB}/api/units/${S}/session`, `${SUB}/web/`,
    ]) expect(decide(u), u).toBe(false)
    expect(decide(`${SUB}/api/units/${S}/proxy/web/`, 'cross-site')).toBe(false)
  })
  it('开窗许可:只认这台子域里的地址,发起页也得在子域里', () => {
    const g = createUnitOpenGrants(() => 0)
    expect(g.issue(b, `${CLOUD}/api/units/${S}/proxy/?x`, ACCT, CLOUD, { pageUrl: WEB })).toBe(false)
    expect(g.issue(b, `${SUB}/api/units/${S}/proxy/web/?x`, ACCT, CLOUD, { pageUrl: `${CLOUD}/api/units/${S}/proxy/` })).toBe(false)
    expect(g.issue(b, `${SUB}/api/units/${S}/proxy/web/?x`, ACCT, CLOUD, { pageUrl: WEB })).toBe(true)
    expect(g.consume(`${SUB}/api/units/${S}/proxy/web/?x`, ACCT, CLOUD)).toEqual(b)
  })
})

describe('replaceAuthorization', () => {
  it('页面自带的占位值(任意大小写)全删,只留宿主写的那一份', () => {
    const h: Record<string, string> = { authorization: 'Bearer tunnel', AUTHORIZATION: 'x', Accept: '*/*' }
    replaceAuthorization(h, 'Bearer real')
    expect(h).toEqual({ Accept: '*/*', Authorization: 'Bearer real' })
    const h2: Record<string, string> = { Authorization: 'Bearer tunnel' }
    replaceAuthorization(h2, 'Bearer real')
    expect(h2).toEqual({ Authorization: 'Bearer real' })
    const h3: Record<string, string> = {}
    replaceAuthorization(h3, 'Bearer real')
    expect(h3).toEqual({ Authorization: 'Bearer real' })
  })
})

describe('sharedOnlyUnit(units:openWindow 拒共享行)', () => {
  it('只在共享里 → true;自己名下 / 都没有 / 名册读失败 → false', () => {
    expect(sharedOnlyUnit(roster(), S)).toBe(true)
    expect(sharedOnlyUnit(roster(), OWN)).toBe(false)
    expect(sharedOnlyUnit(roster(), 'aaaaaaaa-0000-4000-8000-000000000009')).toBe(false)
    expect(sharedOnlyUnit({ ok: false, code: 'roster_unavailable' }, S)).toBe(false)
    expect(sharedOnlyUnit({ ok: true, units: [{ id: S }], shared: [sharedRow(S, 'frame', WEB)] }, S)).toBe(false)
  })
})

describe('自己名下的名册读法不吃共享行(添加到桌面按它核)', () => {
  it('parseRosterResponse 只认 units,shared 里的行不进来', () => {
    const r = parseRosterResponse({ status: 200, json: { units: [{ id: OWN, name: 'mine' }], shared: [{ id: S, name: 'theirs', shared: {} }] } })
    expect(r).toEqual({ ok: true, units: [{ id: OWN, name: 'mine', icon: null, platform: null }] })
  })
})
