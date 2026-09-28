/**
 * 「允许远程会话」会话档闸的两个拒绝码(P1 · K4 / INTEGRATION R-10)在设备页 / web / 手机共用的本地化出口里:
 * REMOTE_SESSIONS_OFF、REMOTE_CALLER_UNCONFIRMED(state=denied 另有一句)。unitWeb 那句英文 detail 不上屏。
 */
import { describe, expect, it } from 'vitest'
import { httpErrorMessage, remoteCallerMessage, remoteRefusalMessage } from './localOnly'
import { setLocaleGlobal, translateFor } from '../i18n'

const res = (body: unknown, status = 403): Response => new Response(JSON.stringify(body), { status })

describe('localOnly × P1-K4 拒绝码', () => {
  it('两个码都换成本地化提示(zh / en 成对,en 无汉字)', () => {
    setLocaleGlobal('zh')
    expect(remoteRefusalMessage('REMOTE_SESSIONS_OFF')).toBe(translateFor('zh', 'unitpage.remoteSessionsOff'))
    expect(remoteRefusalMessage('REMOTE_SESSIONS_OFF')).toContain('设置 › 远程会话')
    expect(remoteRefusalMessage('REMOTE_CALLER_UNCONFIRMED')).toContain('允许')
    for (const k of ['unitpage.remoteSessionsOff', 'unitpage.remoteCallerUnconfirmed', 'unitpage.remoteCallerDenied', 'unitpage.remoteCallerStrict',
      'unitpage.remoteCallerNeverPrompts', 'unitpage.remoteCallerNotSignedIn', 'unitpage.remoteCallerRosterMiss', 'unitpage.remoteCallerRosterUnreachable',
      'unitpage.remoteCallerNoAnswer', 'unitpage.remoteCallerBusy']) {
      const en = translateFor('en', k)
      expect(en, k).not.toBe(k)
      expect(/[一-鿿]/.test(en), k).toBe(false)
    }
  })

  it('httpErrorMessage:403 REMOTE_SESSIONS_OFF / UNCONFIRMED 出本地化句子并带 code;state=denied 换「已被拒绝」那句', async () => {
    setLocaleGlobal('zh')
    const off = await httpErrorMessage(res({ code: 'REMOTE_SESSIONS_OFF', detail: 'Remote sessions are turned off on this device' }))
    expect(off).toEqual({ message: translateFor('zh', 'unitpage.remoteSessionsOff'), code: 'REMOTE_SESSIONS_OFF' })
    const pending = await httpErrorMessage(res({ code: 'REMOTE_CALLER_UNCONFIRMED', detail: 'x', state: 'pending' }))
    expect(pending.message).toBe(translateFor('zh', 'unitpage.remoteCallerUnconfirmed'))
    const denied = await httpErrorMessage(res({ code: 'REMOTE_CALLER_UNCONFIRMED', detail: 'x', state: 'denied' }))
    expect(denied).toEqual({ message: translateFor('zh', 'unitpage.remoteCallerDenied'), code: 'REMOTE_CALLER_UNCONFIRMED' })
    setLocaleGlobal('en')
    expect((await httpErrorMessage(res({ code: 'REMOTE_SESSIONS_OFF', detail: 'x' }))).message).toMatch(/^Remote sessions are turned off on that computer/)
    setLocaleGlobal('zh')
  })

  it('评审 P2:有 reason 时按 reason 出句子,不说「正在等待确认」(没有弹框、也不会有弹框);不认的 reason 回落 state', async () => {
    setLocaleGlobal('zh')
    const waiting = translateFor('zh', 'unitpage.remoteCallerUnconfirmed')
    const cases: Array<[state: string, reason: string, key: string]> = [
      ['denied', 'strict', 'unitpage.remoteCallerStrict'],
      ['unconfirmed', 'never-prompts', 'unitpage.remoteCallerNeverPrompts'],
      ['unconfirmed', 'not-signed-in', 'unitpage.remoteCallerNotSignedIn'],
      ['denied', 'roster-miss', 'unitpage.remoteCallerRosterMiss'],
      ['unconfirmed', 'roster-unreachable', 'unitpage.remoteCallerRosterUnreachable'],
      ['unconfirmed', 'no-answer', 'unitpage.remoteCallerNoAnswer'],
      ['unconfirmed', 'busy', 'unitpage.remoteCallerBusy'],
    ]
    for (const [state, reason, key] of cases) {
      const m = await httpErrorMessage(res({ code: 'REMOTE_CALLER_UNCONFIRMED', detail: 'x', state, reason }))
      expect(m, reason).toEqual({ message: translateFor('zh', key), code: 'REMOTE_CALLER_UNCONFIRMED' })
      expect(m.message, reason).not.toBe(waiting)
      expect(remoteCallerMessage({ state, reason }), reason).toBe(translateFor('zh', key))
    }
    expect(translateFor('zh', 'unitpage.remoteCallerNeverPrompts')).toContain('中转') // 与设备切换器的通路名一致
    expect(translateFor('en', 'unitpage.remoteCallerNeverPrompts')).toContain('Relay')
    expect(remoteCallerMessage({ state: 'pending', reason: 'nonsense' })).toBe(waiting)
    expect(remoteCallerMessage({ state: 'denied', reason: 42 })).toBe(translateFor('zh', 'unitpage.remoteCallerDenied'))
  })
})

// P1-KF:所有渲染这条拒绝的出口都按 reason 先、state 后 —— remoteRefusalMessage 带上响应体;只凭码的老调用 = 「正在等待确认」(兼容)。
describe('localOnly × P1-KF 拒绝按 reason 选文案', () => {
  const RCU = 'REMOTE_CALLER_UNCONFIRMED'
  const REASONS: Array<[reason: string, state: string, key: string]> = [
    ['strict', 'denied', 'unitpage.remoteCallerStrict'],
    ['never-prompts', 'unconfirmed', 'unitpage.remoteCallerNeverPrompts'],
    ['not-signed-in', 'unconfirmed', 'unitpage.remoteCallerNotSignedIn'],
    ['roster-miss', 'denied', 'unitpage.remoteCallerRosterMiss'],
    ['roster-unreachable', 'unconfirmed', 'unitpage.remoteCallerRosterUnreachable'],
    ['no-answer', 'unconfirmed', 'unitpage.remoteCallerNoAnswer'],
    ['busy', 'unconfirmed', 'unitpage.remoteCallerBusy'],
  ]

  it.each(['zh', 'en'] as const)('remoteRefusalMessage(code, body)[%s]:reason → reason 那句;不是「正在等待确认」,也不是「已拒绝」', (lang) => {
    setLocaleGlobal(lang)
    try {
      const waiting = translateFor(lang, 'unitpage.remoteCallerUnconfirmed')
      const denied = translateFor(lang, 'unitpage.remoteCallerDenied')
      for (const [reason, state, key] of REASONS) {
        const m = remoteRefusalMessage(RCU, { code: RCU, detail: 'x', state, reason })
        expect(m, reason).toBe(translateFor(lang, key))
        expect(m, reason).not.toBe(waiting)
        expect(m, reason).not.toBe(denied)
      }
      // 没有 reason:state 分句 —— pending = 真在等;unconfirmed = 还没问过(此刻没有弹框);denied = 点了「不允许」
      expect(remoteRefusalMessage(RCU, { state: 'pending' })).toBe(waiting)
      expect(remoteRefusalMessage(RCU, { state: 'unconfirmed' })).toBe(translateFor(lang, 'unitpage.remoteCallerNotAsked'))
      expect(remoteRefusalMessage(RCU, { state: 'denied' })).toBe(denied)
      expect(remoteRefusalMessage(RCU)).toBe(waiting) // 只有码(老调用 / 老体):兼容旧口径
      expect(remoteRefusalMessage(RCU, null)).toBe(waiting)
      expect(remoteRefusalMessage('REMOTE_SESSIONS_OFF', { reason: 'strict' })).toBe(translateFor(lang, 'unitpage.remoteSessionsOff')) // reason 只对这个码有意义
    } finally { setLocaleGlobal('zh') }
  })

  it('「10 分钟后可以再次请求」只属于用户点了「不允许」的那次;严格档 / 名册缺失(zh / en)都不许诺它', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const key of ['unitpage.remoteCallerStrict', 'unitpage.remoteCallerRosterMiss', 'unitpage.remoteCallerNotAsked']) {
        expect(translateFor(lang, key), `${lang} ${key}`).not.toMatch(/10\s*分钟|10 minutes/)
      }
      expect(translateFor(lang, 'unitpage.remoteCallerDenied')).toMatch(/10\s*分钟|10 minutes/)
      expect(/[一-鿿]/.test(translateFor('en', 'unitpage.remoteCallerNotAsked'))).toBe(false)
    }
  })

  it('httpErrorMessage 与 remoteRefusalMessage 同一口径(设备页 startRun / web 走前者,服务层 request 走后者)', async () => {
    for (const [reason, state] of REASONS) {
      const body = { code: RCU, detail: 'x', state, reason }
      expect((await httpErrorMessage(res(body))).message, reason).toBe(remoteRefusalMessage(RCU, body))
    }
  })
})

