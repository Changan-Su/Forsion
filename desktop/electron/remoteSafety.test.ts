/**
 * P1 · K2 §3.8:急停 / 远程锁定控制器(零 electron;假引擎 = 真 HTTP 服务 + SSE,文件 / 热键 / 通知 / 认证换内存)。
 *   S6 断网 / 引擎不可达照样锁;引擎 ready 后补发急停。S7 锁跨重启(第二个控制器读同一文件)。S8 锁文件坏 → 锁定。
 *   S2 解锁要系统认证:cancelled / unavailable / failed 都保持锁定;写盘失败保持锁定(不做半解锁)。
 *   S12 失败可见:热键注册失败 / 写盘失败 / 引擎不可达都进状态。
 *   以及:急停顺序(内存锁先于写盘先于引擎)、闩对账、keepAwake 强制通道、新调用方提示限频、设备名净化。
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRemoteSafety, parseLockFile, sanitizeLabel, type RemoteSafetyDeps } from './remoteSafety'
import { DEFAULT_ESTOP_HOTKEY, REMOTE_LOCK_FILE_ENV } from '../shared/remoteSafety'
import type { ActivitySnapshot } from '../shared/remoteActivity'

const until = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function fakeEngine() {
  const calls: Array<{ path: string; body: any; auth: string }> = []
  const streams = new Set<http.ServerResponse>()
  let unlockStatus = 200
  let bootId = 'boot0001'
  let seq = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url === '/agent/remote/activity/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': open\n\n')
        streams.add(res)
        res.on('close', () => streams.delete(res))
        return
      }
      calls.push({ path: req.url || '', body: body ? JSON.parse(body) : null, auth: String(req.headers.authorization || '') })
      if (req.url === '/agent/remote/estop') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, aborted: [{ runId: 'r1', sessionId: 's1', category: 'remote' }], killedProcesses: 2, revertedEntries: 1, locked: true }))
        return
      }
      if (req.url === '/agent/remote/unlock') {
        res.writeHead(unlockStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(unlockStatus === 200 ? { ok: true, locked: false } : { code: 'REMOTE_UNLOCK_NOT_CONFIRMED' }))
        return
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url, calls,
    streams: () => streams.size,
    setUnlockStatus: (s: number) => { unlockStatus = s },
    setBoot: (b: string) => { bootId = b },
    push: (p: Partial<ActivitySnapshot>) => {
      const snap: ActivitySnapshot = { v: 1, bootId, seq: ++seq, lock: { locked: false, source: null }, runs: [], processes: [], ...p }
      for (const s of streams) s.write(`data: ${JSON.stringify({ type: 'snapshot', ...snap })}\n\n`)
    },
    close: () => { for (const s of streams) s.destroy(); server.closeAllConnections?.(); server.close() },
  }
}

type Harness = Awaited<ReturnType<typeof harness>>
const opened: Harness[] = []
async function harness(o: {
  engineUp?: boolean; register?: (acc: string) => boolean; auth?: Awaited<ReturnType<RemoteSafetyDeps['systemAuth']>>;
  writeFails?: () => boolean; dir?: string; trusted?: Record<string, string>; capable?: boolean
} = {}) {
  const dir = o.dir ?? await mkdtemp(join(tmpdir(), 'k2-safety-'))
  const file = join(dir, 'remote-lock.json')
  const engine = await fakeEngine()
  let up = o.engineUp ?? true
  const order: string[] = []
  const registered = new Set<string>()
  const notifications: Array<{ title: string; body: string }> = []
  const forced: boolean[] = []
  const trays: Array<{ title: string; tooltip: string }> = []
  const logs: string[] = []
  let authCalls = 0
  const rs = createRemoteSafety({
    file: () => file,
    engine: () => ({ url: up ? engine.url : null, token: 'LOCAL_TOKEN' }),
    shortcuts: {
      register: (acc) => { const ok = (o.register ?? (() => true))(acc); if (ok) registered.add(acc); return ok },
      unregister: (acc) => { registered.delete(acc) },
    },
    notify: (title, body) => { notifications.push({ title, body }) },
    refreshTray: (ind) => { order.push('tray'); trays.push(ind) },
    keepAwake: { force: (_k, on) => { forced.push(on); return on } },
    systemAuth: async () => { authCalls++; return o.auth ?? 'ok' },
    lang: () => 'en',
    remoteCapable: () => o.capable ?? true,
    trustedCallerLabel: (id) => o.trusted?.[id] ?? null,
    mac: true,
    log: (m) => { logs.push(m) },
    readFile: async (f) => { try { return await readFile(f, 'utf8') } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e } },
    writeFile: async (f, data) => { order.push('write'); if (o.writeFails?.()) throw new Error('EACCES'); await writeFile(f, JSON.stringify(data)) },
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/agent/remote/estop')) order.push('engine')
      return fetch(url, init)
    }) as typeof fetch,
  })
  const h = {
    rs, engine, file, dir, order, registered, notifications, forced, trays, logs,
    authCalls: () => authCalls,
    setUp: (v: boolean) => { up = v },
    close: () => { rs.dispose(); engine.close() },
  }
  opened.push(h)
  return h
}
afterEach(async () => { for (const h of opened.splice(0)) { h.close(); await rm(h.dir, { recursive: true, force: true }).catch(() => {}) } })

const REMOTE_RUN = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId, sessionId: `s-${runId}`, category: 'remote' as const, startedAt: 1, pendingApprovals: 0, pendingInquiries: 0,
  remote: { via: 'tunnel' as const, marked: true, callerUnit: '0f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f', callerKind: 'phone' as const, callerName: 'Pixel 9' }, ...extra,
})

describe('锁文件解析(与引擎同口径 fail closed)', () => {
  it('ENOENT → 未锁 + 缺省热键;lock:null → 未锁;locked:true → 锁;坏 / 缺 lock 键 / 形状不对 → 锁 + corrupt', () => {
    expect(parseLockFile(null)).toEqual({ lock: null, hotkey: DEFAULT_ESTOP_HOTKEY })
    expect(parseLockFile('{"v":1,"lock":null,"hotkey":""}')).toEqual({ lock: null, hotkey: '' })
    expect(parseLockFile('{"v":1,"lock":{"locked":true,"at":5,"source":"tray"}}').lock).toEqual({ locked: true, at: 5, source: 'tray' })
    for (const raw of ['{', '[]', '{"v":1}', '{"lock":false}', '{"lock":{"locked":"y"}}']) expect(parseLockFile(raw)).toMatchObject({ lock: { locked: true }, corrupt: true })
  })
  it('env 名与引擎镜像一致', () => { expect(REMOTE_LOCK_FILE_ENV).toBe('FORSION_REMOTE_LOCK_FILE') })
  it('设备名净化:去控制符 / 零宽 / 双向覆写,截 40', () => {
    expect(sanitizeLabel(`Pix${String.fromCharCode(0x202e)}el${String.fromCharCode(0x200b)}\n9`)).toBe('Pixel 9')
    expect(sanitizeLabel('x'.repeat(60))).toHaveLength(40)
    expect(sanitizeLabel(String.fromCharCode(0x200b))).toBeNull()
  })
})

describe('createRemoteSafety', () => {
  it('start 之前按锁定(fail closed);读到 ENOENT → 未锁、注册缺省热键 ⌃⌥⇧.', async () => {
    const h = await harness()
    expect(h.rs.isLocked()).toBe(true)
    await h.rs.start()
    expect(h.rs.isLocked()).toBe(false)
    expect(h.registered.has('Control+Alt+Shift+.')).toBe(true)
    expect(h.rs.state().hotkey).toEqual({ accelerator: 'Control+Alt+Shift+.', registered: true, error: null })
  })

  it('热键注册返回 false → in_use;抛 → invalid;托盘视图如实(失败可见)', async () => {
    const a = await harness({ register: () => false })
    await a.rs.start()
    expect(a.rs.state().hotkey).toMatchObject({ registered: false, error: 'in_use' })
    expect(a.rs.trayView().hotkey.registered).toBe(false)
    const b = await harness({ register: () => { throw new Error('bad accelerator') } })
    await b.rs.start()
    expect(b.rs.state().hotkey).toMatchObject({ registered: false, error: 'invalid' })
  })

  it('改键:先注册新键成功再注销旧键并落盘;新键失败保留旧键;空串 = 关', async () => {
    let taken = new Set(['Control+Alt+Shift+X'])
    const h = await harness({ register: (acc) => !taken.has(acc) })
    await h.rs.start()
    expect(await h.rs.setHotkey('Control+Alt+Shift+X')).toMatchObject({ accelerator: 'Control+Alt+Shift+.', registered: true, error: 'in_use' })
    expect(h.registered.has('Control+Alt+Shift+.')).toBe(true)
    expect(await h.rs.setHotkey('Control+Alt+Shift+K')).toEqual({ accelerator: 'Control+Alt+Shift+K', registered: true, error: null })
    expect([...h.registered]).toEqual(['Control+Alt+Shift+K'])
    expect(JSON.parse(await readFile(h.file, 'utf8')).hotkey).toBe('Control+Alt+Shift+K')
    expect(await h.rs.setHotkey('')).toEqual({ accelerator: '', registered: false, error: 'disabled' })
    expect(h.registered.size).toBe(0)
    expect(JSON.parse(await readFile(h.file, 'utf8')).hotkey).toBe('')
    expect((await h.rs.setHotkey(42)).error).toBe('invalid')
    expect((await h.rs.setHotkey('x'.repeat(65))).error).toBe('invalid')
    taken = new Set()
  })

  it('急停顺序:内存锁 + 托盘先于写盘先于引擎;通知带计数;锁落盘;引擎收到本机令牌', async () => {
    const h = await harness()
    await h.rs.start()
    h.order.length = 0
    const lockedAtFirstTray: boolean[] = []
    h.rs.onChange((s) => lockedAtFirstTray.push(s.locked))
    const s = await h.rs.estop('hotkey')
    expect(h.order.slice(0, 3)).toEqual(['tray', 'write', 'engine'])
    expect(lockedAtFirstTray[0]).toBe(true)
    expect(s).toMatchObject({ locked: true, lockSource: 'hotkey', pendingEstop: false, lastEstop: { aborted: 1, killedProcesses: 2, revertedEntries: 1, engineReached: true } })
    expect(h.rs.isLocked()).toBe(true)
    expect(JSON.parse(await readFile(h.file, 'utf8'))).toMatchObject({ v: 1, lock: { locked: true, source: 'hotkey' }, hotkey: 'Control+Alt+Shift+.' })
    expect(h.engine.calls[0]).toMatchObject({ path: '/agent/remote/estop', body: { source: 'hotkey' }, auth: 'Bearer LOCAL_TOKEN' })
    expect(h.notifications.at(-1)).toEqual({ title: 'Emergency stop', body: expect.stringContaining('Stopped 1 remote tasks, ended 2 background processes and withdrew 1') })
    expect(h.trays.at(-1)).toEqual({ title: ' Locked', tooltip: 'Forsion · Remote access locked' })
  })

  it('S6 引擎不可达:照样锁 + 落盘,待补发;引擎 ready 后自动补发', async () => {
    const h = await harness({ engineUp: false })
    await h.rs.start()
    const s = await h.rs.estop('tray')
    expect(s).toMatchObject({ locked: true, pendingEstop: true, engine: 'unavailable', lastEstop: { engineReached: false } })
    expect(h.notifications.at(-1)!.body).toContain('engine is unreachable')
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock.locked).toBe(true)
    h.setUp(true)
    h.rs.engineStatusChanged()
    await until(() => h.engine.calls.some((c) => c.path === '/agent/remote/estop'))
    await until(() => !h.rs.state().pendingEstop)
    expect(h.engine.calls.find((c) => c.path === '/agent/remote/estop')!.body).toEqual({ source: 'tray' })
  })

  it('S12 写盘失败:仍锁定(引擎闩兜底),状态与通知都说明', async () => {
    const h = await harness({ writeFails: () => true })
    await h.rs.start()
    const s = await h.rs.estop('settings')
    expect(s).toMatchObject({ locked: true, lockPersistFailed: true })
    expect(h.notifications.at(-1)!.body).toContain('couldn’t be saved')
  })

  it('S7 锁跨重启:第二个控制器读同一文件 → 锁定;S8 坏文件 → 锁定', async () => {
    const a = await harness()
    await a.rs.start()
    await a.rs.estop('hotkey')
    const b = await harness({ dir: a.dir })
    await b.rs.start()
    expect(b.rs.isLocked()).toBe(true)
    expect(b.rs.state().lockSource).toBe('hotkey')
    await writeFile(a.file, '{broken')
    const c = await harness({ dir: a.dir })
    await c.rs.start()
    expect(c.rs.isLocked()).toBe(true)
  })

  it('S2 解锁:认证 cancelled / unavailable / failed 都保持锁定、文件不动', async () => {
    for (const auth of ['cancelled', 'unavailable', 'failed'] as const) {
      const h = await harness({ auth })
      await h.rs.start()
      await h.rs.estop('hotkey')
      expect(await h.rs.unlock()).toEqual({ ok: false, reason: auth })
      expect(h.rs.isLocked()).toBe(true)
      expect(JSON.parse(await readFile(h.file, 'utf8')).lock.locked).toBe(true)
      expect(h.engine.calls.some((c) => c.path === '/agent/remote/unlock')).toBe(false)
    }
  })

  it('S2 解锁:认证通过 → 先写 lock:null 再内存解锁再清引擎闩;写盘失败 → 保持锁定', async () => {
    let fail = false
    const h = await harness({ writeFails: () => fail })
    await h.rs.start()
    await h.rs.estop('hotkey')
    fail = true
    expect(await h.rs.unlock()).toEqual({ ok: false, reason: 'failed' })
    expect(h.rs.isLocked()).toBe(true)
    fail = false
    expect(await h.rs.unlock()).toEqual({ ok: true })
    expect(h.rs.isLocked()).toBe(false)
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock).toBeNull()
    expect(h.engine.calls.at(-1)!.path).toBe('/agent/remote/unlock')
    expect(h.notifications.at(-1)!.title).toBe('Remote access unlocked')
    expect(h.authCalls()).toBe(2)
  })

  it('解锁并发只弹一次认证', async () => {
    const h = await harness()
    await h.rs.start()
    await h.rs.estop('hotkey')
    const [a, b] = await Promise.all([h.rs.unlock(), h.rs.unlock()])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(h.authCalls()).toBe(1)
  })

  it('闩对账:本机已解锁、快照仍报 latch → 重发解锁', async () => {
    const h = await harness()
    h.engine.setUnlockStatus(409)
    await h.rs.start()
    await h.rs.estop('hotkey')
    await h.rs.unlock()
    const before = h.engine.calls.filter((c) => c.path === '/agent/remote/unlock').length
    h.engine.setUnlockStatus(200)
    await until(() => h.engine.streams() > 0)
    h.engine.push({ lock: { locked: true, source: 'latch', at: 1 } })
    await until(() => h.engine.calls.filter((c) => c.path === '/agent/remote/unlock').length > before)
  })

  it('活动快照 → 托盘「远程会话运行中 · 设备名」、keepAwake 强制;新调用方提示一次(10 分钟限频);引擎重启整份替换', async () => {
    const h = await harness({ trusted: { '0f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f': 'Mom’s Pixel' } })
    await h.rs.start()
    await until(() => h.engine.streams() > 0)
    h.engine.push({ runs: [REMOTE_RUN('r1'), { runId: 'l1', sessionId: 's', category: 'local', startedAt: 1, pendingApprovals: 0, pendingInquiries: 0 }] })
    await until(() => h.rs.state().remoteRuns.length === 1)
    expect(h.rs.state().remoteRuns[0]).toMatchObject({ runId: 'r1', label: 'Mom’s Pixel', category: 'remote' })
    expect(h.rs.trayView()).toMatchObject({ activeLabel: 'Mom’s Pixel', activeCount: 1, waitingApproval: false })
    expect(h.forced.at(-1)).toBe(true)
    expect(h.trays.at(-1)).toEqual({ title: ' Remote', tooltip: 'Forsion · Remote session running' })
    expect(h.notifications).toEqual([{ title: 'A remote session started on this computer', body: 'From Mom’s Pixel. Press ⌃⌥⇧. or use the menu bar to stop it at any time.' }])
    // 同一调用方又起一条 run:10 分钟内不再提示;等批准 → 托盘标出来
    h.engine.push({ runs: [REMOTE_RUN('r1'), REMOTE_RUN('r2', { pendingApprovals: 1 })] })
    await until(() => h.rs.state().remoteRuns.length === 2)
    expect(h.notifications.length).toBe(1)
    expect(h.rs.trayView().waitingApproval).toBe(true)
    // 通道 / Muse:进列表但不强制防休眠
    h.engine.push({ runs: [{ runId: 'c1', sessionId: 's', category: 'channel', channel: 'wechat', startedAt: 1, pendingApprovals: 0, pendingInquiries: 0 }] })
    await until(() => h.rs.state().remoteRuns[0]?.runId === 'c1')
    expect(h.rs.state().remoteRuns[0].label).toBe('WeChat')
    expect(h.forced.at(-1)).toBe(false)
    expect(h.trays.at(-1)!.title).toBe(' Remote')
    h.engine.push({ runs: [] })
    await until(() => h.rs.state().remoteRuns.length === 0)
    expect(h.trays.at(-1)).toEqual({ title: '', tooltip: 'Forsion' })
  })

  it('账号级调用方(无设备断言的隧道)用 K4 的「本账号…」名;名字不可信串被净化', async () => {
    const h = await harness({ trusted: { account: 'Browsers and web on this account' } })
    await h.rs.start()
    await until(() => h.engine.streams() > 0)
    h.engine.push({ runs: [REMOTE_RUN('a1', { remote: { via: 'tunnel', marked: true } }), REMOTE_RUN('b1', { remote: { via: 'lan', marked: true } }),
      REMOTE_RUN('d1', { remote: { via: 'tunnel', marked: true, callerUnit: '1f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f', callerKind: 'phone', callerName: `Evil${String.fromCharCode(0x202e)}\nname` } })] })
    await until(() => h.rs.state().remoteRuns.length === 3)
    expect(h.rs.state().remoteRuns.map((r) => r.label)).toEqual(['Browsers and web on this account', 'Paired LAN device', 'Evil name'])
  })

  it('锁定期间不强制防休眠、不提示新会话;托盘常驻「停止全部」与「解锁」', async () => {
    const h = await harness({ capable: false })
    await h.rs.start()
    await h.rs.estop('hotkey')
    await until(() => h.engine.streams() > 0)
    const n = h.notifications.length
    h.engine.push({ runs: [REMOTE_RUN('late')] })
    await until(() => h.rs.state().remoteRuns.length === 1)
    expect(h.forced.at(-1)).toBe(false)
    expect(h.notifications.length).toBe(n)
    expect(h.rs.trayView()).toMatchObject({ locked: true, capable: false })
  })
})
