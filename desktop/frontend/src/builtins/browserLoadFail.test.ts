import { describe, expect, it } from 'vitest'
import { loadFail } from './browserView'

describe('loadFail (走查续七 7.9)', () => {
  it('classifies did-fail-load by code and name', () => {
    expect(loadFail('http://127.0.0.1:59999/', 'ERR_CONNECTION_REFUSED', -102)).toEqual({ url: 'http://127.0.0.1:59999/', code: 'ERR_CONNECTION_REFUSED', kind: 'refused' })
    expect(loadFail('https://nope.invalid/', 'ERR_NAME_NOT_RESOLVED', -105).kind).toBe('host')
    expect(loadFail('https://a.b/', 'ERR_INTERNET_DISCONNECTED', -106).kind).toBe('offline')
    expect(loadFail('https://a.b/', 'ERR_CERT_AUTHORITY_INVALID', -202).kind).toBe('cert')
    expect(loadFail('https://a.b/', 'ERR_CONNECTION_TIMED_OUT', -118).kind).toBe('timeout')
    expect(loadFail('http://a.b:6000/', 'ERR_UNSAFE_PORT', -312).kind).toBe('port')
    expect(loadFail('https://a.b/', 'ERR_FAILED', -2).kind).toBe('other')
  })
  it('parses the raw loadURL rejection instead of showing it', () => {
    const f = loadFail('http://127.0.0.1:59999/', "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:59999/'")
    expect(f).toEqual({ url: 'http://127.0.0.1:59999/', code: 'ERR_CONNECTION_REFUSED', kind: 'refused' })
  })
})
