/**
 * 会话档闸的分档表与判定真值表(P1 · K4 §3.3 / §6)。
 * 跑法:npx vitest run electron/remoteSessionGate.test.ts
 */
import { describe, expect, it } from 'vitest'
import { ENGINE_ROUTES } from './engineRoutes.generated'
import { engineRouteAccess } from './unitWeb'
import { baseTierOnly, decideRemoteEngine, REMOTE_BASE_TIER_NON_GET, remoteEngineTier } from './remoteSessionGate'
import type { UnitCaller } from './unitCaller'
import type { TrustState } from '../shared/remoteSessions'

const PHONE: UnitCaller = { kind: 'unit', caller: { unit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', kind: 'phone', name: '小米 14', platform: 'android', registeredAt: null } }
const CALLERS: Record<string, UnitCaller> = {
  unit: PHONE,
  account: { kind: 'account' },
  paired: { kind: 'paired', pairId: 'p1', name: '客厅 iPad' },
  p2p: { kind: 'p2p' },
}
/** 模板 → 一条具体路径(参数换成样例值)。 */
const concrete = (tpl: string): string => tpl.replace(/:[^/]+/g, 'x1')

describe('remoteEngineTier', () => {
  it('显式基础档表每一行都在生成表里且为 allow(模板逐字一致;生成器改了参数名 / 路由没了就红)', () => {
    for (const [m, p] of REMOTE_BASE_TIER_NON_GET) {
      const row = ENGINE_ROUTES.find((r) => r.method === m && r.path === p)
      expect(row, `${m} ${p}`).toBeTruthy()
      expect(row!.access, `${m} ${p}`).toBe('allow')
      expect(remoteEngineTier(m, concrete(p)), `${m} ${p}`).toBe('base')
    }
  })

  it('完备性:每条 allow 行都落到某一档;GET 全在基础档;非 GET 只有显式表里的在基础档(新路由缺省会话档)', () => {
    const base = new Set(REMOTE_BASE_TIER_NON_GET.map(([m, p]) => `${m} ${p}`))
    for (const r of ENGINE_ROUTES.filter((x) => x.access === 'allow')) {
      const tier = remoteEngineTier(r.method, concrete(r.path))
      if (r.method === 'GET') expect(tier, `${r.method} ${r.path}`).toBe('base')
      else expect(tier, `${r.method} ${r.path}`).toBe(base.has(`${r.method} ${r.path}`) ? 'base' : 'session')
    }
  })

  it('关键行:起 run / steer / 建会话 / 改会话配置 / 上传附件 / 朗读 / 交给 Muse 执行 → 会话档;答审批 / 询问 / 停止 / 截图 / 收件箱杂务 → 基础档;HEAD 按 GET', () => {
    for (const [m, p] of [
      ['POST', '/agent/runs'], ['POST', '/agent/runs/r1/steer'], ['DELETE', '/agent/runs/r1/steer/m1'],
      ['POST', '/agent/sessions'], ['PATCH', '/agent/sessions/s1'], ['PATCH', '/agent/sessions/s1/config'],
      ['POST', '/agent/sessions/s1/branch'], ['POST', '/agent/sessions/s1/aside'], ['POST', '/agent/sessions/s1/compact'],
      ['POST', '/agent/workspace/upload'], ['POST', '/agent/tts'], ['POST', '/agent/vision/describe'],
      ['POST', '/agent/special/muse/todos/t1/approve'], ['POST', '/agent/solo/agent/a1/open'], ['POST', '/agent/teams/t1/session/open'],
    ] as const) {
      expect(engineRouteAccess(m, p), `${m} ${p}`).toBe('allow')
      expect(remoteEngineTier(m, p), `${m} ${p}`).toBe('session')
    }
    for (const [m, p] of [
      ['POST', '/agent/runs/r1/approvals/a1'], ['POST', '/agent/runs/r1/inquiries/q1'], ['POST', '/agent/runs/r1/abort'],
      ['POST', '/agent/runs/r1/captures/s1'], ['POST', '/agent/special/approvals/x/approve'], ['POST', '/agent/special/approvals/x/reject'],
      ['PATCH', '/agent/inbox/m1'], ['DELETE', '/agent/inbox/m1'], ['POST', '/agent/inbox/pull'], ['POST', '/agent/inbox/read-all'],
      ['POST', '/agent/inbox/m1/claim'], ['PATCH', '/agent/special/muse/todos/t1'], ['POST', '/agent/reply-segments'], ['POST', '/agent/commands/c/expand'],
      ['GET', '/agent/sessions'], ['HEAD', '/agent/sessions'], ['GET', '/agent/runs/r1/events'],
    ] as const) {
      expect(remoteEngineTier(m, p), `${m} ${p}`).toBe('base')
    }
    // 大小写不敏感(规整后的路径保留大小写,匹配时降)
    expect(remoteEngineTier('post', '/Agent/Runs/R1/Abort')).toBe('base')
    expect(remoteEngineTier('POST', '/Agent/Runs')).toBe('session')
  })

  it('没命中任何 allow 行的非 GET → 会话档(失败偏严;调用方本不该交进来)', () => {
    expect(remoteEngineTier('POST', '/agent/plugins/install')).toBe('session')
    expect(remoteEngineTier('PUT', '/agent/nope')).toBe('session')
  })
})

describe('decideRemoteEngine 真值表', () => {
  const trusts: Array<TrustState | null> = ['trusted', 'pending', 'denied', 'unconfirmed', null]
  it('base:任意开关 × 任意调用方 × 任意信任 → 放行', () => {
    for (const enabled of [true, false]) for (const c of Object.values(CALLERS)) for (const t of trusts) {
      expect(decideRemoteEngine('base', enabled, c, t)).toEqual({ ok: true })
    }
  })
  it('session + 开关关:任意调用方(含受信设备、局域网配对)→ 403 REMOTE_SESSIONS_OFF', () => {
    for (const c of Object.values(CALLERS)) for (const t of trusts) {
      const g = decideRemoteEngine('session', false, c, t)
      expect(g.ok).toBe(false)
      if (!g.ok) { expect(g.status).toBe(403); expect(g.body.code).toBe('REMOTE_SESSIONS_OFF'); expect(g.body.state).toBeUndefined() }
    }
  })
  it('session + 开关开:paired 放行;unit / account / p2p 只有 trusted 放行,其余 403 REMOTE_CALLER_UNCONFIRMED 带 state', () => {
    expect(decideRemoteEngine('session', true, CALLERS.paired, null)).toEqual({ ok: true })
    for (const k of ['unit', 'account', 'p2p'] as const) {
      expect(decideRemoteEngine('session', true, CALLERS[k], 'trusted')).toEqual({ ok: true })
      for (const t of ['pending', 'denied', 'unconfirmed', null] as const) {
        const g = decideRemoteEngine('session', true, CALLERS[k], t)
        expect(g.ok, `${k} ${t}`).toBe(false)
        if (!g.ok) expect(g.body).toMatchObject({ code: 'REMOTE_CALLER_UNCONFIRMED', state: t ?? 'unconfirmed' })
      }
    }
  })
  it('INV-MONO:未识别调用方(account)与未受信的已登记设备拿到逐字相同的拒绝', () => {
    for (const t of ['pending', 'denied', 'unconfirmed'] as const) {
      expect(decideRemoteEngine('session', true, CALLERS.account, t)).toEqual(decideRemoteEngine('session', true, CALLERS.unit, t))
    }
  })
  it('baseTierOnly(缺省闸):基础档放行,会话档一律 REMOTE_SESSIONS_OFF', () => {
    expect(baseTierOnly('GET', '/agent/sessions')).toEqual({ ok: true })
    expect(baseTierOnly('POST', '/agent/runs/r1/abort')).toEqual({ ok: true })
    const g = baseTierOnly('POST', '/agent/runs')
    expect(!g.ok && g.body.code).toBe('REMOTE_SESSIONS_OFF')
  })
})
