import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { randomUUID, type KeyObject } from 'node:crypto'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { sendControl } from '../../unit/control'
import { signDir, testKeyPair } from './bundleSignature.testutil'

const exec = promisify(execFile)
let root: string, scratch: string, main: string, file: string
const children = new Set<ChildProcess>()
const env = { ...process.env }
delete env.UNIT_PORT
// Generated per run; only the public half is written into the fixture unit.json.
const trusted = testKeyPair(), stranger = testKeyPair()
const signed = async (dir: string, key: KeyObject = trusted.privateKey) => { await signDir(dir, key); return dir }
const enableManagement = async () => {
  const config = JSON.parse(await readFile(file, 'utf8'))
  config.management = { enabled: true, trustedKeys: [trusted.publicKeyPem] }
  await writeFile(file, JSON.stringify(config))
  return config
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'unit-cli-test-'))
  main = join(root, 'dist/main.mjs')
  // Use the release entrypoints and bundle settings, without a renderer build or real database.
  await build({ entryPoints: [resolve('../unit/main.ts'), resolve('../unit/backendWorker.ts')],
    outdir: join(root, 'dist'), outExtension: { '.js': '.mjs' }, bundle: true,
    platform: 'node', target: 'node20', format: 'esm', logLevel: 'silent', tsconfig: resolve('tsconfig.json') })
  await mkdir(join(root, 'dist/web'))
  await writeFile(join(root, 'dist/web/index.html'), '<html><head></head><body>Unit CLI fixture</body></html>')
}, 15_000)
beforeEach(async () => {
  scratch = await mkdtemp(join(root, 'instance-'))
  file = join(scratch, 'state/unit.json')
  await cli('init', join(scratch, 'state'), '--port', '0')
})
afterEach(async () => {
  for (const child of children) await stop(child)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function cli(...args: string[]) {
  return (await exec(process.execPath, [main, ...args], { cwd: scratch || root, env, timeout: 15_000 })).stdout
}
const status = async () => JSON.parse(await cli('status', file))
async function start() {
  const child = spawn(process.execPath, [main, 'run', file], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout!.on('data', (chunk) => { output += chunk })
  child.stderr!.on('data', (chunk) => { output += chunk })
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Unit exited before ready: ${output}`)
    return (await status()).running
  }, { timeout: 10_000 }).toBe(true)
  return child
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Unit did not stop')) }, 5_000)
      child.once('exit', () => { clearTimeout(timer); done() })
      child.kill('SIGTERM')
    })
  }
  children.delete(child)
}
async function fixture(id: string, version: string, failStart = false, requires?: string[]) {
  const dir = join(scratch, `${id}-${version}`)
  await mkdir(dir)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id, version, apiVersion: 1, ...(requires ? { requires } : {}),
    backend: { apiVersion: 1, main: 'backend.mjs' } }))
  await writeFile(join(dir, 'service.mjs'), `export const version = ${JSON.stringify(version)};`)
  await writeFile(join(dir, 'backend.mjs'), `
    import { appendFile, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { threadId } from 'node:worker_threads';
    import { version } from './service.mjs';
    export default (ctx) => ({
      mounts: [${JSON.stringify('/api/' + id)}],
      account: ${JSON.stringify(id)} === 'authority' ? {
        metadata: { apiBase: '/api', loginPath: '/auth' },
        async resolve(token, options) {
          if (['auditor', 'operator', 'scopeless'].includes(token) && options?.purpose !== 'administration') return null;
          if (!['admin', 'ordinary', 'auditor', 'operator', 'scopeless'].includes(token)) return null;
          const demoted = await readFile(join(ctx.dataDir, 'demoted'), 'utf8').catch(() => '');
          if (['auditor', 'operator', 'scopeless'].includes(token)) return { userId: 'admin', username: 'admin', role: 'ADMIN_SCOPED', adminAccessRole: token, adminPermissions: token === 'scopeless' ? undefined : token === 'auditor' ? ['unit.read'] : ['unit.read', 'unit.lifecycle', 'unit.update'] };
          return { userId: token, username: token, role: token === 'admin' && !demoted ? 'ADMIN' : 'USER' };
        }
      } : undefined,
      start() { if (${failStart}) throw new Error('Rejected CLI fixture activation'); },
      migrate() { return appendFile(join(ctx.dataDir, 'migration-ran'), 'ran'); },
      handle(req, res) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version, pid: process.pid, threadId }));
      }
    });
  `)
  return dir
}
const service = async (port: number, id = 'service') => (await fetch(`http://127.0.0.1:${port}/api/${id}`)).json()

it('authorizes Unit jobs and survives independent updates, bad releases and authority replacement', async () => {
  await cli('install', file, await fixture('authority', '1.0.0'))
  await cli('install', file, await fixture('service', '1.0.0'))
  let child = await start(), port = (await status()).port
  const request = (path: string, body?: unknown, token = 'admin') => fetch(`http://127.0.0.1:${port}/api/admin/unit/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  expect((await request('status')).status).toBe(503)
  const privateConfig = JSON.parse(await readFile(file, 'utf8'))
  await expect(sendControl(privateConfig.dataDir, { action: 'stage', path: scratch, remote: true })).rejects.toThrow('Remote Unit management is disabled')
  await stop(child)
  const config = await enableManagement()
  child = await start(); port = (await status()).port
  const original = await status(), authorityBefore = await service(port, 'authority')
  expect((await request('status', undefined, 'forged')).status).toBe(401)
  expect((await request('status', undefined, 'ordinary')).status).toBe(403)
  expect((await request('status')).status).toBe(200)
  expect((await request('status', undefined, 'auditor')).status).toBe(200)
  expect((await request('status', undefined, 'scopeless')).status).toBe(403)
  expect((await fetch(`http://127.0.0.1:${port}/admin/unit/config`, { headers: { Authorization: 'Bearer operator' } })).status).toBe(403)
  const next = await signed(await fixture('service', '2.0.0'))
  const staged = JSON.parse(await cli('stage', file, next))
  await rm(next, { recursive: true })
  const releases = await (await request('releases')).text()
  expect(releases).toContain(staged.releaseId); expect(releases).not.toContain(scratch)
  const input = { action: 'update', pluginId: 'service', releaseId: staged.releaseId, requestId: randomUUID(), confirm: true }
  expect((await request('operations', { ...input, confirm: false })).status).toBe(400)
  expect((await request('operations', { ...input, path: '/tmp/anything' })).status).toBe(400)
  expect((await request('operations', { ...input, pluginId: 'authority' })).status).toBe(400)
  expect((await request('operations', input, 'ordinary')).status).toBe(403)
  expect((await request('operations', input, 'auditor')).status).toBe(403)
  expect((await request('operations', { action: 'migrate', pluginId: 'service', requestId: randomUUID(), confirm: true }, 'operator')).status).toBe(403)
  const waitJob = async (id: string, expected = 'succeeded') => {
    await expect.poll(async () => {
      const response = await request('operations/' + id)
      return response.ok ? (await response.json()).state : 'authority-unavailable'
    }, { timeout: 12_000 }).toBe(expected)
  }
  expect((await request('operations', input, 'operator')).status).toBe(202)
  expect((await request('operations', input)).status).toBe(200)
  expect((await request('operations', { ...input, requestId: randomUUID() })).status).toBe(409)
  await waitJob(input.requestId)
  expect((await service(port)).version).toBe('2.0.0')
  expect((await service(port, 'authority')).threadId).toBe(authorityBefore.threadId)
  expect((await status()).pid).toBe(original.pid)
  expect((await request('operations', { ...input, action: 'restart', releaseId: undefined })).status).toBe(409)
  const bad = JSON.parse(await cli('stage', file, await signed(await fixture('service', '3.0.0', true))))
  const saved = await readFile(file, 'utf8'), failedId = randomUUID()
  expect((await request('operations', { ...input, releaseId: bad.releaseId, requestId: failedId })).status).toBe(202)
  await waitJob(failedId, 'failed')
  expect(await readFile(file, 'utf8')).toBe(saved)
  expect((await service(port)).version).toBe('2.0.0')
  await writeFile(join(config.dataDir, 'releases', staged.releaseId, 'package/service.mjs'), 'export const version = "tampered";')
  const tamperedJob = randomUUID()
  expect((await request('operations', { ...input, requestId: tamperedJob })).status).toBe(202)
  await waitJob(tamperedJob, 'failed')
  const action = async (action: string, expected = 'succeeded') => {
    const requestId = randomUUID()
    expect((await request('operations', { action, pluginId: 'service', requestId, confirm: true })).status).toBe(202)
    await waitJob(requestId, expected)
  }
  await action('migrate', 'failed')
  await action('disable'); await action('migrate'); await action('enable'); await action('restart')
  expect((await request('operations', { action: 'disable', pluginId: 'authority', requestId: randomUUID(), confirm: true })).status).toBe(409)
  const replacement = JSON.parse(await cli('stage', file, await signed(await fixture('authority', '2.0.0'))))
  const authorityJob = randomUUID()
  expect((await request('operations', { ...input, pluginId: 'authority', releaseId: replacement.releaseId, requestId: authorityJob })).status).toBe(202)
  await waitJob(authorityJob)
  expect((await service(port, 'authority')).threadId).not.toBe(authorityBefore.threadId)
  expect((await status()).pid).toBe(original.pid)
  await stop(child); child = await start(); port = (await status()).port
  await waitJob(authorityJob)
  await writeFile(join(config.dataDir, 'plugins/authority/demoted'), 'yes')
  expect((await request('status')).status).toBe(403)
  expect((await request('operations', { ...input, requestId: randomUUID() })).status).toBe(403)
  await stop(child)
  await rm(join(config.dataDir, 'plugins/authority/demoted'))
  const journal = join(config.dataDir, 'management-jobs.json')
  const jobs = JSON.parse(await readFile(journal, 'utf8')), interruptedId = randomUUID()
  jobs.push({ ...jobs[0], id: interruptedId, state: 'running' })
  await writeFile(journal, JSON.stringify(jobs))
  child = await start(); port = (await status()).port
  await waitJob(interruptedId, 'interrupted')
  const revokedJob = randomUUID()
  expect((await request('operations', { action: 'disable', pluginId: 'service', requestId: revokedJob, confirm: true })).status).toBe(202)
  await writeFile(join(config.dataDir, 'plugins/authority/demoted'), 'yes')
  await new Promise((resolve) => setTimeout(resolve, 250))
  await rm(join(config.dataDir, 'plugins/authority/demoted'))
  await waitJob(revokedJob, 'failed')
  expect((await status()).plugins.find((p: any) => p.id === 'service').state).toBe('active')
  await stop(child)
}, 40_000)

it('installs only trusted releases, refuses protected or required plugins, and keeps files after uninstall', async () => {
  await cli('install', file, await fixture('authority', '1.0.0'))
  const config = await enableManagement()
  let child = await start(), port = (await status()).port
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}/api/admin/unit/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const operate = (action: string, pluginId: string, releaseId?: string) =>
    request('operations', { action, pluginId, ...(releaseId ? { releaseId } : {}), requestId: randomUUID(), confirm: true })
  const run = async (action: string, pluginId: string, releaseId?: string, expected = 'succeeded') => {
    const response = await operate(action, pluginId, releaseId)
    expect(response.status).toBe(202)
    const { id } = await response.json()
    await expect.poll(async () => (await (await request('operations/' + id)).json()).state, { timeout: 12_000 }).toBe(expected)
    return (await (await request('operations/' + id)).json())
  }
  const rejected = async (response: Response, status: number, message: string) => {
    expect(response.status).toBe(status); expect((await response.json()).error).toContain(message)
  }
  const unit = await (await request('status')).json()
  expect(unit.management.actions).toEqual(['enable', 'disable', 'restart', 'update', 'migrate', 'install', 'uninstall'])
  expect(unit.plugins).toEqual([expect.objectContaining({ id: 'authority', state: 'active', requires: [], protected: true })])
  const stage = async (dir: string) => JSON.parse(await cli('stage', file, dir)).releaseId as string
  const service = await stage(await signed(await fixture('service', '1.0.0')))
  const dependent = await stage(await signed(await fixture('dependent', '1.0.0', false, ['service'])))
  const broken = await stage(await signed(await fixture('broken', '1.0.0', true)))
  const foreign = await stage(await signed(await fixture('foreign', '1.0.0'), stranger.privateKey))
  const bare = await stage(await fixture('bare', '1.0.0'))
  const padded = await signed(await fixture('padded', '1.0.0'))
  await writeFile(join(padded, 'unsigned.mjs'), 'export const added = true') // added after signing
  const incomplete = await stage(padded)
  const authorityUpdate = await stage(await fixture('authority', '1.1.0'))
  const releases: Array<{ releaseId: string; installed: boolean; signature: string }> = (await (await request('releases')).json()).releases
  const release = (id: string) => releases.find((item) => item.releaseId === id)
  expect(release(service)).toMatchObject({ pluginId: 'service', installed: false, signature: 'trusted' })
  expect(release(foreign)).toMatchObject({ installed: false, signature: 'untrusted' })
  expect(release(bare)).toMatchObject({ installed: false, signature: 'missing' })
  expect(release(incomplete)).toMatchObject({ installed: false, signature: 'untrusted' })
  expect(release(authorityUpdate)).toMatchObject({ installed: true, signature: 'missing' })
  await rejected(await operate('install', 'foreign', foreign), 400, 'Release is not signed by a trusted key')
  await rejected(await operate('install', 'bare', bare), 400, 'Release is not signed by a trusted key')
  await rejected(await operate('install', 'padded', incomplete), 400, 'Release is not signed by a trusted key')
  await rejected(await operate('update', 'authority', authorityUpdate), 400, 'Release is not signed by a trusted key')
  expect((await operate('install', 'service')).status).toBe(400)
  await rejected(await operate('install', 'dependent', dependent), 409, 'Required plugins are not active: service')
  await rejected(await operate('uninstall', 'service'), 404, 'not installed')

  await run('install', 'service', service)
  expect((await (await fetch(`http://127.0.0.1:${port}/api/service`)).json()).version).toBe('1.0.0')
  let saved = JSON.parse(await readFile(file, 'utf8'))
  const servicePath = saved.plugins[1].path as string
  expect(relative(join(scratch, 'state/plugins/service'), servicePath)).toMatch(/^1\.0\.0-/)
  await rejected(await operate('install', 'service', service), 409, 'already installed; use update')
  await run('install', 'dependent', dependent)
  await run('disable', 'dependent')
  await rejected(await operate('uninstall', 'service'), 409, 'require it first: dependent')
  await rejected(await operate('uninstall', 'authority'), 409, 'account authority')
  const beforeBroken = await readFile(file, 'utf8')
  await run('install', 'broken', broken, 'failed')
  expect(await readFile(file, 'utf8')).toBe(beforeBroken)
  expect((await status()).plugins.map((p: { id: string }) => p.id)).not.toContain('broken')
  expect(await readdir(join(scratch, 'state/plugins/broken'))).toEqual([]) // the failed version directory is removed

  const dependentPath = JSON.parse(beforeBroken).plugins[2].path as string
  await run('uninstall', 'dependent')
  // Directory modes do not stop writes on Windows or for root; there the write cannot be made to fail.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    // unit.json cannot be replaced: the uninstall is undone in the running Unit, with its entry intact.
    const unchanged = await readFile(file, 'utf8'), worker = (await (await fetch(`http://127.0.0.1:${port}/api/service`)).json()).threadId
    await chmod(join(scratch, 'state'), 0o500)
    try { await run('uninstall', 'service', undefined, 'failed') } finally { await chmod(join(scratch, 'state'), 0o700) }
    expect(await readFile(file, 'utf8')).toBe(unchanged)
    expect((await status()).plugins.find((p: { id: string }) => p.id === 'service')?.state).toBe('active')
    const restored = await (await fetch(`http://127.0.0.1:${port}/api/service`)).json()
    expect(restored.version).toBe('1.0.0'); expect(restored.threadId).not.toBe(worker) // stopped, then restored
  }
  await run('uninstall', 'service')
  saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.plugins.map((p: { path: string }) => p.path)).toEqual([JSON.parse(beforeBroken).plugins[0].path])
  for (const kept of [join(config.dataDir, 'plugins/service'), join(config.dataDir, 'plugins/dependent'), servicePath, dependentPath]) {
    expect((await stat(kept)).isDirectory()).toBe(true)
  }
  expect((await (await request('status')).json()).plugins.map((p: { id: string }) => p.id)).toEqual(['authority'])
  await stop(child); child = await start(); port = (await status()).port
  expect((await status()).plugins.map((p: { id: string }) => p.id)).toEqual(['authority'])
  await run('install', 'service', service)
  expect((await (await request('releases')).json()).releases.find((item: { releaseId: string }) => item.releaseId === service).installed).toBe(true)
  await stop(child)
}, 60_000)
