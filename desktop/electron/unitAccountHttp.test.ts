/** Real HTTP coverage for visitor persistence: UTF-8 uploads and late revocation. */
import { describe, expect, it } from 'vitest'
import http, { type IncomingMessage } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createAccountHttp } from '../../unit/accountHttp'
import type { BackendAccount, BackendIdentity } from '../../unit/backendTypes'

const owner: BackendIdentity = { userId: 'user-a', username: 'Alice', role: 'ADMIN',
  tenantId: 'personal:user-a', workspaceId: 'personal:user-a' }
const pluginPath = '/unit/plugin-data/server-admin'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'unit-account-http-'))
  let resolveAccount: BackendAccount['resolve'] = async (token) => token === 'valid-token' ? owner : null
  let provider: { id: string; account: BackendAccount } | undefined = {
    id: 'forsion-account', account: { resolve: (token, options) => resolveAccount(token, options) },
  }
  const handle = createAccountHttp({ dataDir, provider: () => provider, pluginActive: (id) => id === 'server-admin' })
  const chunks = new EventEmitter()
  const chunkSizes: number[] = []
  const server = http.createServer((req, res) => {
    // Observe real HTTP chunks without entering flowing mode before authentication.
    const originalIterator = req[Symbol.asyncIterator].bind(req)
    req[Symbol.asyncIterator] = async function* () {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        chunkSizes.push(chunk.length)
        chunks.emit('chunk')
        yield chunk
      }
    } as IncomingMessage[typeof Symbol.asyncIterator]
    void handle(new URL(req.url || '/', 'http://unit.test').pathname, req, res).then((handled) => {
      if (!handled) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not found"}') }
    }).catch(() => { res.writeHead(500); res.end() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' }
  async function put(data: string) {
    return fetch(base + pluginPath, { method: 'PUT', headers, body: JSON.stringify({ data }) })
  }
  async function read() {
    const response = await fetch(base + pluginPath, { headers })
    return { status: response.status, body: await response.json() }
  }
  return {
    dataDir, base, headers, chunks, chunkSizes, put, read,
    resolveWith(resolver: BackendAccount['resolve']) { resolveAccount = resolver },
    removeProvider() { provider = undefined },
    replaceProvider() { provider = { id: 'forsion-account', account: { resolve: async () => owner } } },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await filesUnder(path))
    else results.push(path)
  }
  return results.sort()
}

describe('Unit account HTTP persistence', () => {
  it('preserves Chinese text and emoji when each UTF-8 byte arrives separately', async () => {
    const f = await fixture()
    try {
      const data = JSON.stringify({ title: '扶桑经营总览 🪴', note: '切换账号之后，保持个人工作区隔离。' })
      const body = Buffer.from(JSON.stringify({ data }))
      const request = http.request(f.base + pluginPath, { method: 'PUT', headers: f.headers })
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        request.once('error', reject)
        request.once('response', (res) => {
          let text = ''
          res.on('data', (chunk) => { text += chunk.toString() })
          res.once('error', reject)
          res.once('end', () => resolve({ status: res.statusCode!, body: text }))
        })
      })
      request.setNoDelay(true)
      for (const byte of body) {
        const observed = once(f.chunks, 'chunk')
        request.write(Buffer.from([byte]))
        await observed
      }
      request.end()
      expect((await response).status).toBe(200)
      expect(f.chunkSizes).toHaveLength(body.length)
      expect(f.chunkSizes.every((length) => length === 1)).toBe(true)
      expect(await f.read()).toEqual({ status: 200, body: { data } })
    } finally { await f.close() }
  })

  it.each([3, 4])('rejects revocation during identity check %i without replacing existing data', async (blockedCall) => {
    const f = await fixture()
    const blocked = deferred()
    const resume = deferred()
    try {
      expect((await f.put('before-logout')).status).toBe(200)
      const originalFiles = await filesUnder(f.dataDir)
      let calls = 0
      let revoked = false
      f.resolveWith(async () => {
        if (++calls === blockedCall) { blocked.resolve(); await resume.promise }
        return revoked ? null : owner
      })
      const pending = f.put('must-not-commit-after-logout')
      await blocked.promise
      revoked = true
      resume.resolve()
      const response = await pending
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Account changed' })
      expect(calls).toBe(blockedCall)
      f.resolveWith(async () => owner)
      expect(await f.read()).toEqual({ status: 200, body: { data: 'before-logout' } })
      expect(await filesUnder(f.dataDir)).toEqual(originalFiles)
    } finally { resume.resolve(); await f.close() }
  })

  it('fails closed when the provider cannot resolve identity, without leaking data or error details', async () => {
    const f = await fixture()
    try {
      expect((await f.put('private-owner-data')).status).toBe(200)
      f.resolveWith(async () => { throw new Error('private provider configuration') })
      const response = await fetch(f.base + pluginPath, { headers: f.headers })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'Account service unavailable' })
      const anonymous = await fetch(f.base + pluginPath)
      expect(anonymous.status).toBe(401)
      expect(await anonymous.json()).toEqual({ error: 'Authentication required' })
      f.removeProvider()
      const unavailable = await fetch(f.base + pluginPath, { headers: f.headers })
      expect(unavailable.status).toBe(404)
      expect(await unavailable.json()).toEqual({ error: 'Not found' })
    } finally { await f.close() }
  })

  it('does not return an old identity if its provider is replaced while resolving', async () => {
    const f = await fixture()
    const blocked = deferred()
    const resume = deferred()
    try {
      f.resolveWith(async () => { blocked.resolve(); await resume.promise; return owner })
      const pending = fetch(f.base + '/unit/account', { headers: f.headers })
      await blocked.promise
      f.replaceProvider()
      resume.resolve()
      const response = await pending
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'Account provider changed' })
      expect(await filesUnder(f.dataDir)).toEqual([])
    } finally { resume.resolve(); await f.close() }
  })
})
