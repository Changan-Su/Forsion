/**
 * 托管引擎共享密钥的**快照纪律**单测。
 *
 * 钉的是 2026-09-03 实测到的真 bug:auth.json 被 24h 滑动续期改写后(refreshAuthSliding 刻意不重启
 * 引擎),getToken() 若实时重读,就会把**新串**发给只认 spawn 时那枚 env 快照的引擎 —— unitWeb 的
 * /engine 反代是每请求现取,于是设备页 `/engine/agent/*` 整片 401、报「会话列表加载失败:Unauthorized」,
 * 而免鉴权的 /engine/health 照常 200(所以看着像「连上了但没权限」)。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ dir: '' }))
H.dir = mkdtempSync(join(tmpdir(), 'forsion-bm-'))

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0-test' } }))
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

describe('BackendManager channel client attribution', () => {
  it('spawns the managed engine with the real Desktop version for background channel runs', () => {
    const source = readFileSync(new URL('./backendManager.ts', import.meta.url), 'utf8')
    // 通道 run 不经 renderer startRun(),只有这个 spawn 契约能把真实 App 版本交给引擎。
    expect(source).toContain('env.TANGU_HOST_CLIENT = `desktop/${app.getVersion()}`')
  })
})

describe('BackendManager startup exits', () => {
  it('启动期早退只由 spawnOnce 换端口重试 3 次,不再叠一条重启链(否则后起的顶掉 this.child,先起的成孤儿)', async () => {
    // 模拟 2.11.2 反馈:引擎每次都在就绪前以 code 0 静默退出
    const entry = join(H.dir, 'silent-exit.js')
    writeFileSync(entry, "process.stderr.write('boot\\n')", 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(entry)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    await m.start({ cloudUrl: '', sandbox: 'none' })
    await new Promise((r) => setTimeout(r, 2500)) // 越过旧实现 1s 的退避重启
    const logs = m.getLogs()
    expect(logs.filter((l) => l === 'boot')).toHaveLength(3)
    expect(logs.filter((l) => l.startsWith('[manager] 后端退出(code=0'))).toHaveLength(3)
    expect(m.getStatus().state).toBe('crashed')
  }, 15_000)

  it('紧跟在 start() 后的 stop() 作废这次拉起:之后一个进程都不再起', async () => {
    const entry = join(H.dir, 'silent-exit.js')
    writeFileSync(entry, "process.stderr.write('boot\\n')", 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(entry)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    const starting = m.start({ cloudUrl: '', sandbox: 'none' })
    await m.stop() // 例:退出 App / 安装更新时,拉起链正卡在 freePort,手里还没有 child
    await starting
    await new Promise((r) => setTimeout(r, 1000))
    expect(m.getLogs().filter((l) => l === 'boot')).toHaveLength(0)
    expect(m.getStatus().state).toBe('stopped')
  }, 15_000)
})
