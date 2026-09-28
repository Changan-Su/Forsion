/**
 * 远程会话控制器(P1 · K4):迁移、落盘、K5 门控、账号作用域、确认状态机、IPC 发送方校验、主进程文案。
 * 零 electron:文件读写、名册、确认框、时钟全部注入。
 * 跑法:npx vitest run electron/remoteSessions.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  confirmDialogOptions, createRemoteSessions, lookupRosterUnit, parseRemoteSessionsFile, registerRemoteSessionsIpc,
  REMOTE_SESSIONS_FILE, REMOTE_SESSIONS_MESSAGES, type ConfirmDialogOptions, type RemoteSessionsDeps, type RosterUnit,
} from './remoteSessions'
import { setMainLocale } from './mainI18n'
import type { UnitCaller } from './unitCaller'
import type { CapMode, RemoteSessionsView } from '../shared/remoteSessions'

const ACC = 'https://cloud.test::u1'
const PHONE_ID = '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f'
const phone = (id = PHONE_ID, over: Partial<{ name: string; kind: 'phone' | 'desktop' }> = {}): UnitCaller =>
  ({ kind: 'unit', caller: { unit: id, kind: over.kind ?? 'phone', name: over.name ?? '断言里的名字', platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z' } })
const ROSTER: RosterUnit = { name: '小米 14(改过名)', registeredName: '小米 14', kind: 'phone', platform: 'android', createdAt: '2026-09-20T08:00:00.000Z' }
const RUN = { method: 'POST', path: '/agent/runs', via: 'tunnel' }
const tick = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }

interface Prompt { opts: ConfirmDialogOptions; signal: AbortSignal; answer(v: boolean | null): void }

function harness(o: {
  disk?: string | null
  host?: boolean
  account?: string | null
  permitted?: boolean
  roster?: Record<string, RosterUnit | null> | 'unreachable'
  /** 确认框被 signal 关掉时仍回 true(模拟「关框后才到的答复」)。 */
  lateAnswer?: boolean
} = {}) {
  const env = {
    disk: o.disk === undefined ? null : o.disk,
    host: o.host ?? false,
    account: o.account === undefined ? ACC : o.account,
    permitted: o.permitted ?? true,
    locked: false,
    failWrite: false,
    cap: 'auto-edit' as CapMode,
    clock: 1_790_000_000_000,
    roster: o.roster ?? { [PHONE_ID]: ROSTER },
  }
  const writes: any[] = []
  const prompts: Prompt[] = []
  const changed: RemoteSessionsView[] = []
  const capWrites: CapMode[] = []
  const lookupUnit = vi.fn(async (id: string) => (env.roster === 'unreachable' ? 'unreachable' as const : env.roster[id] ?? null))
  const permitted = vi.fn(() => env.permitted)
  const confirm = vi.fn((opts: ConfirmDialogOptions, signal: AbortSignal) => new Promise<boolean | null>((resolve) => {
    prompts.push({ opts, signal, answer: resolve })
    if (!o.lateAnswer) signal.addEventListener('abort', () => resolve(null)) // 真 Electron:signal 关框 = 按取消;main.ts 据 signal.aborted 回 null
  }))
  const deps: RemoteSessionsDeps = {
    file: () => '/userData/remote-sessions.json',
    unitHostEnabled: async () => env.host,
    readCap: async () => env.cap,
    writeCap: async (m) => { env.cap = m; capWrites.push(m) },
    accountId: () => env.account,
    lookupUnit,
    confirm,
    permitted,
    isLocked: () => env.locked,
    onChanged: (v) => { changed.push(v) },
    log: () => {},
    now: () => env.clock,
    readFile: async () => env.disk,
    writeFile: async (_f, data) => {
      if (env.failWrite) throw new Error('EIO')
      env.disk = JSON.stringify(data)
      writes.push(JSON.parse(env.disk))
    },
  }
  const rs = createRemoteSessions(deps)
  return { rs, env, writes, prompts, changed, capWrites, lookupUnit, confirm, permitted, deps, disk: () => (env.disk ? JSON.parse(env.disk) : null) }
}
const booted = async (o: Parameters<typeof harness>[0] = {}) => { const h = harness(o); await h.rs.init(); return h }
const enabledDisk = (extra: object = {}): string => JSON.stringify({ v: 1, enabled: true, migratedFromUnitHost: false, trusted: [], ...extra })

afterEach(() => { vi.useRealTimers(); setMainLocale(null) })

describe('迁移(一次性、持久化)', () => {
  it('新用户:无文件 + 未开互联 → 写 enabled:false;之后打开「允许其他设备连接本机」不带开远程会话(负对照 #2)', async () => {
    const h = await booted({ host: false })
    expect(h.disk()).toMatchObject({ v: 1, enabled: false, migratedFromUnitHost: false, trusted: [] })
    expect(h.rs.isEnabled()).toBe(false)
    h.env.host = true // 用户随后打开父开关
    expect(h.rs.isEnabled()).toBe(false)
    expect((await h.rs.view()).enabled).toBe(false)
    // 下次启动:文件在 → 绝不再看 unitHostEnabled
    const again = harness({ disk: h.env.disk, host: true })
    await again.rs.init()
    expect(again.rs.isEnabled()).toBe(false)
    expect(again.writes).toEqual([])
  })

  it('老用户:无文件 + 已开互联 + 已登录 → 开关开 + 账号行预置(preconfirmed);浏览器设备页照常能起任务', async () => {
    const h = await booted({ host: true })
    expect(h.disk()).toMatchObject({ enabled: true, migratedFromUnitHost: true, trusted: [{ principal: 'account', accountId: ACC, preconfirmed: true }] })
    expect(h.rs.isEnabled()).toBe(true)
    expect(h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } })).toEqual({ ok: true })
    expect((await h.rs.view()).trusted).toEqual([{ principal: 'account', confirmedAt: h.env.clock, preconfirmed: true }])
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('老用户但迁移时未登录:开关开,不写通配账号行(之后登录的账号第一次要确认)', async () => {
    const h = await booted({ host: true, account: null })
    expect(h.disk()).toMatchObject({ enabled: true, trusted: [] })
    h.env.account = ACC
    const g = h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } })
    expect(!g.ok && g.body).toMatchObject({ code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending' })
  })

  it('迁移落盘失败:本次按迁移结果运行,下次启动重来(文件仍不存在)', async () => {
    const h = harness({ host: true })
    h.env.failWrite = true
    await h.rs.init()
    expect(h.rs.isEnabled()).toBe(true)
    expect(h.env.disk).toBeNull()
  })

  it('坏 JSON → fail closed(关、零信任),不回写;形状不合法的行被丢', async () => {
    const h = await booted({ disk: '{"v":1,"enabled":tru', host: true })
    expect(h.rs.isEnabled()).toBe(false)
    expect(h.writes).toEqual([])
    expect(parseRemoteSessionsFile('[1]')).toBeNull()
    const p = parseRemoteSessionsFile(JSON.stringify({ enabled: true, trusted: [
      { principal: 'unit', accountId: ACC, unitId: 'not-a-uuid', name: 'x', kind: 'phone', confirmedAt: 1 },
      { principal: 'unit', accountId: ACC, unitId: PHONE_ID, name: 'ok', kind: 'tablet', confirmedAt: 1 },
      { principal: 'account', confirmedAt: 1 },
      { principal: 'unit', accountId: ACC, unitId: PHONE_ID.toUpperCase(), name: 'A\u202eB', kind: 'phone', confirmedAt: 2 },
    ] }))
    expect(p!.trusted).toEqual([{ principal: 'unit', accountId: ACC, unitId: PHONE_ID, name: 'AB', kind: 'phone', platform: null, registeredAt: null, confirmedAt: 2 }])
  })
})

describe('开关 / 审批档 / 撤销:落盘与广播', () => {
  it('R-24:K5 不允许时 isEnabled=false(存档开也一样)、setEnabled(true) 抛 secret-store-insecure、闸回 REMOTE_SESSIONS_OFF', async () => {
    const h = await booted({ disk: enabledDisk(), permitted: false, host: true })
    expect(h.rs.isEnabled()).toBe(false)
    await expect(h.rs.setEnabled(true)).rejects.toThrow('secret-store-insecure')
    const g = h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'paired', pairId: 'p', name: 'x' } })
    expect(!g.ok && g.body.code).toBe('REMOTE_SESSIONS_OFF')
    expect((await h.rs.view())).toMatchObject({ enabled: true, permitted: false })
    h.env.permitted = true // 用户在本机解决了钥匙串
    expect(h.rs.isEnabled()).toBe(true)
  })

  it('K5 懒加载契约(评审 P1):互联关着 → init / 广播 / view / notifyChanged 都不问 K5(permitted=null = 未知,不是未加密);互联一开才问', async () => {
    // 新用户(无文件);以及迁移过来开关开着、后来关了互联的老用户 —— 两种人都不许因为这个包在每次启动时碰钥匙串
    for (const disk of [null, enabledDisk({ trusted: [{ principal: 'account', accountId: ACC, confirmedAt: 1, preconfirmed: true }] })]) {
      const h = harness({ disk, host: false })
      await h.rs.init()
      await tick(12)
      h.rs.notifyChanged()
      await tick(12)
      const v = await h.rs.view()
      expect(v.permitted, String(disk)).toBeNull()
      expect(h.changed.length).toBeGreaterThan(0)
      expect(h.changed.every((x) => x.permitted === null)).toBe(true)
      expect(h.permitted).not.toHaveBeenCalled()
      h.env.host = true // 用户打开「允许其他设备连接本机」:这时才问(同 K5 提示只在互联开着时问状态)
      expect((await h.rs.view()).permitted).toBe(true)
      expect(h.permitted).toHaveBeenCalled()
    }
  })

  it('setEnabled:开 = 落盘成功才生效;关 = 先关再落盘(落盘失败内存仍是关);都广播', async () => {
    const h = await booted()
    h.env.failWrite = true
    await expect(h.rs.setEnabled(true)).rejects.toThrow('EIO')
    expect(h.rs.isEnabled()).toBe(false)
    h.env.failWrite = false
    const v = await h.rs.setEnabled(true)
    expect(v.enabled).toBe(true)
    expect(h.disk().enabled).toBe(true)
    h.env.failWrite = true
    await expect(h.rs.setEnabled(false)).rejects.toThrow('EIO')
    expect(h.rs.isEnabled()).toBe(false)
    await tick()
    expect(h.changed.at(-1)!.enabled).toBe(false)
    await expect(h.rs.setEnabled('yes' as unknown as boolean)).rejects.toThrow('bad-arg')
  })

  it('审批档只收三值(custom / 其他 → 抛,永不写);写后广播,闸的状态面同步', async () => {
    const h = await booted({ disk: enabledDisk() })
    for (const bad of ['custom', 'x', undefined, null, 1]) await expect(h.rs.setMaxApprovalMode(bad)).rejects.toThrow('bad-approval-mode')
    expect(h.capWrites).toEqual([])
    const v = await h.rs.setMaxApprovalMode('full-auto')
    expect(v.maxApprovalMode).toBe('full-auto')
    expect(h.capWrites).toEqual(['full-auto'])
    expect(h.rs.gate.status({ kind: 'account' }).maxApprovalMode).toBe('full-auto')
  })

  it('账号作用域:只认当前账号的行;换号后旧行不生效、不显示,换回来又在', async () => {
    const other = 'https://cloud.test::u2'
    const h = await booted({ disk: enabledDisk({ trusted: [
      { principal: 'account', accountId: ACC, confirmedAt: 5 },
      { principal: 'unit', accountId: other, unitId: PHONE_ID, name: '别人的手机', kind: 'phone', confirmedAt: 6 },
    ] }) })
    expect(h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } })).toEqual({ ok: true })
    expect((await h.rs.view()).trusted).toEqual([{ principal: 'account', confirmedAt: 5, preconfirmed: false }])
    expect(h.rs.trustedCaller(PHONE_ID)).toBeNull()
    h.env.account = other
    expect(h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } }).ok).toBe(false)
    expect(h.rs.trustedCaller(PHONE_ID)?.name).toBe('别人的手机')
    h.env.account = null // 未登录:谁都不信
    expect(h.rs.gate.gateEngine({ ...RUN, caller: phone() }).ok).toBe(false)
  })

  it('撤销:设备行 / 账号行都先生效再落盘;撤销后闸重新 403;不认的主体抛', async () => {
    const h = await booted({ disk: enabledDisk({ trusted: [
      { principal: 'account', accountId: ACC, confirmedAt: 5, preconfirmed: true },
      { principal: 'unit', accountId: ACC, unitId: PHONE_ID, name: '小米 14', kind: 'phone', confirmedAt: 6 },
    ] }) })
    expect(h.rs.gate.gateEngine({ ...RUN, caller: phone() })).toEqual({ ok: true })
    await h.rs.revoke(PHONE_ID.toUpperCase())
    expect(h.disk().trusted.map((r: any) => r.principal)).toEqual(['account'])
    const g = h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    expect(!g.ok && g.body.code).toBe('REMOTE_CALLER_UNCONFIRMED')
    const v = await h.rs.revoke('account')
    expect(v.trusted.some((r) => r.principal === 'account')).toBe(false)
    expect(h.disk().trusted).toEqual([])
    for (const bad of ['', 'x', '../etc', 42, null]) await expect(h.rs.revoke(bad)).rejects.toThrow('bad-principal')
  })
})

describe('首次本机确认(状态机)', () => {
  it('未受信设备:闸当场 403 pending(不等弹框)→ 查名册 → 弹一次(名字 = registeredName)→ 允许 → 先落盘再信任;快照之后不随名册改名', async () => {
    const h = await booted({ disk: enabledDisk() })
    const g = h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    expect(!g.ok && g.body).toMatchObject({ code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending' })
    // 去重:同一台设备连打,不再弹、不再查
    for (let i = 0; i < 5; i++) h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick()
    expect(h.lookupUnit).toHaveBeenCalledTimes(1)
    expect(h.prompts.length).toBe(1)
    expect(h.prompts[0].opts.message).toContain('小米 14')
    expect(h.prompts[0].opts.message).not.toContain('改过名')
    expect(h.prompts[0].opts.message).not.toContain('断言里的名字')
    expect(h.rs.gate.status(phone()).caller).toBe('pending')
    h.prompts[0].answer(true)
    await tick(12)
    expect(h.disk().trusted[0]).toMatchObject({ principal: 'unit', accountId: ACC, unitId: PHONE_ID, name: '小米 14', kind: 'phone', platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z' })
    expect(h.rs.gate.gateEngine({ ...RUN, caller: phone() })).toEqual({ ok: true })
    h.env.roster = { [PHONE_ID]: { ...ROSTER, registeredName: null, name: '冒充的名字' } }
    expect((await h.rs.view()).trusted[0]).toMatchObject({ name: '小米 14' })
    expect(h.rs.trustedCaller(PHONE_ID)?.name).toBe('小米 14')
    expect(h.capWrites).toEqual([]) // 确认流程之外零外呼(不写审批档、不碰别的面)
  })

  it('负对照 #3:unitId 不在本账号名册里 → 直接 denied,不弹框', async () => {
    const h = await booted({ disk: enabledDisk(), roster: {} })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick(12)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.rs.gate.status(phone()).caller).toBe('denied')
  })

  it('名册不可达 → 不弹框、回 unconfirmed(不拿断言自报的名字弹框);可再请求', async () => {
    const h = await booted({ disk: enabledDisk(), roster: 'unreachable' })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick(12)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.rs.gate.status(phone()).caller).toBe('unconfirmed')
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick(12)
    expect(h.lookupUnit).toHaveBeenCalledTimes(2)
  })

  it('R-25:名册 kind 与断言不一致 → denied,不弹框', async () => {
    const h = await booted({ disk: enabledDisk() })
    h.rs.gate.gateEngine({ ...RUN, caller: phone(PHONE_ID, { kind: 'desktop' }) })
    await tick(12)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.rs.gate.status(phone()).caller).toBe('denied')
  })

  it('负对照 #5:允许后落盘失败 → 仍不信任(unconfirmed),内存与盘都没有这一行', async () => {
    const h = await booted({ disk: enabledDisk() })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick()
    h.env.failWrite = true
    h.prompts[0].answer(true)
    await tick(12)
    expect(h.rs.gate.status(phone()).caller).toBe('unconfirmed')
    expect(h.rs.gate.gateEngine({ ...RUN, caller: phone() }).ok).toBe(false)
    expect(h.disk().trusted).toEqual([])
  })

  it('拒绝 → denied,内存冷却 10 分钟内不再弹;到期后可再请求', async () => {
    const h = await booted({ disk: enabledDisk() })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick()
    h.prompts[0].answer(false)
    await tick(12)
    expect(h.rs.gate.status(phone()).caller).toBe('denied')
    const g = h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    expect(!g.ok && g.body.state).toBe('denied')
    await tick(12)
    expect(h.prompts.length).toBe(1)
    h.env.clock += 10 * 60_000 + 1
    expect(h.rs.gate.status(phone()).caller).toBe('unconfirmed')
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick(12)
    expect(h.prompts.length).toBe(2)
  })

  it('全局 1 框 + 队列 ≤ 3:第 5 个不同的调用方直接 unconfirmed、不排队;前一个答完才弹下一个', async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => `0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6${n}`)
    const h = await booted({ disk: enabledDisk(), roster: Object.fromEntries(ids.map((id) => [id, ROSTER])) })
    const states = ids.map((id) => { const g = h.rs.gate.gateEngine({ ...RUN, caller: phone(id) }); return g.ok ? 'ok' : g.body.state })
    expect(states).toEqual(['pending', 'pending', 'pending', 'pending', 'unconfirmed'])
    await tick(12)
    expect(h.prompts.length).toBe(1)
    h.prompts[0].answer(false)
    await tick(12)
    expect(h.prompts.length).toBe(2)
    expect((await h.rs.view()).pending.length).toBe(3)
  })

  it('TTL 2 分钟:到点经 signal 真关框 → unconfirmed(不是 denied)', async () => {
    vi.useFakeTimers()
    const h = await booted({ disk: enabledDisk() })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick()
    expect(h.prompts[0].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(h.prompts[0].signal.aborted).toBe(true)
    await tick(12)
    expect(h.rs.gate.status(phone()).caller).toBe('unconfirmed')
  })

  it('弹框开着时关掉开关:signal 真关框、排队清空;关框后才到的「允许」一律丢弃', async () => {
    const h = await booted({ disk: enabledDisk(), lateAnswer: true, roster: { [PHONE_ID]: ROSTER, '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e61': ROSTER } })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    h.rs.gate.gateEngine({ ...RUN, caller: phone('0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e61') })
    await tick()
    await h.rs.setEnabled(false)
    expect(h.prompts[0].signal.aborted).toBe(true)
    h.prompts[0].answer(true) // 迟到的「允许」
    await tick(12)
    await h.rs.setEnabled(true)
    expect(h.disk().trusted).toEqual([])
    expect(h.rs.gate.status(phone()).caller).toBe('unconfirmed')
    expect(h.prompts.length).toBe(1) // 排队的那个没被弹
    expect((await h.rs.view()).pending).toEqual([])
  })

  it('R-26:锁定时不弹确认、不查名册', async () => {
    const h = await booted({ disk: enabledDisk() })
    h.env.locked = true
    const g = h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    expect(!g.ok && g.body.state).toBe('unconfirmed')
    await h.rs.gate.request({ kind: 'account' })
    await tick(12)
    expect(h.lookupUnit).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('弹框期间换号 / 撤销那个待确认项:框被关掉,结果丢弃', async () => {
    const h = await booted({ disk: enabledDisk(), lateAnswer: true })
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick()
    h.env.account = 'https://cloud.test::u2'
    h.rs.notifyChanged()
    expect(h.prompts[0].signal.aborted).toBe(true)
    h.prompts[0].answer(true)
    await tick(12)
    h.env.account = ACC
    expect(h.rs.gate.status(phone()).caller).toBe('unconfirmed')
    h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    await tick()
    await h.rs.revoke(PHONE_ID)
    expect(h.prompts[1].signal.aborted).toBe(true)
    h.prompts[1].answer(true)
    await tick(12)
    expect(h.disk().trusted).toEqual([])
  })

  it('U1 账号行:未识别客户端第一次请求会话档弹「本账号的浏览器与网页版」,允许后 account 放行,P2P 跟随;P2P 自己从不触发确认', async () => {
    setMainLocale('zh')
    const h = await booted({ disk: enabledDisk() })
    const p2p = h.rs.gate.gateEngine({ ...RUN, via: 'p2p', caller: { kind: 'p2p' } })
    expect(!p2p.ok && p2p.body.state).toBe('unconfirmed')
    await h.rs.gate.request({ kind: 'p2p' })
    await tick(12)
    expect(h.confirm).not.toHaveBeenCalled()
    h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } })
    await tick()
    expect(h.lookupUnit).not.toHaveBeenCalled() // 账号行不查名册
    expect(h.prompts[0].opts.message).toBe('你账号下的浏览器与网页版请求在这台电脑上运行会话')
    h.prompts[0].answer(true)
    await tick(12)
    expect(h.disk().trusted).toEqual([{ principal: 'account', accountId: ACC, confirmedAt: h.env.clock }])
    expect(h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } })).toEqual({ ok: true })
    expect(h.rs.gate.gateEngine({ ...RUN, via: 'p2p', caller: { kind: 'p2p' } })).toEqual({ ok: true })
    expect(h.rs.gate.status({ kind: 'p2p' })).toEqual({ remoteSessions: true, principal: 'p2p', caller: 'trusted', maxApprovalMode: 'auto-edit' })
    expect(h.rs.trustedCaller('account')?.name).toBe('本账号的浏览器与网页版')
    // 局域网配对:开关开即放行,不进信任表
    expect(h.rs.gate.gateEngine({ ...RUN, via: 'lan', caller: { kind: 'paired', pairId: 'p', name: 'x' } })).toEqual({ ok: true })
    expect(h.rs.gate.status({ kind: 'paired', pairId: 'p', name: 'x' })).toMatchObject({ principal: 'lan', caller: 'paired' })
  })

  it('开关关:闸与 request 都不弹框;基础档照常', async () => {
    const h = await booted()
    const g = h.rs.gate.gateEngine({ ...RUN, caller: phone() })
    expect(!g.ok && g.body.code).toBe('REMOTE_SESSIONS_OFF')
    expect(h.rs.gate.gateEngine({ method: 'POST', path: '/agent/runs/r1/approvals/a1', via: 'tunnel', caller: phone() })).toEqual({ ok: true })
    expect(await h.rs.gate.request(phone())).toMatchObject({ remoteSessions: false, principal: 'unit', caller: 'unconfirmed' })
    await tick(12)
    expect(h.lookupUnit).not.toHaveBeenCalled()
  })

  it('init 之前:闸 fail closed(连基础档之外一律 OFF)', () => {
    const h = harness({ disk: enabledDisk({ trusted: [{ principal: 'account', accountId: ACC, confirmedAt: 1 }] }) })
    const g = h.rs.gate.gateEngine({ ...RUN, caller: { kind: 'account' } })
    expect(!g.ok && g.body.code).toBe('REMOTE_SESSIONS_OFF')
    expect(h.rs.isEnabled()).toBe(false)
  })
})

describe('IPC / 文案 / 名册 / 落点', () => {
  it('IPC 四个通道都先校验发送方(webview / 子 frame → forbidden)', async () => {
    const h = await booted()
    const handlers = new Map<string, (e: any, ...a: any[]) => unknown>()
    let trusted = false
    registerRemoteSessionsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, h.rs, () => trusted)
    expect([...handlers.keys()].sort()).toEqual(['remoteSessions:get', 'remoteSessions:revoke', 'remoteSessions:setEnabled', 'remoteSessions:setMaxApprovalMode'])
    for (const [ch, args] of [['remoteSessions:get', []], ['remoteSessions:setEnabled', [true]], ['remoteSessions:setMaxApprovalMode', ['full-auto']], ['remoteSessions:revoke', ['account']]] as const) {
      await expect(Promise.resolve().then(() => handlers.get(ch)!({}, ...args)), ch).rejects.toThrow('forbidden')
    }
    expect(h.capWrites).toEqual([])
    trusted = true
    expect(((await handlers.get('remoteSessions:setEnabled')!({}, true)) as RemoteSessionsView).enabled).toBe(true)
  })

  it('确认框文案:zh / en 键集与占位符逐字一致、en 无汉字;名字里的 {占位符} 与双向覆写字符不生效', () => {
    for (const [k, v] of Object.entries(REMOTE_SESSIONS_MESSAGES)) {
      const ph = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(ph(v.en), k).toEqual(ph(v.zh))
      expect(/[一-鿿]/.test(v.en), k).toBe(false)
    }
    const info = { principal: 'unit' as const, unitId: PHONE_ID, name: '{idTail}\u202e好手机', kind: 'phone' as const, platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z', cap: 'auto-edit' as const }
    setMainLocale('zh')
    const zh = confirmDialogOptions(info)
    expect(zh.message).toBe('「{idTail}好手机」请求在这台电脑上运行会话')
    expect(zh.detail).toContain('设备：手机 · android')
    expect(zh.detail).toContain('首次登记：2026-09-20')
    expect(zh.detail).toContain('设备 ID：…4d5e6f')
    expect(zh.detail).toContain('审批档最高为「自动编辑」')
    expect(zh.buttons).toEqual(['允许', '不允许'])
    expect([zh.defaultId, zh.cancelId]).toEqual([1, 1]) // 回车 / Esc = 不允许
    setMainLocale('en')
    const en = confirmDialogOptions({ principal: 'account', cap: 'full-auto' })
    expect(en.title).toBe('Remote session request')
    expect(en.detail).toContain('capped at "Full auto"')
    expect(/[一-鿿]/.test(JSON.stringify(en))).toBe(false)
  })

  it('lookupRosterUnit:按 id(不分大小写)找;不在 → null;401 / 坏包 / 网络错 → unreachable;未登录不发请求', async () => {
    const f = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
    const units = { units: [{ id: PHONE_ID.toUpperCase(), name: 'n', registeredName: 'r', kind: 'phone', platform: 'android', createdAt: '2026-01-01' }] }
    expect(await lookupRosterUnit({ base: 'https://c.test/', token: 't', fetch: f(200, units) }, PHONE_ID)).toEqual({ name: 'n', registeredName: 'r', kind: 'phone', platform: 'android', createdAt: '2026-01-01' })
    expect(await lookupRosterUnit({ base: 'https://c.test', token: 't', fetch: f(200, { units: [] }) }, PHONE_ID)).toBeNull()
    expect(await lookupRosterUnit({ base: 'https://c.test', token: 't', fetch: f(401, {}) }, PHONE_ID)).toBe('unreachable')
    expect(await lookupRosterUnit({ base: 'https://c.test', token: 't', fetch: f(200, { nope: 1 }) }, PHONE_ID)).toBe('unreachable')
    expect(await lookupRosterUnit({ base: 'https://c.test', token: 't', fetch: vi.fn(async () => { throw new Error('ENOTFOUND') }) }, PHONE_ID)).toBe('unreachable')
    const none = vi.fn()
    expect(await lookupRosterUnit({ base: 'https://c.test', token: '', fetch: none as never }, PHONE_ID)).toBe('unreachable')
    expect(none).not.toHaveBeenCalled()
  })

  it('⑪ 文件落在 userData 下(继承 C4 凭据路径保护):main.ts 用 join(app.getPath(\'userData\'), REMOTE_SESSIONS_FILE)', () => {
    expect(REMOTE_SESSIONS_FILE).toBe('remote-sessions.json')
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    expect(main).toContain("join(app.getPath('userData'), REMOTE_SESSIONS_FILE)")
    // 清空数据(desktop)一并删掉 → 重置信任(G11:急停的 remote-lock.json 不在此列,那是 K2 的)
    expect(main).toMatch(/for \(const f of \[[^\]]*REMOTE_SESSIONS_FILE[^\]]*\]\)/)
  })
})
