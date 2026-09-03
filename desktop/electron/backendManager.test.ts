/**
 * 托管引擎共享密钥的**快照纪律**单测。
 *
 * 钉的是 2026-09-03 实测到的真 bug:auth.json 被 24h 滑动续期改写后(refreshAuthSliding 刻意不重启
 * 引擎),getToken() 若实时重读,就会把**新串**发给只认 spawn 时那枚 env 快照的引擎 —— unitWeb 的
 * /engine 反代是每请求现取,于是设备页 `/engine/agent/*` 整片 401、报「会话列表加载失败:Unauthorized」,
 * 而免鉴权的 /engine/health 照常 200(所以看着像「连上了但没权限」)。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ dir: '' }))
H.dir = mkdtempSync(join(tmpdir(), 'forsion-bm-'))

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('./forsionHome', () => ({
  forsionHomeDir: () => H.dir,
  tanguDataDir: () => H.dir,
  defaultWorkspaceDir: () => H.dir,
}))
vi.mock('./amadeus/settings', () => ({ amadeusConfigPath: () => join(H.dir, 'amadeus-config.json') }))

const { BackendManager } = await import('./backendManager')

const writeAuth = (token: string): void =>
  writeFileSync(join(H.dir, 'auth.json'), JSON.stringify({ token }), 'utf8')

describe('BackendManager.getToken', () => {
  it('托管引擎在跑时恒返回 spawn 那枚 —— auth.json 被续期改写也不跟着漂', () => {
    writeAuth('token-at-spawn')
    const m = new BackendManager() as any
    m.spawnToken = m.freshToken() // spawnOnce 里 env.TANGU_TOKEN 钉的就是这一枚
    m.child = {}                  // 子进程活着 = 有个「只认旧串」的对面要对齐

    expect(m.getToken()).toBe('token-at-spawn')
    writeAuth('token-after-sliding-refresh') // 24h 滑动续期改写 auth.json,引擎不重启
    // ⚠️ 实时重读的写法在这一行会变成 token-after-sliding-refresh —— 那就是设备页整片 401 的根因
    expect(m.getToken()).toBe('token-at-spawn')
  })

  it('没有托管子进程时(external 形态 / 已停 / 重启窗口)回落实时值', () => {
    writeAuth('live-1')
    const m = new BackendManager() as any
    expect(m.getToken()).toBe('live-1')
    writeAuth('live-2')
    expect(m.getToken()).toBe('live-2')
  })
})
