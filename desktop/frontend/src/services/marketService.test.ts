import { afterEach, describe, expect, it } from 'vitest'
import { installMarket } from './marketService'

// 2026-09-21:主进程只给语言中立的原因码,Electron 还会在 invoke 的拒绝外面包一层前缀 —— 两样都不能原样上屏。
const g = globalThis as unknown as { window?: { tangu?: Record<string, unknown> } }
const withInstallError = (message: string): void => {
  g.window = { tangu: { marketList: async () => ({ items: [] }), marketInstall: async () => { throw new Error(message) } } }
}
afterEach(() => { delete g.window })

describe('installMarket 的错误文案', () => {
  it('剥掉 Electron 的 IPC 包装前缀,下载原因(主机: 原因码)原样保留', async () => {
    withInstallError("Error invoking remote method 'market:install': Error: github.com: timeout · ghfast.top: HTTP 502")
    await expect(installMarket('x')).rejects.toThrow(/^github\.com: timeout · ghfast\.top: HTTP 502$/)
  })
  it('resolve 原因码套上界面语言的文案(测试钉 zh)', async () => {
    withInstallError("Error invoking remote method 'market:install': Error: resolve: HTTP 502")
    await expect(installMarket('x')).rejects.toThrow('没能从 Forsion 服务器拿到下载地址(HTTP 502)')
    await expect(installMarket('x')).rejects.toMatchObject({ stage: 'resolve' }) // 界面据此不附 GitHub 网络指引
  })
})
