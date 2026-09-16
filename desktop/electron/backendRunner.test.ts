import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { build } from 'esbuild'
import { startBackend, migrateBackend, type BackendHandle, type BackendOptions } from '../../unit/backendRunner'

let root: string
let workerFile: string
let counter = 0

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'unit-backend-test-'))
  workerFile = join(root, 'worker.mjs')
  await build({ entryPoints: [resolve('../unit/backendWorker.ts')], outfile: workerFile,
    bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'silent' })
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(source: string, extra: Partial<BackendOptions> = {}): Promise<BackendOptions> {
  const packageDir = join(root, String(++counter))
  const dataDir = join(packageDir, 'data')
  await mkdir(dataDir, { recursive: true })
  const entry = join(packageDir, 'plugin.mjs')
  await writeFile(entry, source)
  return { id: 'fixture', entry, packageDir, dataDir, workerFile, startTimeoutMs: 2000, stopTimeoutMs: 1000, ...extra }
}

async function gateway(backend: BackendHandle) {
  const server = http.createServer(backend.handle)
  server.on('upgrade', backend.upgrade)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return { server, base: `http://127.0.0.1:${port}`, port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await backend.stop() } }
}

async function eventually(assertion: () => Promise<void>, timeout = 1500): Promise<void> {
  const until = Date.now() + timeout
  let last: unknown
  while (Date.now() < until) {
    try { await assertion(); return } catch (error) { last = error }
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw last
}

const LIFECYCLE = `
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
let starts = 0;
export default async (ctx) => {
  const event = (s) => appendFile(join(ctx.dataDir, 'events'), s + '\\n');
  return {
    mounts: ['/api'],
    start: async () => { starts++; await event('start'); },
    migrate: async () => { await event('migrate'); },
    stop: async () => { await event('stop:' + ctx.signal.aborted); },
    handle(req, res) {
      if (req.url === '/api/restart') { res.end('restarting'); ctx.requestRestart(); return; }
      if (req.url === '/api/fail') { throw new Error(ctx.config.secret); }
      if (req.url === '/api/exit') { process.exit(17); return; }
      res.setHeader('Set-Cookie', ['a=1; HttpOnly', 'b=2']);
      res.end(JSON.stringify({ pid: process.pid, isMainThread, starts,
        env: process.env.UNIT_FIXTURE_SETTING, remote: req.socket.remoteAddress,
        method: req.method, url: req.url, authorization: req.headers.authorization }));
    }
  };
};`

// Detached migration-style job deliberately ignores SIGTERM. The plugin owns the
// grace period and SIGKILL, which disappear if its worker is terminated too early.
function detachedJobFixture(phase: 'start' | 'migrate' | 'factory', stopThrows = false): string {
  return `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    export default async (ctx) => {
      let child, exited;
      const begin = async () => {
        child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);")}],
          { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
        exited = once(child, 'exit');
        await once(child.stdout, 'data');
        await writeFile(join(ctx.dataDir, 'child.pid'), String(child.pid));
        ctx.log('detached job ready');
        if (!ctx.signal.aborted) await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
        if (${stopThrows}) await cleanup();
      };
      const cleanup = async () => {
        if (child) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          await delay(150);
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          await exited;
        }
        await writeFile(join(ctx.dataDir, 'stopped'), String(ctx.signal.aborted));
      };
      const plugin = { mounts: ['/api'], handle(_req, res) { res.end('should not publish'); },
        async stop() {
          if (${stopThrows}) throw new Error('stop hook failed while migration was reaping');
          await cleanup();
        },
      };
      ${phase === 'factory' ? 'await begin();' : `plugin.${phase} = begin;`}
      return plugin;
    };
  `
}

async function cleanDetachedFixture(options: BackendOptions): Promise<void> {
  const pid = Number(await readFile(join(options.dataDir, 'child.pid'), 'utf8').catch(() => ''))
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* fixture already reaped */ }
  }
}

describe('Unit backend workers', () => {
  it('resolves concurrent accounts without crossing identities or exposing provider private fields', async () => {
    const options = await fixture(`
      export default () => ({ mounts: ['/api'], handle(_req, res) { res.end('available'); },
        account: { metadata: { apiBase: '/api', loginPath: '/auth' }, async resolve(token) {
          await new Promise((done) => setTimeout(done, token === 'alice' ? 40 : 1));
          if (token === 'invalid') return null;
          if (token === 'error') throw new Error('PRIVATE_TOKEN_SENTINEL');
          if (token === 'malformed') return { userId: 17, username: 'wrong', role: 'ADMIN' };
          return { userId: token, username: token, role: token === 'alice' ? 'ADMIN' : 'USER',
            tenantId: 'personal:' + token, workspaceId: 'personal:' + token,
            password: 'PRIVATE_PASSWORD_SENTINEL', token: 'PRIVATE_TOKEN_SENTINEL' };
        } }
      });
    `)
    const backend = await startBackend(options)
    const app = await gateway(backend)
    try {
      expect(backend.account).toBeDefined()
      expect(backend.account?.metadata).toEqual({ apiBase: '/api', loginPath: '/auth' })
      const tokens = Array.from({ length: 30 }, (_, index) => index % 2 ? 'bob' : 'alice')
      const identities = await Promise.all(tokens.map((token) => backend.account!.resolve(token)))
      identities.forEach((identity, index) => expect(identity).toEqual({ userId: tokens[index], username: tokens[index],
        role: tokens[index] === 'alice' ? 'ADMIN' : 'USER', tenantId: 'personal:' + tokens[index], workspaceId: 'personal:' + tokens[index] }))
      await expect(backend.account!.resolve('invalid')).resolves.toBeNull()
      await expect(backend.account!.resolve('error')).rejects.toThrow('Account provider unavailable')
      await expect(backend.account!.resolve('malformed')).rejects.toThrow('Account provider unavailable')
      expect(await (await fetch(app.base + '/api')).text()).toBe('available')
      expect(backend.state).toBe('running')
    } finally { await app.close() }
  })

  it('bounds account calls, cancels individually, and rejects all pending identities before stopping', async () => {
    const options = await fixture(`
      import { appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default (ctx) => ({ mounts: ['/api'], handle(_req, res) { res.end('available'); },
        account: { async resolve(token, { signal }) {
          if (token === 'quick') return { userId: token, username: token, role: 'USER' };
          signal.addEventListener('abort', () => { void appendFile(join(ctx.dataDir, 'account-aborted'), token + '\\n'); }, { once: true });
          await appendFile(join(ctx.dataDir, 'account-started'), token + '\\n');
          return new Promise(() => {});
        } }
      });
    `, { accountTimeoutMs: 100 })
    const backend = await startBackend(options)
    try {
      await expect(backend.account!.resolve('deadline')).rejects.toThrow('timed out')
      await eventually(async () => expect(await readFile(join(options.dataDir, 'account-aborted'), 'utf8')).toContain('deadline'))
      const controller = new AbortController()
      const cancelled = expect(backend.account!.resolve('cancelled', { signal: controller.signal })).rejects.toThrow('cancelled')
      await eventually(async () => expect(await readFile(join(options.dataDir, 'account-started'), 'utf8')).toContain('cancelled'))
      controller.abort()
      await cancelled
      await eventually(async () => expect(await readFile(join(options.dataDir, 'account-aborted'), 'utf8')).toContain('cancelled'))
      await expect(backend.account!.resolve('quick')).resolves.toMatchObject({ userId: 'quick' })
      const stopped = expect(backend.account!.resolve('stopping')).rejects.toThrow('unavailable')
      await backend.stop()
      await stopped
      await expect(backend.account!.resolve('quick')).rejects.toThrow('unavailable')
    } finally { await backend.stop() }
  })

  it('rejects pending account calls if the worker crashes while preserving plugins without accounts', async () => {
    const plain = await startBackend(await fixture(LIFECYCLE))
    expect(plain.account).toBeUndefined()
    await plain.stop()
    const backend = await startBackend(await fixture(`
      export default () => ({ mounts: ['/api'], handle() {}, account: {
        resolve() { setTimeout(() => process.exit(9), 10); return new Promise(() => {}); }
      } });
    `))
    try {
      await expect(backend.account!.resolve('waiting')).rejects.toThrow('unavailable')
      expect(backend.state).toBe('failed')
    } finally { await backend.stop() }
  })

  it('refuses login descriptors which could send browser credentials to another origin', async () => {
    for (const loginPath of ['https://account.example/auth', '//account.example/auth', '/\\\\account.example/auth']) {
      await expect(startBackend(await fixture(`
        export default () => ({ mounts: ['/api'], handle() {}, account: {
          metadata: { apiBase: '/api', loginPath: ${JSON.stringify(loginPath)} },
          async resolve() { return null; }
        } });
      `))).rejects.toThrow('Account endpoints must be absolute same-origin paths')
    }
  })

  it('runs handlers in the Unit process with a worker-local environment and normal HTTP metadata', async () => {
    const options = await fixture(LIFECYCLE, { env: { UNIT_FIXTURE_SETTING: 'worker-only' }, config: { secret: 'PRIVATE_CONFIG_SENTINEL' } })
    const backend = await startBackend(options)
    expect(backend.mounts).toEqual(['/api'])
    expect(backend.state).toBe('running')
    const app = await gateway(backend)
    try {
      const response = await fetch(app.base + '/api/me?q=1', { headers: { Authorization: 'Bearer fixture', 'X-Forwarded-For': '10.0.0.99', 'X-Unit-Internal': 'forged' } })
      const text = await response.text()
      expect(text).not.toContain('PRIVATE_CONFIG_SENTINEL')
      expect(JSON.parse(text)).toMatchObject({ pid: process.pid, isMainThread: false, starts: 1,
        env: 'worker-only', remote: '127.0.0.1', method: 'GET', url: '/api/me?q=1', authorization: 'Bearer fixture' })
      expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2'])
      expect(process.env.UNIT_FIXTURE_SETTING).toBeUndefined()
    } finally { await app.close() }
    expect(backend.state).toBe('stopped')
    expect(await readFile(join(options.dataDir, 'events'), 'utf8')).toBe('start\nstop:true\n')
    await backend.stop()
  })

  it('streams uploads and responses without waiting for EOF, and propagates client cancellation', async () => {
    const options = await fixture(`
      import { appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default (ctx) => ({ mounts: ['/api'], handle(req, res) {
        if (req.url === '/api/upload') {
          let bytes = 0;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          req.on('data', (chunk) => { bytes += chunk.length; res.write(String(bytes) + '\\n'); });
          req.on('end', () => res.end('finished'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: initial\\n\\n');
        const timer = setInterval(() => res.write('data: live\\n\\n'), 20);
        res.once('close', () => { clearInterval(timer); void appendFile(join(ctx.dataDir, 'cancelled'), 'closed'); });
      }});
    `)
    const backend = await startBackend(options)
    const app = await gateway(backend)
    try {
      const upload = http.request(app.base + '/api/upload', { method: 'POST' })
      const responsePromise = once(upload, 'response')
      upload.write(Buffer.alloc(128 * 1024, 'a'))
      const [response] = await responsePromise as [http.IncomingMessage]
      const [chunk] = await once(response, 'data')
      expect(String(chunk)).toMatch(/^\d+\n/)
      expect(upload.writableEnded).toBe(false)
      upload.end(Buffer.alloc(128 * 1024, 'b'))
      await once(response, 'end')
      const controller = new AbortController()
      const stream = await fetch(app.base + '/api/stream', { signal: controller.signal })
      const reader = stream.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: initial')
      controller.abort()
      await eventually(async () => expect(await readFile(join(options.dataDir, 'cancelled'), 'utf8')).toBe('closed'))
    } finally { await app.close() }
  })

  it('supports raw HTTP upgrades and bytes already read past the upgrade headers', async () => {
    const options = await fixture(`
      export default () => ({ mounts: ['/api'], handle(_req, res) { res.end('http'); },
        upgrade(req, socket, head) {
          socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: fixture\\r\\n\\r\\n');
          if (head.length) socket.write(head);
          socket.pipe(socket);
        }
      });
    `)
    const backend = await startBackend(options)
    const app = await gateway(backend)
    const socket = net.connect(app.port, '127.0.0.1')
    try {
      await once(socket, 'connect')
      let output = ''
      socket.on('data', (chunk) => { output += chunk })
      socket.write('GET /api/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\nfirst-frame')
      await eventually(async () => { expect(output).toContain('101 Switching Protocols'); expect(output).toContain('first-frame') })
      socket.write('second-frame')
      await eventually(async () => expect(output).toContain('second-frame'))
    } finally { socket.destroy(); await app.close() }
  })

  it('preserves chunked request and response trailers through the byte bridge', async () => {
    const options = await fixture(`
      export default () => ({ mounts: ['/api'], handle(req, res) {
        req.resume();
        req.once('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json', Trailer: 'X-Response-Finished' });
          res.write(JSON.stringify(req.trailers));
          res.addTrailers({ 'X-Response-Finished': 'yes' });
          res.end();
        });
      }});
    `)
    const backend = await startBackend(options)
    const app = await gateway(backend)
    try {
      const request = http.request(app.base + '/api/trailers', { method: 'POST', headers: { Trailer: 'X-Request-Finished' } })
      const incoming = once(request, 'response')
      request.write('some data')
      request.addTrailers({ 'X-Request-Finished': 'yes' })
      request.end()
      const [response] = await incoming as [http.IncomingMessage]
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      await once(response, 'end')
      expect(JSON.parse(body)).toEqual({ 'x-request-finished': 'yes' })
      expect(response.trailers).toEqual({ 'x-response-finished': 'yes' })
    } finally { await app.close() }
  })

  it('rejects backend listeners and cleans up when start fails', async () => {
    const failed = await fixture(`
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default (ctx) => ({ mounts: ['/api'], handle() {},
        start() { throw new Error('fixture startup failed'); },
        stop() { return writeFile(join(ctx.dataDir, 'stopped'), String(ctx.signal.aborted)); }
      });
    `)
    await expect(startBackend(failed)).rejects.toThrow('fixture startup failed')
    expect(await readFile(join(failed.dataDir, 'stopped'), 'utf8')).toBe('true')
    const listener = await fixture(`
      import http from 'node:http';
      export default () => { http.createServer().listen(0); return { mounts: [], handle() {} }; };
    `)
    await expect(startBackend(listener)).rejects.toThrow('Unit HTTP listener')
  })

  it('contains crashes and exits, redacts failure responses, and allows a fresh worker', async () => {
    const failures: Error[] = []
    const options = await fixture(LIFECYCLE, { config: { secret: 'PRIVATE_CRASH_SENTINEL' }, onFailure: (e) => failures.push(e) })
    for (const route of ['/api/fail', '/api/exit']) {
      const backend = await startBackend(options)
      const app = await gateway(backend)
      try {
        const response = await fetch(app.base + route)
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain('PRIVATE_CRASH_SENTINEL')
        await eventually(async () => expect(backend.state).toBe('failed'))
        expect((await fetch(app.base + '/api/me')).status).toBe(503)
      } finally { await app.close() }
    }
    expect(failures).toHaveLength(2)
    const fresh = await startBackend({ ...options, env: { UNIT_FIXTURE_SETTING: 'fresh' } })
    const app = await gateway(fresh)
    try { expect(await fetch(app.base + '/api/me').then((r) => r.json())).toMatchObject({ starts: 1, env: 'fresh' }) }
    finally { await app.close() }
  })

  it('runs migrations without start and forwards restart requests to the host', async () => {
    let restartCount = 0
    const options = await fixture(LIFECYCLE, { onRestart: () => { restartCount++ } })
    await migrateBackend(options)
    expect(await readFile(join(options.dataDir, 'events'), 'utf8')).toBe('migrate\nstop:true\n')
    const backend = await startBackend(options)
    const app = await gateway(backend)
    try {
      expect(await fetch(app.base + '/api/restart').then((r) => r.text())).toBe('restarting')
      await eventually(async () => expect(restartCount).toBe(1))
    } finally { await app.close() }
  })

  it('enforces startup and shutdown deadlines without taking down the Unit', async () => {
    const hangingStart = await fixture(`export default () => ({ mounts: [], handle() {}, start: () => new Promise(() => {}) });`, { startTimeoutMs: 100 })
    await expect(startBackend(hangingStart)).rejects.toThrow('timed out')
    const hangingStop = await fixture(`export default () => ({ mounts: [], handle(_q, r) { r.end('ok'); }, stop: () => new Promise(() => {}) });`, { stopTimeoutMs: 100 })
    const backend = await startBackend(hangingStop)
    await expect(backend.stop()).rejects.toThrow('timed out')
    expect(backend.state).toBe('failed')
  })

  it.each(['start', 'migrate', 'factory'] as const)('cancels a detached job before rejecting a %s timeout', { skip: process.platform === 'win32', timeout: 6000 }, async (phase) => {
    const failures: Error[] = []
    const options = await fixture(detachedJobFixture(phase), {
      startTimeoutMs: 800, stopTimeoutMs: 1500, onFailure: (error) => failures.push(error),
    })
    try {
      const operation = phase === 'migrate' ? migrateBackend(options) : startBackend(options)
      await expect(operation).rejects.toThrow(`Backend ${phase === 'migrate' ? 'migrate' : 'start'} timed out`)
      // Rejection is a cleanup barrier: no polling after the caller receives it.
      const pid = Number(await readFile(join(options.dataDir, 'child.pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      expect(await readFile(join(options.dataDir, 'stopped'), 'utf8')).toBe('true')
      expect(failures).toHaveLength(1)
      expect(failures[0].message).toContain('timed out')
    } finally { await cleanDetachedFixture(options) }
  })

  it.each([false, true])('aborts a migration and awaits detached-job cleanup even when stop throws=%s', { skip: process.platform === 'win32', timeout: 6000 }, async (stopThrows) => {
    const controller = new AbortController()
    const reason = new Error('Migration interrupted by the Unit CLI')
    const failures: Error[] = []
    const options = await fixture(detachedJobFixture('migrate', stopThrows), {
      signal: controller.signal, startTimeoutMs: 5000, stopTimeoutMs: 1500,
      onLog: (message) => { if (message === 'detached job ready') controller.abort(reason) },
      onFailure: (error) => failures.push(error),
    })
    try {
      await expect(migrateBackend(options)).rejects.toBe(reason)
      const pid = Number(await readFile(join(options.dataDir, 'child.pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      expect(await readFile(join(options.dataDir, 'stopped'), 'utf8')).toBe('true')
      expect(failures).toEqual([reason])
    } finally { await cleanDetachedFixture(options) }
  })

  it('rejects an already aborted operation before creating its worker', async () => {
    const controller = new AbortController()
    const reason = new Error('Cancelled before launch')
    controller.abort(reason)
    const options = await fixture(LIFECYCLE, { signal: controller.signal })
    await expect(migrateBackend(options)).rejects.toBe(reason)
    await expect(readFile(join(options.dataDir, 'events'))).rejects.toThrow()
  })

  it('closes active request streams before the plugin releases its backend resources', async () => {
    const options = await fixture(`
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default (ctx) => {
        let request;
        return { mounts: ['/api'], handle(req, res) { request = req; res.writeHead(200); res.write('started'); },
          stop() { return writeFile(join(ctx.dataDir, 'stop-state'), JSON.stringify({ aborted: ctx.signal.aborted, destroyed: request?.socket.destroyed })); }
        };
      };
    `)
    const backend = await startBackend(options)
    const app = await gateway(backend)
    try {
      const response = await fetch(app.base + '/api/long-running')
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('started')
      await backend.stop()
      await reader.read().catch(() => {})
      expect(JSON.parse(await readFile(join(options.dataDir, 'stop-state'), 'utf8'))).toEqual({ aborted: true, destroyed: true })
    } finally { await app.close() }
  })
})
