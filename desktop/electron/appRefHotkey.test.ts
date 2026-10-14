import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppRefHotkey, frontToAppRef } from './appRefHotkey'

// 真 unix socket + 一个按行回话的假助手:线协议就是 electron/appRefHotkey.ts 顶注那三行。
const dir = mkdtempSync(path.join(os.tmpdir(), 'apprefhk-'))
const servers: net.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

let seq = 0
function helper(reply: (msg: Record<string, unknown>, socket: net.Socket) => void): Promise<{ sock: string; requests: Array<Record<string, unknown>>; sockets: net.Socket[] }> {
  const sock = path.join(dir, `h${++seq}.sock`)
  const requests: Array<Record<string, unknown>> = []
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { for (const line of chunk.split('\n').filter(Boolean)) { const msg = JSON.parse(line); requests.push(msg); reply(msg, socket) } })
    socket.on('error', () => {})
  })
  servers.push(server)
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, requests, sockets })))
}
const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); expect(ok()).toBe(true) }
const FRONT = { bundleId: 'com.google.Chrome', app: 'Google Chrome', pid: 11, windowId: 101, title: 'Linear – Pricing' }

describe('助手给的最前面的窗口 → 引用', () => {
  it('有标题 = 窗口引用(带上 pid / 窗口号);没标题 = 应用引用;标识不合法 = 不要', () => {
    expect(frontToAppRef(FRONT)).toEqual({ ref: { kind: 'window', id: 'com.google.Chrome', name: 'Linear – Pricing' }, pid: 11, windowId: 101 })
    expect(frontToAppRef({ ...FRONT, title: '  ' })?.ref).toEqual({ kind: 'app', id: 'com.google.Chrome', name: 'Google Chrome' })
    expect(frontToAppRef({ bundleId: 'com.x', title: '' })?.ref).toEqual({ kind: 'app', id: 'com.x', name: 'com.x' })
    expect(frontToAppRef({ ...FRONT, bundleId: 'a b' })).toBeNull()
    expect(frontToAppRef({ title: '没有标识' })).toBeNull()
  })
})

describe('Windows:连不上就拉起助手(那边没有权限框)', () => {
  it('拉起一次后连上;拉了还是连不上,试几次就不再试(不会每半分钟起一个进程)', async () => {
    const sock = path.join(dir, 'win.sock')
    const requests: unknown[] = []
    let launched = 0
    const launch = async (): Promise<void> => {
      launched++
      const server = net.createServer((s) => { s.setEncoding('utf8'); s.on('data', (c: string) => { const m = JSON.parse(c); requests.push(m); s.write(`${JSON.stringify({ id: m.id, ok: true, result: { subscribed: true } })}\n`) }); s.on('error', () => {}) })
      servers.push(server)
      await new Promise<void>((r) => server.listen(sock, () => r()))
    }
    const hk = createAppRefHotkey({ target: () => ({ path: sock, launch }), ownPid: 1, onFire: () => {}, retryMs: 60_000 })
    hk.setWanted(true)
    await until(() => requests.length === 1)
    expect(launched).toBe(1)
    hk.setWanted(false)

    // 还没应答就被关掉又打开:旧连接晚到的 close 不许去拉起助手、也不许动新连接的状态
    const mute = await helper(() => {})
    let stray = 0
    const flip = createAppRefHotkey({ target: () => ({ path: mute.sock, launch: async () => { stray++ } }), ownPid: 1, onFire: () => {}, retryMs: 60_000 })
    flip.setWanted(true)
    await until(() => mute.requests.length === 1)
    flip.setWanted(false)
    flip.setWanted(true)
    await until(() => mute.requests.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(stray).toBe(0)
    expect(flip.state().connected).toBe(true)
    flip.setWanted(false)

    let tries = 0
    const stuck = createAppRefHotkey({ target: () => ({ path: path.join(dir, 'never.sock'), launch: async () => { tries++ } }), ownPid: 1, onFire: () => {}, retryMs: 10 })
    stuck.setWanted(true)
    await until(() => stuck.state().dead)
    expect(tries).toBe(3)
  }, 20_000)
  it('Windows 的窗口:标识由调用方给的规则从 exe 路径算;算不出来 = 不要(调用方改问「最前面是谁」)', () => {
    const front = { exe: 'notepad.exe', path: 'C:\\Windows\\System32\\notepad.exe', app: 'Notepad', pid: 4140, windowId: 262638, title: 'Untitled - Notepad' }
    expect(frontToAppRef(front, () => 'notepad.exe')).toEqual({ ref: { kind: 'window', id: 'notepad.exe', name: 'Untitled - Notepad' }, pid: 4140, windowId: 262638 })
    expect(frontToAppRef(front, () => null)).toBeNull()
    expect(frontToAppRef(front)).toBeNull() // 缺省只认 bundleId(macOS)
  })
})

describe('全局双 ⌘ 的订阅', () => {
  it('订阅时带上自己的 pid(Forsion 在前台时助手不推);收到一行按键事件就交出那扇窗口', async () => {
    const h = await helper((msg, s) => s.write(`${JSON.stringify({ id: msg.id, ok: true, result: { subscribed: true } })}\n`))
    const fired: unknown[] = []
    const hk = createAppRefHotkey({ target: () => ({ path: h.sock }), ownPid: 4242, onFire: (f) => fired.push(f) })
    hk.setWanted(true)
    await until(() => h.requests.length === 1)
    expect(h.requests[0]).toMatchObject({ cmd: 'hotkeySubscribe', gesture: 'modPair', excludePids: [4242] })
    // 一个包里两行、再加半行:按行拆,别的事件 / 别的手势不认
    // 一个包里好几行、再加半行:按行拆;写队列溢出的 system 行、别的手势、旧设想的信封都不认
    const ev = (o: Record<string, unknown>): string => `${JSON.stringify({ ev: { t: 1, kind: 'hotkey', gesture: 'modPair', ...o } })}\n`
    h.sockets[0].write(`${ev({ front: FRONT })}${JSON.stringify({ ev: { kind: 'system', state: 'dropped', count: 2 } })}\n${ev({ gesture: 'other', front: FRONT })}${JSON.stringify({ event: 'hotkey', gesture: 'modPair', front: FRONT })}\n${ev({ front: null })}{"ev":`)
    await until(() => fired.length === 2)
    expect(fired).toEqual([FRONT, null]) // 助手判断不出最前面是谁时给 null,由调用方自己再问
    hk.setWanted(false)
    await until(() => !hk.state().connected && h.sockets[0].destroyed)
  })

  it('老助手不认这条命令:告诉主进程一次、不放弃;助手被换成新版后 poke 一下当场连上(不用重启 Forsion)', async () => {
    let fresh = false // 助手换没换成新版
    const h = await helper((msg, s) => s.write(`${JSON.stringify(fresh ? { id: msg.id, ok: true, result: { subscribed: true } } : { id: msg.id, ok: false, error: { code: 'unknown_command', message: 'hotkeySubscribe' } })}\n`))
    let told = 0
    const hk = createAppRefHotkey({ target: () => ({ path: h.sock }), ownPid: 1, onFire: () => {}, onOutdated: () => { told++ }, retryMs: 20 })
    hk.setWanted(true)
    await until(() => hk.state().outdated && !hk.state().connected)
    expect(hk.state().dead).toBe(false)
    await new Promise((r) => setTimeout(r, 80)) // 旧版期间不按短间隔追着问(那是 5 分钟一次)
    expect(h.requests).toHaveLength(1)
    hk.poke() // 还是旧版:再问一次,但不再叫 onOutdated
    await until(() => h.requests.length === 2 && !hk.state().connected)
    expect(told).toBe(1)
    fresh = true
    hk.poke()
    await until(() => hk.state().connected && !hk.state().outdated)
    expect(h.requests).toHaveLength(3)
    hk.setWanted(false)
  })

  it('助手没在跑:不报错,隔一阵再试;助手起来后 poke 一下立刻连上;连接断了会重连', async () => {
    const sock = path.join(dir, 'late.sock')
    const hk = createAppRefHotkey({ target: () => ({ path: sock }), ownPid: 1, onFire: () => {}, retryMs: 60_000 })
    hk.setWanted(true)
    await until(() => hk.state().attempts === 1 && !hk.state().connected) // 第一次连过了、没连上
    const requests: unknown[] = []
    const sockets: net.Socket[] = []
    const server = net.createServer((s) => { sockets.push(s); s.setEncoding('utf8'); s.on('data', (c: string) => { const m = JSON.parse(c); requests.push(m); s.write(`${JSON.stringify({ id: m.id, ok: true, result: {} })}\n`) }); s.on('error', () => {}) })
    servers.push(server)
    await new Promise<void>((r) => server.listen(sock, () => r()))
    hk.poke()
    await until(() => requests.length === 1)
    hk.setWanted(false)
    // 重连:换一个重试间隔短的实例,助手主动断开后它自己连回来
    const again = createAppRefHotkey({ target: () => ({ path: sock }), ownPid: 1, onFire: () => {}, retryMs: 20 })
    again.setWanted(true)
    await until(() => requests.length === 2)
    sockets[sockets.length - 1].destroy()
    await until(() => requests.length === 3)
    again.setWanted(false)
  })

  it('没说要(用户改了键 / 解绑)就不连;这个平台没有助手也不连', async () => {
    const h = await helper(() => {})
    const off = createAppRefHotkey({ target: () => ({ path: h.sock }), ownPid: 1, onFire: () => {} })
    off.poke()
    const none = createAppRefHotkey({ target: () => null, ownPid: 1, onFire: () => {} })
    none.setWanted(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(h.requests).toHaveLength(0)
    expect(none.state().connected).toBe(false)
  })
})
