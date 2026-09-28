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
