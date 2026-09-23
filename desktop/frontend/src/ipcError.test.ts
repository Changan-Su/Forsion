import { afterEach, describe, expect, it } from 'vitest'
import { setLocaleGlobal } from './i18n'
import { ipcErrorText } from './ipcError'

const CJK = /[㐀-鿿]/
const CODES = ['not-logged-in', 'login-expired', 'vault-missing', 'mirror-missing', 'scan-failed', 'invalid-space-id', 'invalid-plugin-id', 'not-user-plugin', 'plugin-not-found']

describe('ipcErrorText', () => {
  afterEach(() => setLocaleGlobal('zh'))

  it('每个原因码中英都有文案(zh 带汉字、en 不带),不再原样上屏', () => {
    for (const code of CODES) {
      setLocaleGlobal('zh')
      const zh = ipcErrorText(new Error(code))
      setLocaleGlobal('en')
      const en = ipcErrorText(new Error(code))
      expect(zh, code).toMatch(CJK)
      expect(en, code).not.toMatch(CJK)
      expect(en, code).not.toBe(code)
    }
  })

  it('剥掉 Electron invoke 前缀;细节(可能自带冒号)原样带进文案', () => {
    setLocaleGlobal('en')
    const e = new Error("Error invoking remote method 'amadeusSync:x': Error: scan-failed: /v/Notes: EACCES: permission denied")
    expect(ipcErrorText(e)).toBe("Couldn't read the local folder, so this round won't treat missing files as deleted: /v/Notes: EACCES: permission denied")
    expect(ipcErrorText("Error invoking remote method 'spaces:delete': Error: invalid-space-id")).toBe('Invalid Space identifier')
    setLocaleGlobal('zh')
    expect(ipcErrorText('vault-missing: /Users/a/vault')).toBe('vault 目录不存在:/Users/a/vault')
  })

  it('不认识的原样透传(只剥前缀)', () => {
    expect(ipcErrorText('network error')).toBe('network error')
    expect(ipcErrorText('resolve: HTTP 502')).toBe('resolve: HTTP 502')
    expect(ipcErrorText(new Error("Error invoking remote method 'x': TypeError: boom"))).toBe('boom')
    expect(ipcErrorText(new Error('fetch failed'))).toBe('fetch failed')
  })
})
