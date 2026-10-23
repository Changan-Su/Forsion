import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createPluginSandbox, isSandboxRoot, readSandboxManifest, sandboxEnv, sandboxPaths } from './pluginSandbox'

const tmp = () => mkdtempSync(join(tmpdir(), 'sbx-'))
function pluginDir(id = 'reading-log'): string {
  const d = join(tmp(), id)
  mkdirSync(join(d, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ id, name: 'Reading log', version: '0.1.0', main: 'main.js', apiVersion: 1 }))
  writeFileSync(join(d, 'main.js'), 'module.exports = {}')
  writeFileSync(join(d, 'node_modules', 'x', 'big.js'), '1')
  return d
}

const status = (over: Record<string, unknown> = {}) => ({
  v: 1, state: 'running', pluginId: 'reading-log', name: 'Reading log', version: '0.1.0', dir: '/p', views: ['shelf'], spaces: [], hiddenSpaces: [],
  setupError: null, blocked: null, mountErrors: [], logs: [], warnCount: 0, errorCount: 0, loads: 1, windowVisible: false, ...over,
})

/** 假子进程:像 sandboxChild 那样用环境里的地址和令牌连回来,按行答请求。 */
function fakeSpawn(opts: { token?: (real: string) => string; states?: string[] } = {}) {
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const ops: string[] = []
  const spawn = (args: string[], env: NodeJS.ProcessEnv): ChildProcess => {
    seen.push({ args, env })
    const proc = new EventEmitter() as ChildProcess & EventEmitter
    const states = [...(opts.states ?? ['starting', 'running'])]
    const exit = () => setImmediate(() => proc.emit('exit', 0))
    ;(proc as { kill: unknown }).kill = () => { exit(); return true }
    ;(proc as { pid: number }).pid = 4242
    const sock = connect(env.FORSION_SANDBOX_SOCK!)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ hello: opts.token ? opts.token(env.FORSION_SANDBOX_TOKEN!) : env.FORSION_SANDBOX_TOKEN }) + '\n'))
    let buf = ''
    sock.on('data', (c: string) => {
      buf += c
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        ops.push(msg.op)
        if (msg.op === 'quit') { sock.end(); exit(); continue }
        const reply = msg.op === 'status' ? { status: status({ state: states.length > 1 ? states.shift() : states[0] }) }
          : msg.op === 'screenshot' ? { image: 'data:image/jpeg;base64,AAAA' } : {}
        sock.write(JSON.stringify({ id: msg.id, ...reply }) + '\n')
      }
    })
    sock.on('close', exit)
    sock.on('error', () => {})
    return proc
  }
  return { spawn, seen, ops }
}

function sandbox(home: string, f: ReturnType<typeof fakeSpawn>) {
  return createPluginSandbox({
    forsionHome: () => home, spawn: f.spawn, appArgs: ['/app'], platform: process.platform, pid: process.pid,
    ui: () => ({ locale: 'en', storage: { forsion_theme_skin: 'blue' } }), onChange: () => {}, onChildEvent: () => {}, log: () => {},
  })
}

describe('子进程环境与目录', () => {
  it('父进程自己的 TANGU_HOME / 工作区 / 电脑操作 socket 一律换成沙箱的', () => {
    const p = sandboxPaths('/h', 'reading-log')
    const env = sandboxEnv({ TANGU_HOME: '/real', FORSION_WORKSPACE_DIR: '/real-ws', PI_CU_SOCKET_PATH: '/real.sock', PATH: '/bin' }, p, { dir: '/p', sock: '/s', token: 't', info: '{}' })
    expect(env).toMatchObject({ TANGU_HOME: '/h/sandbox/reading-log/home', FORSION_WORKSPACE_DIR: '/h/sandbox/reading-log/workspace', FORSION_SANDBOX: '1', PATH: '/bin' })
    expect(env.PI_CU_SOCKET_PATH).not.toBe('/real.sock')
    expect(env.TANGU_BACKEND_URL).toBe('http://127.0.0.1:1')
  })
  it('删目录只认 <home>/sandbox/<合法 id>', () => {
    expect(isSandboxRoot('/h', '/h/sandbox/reading-log')).toBe(true)
    for (const p of ['/h/sandbox', '/h/sandbox/../plugins', '/h/sandbox/a/b', '/h/plugins/reading-log', '/h/sandbox/Bad_Id']) expect(isSandboxRoot('/h', p), p).toBe(false)
  })
  it('清单:相对路径 / 没清单 / 商店身份 → 拒', async () => {
    await expect(readSandboxManifest('rel/p')).rejects.toThrow(/absolute/)
    await expect(readSandboxManifest(tmp())).rejects.toThrow(/manifest\.json/)
    const d = pluginDir('market-0a1b')
    await expect(readSandboxManifest(d)).rejects.toThrow(/kebab-case/)
    expect(await readSandboxManifest(pluginDir())).toEqual({ pluginId: 'reading-log', name: 'Reading log', version: '0.1.0' })
  })
})

describe('控制通道', () => {
  it('start:等装载落定 → 回状态 + 截图;起前写好隔离配置(两份 userData),带上语言与主题', async () => {
    const home = tmp(); const dir = pluginDir(); const f = fakeSpawn()
    const sbx = sandbox(home, f)
    const r = await sbx.exec('start', { dir }, { sessionId: 's1' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.text!).state).toBe('running')
    expect(r.image).toMatch(/^data:image\/jpeg/)
    expect(f.seen[0].args).toEqual(expect.arrayContaining(['/app', `--user-data-dir=${join(home, 'sandbox/reading-log/userdata')}`, '--lang=en']))
    expect(JSON.parse(f.seen[0].env.FORSION_SANDBOX_INFO!).ui.storage).toEqual({ forsion_theme_skin: 'blue' })
    for (const d of ['userdata', 'userdata-dev']) {
      expect(JSON.parse(readFileSync(join(home, 'sandbox/reading-log', d, 'tangu-desktop-config.json'), 'utf8')).mode).toBe('external')
    }
    expect(sbx.state()).toMatchObject({ running: true, pluginId: 'reading-log', sessionId: 's1' })
    await sbx.dispose()
    expect(f.ops).toContain('quit')
    expect(sbx.state().running).toBe(false)
  })

  it('同一个插件再 start = 就地重载,不起第二个进程', async () => {
    const f = fakeSpawn({ states: ['running'] })
    const sbx = sandbox(tmp(), f); const dir = pluginDir()
    await sbx.exec('start', { dir })
    await sbx.exec('start', { dir })
    expect(f.seen).toHaveLength(1)
    expect(f.ops).toContain('reload')
    await sbx.dispose()
  })

  it('负对照:令牌不对 → 不收这个连接,start 报没起来', async () => {
    const f = fakeSpawn({ token: () => 'wrong' })
    const sbx = createPluginSandbox({
      forsionHome: () => tmp(), spawn: f.spawn, appArgs: [], platform: process.platform, pid: process.pid,
      ui: () => ({ locale: 'zh', storage: {} }), onChange: () => {}, onChildEvent: () => {}, log: () => {},
    })
    const r = await sbx.exec('start', { dir: pluginDir() })
    expect(r.ok).toBe(false)
    expect(sbx.state().running).toBe(false)
  }, 60_000)

  it('闲置:窗口不在前台、超过闲置时长 → 自动停;用户正在用(前台)→ 不停', async () => {
    const { vi } = await import('vitest')
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    try {
      const f = fakeSpawn({ states: ['running'] })
      const sbx = createPluginSandbox({
        forsionHome: () => tmp(), spawn: f.spawn, appArgs: [], platform: process.platform, pid: process.pid, idleMs: 60_000,
        ui: () => ({ locale: 'zh', storage: {} }), onChange: () => {}, onChildEvent: () => {}, log: () => {},
      })
      await sbx.exec('start', { dir: pluginDir() })
      vi.advanceTimersByTime(61_000) // 61s 没人用、窗口不在前台(假子进程的状态 windowVisible:false)
      await vi.waitFor(() => expect(f.ops).toContain('quit'), { timeout: 5_000 })
    } finally { vi.useRealTimers() }
  })

  it('没在跑时看状态 → no_sandbox', async () => {
    const r = await sandbox(tmp(), fakeSpawn()).exec('status', {})
    expect(r).toMatchObject({ ok: false, code: 'no_sandbox' })
  })

  it('安装:拷进 plugins/<id>,不带 node_modules', async () => {
    const home = tmp(); const dir = pluginDir()
    const sbx = sandbox(home, fakeSpawn({ states: ['running'] }))
    await sbx.exec('start', { dir })
    expect(await sbx.install()).toEqual({ ok: true, pluginId: 'reading-log' })
    expect(existsSync(join(home, 'plugins/reading-log/main.js'))).toBe(true)
    expect(existsSync(join(home, 'plugins/reading-log/node_modules'))).toBe(false)
    await sbx.dispose()
  })
})
