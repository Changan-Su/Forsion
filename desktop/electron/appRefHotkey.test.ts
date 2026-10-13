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

describe('全局双 ⌘ 的订阅', () => {
  it('订阅时带上自己的 pid(Forsion 在前台时助手不推);收到一行按键事件就交出那扇窗口', async () => {
    const h = await helper((msg, s) => s.write(`${JSON.stringify({ id: msg.id, ok: true, result: { subscribed: true } })}\n`))
    const fired: unknown[] = []
    const hk = createAppRefHotkey({ socketPath: () => h.sock, ownPid: 4242, onFire: (f) => fired.push(f) })
    hk.setWanted(true)
    await until(() => h.requests.length === 1)
    expect(h.requests[0]).toMatchObject({ cmd: 'hotkeySubscribe', gesture: 'modPair', excludePids: [4242] })
    // 一个包里两行、再加半行:按行拆,别的事件 / 别的手势不认
    h.sockets[0].write(`${JSON.stringify({ event: 'hotkey', gesture: 'modPair', at: 1, front: FRONT })}\n${JSON.stringify({ event: 'hotkey', gesture: 'other', front: FRONT })}\n{"ev":`)
    await until(() => fired.length === 1)
    expect(fired[0]).toEqual(FRONT)
    hk.setWanted(false)
    await until(() => !hk.state().connected && h.sockets[0].destroyed)
  })

  it('老助手不认这条命令:这次运行不再试', async () => {
    const h = await helper((msg, s) => s.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code: 'unknown_command', message: 'hotkeySubscribe' } })}\n`))
    const hk = createAppRefHotkey({ socketPath: () => h.sock, ownPid: 1, onFire: () => {}, retryMs: 20 })
    hk.setWanted(true)
    await until(() => hk.state().dead && !hk.state().connected)
    hk.poke()
    await new Promise((r) => setTimeout(r, 80))
    expect(h.requests).toHaveLength(1)
  })

  it('助手没在跑:不报错,隔一阵再试;助手起来后 poke 一下立刻连上;连接断了会重连', async () => {
    const sock = path.join(dir, 'late.sock')
    const hk = createAppRefHotkey({ socketPath: () => sock, ownPid: 1, onFire: () => {}, retryMs: 60_000 })
    hk.setWanted(true)
    await until(() => !hk.state().connected)
    const requests: unknown[] = []
    const sockets: net.Socket[] = []
    const server = net.createServer((s) => { sockets.push(s); s.setEncoding('utf8'); s.on('data', (c: string) => { const m = JSON.parse(c); requests.push(m); s.write(`${JSON.stringify({ id: m.id, ok: true, result: {} })}\n`) }); s.on('error', () => {}) })
    servers.push(server)
    await new Promise<void>((r) => server.listen(sock, () => r()))
    hk.poke()
    await until(() => requests.length === 1)
    hk.setWanted(false)
    // 重连:换一个重试间隔短的实例,助手主动断开后它自己连回来
    const again = createAppRefHotkey({ socketPath: () => sock, ownPid: 1, onFire: () => {}, retryMs: 20 })
    again.setWanted(true)
    await until(() => requests.length === 2)
    sockets[sockets.length - 1].destroy()
    await until(() => requests.length === 3)
    again.setWanted(false)
  })

  it('没说要(用户改了键 / 解绑)就不连;这个平台没有助手也不连', async () => {
    const h = await helper(() => {})
    const off = createAppRefHotkey({ socketPath: () => h.sock, ownPid: 1, onFire: () => {} })
    off.poke()
    const none = createAppRefHotkey({ socketPath: () => '', ownPid: 1, onFire: () => {} })
    none.setWanted(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(h.requests).toHaveLength(0)
    expect(none.state().connected).toBe(false)
  })
})
