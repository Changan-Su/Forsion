import { describe, expect, it } from 'vitest'
import { APP_COUNT_KEYS, achievementCountKey, classifyInstallError, classifyUpdateError, isAppCountKey, settingChange } from './telemetryKeys'

// 报错原文取自本仓真实的 throw(main.ts market:install、marketInstall.ts DownloadFailed、npmMarketInstall.ts、
// tangu-agent contracts/marketplace.ts、marketPluginUpdates.ts)。断言只看枚举:原文绝不出 classify*。
describe('classifyInstallError', () => {
  const c = classifyInstallError
  it('resolve 阶段', () => {
    expect(c('resolve: timeout')).toEqual({ stage: 'resolve', errorClass: 'timeout' })
    expect(c('resolve: HTTP 404')).toEqual({ stage: 'resolve', errorClass: 'http' })
    expect(c('resolve: ENOTFOUND')).toEqual({ stage: 'resolve', errorClass: 'network' })
    expect(c('resolve: market identity changed')).toEqual({ stage: 'resolve', errorClass: 'identity' })
    expect(c('resolve: invalid target')).toEqual({ stage: 'resolve', errorClass: 'other' })
    // Electron 包的那层「Error invoking remote method」剥掉再认
    expect(c("Error invoking remote method 'market:install': Error: resolve: HTTP 502")).toEqual({ stage: 'resolve', errorClass: 'http' })
  })
  it('download 阶段(DownloadFailed:host: 原因码 用 · 连)', () => {
    expect(c('github.com: timeout · ghproxy.net: stalled')).toEqual({ stage: 'download', errorClass: 'timeout' })
    expect(c('github.com: HTTP 403 · ghproxy.net: ECONNRESET')).toEqual({ stage: 'download', errorClass: 'http' })
    expect(c('registry.npmjs.org: too large')).toEqual({ stage: 'download', errorClass: 'too-large' })
    expect(c('cdn.example.com:8443: not a zip')).toEqual({ stage: 'download', errorClass: 'not-zip' })
    expect(c('github.com: ECONNRESET · ghproxy.net: fetch failed')).toEqual({ stage: 'download', errorClass: 'network' })
  })
  it('install 阶段', () => {
    expect(c('install: requires Forsion 2.14.0+')).toEqual({ stage: 'install', errorClass: 'min-app' })
    expect(c('install: unsupported platform')).toEqual({ stage: 'install', errorClass: 'platform' })
    expect(c('install: npm integrity mismatch')).toEqual({ stage: 'install', errorClass: 'integrity' })
    expect(c('install: npm package identity mismatch')).toEqual({ stage: 'install', errorClass: 'identity' })
    expect(c('install: builtin')).toEqual({ stage: 'install', errorClass: 'builtin' })
    expect(c('install: npm and Forsion manifest versions differ')).toEqual({ stage: 'install', errorClass: 'version' })
    expect(c('install: version is not newer')).toEqual({ stage: 'install', errorClass: 'version' })
    expect(c('install: incompatible plugin API')).toEqual({ stage: 'install', errorClass: 'version' })
    expect(c('install: manifest too large')).toEqual({ stage: 'install', errorClass: 'other' })
    expect(c('解压失败:不是有效的压缩包')).toEqual({ stage: 'install', errorClass: 'not-zip' })
    expect(c("Can't find end of central directory : is this a zip file ?")).toEqual({ stage: 'install', errorClass: 'not-zip' })
  })
  it('认不出前缀时按最后报到的阶段;路径 / 主机名不进结果', () => {
    expect(c("EACCES: permission denied, open '/Users/me/Plugins/x'", 'install')).toEqual({ stage: 'install', errorClass: 'disk' })
    expect(c('something odd', 'download')).toEqual({ stage: 'download', errorClass: 'other' })
    expect(c(undefined)).toEqual({ stage: 'install', errorClass: 'other' })
    expect(JSON.stringify(c("EACCES: '/Users/me/x'"))).not.toContain('/Users')
  })
})

describe('classifyUpdateError', () => {
  it.each([
    ['sha512 mismatch for tangu-engine.tgz', 'integrity'],
    ['signature verification failed: /Users/me/.forsion/x', 'signature'],
    ['identity changed', 'identity'],
    ['incompatible engine API', 'incompatible'],
    ['ENOSPC: no space left on device', 'disk'],
    ['HttpError: 404 Not Found "method: GET url: https://github.com/x?token=abc"', 'http'],
    ['package is 2.13.6, not 2.13.7', 'version'],
    ['getaddrinfo ENOTFOUND registry.npmjs.org', 'network'],
    ['download stalled', 'network'],
    ['weird', 'other'],
  ])('%s → %s', (raw, want) => expect(classifyUpdateError(raw)).toBe(want))
})

describe('settingChange', () => {
  it('键在表里、值归得了档才有', () => {
    expect(settingChange('ui.themeMode', 'system')).toEqual({ key: 'ui.themeMode', value: 'system' })
    expect(settingChange('ui.language', 'en')).toEqual({ key: 'ui.language', value: 'en' })
    expect(settingChange('ui.language', 'ja')).toBeNull()
    expect(settingChange('ui.skin', 'custom')).toEqual({ key: 'ui.skin', value: 'custom' })
    expect(settingChange('ui.skin', '#ff00aa')).toBeNull()
    expect(settingChange('ui.scale', 1.14)).toEqual({ key: 'ui.scale', value: '1.1' })
    expect(settingChange('ui.scale', 9)).toEqual({ key: 'ui.scale', value: '2.0' })
    expect(settingChange('ui.scale', 0.2)).toEqual({ key: 'ui.scale', value: '0.5' })
    expect(settingChange('ui.scale', 0)).toBeNull()
    expect(settingChange('muse.enabled', false)).toEqual({ key: 'muse.enabled', value: 'off' })
    expect(settingChange('muse.heartbeat', 60)).toEqual({ key: 'muse.heartbeat', value: '60' })
    expect(settingChange('muse.heartbeat', 61)).toEqual({ key: 'muse.heartbeat', value: 'other' })
    expect([0, 1, 3, 5, 8, 50].map((n) => settingChange('muse.maxDmPerDay', n)?.value)).toEqual(['0', '1', '2-3', '4-5', '6-10', '11+'])
    expect(settingChange('muse.maxDmPerDay', 2.5)).toBeNull()
    expect(settingChange('approval.defaultMode', 'full-auto')).toEqual({ key: 'approval.defaultMode', value: 'full-auto' })
    expect(settingChange('update.channel', 'nightly')).toBeNull()
    expect(settingChange('toString', 'x')).toBeNull() // 原型链上的键不算
    expect(settingChange('ui.fontFamily', 'serif')).toBeNull()
  })
})

describe('计数键', () => {
  it('官方成就 → app_counts;插件计数 / 表外 / 原型链键不算', () => {
    expect(achievementCountKey('chat.send')).toBe('achChatSend')
    expect(achievementCountKey('special.enable')).toBe('achSpecialEnable')
    expect(achievementCountKey('plugin:demo:hello')).toBeUndefined()
    expect(achievementCountKey('constructor')).toBeUndefined()
    expect(isAppCountKey('openNote')).toBe(true)
    expect(isAppCountKey('hasOwnProperty')).toBe(false)
  })
  it('app_counts 字段 = 契约 telemetry-schema.json v2 的 57 个(这里钉住名单,改契约要同改)', () => {
    expect(APP_COUNT_KEYS).toHaveLength(57)
    expect(new Set(APP_COUNT_KEYS).size).toBe(57)
    for (const k of APP_COUNT_KEYS) expect(k).toMatch(/^[a-z][A-Za-z0-9]*$/)
  })
})
