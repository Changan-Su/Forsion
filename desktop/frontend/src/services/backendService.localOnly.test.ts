// @vitest-environment happy-dom
/**
 * 设备页打到远端不许用的引擎路由时,unitWeb 回 403 { code: 'LOCAL_ONLY' }(设备能力 MCP 方案 §6.6);
 * 共享的 request() 把它换成本地化的「只能在那台设备本机上进行」提示(zh/en 成对),并把 code 带给调用方。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from './http'
import { syncNow } from './backendService'
import { translateFor } from '../i18n'
import { connectionTarget } from './engine/targets'

vi.mock('./http', () => ({ authFetch: vi.fn() }))
const cfg = { backendUrl: 'http://unit/engine', token: 't' } as any
const json = (body: unknown, status: number) => Promise.resolve(new Response(JSON.stringify(body), { status }))

beforeEach(() => { vi.mocked(authFetch).mockReset() })

describe('request() × LOCAL_ONLY', () => {
  it('403 LOCAL_ONLY → 本地化提示 + code/status 带给调用方(unitWeb 那句英文 detail 不上屏)', async () => {
    vi.mocked(authFetch).mockImplementation(() => json({ code: 'LOCAL_ONLY', detail: 'This action is only available on the device itself' }, 403))
    const err = await syncNow(connectionTarget(cfg)).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(translateFor('zh', 'unitpage.localOnly'))
    expect(err.code).toBe('LOCAL_ONLY')
    expect(err.status).toBe(403)
  })

  it('zh / en 两份文案都在,英文不含汉字', () => {
    expect(translateFor('zh', 'unitpage.localOnly')).toContain('本机')
    const en = translateFor('en', 'unitpage.localOnly')
    expect(en).toMatch(/only available on that device/)
    expect(/[一-龥]/.test(en)).toBe(false)
  })

  it('别的 403(配额 / 权限)不被改写', async () => {
    vi.mocked(authFetch).mockImplementation(() => json({ detail: 'quota exceeded', error: 'quota' }, 403))
    const err = await syncNow(connectionTarget(cfg)).catch((e) => e)
    expect(err.message).toBe('quota exceeded')
    expect(err.code).toBe('quota')
  })
})

// P1-KF:设备页(浏览器里打开的那台电脑的页面,home 目标 = /engine)同一口径 —— 拒绝体里的 reason 先于 state。
describe('request() × REMOTE_CALLER_UNCONFIRMED(设备页)', () => {
  it('带 reason → reason 那句(zh / en);没有 reason 的 pending 才是「等待确认」', async () => {
    const { setLocaleGlobal } = await import('../i18n')
    for (const lang of ['zh', 'en'] as const) {
      setLocaleGlobal(lang)
      try {
        vi.mocked(authFetch).mockImplementation(() => json({ code: 'REMOTE_CALLER_UNCONFIRMED', detail: 'x', state: 'denied', reason: 'strict' }, 403))
        const err = await syncNow(connectionTarget(cfg)).catch((e) => e)
        expect(err.message).toBe(translateFor(lang, 'unitpage.remoteCallerStrict'))
        expect(err.code).toBe('REMOTE_CALLER_UNCONFIRMED')
        vi.mocked(authFetch).mockImplementation(() => json({ code: 'REMOTE_CALLER_UNCONFIRMED', detail: 'x', state: 'pending' }, 403))
        expect((await syncNow(connectionTarget(cfg)).catch((e) => e)).message).toBe(translateFor(lang, 'unitpage.remoteCallerUnconfirmed'))
      } finally { setLocaleGlobal('zh') }
    }
  })
})

