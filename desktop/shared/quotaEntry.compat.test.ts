/**
 * 遥测 v3 契约 §16 新旧混跑:额度操作 / 下单的 entry 一律追加在通道参数末尾。
 *  - 新调用方 × 老接收方(Forsion Extend 0.10.x 的 channels.ts 原样逐条校验):照常成功,多出来的 entry 被忽略;
 *  - 没有 entry / 表外的 entry:一个参数都不多带(老接收方看到的和原来逐个相同);
 *  - 新接收方对表外的 entry 当没给,绝不因此拒绝(这里用 quotaEntry 模拟新接收方的口径)。
 * 下面的 old* 是 Forsion-Extend src/core/channels.ts(origin/main,2026-11-20)那几条 handler 的参数校验原样搬过来的。
 */
import { describe, expect, it } from 'vitest'
import { invokePayCenter, payCenterArgs, quotaEntry, QUOTA_ENTRIES } from './telemetryKeys'

const PAY_TABS = ['membership', 'credits', 'storefront'] as const
const PAY_PLAN_RE = /^[A-Za-z0-9_-]{1,64}$/
const PAY_PERIODS = ['monthly', 'quarterly', 'yearly'] as const
/** 老 Extend auth:openPayCenter(e, tab?, plan?, period?):给了不合规的就拒,多余参数不看。 */
function oldOpenPayCenter(...args: unknown[]): { ok: boolean; error?: string; url?: string } {
  const [tab, plan, period] = args
  if (tab !== undefined && !(PAY_TABS as readonly unknown[]).includes(tab)) return { ok: false, error: 'invalid_tab' }
  if (plan !== undefined && (typeof plan !== 'string' || !PAY_PLAN_RE.test(plan))) return { ok: false, error: 'invalid_plan' }
  if (period !== undefined && !(PAY_PERIODS as readonly unknown[]).includes(period)) return { ok: false, error: 'invalid_period' }
  return { ok: true, url: `/pay?tab=${tab ?? 'membership'}` }
}
/** 老 Extend account:useResetCard(e, type?):缺省 both,给了别的就拒。 */
function oldUseResetCard(...args: unknown[]): { status: number; body?: unknown } {
  const [type] = args
  if (type !== undefined && type !== 'both') return { status: 400 }
  return { status: 200, body: { type: type ?? 'both' } }
}
function oldBgConvert(...args: unknown[]): { status: number; body?: unknown } {
  const [percent] = args
  if (!Number.isInteger(percent) || (percent as number) < 1 || (percent as number) > 100) return { status: 400 }
  return { status: 200, body: { percent } }
}
function oldBoolSwitch(...args: unknown[]): { status: number; body?: unknown } {
  const [enabled] = args
  if (typeof enabled !== 'boolean') return { status: 400 }
  return { status: 200, body: { enabled } }
}
/** 新接收方:末位 entry 过枚举,表外的当没给。 */
function newUseResetCard(...args: unknown[]): { status: number; body?: unknown } {
  const r = oldUseResetCard(...args)
  const e = quotaEntry(args[1])
  return r.status === 200 ? { status: 200, body: { ...(r.body as object), ...(e ? { entry: e } : {}) } } : r
}

describe('新调用方 × 老 Extend:entry 追加在末尾,老接收方照常成功', () => {
  it('openPayCenter:entry 排在 (tab, plan, period) 之后;前三位是 undefined,不是 null', () => {
    const args = payCenterArgs({ entry: 'chat-banner' })
    expect(args).toEqual([undefined, undefined, undefined, 'chat-banner'])
    expect(args.slice(0, 3).every((a) => a === undefined)).toBe(true)
    expect(oldOpenPayCenter(...args)).toEqual({ ok: true, url: '/pay?tab=membership' })
    // 要是前三位被当成 null 交过去,老 Extend 会拒 —— 这正是不能拿 {entry} 当首参、也不能填 null 的原因
    expect(oldOpenPayCenter({ entry: 'chat-banner' })).toEqual({ ok: false, error: 'invalid_tab' })
    expect(oldOpenPayCenter(null, null, null, 'chat-banner')).toEqual({ ok: false, error: 'invalid_tab' })
  })
  it('useResetCard / bgConvert / bgAutoMain / pointsAutoDeduct:调用方把 entry 写在末尾、preload 原样转,老接收方照常', () => {
    // 这几处调用点原样(QuotaAdvisoryBanner / AccountCard / pointsAutoDeduct):第一个参数写明,entry 跟在后面
    expect(oldUseResetCard('both', 'avatar-menu')).toEqual({ status: 200, body: { type: 'both' } })
    expect(oldUseResetCard(undefined, 'avatar-menu')).toEqual({ status: 200, body: { type: 'both' } })
    expect(oldBgConvert(10, 'chat-banner')).toEqual({ status: 200, body: { percent: 10 } })
    expect(oldBoolSwitch(true, 'quota-page')).toEqual({ status: 200, body: { enabled: true } })
    // 防烧卡:带 entry 时第一个参数绝不能是 null(老 / 新接收方都回 400)
    expect(oldUseResetCard(null, 'avatar-menu').status).toBe(400)
  })
  it('没有 entry / 表外的 entry:openPayCenter 一个参数都不多带', () => {
    expect(payCenterArgs()).toEqual([])
    expect(payCenterArgs({ entry: 'nope' })).toEqual([])
    expect(payCenterArgs({ entry: undefined })).toEqual([])
  })
})

describe('openPayCenter 带 entry 被拒时不带 entry 重开一次', () => {
  it('invalid_* → 立刻无参重试;成功 / 别的失败 / 没带 entry 都不重试', async () => {
    const calls: unknown[][] = []
    const rejectFourth = async (...a: unknown[]) => { calls.push(a); return a.length > 3 ? { ok: false, error: 'invalid_tab' } : { ok: true } }
    expect(await invokePayCenter(rejectFourth, { entry: 'chat-banner' })).toEqual({ ok: true })
    expect(calls).toEqual([[undefined, undefined, undefined, 'chat-banner'], []])
    calls.length = 0
    const old = async (...a: unknown[]) => { calls.push(a); return oldOpenPayCenter(...a) }
    expect((await invokePayCenter(old, { entry: 'run-error' })).ok).toBe(true)
    expect(calls).toHaveLength(1)
    calls.length = 0
    const offline = async (...a: unknown[]) => { calls.push(a); return { ok: false } }
    expect(await invokePayCenter(offline, { entry: 'run-error' })).toEqual({ ok: false })
    expect(await invokePayCenter(rejectFourth)).toEqual({ ok: true })
    expect(calls).toEqual([[undefined, undefined, undefined, 'run-error'], []]) // 没 entry 的那次只发一回
  })
})

describe('新接收方:表外的 entry 当没给,不拒', () => {
  it('合法的带上,不合法的丢掉,请求照常', () => {
    expect(newUseResetCard('both', 'backpack')).toEqual({ status: 200, body: { type: 'both', entry: 'backpack' } })
    expect(newUseResetCard('both', 'from-the-future')).toEqual({ status: 200, body: { type: 'both' } })
    expect(newUseResetCard('both')).toEqual({ status: 200, body: { type: 'both' } })
  })
  it('入口表照抄契约 §17', () => {
    expect(QUOTA_ENTRIES).toEqual(['chat-banner', 'run-error', 'run-toast', 'avatar-menu', 'muse-settings', 'quota-page', 'agent-tool', 'backpack', 'other'])
  })
})
