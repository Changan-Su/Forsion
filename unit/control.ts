/** Local owner-only control plane. No administrative lifecycle routes are published over HTTP. */
import net from 'node:net'
import { chmod, rm, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

export interface ControlCommand { action: 'status' | 'enable' | 'disable' | 'restart' | 'update' | 'migrate'; id?: string; path?: string }
export const controlAddress = (dataDir: string) => process.platform === 'win32'
  ? `\\\\.\\pipe\\forsion-unit-${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 24)}`
  : resolve(tmpdir(), `forsion-unit-${process.getuid?.() ?? 'user'}`, createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 24) + '.sock')
export async function sendControl(dataDir: string, command: ControlCommand): Promise<unknown> {
  return new Promise((resolveReply, reject) => {
    const socket = net.connect(controlAddress(dataDir))
    let body = ''
    socket.setTimeout(240_000, () => socket.destroy(new Error('Unit control timed out')))
    socket.once('connect', () => socket.write(JSON.stringify(command) + '\n'))
    socket.on('data', (data) => {
      body += data
      if (body.length > 1_000_000) { socket.destroy(new Error('Oversized control response')); return }
      if (!body.includes('\n')) return
      try { const reply = JSON.parse(body.split('\n')[0]); socket.end(); if (reply.ok) resolveReply(reply.result); else reject(new Error(reply.error || 'Unit command failed')) }
      catch (error) { socket.destroy(); reject(error) }
    })
    socket.once('error', reject)
    socket.once('end', () => { if (!body.includes('\n')) reject(new Error('Unit control connection closed')) })
  })
}
export const unitIsOffline = (error: unknown) => ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException)?.code || '')
export async function startControl(dataDir: string, dispatch: (command: ControlCommand) => Promise<unknown>) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  try { await sendControl(dataDir, { action: 'status' }); throw new Error('This Unit is already running') }
  catch (error) { if (!unitIsOffline(error)) throw error }
  const address = controlAddress(dataDir)
  if (process.platform !== 'win32') { await mkdir(dirname(address), { recursive: true, mode: 0o700 }); await chmod(dirname(address), 0o700) }
  if (process.platform !== 'win32') await rm(address, { force: true })
  const clients = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    clients.add(socket); socket.once('close', () => clients.delete(socket))
    let body = '', dispatched = false
    socket.setTimeout(240_000, () => socket.destroy())
    socket.on('data', (data) => {
      if (dispatched) return
      body += data
      if (body.length > 1_000_000) { socket.destroy(); return }
      if (!body.includes('\n')) return
      dispatched = true
      void (async () => {
        try { socket.end(JSON.stringify({ ok: true, result: await dispatch(JSON.parse(body.split('\n')[0])) }) + '\n') }
        catch (error) { socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unit command failed' }) + '\n') }
      })()
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(address, ready) })
  if (process.platform !== 'win32') await chmod(address, 0o600)
  return { close: async () => {
    await new Promise<void>((done) => { server.close(() => done()); for (const socket of clients) socket.destroy() })
    if (process.platform !== 'win32') await rm(address, { force: true })
  } }
}
