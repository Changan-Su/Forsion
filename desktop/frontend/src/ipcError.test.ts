import { afterEach, describe, expect, it } from 'vitest'
import { setLocaleGlobal } from './i18n'
import { ipcErrorCode, ipcErrorText } from './ipcError'

const CJK = /[㐀-鿿]/
const CODES = ['not-logged-in', 'login-expired', 'vault-missing', 'mirror-missing', 'scan-failed', 'invalid-space-id', 'invalid-plugin-id', 'not-user-plugin', 'plugin-not-found', 'mcp-name-reserved', 'amadeus-config-unreadable', 'amadeus-config-unparseable', 'amadeus-config-malformed']

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
    expect(ipcErrorText('vault-missing: /Users/a/vault')).toBe('智库目录不存在：/Users/a/vault')
    // mcp:write 拒保留名:细节是 server 名,两种语言都带出来
    expect(ipcErrorText("Error invoking remote method 'mcp:write': Error: mcp-name-reserved: dev_phone")).toContain('dev_phone')
    setLocaleGlobal('en')
    expect(ipcErrorText("Error invoking remote method 'mcp:write': Error: mcp-name-reserved: dev_phone")).toMatch(/^The MCP server name "dev_phone" is reserved/)
  })

  it('智库设置文件读不了(restoreVault / 普通写抛的三个码)→ 一句看得懂的话,不带原码;内容坏的不引到权限上', () => {
    const cases: Array<[string, string, string]> = [
      ['amadeus-config-unreadable', '读不了智库的设置文件，没有改动它。检查这个文件的权限后重试。', "Couldn't read the vault settings file, so it was left unchanged. Check the file's permissions and try again."],
      ['amadeus-config-unparseable', '智库的设置文件内容不完整或格式不对，没有改动它。检查这个文件后重试。', 'The vault settings file is incomplete or invalid, so it was left unchanged. Check the file and try again.'],
      ['amadeus-config-malformed', '智库的设置文件内容不完整或格式不对，没有改动它。检查这个文件后重试。', 'The vault settings file is incomplete or invalid, so it was left unchanged. Check the file and try again.'],
    ]
    for (const [code, zh, en] of cases) {
      const e = new Error(`Error invoking remote method 'amadeus:restoreVault': Error: ${code}`)
      setLocaleGlobal('zh')
      expect(ipcErrorText(e), code).toBe(zh)
      setLocaleGlobal('en')
      expect(ipcErrorText(e), code).toBe(en)
      expect(ipcErrorCode(e), code).toBe(code)
    }
    expect(ipcErrorCode(new Error('fetch failed'))).toBeNull()
    expect(ipcErrorCode('resolve: HTTP 502')).toBe('resolve')
  })

  it('不认识的原样透传(只剥前缀)', () => {
    expect(ipcErrorText('network error')).toBe('network error')
    expect(ipcErrorText('resolve: HTTP 502')).toBe('resolve: HTTP 502')
    expect(ipcErrorText(new Error("Error invoking remote method 'x': TypeError: boom"))).toBe('boom')
    expect(ipcErrorText(new Error('fetch failed'))).toBe('fetch failed')
  })
})
