/**
 * 托管引擎的凭据契约单测(设备能力 MCP 方案 §6.2-9,契约 C1 / C2)。
 *
 * 本机端点鉴权用每次启动随机生成的本机令牌(TANGU_LOCAL_TOKEN),forsion_token 只作云端凭据(TANGU_TOKEN),
 * 另给引擎一枚远端来源标记密钥(TANGU_REMOTE_MARK_SECRET)。
 * 顺带钉死 2026-09-03 那类 bug 的结构性消失:以前本机令牌就是 forsion_token,auth.json 被 24h 滑动续期改写后,
 * 每请求现取令牌的 /engine 反代把新串发给只认 spawn 快照的引擎 → 设备页 /engine/agent/* 整片 401。
 * 现在 getToken() 与 auth.json 无关,续期怎么改都不漂。
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ dir: '' }))
H.dir = mkdtempSync(join(tmpdir(), 'forsion-bm-'))

vi.mock('electron', () => ({ app: { isPackaged: false, getLocale: () => 'zh-CN', getVersion: () => '0.0.0-test', getPath: (name: string) => join(H.dir, name) } }))
vi.mock('./forsionHome', () => ({
  forsionHomeDir: () => H.dir,
  tanguDataDir: () => H.dir,
  defaultWorkspaceDir: () => H.dir,
  isDevMode: () => false,
}))
vi.mock('./amadeus/settings', () => ({ amadeusConfigPath: () => join(H.dir, 'amadeus-config.json') }))
vi.mock('./forsionAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./forsionAuth')>()
  return { ...real, loadTanguCreds: vi.fn(real.loadTanguCreds) }
})

const { BackendManager, injectEngineLang } = await import('./backendManager')
const { loadTanguCreds } = await import('./forsionAuth')

const writeAuth = (token: string): void =>
  writeFileSync(join(H.dir, 'auth.json'), JSON.stringify({ token }), 'utf8')

/** 假引擎:把收到的三枚凭据 env 落盘,再答 /health。 */
function envDumpEngine(): { entry: string; dump: () => { local: string | null; cloud: string | null; mark: string | null } } {
  const entry = join(H.dir, 'env-dump.cjs')
  const out = join(H.dir, 'env-dump.json')
  writeFileSync(entry, [
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
    `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ local: process.env.TANGU_LOCAL_TOKEN ?? null, cloud: process.env.TANGU_TOKEN ?? null, mark: process.env.TANGU_REMOTE_MARK_SECRET ?? null }))`,
    "require('node:http').createServer((_q, s) => s.end('{}')).listen(port, '127.0.0.1')",
  ].join('\n'), 'utf8')
  return { entry, dump: () => JSON.parse(readFileSync(out, 'utf8')) }
}

describe('BackendManager engine credentials (C1 / C2)', () => {
  it('云端票只从 loadTanguCreds 取:auth.json 坏了时账号层的取值策略在那边,这里另读一份就绕开了', () => {
    rmSync(join(H.dir, 'auth.json'), { force: true })
    vi.mocked(loadTanguCreds).mockReturnValueOnce({ token: 'from-account-layer' })
    expect((new BackendManager() as unknown as { cloudToken(): string | null }).cloudToken()).toBe('from-account-layer')
  })

  it('auth.json 内容是 JSON null:算没有云端票,不抛(抛了引擎就起不来)', () => {
    writeFileSync(join(H.dir, 'auth.json'), 'null')
    expect((new BackendManager() as unknown as { cloudToken(): string | null }).cloudToken()).toBeNull()
  })

  it('spawn 契约:TANGU_LOCAL_TOKEN = getToken()(≠ forsion_token),TANGU_TOKEN = forsion_token,TANGU_REMOTE_MARK_SECRET = remoteMarkSecret()', async () => {
    writeAuth('forsion-jwt-at-spawn')
    const eng = envDumpEngine()
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(eng.entry)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    try {
      await m.start({ cloudUrl: '', sandbox: 'none' })
      expect(m.getStatus().state).toBe('ready')
      const env = eng.dump()
      expect(env.local).toBe(m.getToken())
      expect(env.local).toMatch(/^[0-9a-f]{64}$/)
      expect(m.getToken()).not.toBe('forsion-jwt-at-spawn') // 本机端点的钥匙不再是云端账号票
      expect(env.cloud).toBe('forsion-jwt-at-spawn')
      expect(env.mark).toBe(m.remoteMarkSecret())
      expect(env.mark).not.toBe(env.local)
      // 24h 滑动续期改写 auth.json、引擎不重启:本机令牌纹丝不动(= 09-03 设备页整片 401 那类 bug 不再可能)
      writeAuth('forsion-jwt-after-sliding-refresh')
      expect(m.getToken()).toBe(env.local)
      // 引擎重启(ensureBackend)沿用同一枚本机令牌:渲染层缓存的 cfg.token 不失效;云端票按新 auth.json 走
      await m.start({ cloudUrl: '', sandbox: 'none' })
      const env2 = eng.dump()
      expect(env2.local).toBe(env.local)
      expect(env2.mark).toBe(env.mark)
      expect(env2.cloud).toBe('forsion-jwt-after-sliding-refresh')
    } finally { await m.stop() }
  }, 30_000)

  it('未登录:TANGU_TOKEN 显式为空串(压住 shell 继承的同名变量与 config.json 的 cloud.token 回退),本机令牌照样有 → 引擎能独立启动', async () => {
    rmSync(join(H.dir, 'auth.json'), { force: true })
    const eng = envDumpEngine()
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(eng.entry)
    process.env.TANGU_NODE_BIN = process.execPath
    process.env.TANGU_TOKEN = 'leaked-from-dev-shell'
    const m = new BackendManager()
    try {
      await m.start({ cloudUrl: '', sandbox: 'none' })
      const env = eng.dump()
      expect(env.cloud).toBe('') // 不是 undefined:引擎 config.ts 是 `TANGU_TOKEN ?? cloud.token`,缺席会回退到 config.json 残留的云端票
      expect(env.local).toBe(m.getToken())
    } finally {
      delete process.env.TANGU_TOKEN
      await m.stop()
    }
  }, 30_000)

  it('每次启动一枚:两个 BackendManager(= 两次 App 启动)的本机令牌与标记密钥都不同;MCP 外部密钥另是一枚稳定值', () => {
    const a = new BackendManager()
    const b = new BackendManager()
    expect(a.getToken()).not.toBe(b.getToken())
    expect(a.remoteMarkSecret()).not.toBe(b.remoteMarkSecret())
    expect(a.localSecret()).toBe(b.localSecret()) // desktop-local-token:给外部 agent 的 MCP 密钥,持久化
    expect(a.localSecret()).not.toBe(a.getToken())
  })
})

describe('BackendManager channel client attribution', () => {
  it('spawns the managed engine with the real Desktop version for background channel runs', () => {
    const source = readFileSync(new URL('./backendManager.ts', import.meta.url), 'utf8')
    // 通道 run 不经 renderer startRun(),只有这个 spawn 契约能把真实 App 版本交给引擎。
    expect(source).toContain('env.TANGU_HOST_CLIENT = `desktop/${app.getVersion()}`')
    expect(source).toContain("injectEngineLang(env, app.getLocale?.() || '')") // 通道回复 / TUI 语言:spawn 时走下面钉住的判定
  })
})

describe('injectEngineLang(引擎界面语言注入)', () => {
  const run = (env: NodeJS.ProcessEnv, locale = 'zh-CN'): NodeJS.ProcessEnv => {
    const e = { ...env }
    injectEngineLang(e, locale)
    return e
  }
  it('Finder 启动(四个语言变量都没有)→ 按系统界面语言注入', () => {
    expect(run({}).TANGU_LANG).toBe('zh')
    expect(run({}, 'en-US').TANGU_LANG).toBe('en')
  })
  it('⚠️用户 shell 里设了 LANG / LC_ALL / LC_MESSAGES → 不注入(TANGU_LANG 排在它们前面,注入就把用户的选择盖掉)', () => {
    expect(run({ LANG: 'en_US.UTF-8' }).TANGU_LANG).toBeUndefined() // 系统界面中文、shell 英文:引擎该回英文
    expect(run({ LC_ALL: 'zh_CN.UTF-8' }, 'en-US').TANGU_LANG).toBeUndefined()
    expect(run({ LC_MESSAGES: 'en_GB' }).TANGU_LANG).toBeUndefined()
  })
  it('显式 TANGU_LANG 原样保留', () => {
    expect(run({ TANGU_LANG: 'en' }).TANGU_LANG).toBe('en')
  })
  it('C / POSIX / C.UTF-8 / 空白 = 未设置(与引擎 detectZh 同口径)→ 照样注入', () => {
    expect(run({ LANG: 'C.UTF-8', LC_ALL: 'C', LC_MESSAGES: 'POSIX', TANGU_LANG: '  ' }).TANGU_LANG).toBe('zh')
  })
})

describe('BackendManager 电脑历史第二道闸', () => {
  it('拉起引擎时经 FORSION_DESKTOP_CONFIG 传桌面壳配置的绝对路径(引擎据此复核开关;state.json 写不进也删不掉时「关」照样生效)', async () => {
    const entry = join(H.dir, 'env-probe.cjs')
    const out = join(H.dir, 'env-probe.json')
    writeFileSync(entry, [
      `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ v: process.env.FORSION_DESKTOP_CONFIG ?? null }))`,
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
      "require('node:http').createServer((_q, s) => s.end('{}')).listen(port, '127.0.0.1')",
    ].join('\n'), 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(entry)
    process.env.TANGU_NODE_BIN = process.execPath
    delete process.env.FORSION_DESKTOP_CONFIG // 必须是 spawn 设的,不是从测试进程继承的
    const m = new BackendManager()
    await m.start({ cloudUrl: '', sandbox: 'none' })
    try {
      expect(m.getStatus().state).toBe('ready')
      expect(JSON.parse(readFileSync(out, 'utf8')).v).toBe(join(H.dir, 'userData', 'tangu-desktop-config.json'))
    } finally {
      await m.stop()
    }
  }, 15_000)
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

  it('拉起链正卡在 freePort、手里还没有 child 时 stop():这条链作废,之后一个进程都不再起', async () => {
    const entry = join(H.dir, 'silent-exit.js')
    writeFileSync(entry, "process.stderr.write('boot\\n')", 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(entry)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    // spawnOnce 置 starting 后同步调 freePort() 再挂起:微任务里 stop(),正好落在 freePort 已在途的窗口
    const off = m.onStatus((st) => { if (st.state === 'starting') { off(); queueMicrotask(() => void m.stop()) } })
    await m.start({ cloudUrl: '', sandbox: 'none' })
    await new Promise((r) => setTimeout(r, 1000))
    expect(m.getLogs().filter((l) => l === 'boot')).toHaveLength(0)
    expect(m.getStatus().state).toBe('stopped')
  }, 15_000)

  it('两个并发 stop() 都要等同一个 child 真退出(装更新 / 退出 App 前不能提前放行)', async () => {
    // 能答 /health 的假引擎;收到 SIGTERM 400ms 后才退(Windows 上 kill = TerminateProcess,立即退,本例退化为平凡通过)
    const entry = join(H.dir, 'slow-exit.cjs')
    writeFileSync(entry, [
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
      "require('node:http').createServer((_q, s) => s.end('{}')).listen(port, '127.0.0.1')",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400))",
    ].join('\n'), 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(entry)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    await m.start({ cloudUrl: '', sandbox: 'none' })
    expect(m.getStatus().state).toBe('ready')
    const pid = m.getStatus().pid!
    const first = m.stop()
    await m.stop() // 旧写法:第一个 stop() 已把 this.child 置空,这里看到「没有 child」立即返回
    expect(() => process.kill(pid, 0)).toThrow() // 放行时引擎必须已经退了
    await first
    expect(m.getStatus().state).toBe('stopped')
  }, 15_000)
})

describe('BackendManager 引擎热更新起不来时退回', () => {
  /** 假启动器:flag 文件不在 = 跑的是热更新的那一版(按 mode 起不来 / 起来就崩);在 = 已退回,正常答 /health。 */
  function fakeLauncher(mode: 'never-ready' | 'crash-after-ready'): { launch: string[]; control: { active: () => string | null; demote: (v: string, reason: string) => void }; demoted: Array<[string, string]> } {
    const dir = mkdtempSync(join(tmpdir(), 'forsion-bm-overlay-'))
    const flag = join(dir, 'demoted')
    const launcher = join(dir, 'launch.cjs')
    writeFileSync(launcher, [
      "const fs = require('node:fs')",
      `const overlay = !fs.existsSync(${JSON.stringify(flag)})`,
      mode === 'never-ready' ? "if (overlay) { process.stderr.write('overlay-boot\\n'); process.exit(1) }" : '',
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
      "require('node:http').createServer((_q, s) => s.end('{}')).listen(port, '127.0.0.1')",
      mode === 'crash-after-ready' ? "if (overlay) setTimeout(() => process.exit(1), 600)" : '',
    ].join('\n'), 'utf8')
    const demoted: Array<[string, string]> = []
    return {
      launch: [launcher, 'standalone'],
      demoted,
      control: {
        active: () => (existsSync(flag) ? null : '9.9.9'),
        demote: (v, reason) => { demoted.push([v, reason]); writeFileSync(flag, '') },
      },
    }
  }

  it('热更新的那一版连续 3 次起不来:停用它,同一次启动里退回自带的并就绪', async () => {
    const f = fakeLauncher('never-ready')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(f.launch[0]) // 不依赖 CI 上并不存在的引擎 dist
    vi.spyOn(BackendManager, 'resolveLaunch').mockReturnValue(f.launch)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    m.setEngineOverlay(f.control)
    try {
      await m.start({ cloudUrl: '', sandbox: 'none' })
      expect(m.getStatus().state).toBe('ready')
      expect(f.demoted).toHaveLength(1)
      expect(f.demoted[0][0]).toBe('9.9.9')
      expect(m.engineOverlayVersion()).toBeNull()
      expect(m.getLogs().filter((l) => l === 'overlay-boot')).toHaveLength(3)
      expect(m.getLogs().some((l) => l.includes('engine update 9.9.9 disabled, falling back'))).toBe(true)
    } finally { await m.stop() }
  }, 30_000)

  it('热更新的那一版能就绪、但之后一再意外退出:第 3 次停用它,重启后跑自带的', async () => {
    const f = fakeLauncher('crash-after-ready')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(f.launch[0]) // 不依赖 CI 上并不存在的引擎 dist
    vi.spyOn(BackendManager, 'resolveLaunch').mockReturnValue(f.launch)
    process.env.TANGU_NODE_BIN = process.execPath
    const m = new BackendManager()
    m.setEngineOverlay(f.control)
    try {
      await m.start({ cloudUrl: '', sandbox: 'none' })
      expect(m.engineOverlayVersion()).toBe('9.9.9')
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !(f.demoted.length && m.getStatus().state === 'ready')) await new Promise((r) => setTimeout(r, 100))
      expect(f.demoted.map(([v]) => v)).toEqual(['9.9.9'])
      expect(m.getStatus().state).toBe('ready')
      expect(m.engineOverlayVersion()).toBeNull()
      expect(m.getLogs().filter((l) => l.startsWith('[manager] 后端退出(code=1'))).toHaveLength(3)
    } finally { await m.stop() }
  }, 40_000)

  it('启动器自己退回了自带的(拉起前以为会跑新版):以引擎在 /health 里报的版本为准,不把自带引擎记到新版头上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forsion-bm-overlay-'))
    const launcher = join(dir, 'launch.cjs')
    writeFileSync(launcher, [
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
      "require('node:http').createServer((_q, s) => s.end(JSON.stringify({ version: '0.0.0-test' }))).listen(port, '127.0.0.1')", // = App 版本
    ].join('\n'), 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(launcher)
    vi.spyOn(BackendManager, 'resolveLaunch').mockReturnValue([launcher, 'standalone'])
    process.env.TANGU_NODE_BIN = process.execPath
    const demote = vi.fn()
    const m = new BackendManager()
    m.setEngineOverlay({ active: () => '9.9.9', demote })
    try {
      await m.start({ cloudUrl: '', sandbox: 'none' })
      expect(m.getStatus().state).toBe('ready')
      expect(m.engineOverlayVersion()).toBeNull()
      expect(demote).not.toHaveBeenCalled()
    } finally { await m.stop() }
  }, 15_000)

  it('停用没生效(坏版本记录写不进去,启动器下次还会挑中它):不无限重来,按原来的有限次数判 crashed', async () => {
    const f = fakeLauncher('never-ready')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(f.launch[0])
    vi.spyOn(BackendManager, 'resolveLaunch').mockReturnValue(f.launch)
    process.env.TANGU_NODE_BIN = process.execPath
    const demote = vi.fn() // 什么都没记下来
    const m = new BackendManager()
    m.setEngineOverlay({ active: () => '9.9.9', demote })
    await m.start({ cloudUrl: '', sandbox: 'none' })
    expect(m.getStatus().state).toBe('crashed')
    expect(demote).toHaveBeenCalledTimes(1)
    expect(m.getLogs().filter((l) => l === 'overlay-boot')).toHaveLength(3)
  }, 15_000)

  it('没在跑热更新的版本时起不来:不动任何版本,照旧判 crashed', async () => {
    const entry = join(H.dir, 'silent-exit-2.js')
    writeFileSync(entry, "process.exit(1)", 'utf8')
    vi.spyOn(BackendManager, 'resolveEntry').mockReturnValue(entry)
    vi.spyOn(BackendManager, 'resolveLaunch').mockReturnValue([entry, 'standalone'])
    process.env.TANGU_NODE_BIN = process.execPath
    const demote = vi.fn()
    const m = new BackendManager()
    m.setEngineOverlay({ active: () => null, demote })
    await m.start({ cloudUrl: '', sandbox: 'none' })
    expect(m.getStatus().state).toBe('crashed')
    expect(demote).not.toHaveBeenCalled()
  }, 15_000)
})
