/**
 * P1 · K2 §3.8:急停 / 远程锁定控制器(零 electron;假引擎 = 真 HTTP 服务 + SSE,文件 / 热键 / 通知 / 认证换内存)。
 *   S6 断网 / 引擎不可达照样锁;引擎 ready 后补发急停。S7 锁跨重启(第二个控制器读同一文件)。S8 锁文件坏 → 锁定。
 *   S2 解锁要系统认证:cancelled / unavailable / failed 都保持锁定;写盘失败保持锁定(不做半解锁)。
 *   S12 失败可见:热键注册失败 / 写盘失败 / 引擎不可达都进状态。
 *   以及:急停顺序(内存锁先于写盘先于引擎)、闩对账、keepAwake 强制通道、新调用方提示限频、设备名净化。
 *   独立评审(K2 二轮)补的四条,修前都实跑为红:
 *     - 急停 POST 失败而活动流一直健康 → 下一份快照就补发(原先只在重连时补,待补发一直挂着);
 *     - 反向对账:本机锁着、引擎说没锁(写盘失败 + 引擎重启丢了闩)→ 重写锁文件 + 静默补发 estop;
 *     - 引擎带着本机不知道的闩(锁文件不存在)→ 本机接过这把锁,不再对 409 每份快照死循环;旧闩重发解锁前先写回 lock:null、节流;
 *     - 录制快捷键期间挂起全局热键(macOS 上按当前组合键会被 globalShortcut 截走直接急停)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
  let estopStatus = 200
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
        if (estopStatus !== 200) { res.writeHead(estopStatus); res.end(); return }
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
    setEstopStatus: (s: number) => { estopStatus = s },
    setBoot: (b: string) => { bootId = b },
    push: (p: Partial<ActivitySnapshot>) => {
      const snap: ActivitySnapshot = { v: 1, bootId, seq: ++seq, lock: { locked: false, source: null }, runs: [], processes: [], ...p }
      for (const s of streams) s.write(`data: ${JSON.stringify({ type: 'snapshot', ...snap })}\n\n`)
    },
    close: () => { for (const s of streams) s.destroy(); server.closeAllConnections?.(); server.close() },
  }
}

const opened: Array<{ close(): void; dir: string }> = []
async function harness(o: {
  engineUp?: boolean; register?: (acc: string) => boolean; auth?: Awaited<ReturnType<RemoteSafetyDeps['systemAuth']>>;
  writeFails?: () => boolean; dir?: string; trusted?: Record<string, string>; capable?: boolean; recordingTimeoutMs?: number
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
    hotkeyRecordingTimeoutMs: o.recordingTimeoutMs,
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

  const count = (h: { engine: { calls: Array<{ path: string }> } }, path: string): number => h.engine.calls.filter((c) => c.path === path).length
  const tick = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('急停 POST 失败而活动流一直健康:下一份快照就补发;补发回的(引擎按锁定期累计的)报告写进 lastEstop,待补发清掉', async () => {
    const h = await harness()
    await h.rs.start()
    await until(() => h.engine.streams() > 0)
    h.engine.setEstopStatus(500)
    expect(await h.rs.estop('hotkey')).toMatchObject({ locked: true, pendingEstop: true, lastEstop: { engineReached: false } })
    h.engine.setEstopStatus(200)
    const before = count(h, '/agent/remote/estop')
    h.engine.push({ lock: { locked: true, source: 'latch', at: Date.now() } }) // 流没断:不会有重连来触发补发
    await until(() => !h.rs.state().pendingEstop)
    expect(count(h, '/agent/remote/estop')).toBe(before + 1)
    expect(h.engine.calls.at(-1)!.body).toEqual({ source: 'hotkey' })
    expect(h.rs.state().lastEstop).toMatchObject({ aborted: 1, killedProcesses: 2, revertedEntries: 1, engineReached: true })
  })

  it('反向对账:本机锁着、引擎说没锁(写盘失败后引擎重启,闩丢了)→ 重写锁文件 + 静默补发 estop;同一 boot 10s 内不重复;引擎锁着只差写盘 → 只重试写盘', async () => {
    let fail = true
    const h = await harness({ writeFails: () => fail })
    await h.rs.start()
    await until(() => h.engine.streams() > 0)
    await h.rs.estop('hotkey')
    expect(h.rs.state().lockPersistFailed).toBe(true)
    // 引擎还锁着(闩):只重试写盘,不补发
    fail = false
    const e0 = count(h, '/agent/remote/estop')
    h.engine.push({ lock: { locked: true, source: 'latch', at: Date.now() } })
    await until(() => !h.rs.state().lockPersistFailed)
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock).toMatchObject({ locked: true, source: 'hotkey' })
    expect(count(h, '/agent/remote/estop')).toBe(e0)
    // 锁文件被本机进程删掉 + 引擎重启(新 boot,无闩)→ 快照说没锁
    await rm(h.file)
    const notes = h.notifications.length
    h.engine.setBoot('boot0002')
    h.engine.push({ lock: { locked: false, source: null } })
    await until(() => count(h, '/agent/remote/estop') === e0 + 1)
    expect(h.engine.calls.at(-1)!.body).toEqual({ source: 'hotkey' })
    await until(() => { return existsSync(h.file) })
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock).toMatchObject({ locked: true, source: 'hotkey' })
    expect(h.notifications.length).toBe(notes) // 静默
    expect(h.rs.isLocked()).toBe(true)
    h.engine.push({ lock: { locked: false, source: null } })
    await tick()
    expect(count(h, '/agent/remote/estop')).toBe(e0 + 1) // 同一 boot 10s 内不重复
  })

  it('引擎带着本机不知道的闩(绕过主进程直接打了引擎 estop,锁文件不存在):本机接过这把锁(落盘、显示已锁定、可认证解锁),不对 409 死循环', async () => {
    const h = await harness()
    await h.rs.start()
    await until(() => h.engine.streams() > 0)
    h.engine.setUnlockStatus(409)
    expect(h.rs.isLocked()).toBe(false)
    h.engine.push({ lock: { locked: true, source: 'latch', at: Date.now() } })
    await until(() => h.rs.isLocked())
    expect(h.rs.state()).toMatchObject({ locked: true, lockSource: 'settings' })
    await until(() => { return existsSync(h.file) })
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock).toMatchObject({ locked: true })
    h.engine.push({ lock: { locked: true, source: 'latch', at: Date.now() } })
    await tick()
    expect(count(h, '/agent/remote/unlock')).toBe(0)
    expect(h.trays.at(-1)).toEqual({ title: ' Locked', tooltip: 'Forsion · Remote access locked' })
    // 解锁照常要本机认证,写好 lock:null 后引擎清闩
    h.engine.setUnlockStatus(200)
    expect(await h.rs.unlock()).toEqual({ ok: true })
    expect(h.authCalls()).toBe(1)
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock).toBeNull()
    expect(count(h, '/agent/remote/unlock')).toBe(1)
  })

  it('旧闩(早于本机解锁,清闩没送到;锁文件又被删了):先写回 lock:null 再重发解锁;409 节流 + 只记一次日志,不接成新锁', async () => {
    const h = await harness()
    await h.rs.start()
    await until(() => h.engine.streams() > 0)
    await h.rs.estop('hotkey')
    h.engine.setUnlockStatus(409)
    expect(await h.rs.unlock()).toEqual({ ok: true })
    await rm(h.file)
    const u0 = count(h, '/agent/remote/unlock')
    h.engine.push({ lock: { locked: true, source: 'latch', at: 1 } })
    await until(() => count(h, '/agent/remote/unlock') === u0 + 1)
    expect(JSON.parse(await readFile(h.file, 'utf8')).lock).toBeNull() // 先写回再发
    for (let i = 0; i < 3; i++) h.engine.push({ lock: { locked: true, source: 'latch', at: 1 } })
    await tick()
    expect(count(h, '/agent/remote/unlock')).toBe(u0 + 1)
    expect(h.rs.isLocked()).toBe(false)
    expect(h.logs.filter((l) => l.includes('engine unlock not confirmed (409)')).length).toBe(1)
  })

  it('录制快捷键期间挂起全局热键(不再被截走触发急停),热键状态不变;结束 / 保存 / 超时都恢复', async () => {
    const h = await harness({ recordingTimeoutMs: 150 })
    await h.rs.start()
    expect([...h.registered]).toEqual([DEFAULT_ESTOP_HOTKEY])
    h.rs.setHotkeyRecording(true)
    expect([...h.registered]).toEqual([])
    expect(h.rs.state().hotkey).toMatchObject({ accelerator: DEFAULT_ESTOP_HOTKEY, registered: true, error: null })
    h.rs.setHotkeyRecording(false)
    expect([...h.registered]).toEqual([DEFAULT_ESTOP_HOTKEY])
    // 录制中直接保存新键:新键注册、旧键注销,之后的 false 是空操作
    h.rs.setHotkeyRecording(true)
    await h.rs.setHotkey('Control+Alt+Shift+K')
    expect([...h.registered]).toEqual(['Control+Alt+Shift+K'])
    h.rs.setHotkeyRecording(false)
    expect([...h.registered]).toEqual(['Control+Alt+Shift+K'])
    // 录同一个键(按下的正是当前组合键)→ 挂回去
    h.rs.setHotkeyRecording(true)
    expect(await h.rs.setHotkey('Control+Alt+Shift+K')).toMatchObject({ registered: true, error: null })
    expect([...h.registered]).toEqual(['Control+Alt+Shift+K'])
    // 渲染层没说「录完了」(崩溃 / 关窗)→ 超时兜底恢复
    h.rs.setHotkeyRecording(true)
    expect([...h.registered]).toEqual([])
    await until(() => h.registered.has('Control+Alt+Shift+K'), 2000)
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

// G11(INTEGRATION §4):「清空数据」不许删锁文件 —— 删了 = 不经系统认证解锁。钉 main.ts 的 app:clearData 清理列表。
describe('G11 清空数据不解锁', () => {
  it('main.ts 的 app:clearData 里不出现 remote-lock.json / REMOTE_LOCK_FILE', async () => {
    const src = await readFile(join(__dirname, 'main.ts'), 'utf8')
    const at = src.indexOf("ipcMain.handle('app:clearData'")
    expect(at).toBeGreaterThan(0)
    const end = src.indexOf('ipcMain.handle(', at + 10)
    const body = src.slice(at, end > at ? end : at + 4000).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    expect(body).toContain('REMOTE_SESSIONS_FILE') // K4 的开关 / 信任文件照删(对照:确实切到了清理列表那段)
    expect(body).not.toMatch(/REMOTE_LOCK_FILE|remote-lock\.json/)
  })
})
